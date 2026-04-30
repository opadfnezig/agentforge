import { readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { parse as yamlParse, stringify as yamlStringify } from 'yaml'
import { config, paths } from '../config.js'
import { logger } from './logger.js'
import { SpawnRequest } from './types.js'

interface ComposeService {
  image?: string
  build?: { context: string; dockerfile?: string }
  container_name?: string
  restart?: string
  environment?: Record<string, string>
  volumes?: string[]
  networks?: string[]
  command?: string | string[]
  entrypoint?: string | string[]
  // Allow extra keys for forward-compatibility
  [key: string]: unknown
}

// Hardcoded per-kind build contexts. The spawner container mounts the
// host's source tree at /src (see spawner/deploy/docker-compose.yml,
// NTFR_HOST_SRC), so these paths are visible to the compose CLI inside
// the spawner. This is intentionally simple — once we have a real image
// registry, switch the spawner to pull-by-tag and remove this map.
export const KIND_BUILD_CONTEXT: Record<string, string | undefined> = {
  developer: '/src/developer',
  oracle: '/src/oracle',
  researcher: '/src/researcher',
}

// Derive the WS coordinator URL from NTFR_SERVER_URL when no explicit
// NTFR_COORDINATOR_URL is set: swap http(s)→ws(s) and drop a trailing
// /api segment if present. Spawner and the primitives it spawns share the
// same docker network, so the same hostname/port the spawner uses to POST
// lifecycle events is reachable from the primitive too.
const deriveCoordinatorUrl = (): string | undefined => {
  if (config.NTFR_COORDINATOR_URL) return config.NTFR_COORDINATOR_URL
  if (!config.NTFR_SERVER_URL) return undefined
  try {
    const u = new URL(config.NTFR_SERVER_URL)
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
    u.pathname = u.pathname.replace(/\/api\/?$/, '/').replace(/\/+$/, '') || '/'
    return u.toString().replace(/\/$/, '')
  } catch {
    return undefined
  }
}

// Static env vars the spawner injects per primitive kind. User-provided
// env in the spawn request always wins (we merge user last). DEVELOPER_ID
// + DEVELOPER_SECRET (and ORACLE_ID + ORACLE_SECRET) are intentionally NOT
// here — those are caller-supplied because they require backend-side
// primitive registration.
const buildKindEnv = (kind: string): Record<string, string> => {
  if (kind === 'developer') {
    const env: Record<string, string> = { WORKSPACE_PATH: '/workspace' }
    const coord = deriveCoordinatorUrl()
    if (coord) env.COORDINATOR_URL = coord
    return env
  }
  if (kind === 'oracle') {
    // WORKSPACE_PATH is pinned to /workspace so the claude CLI's auto-memory
    // dir resolves to ~/.claude/projects/-workspace/memory inside the
    // container — that path is what the host volume targets.
    const env: Record<string, string> = { WORKSPACE_PATH: '/workspace' }
    const coord = deriveCoordinatorUrl()
    if (coord) env.COORDINATOR_URL = coord
    return env
  }
  if (kind === 'researcher') {
    const env: Record<string, string> = { WORKSPACE_PATH: '/workspace' }
    const coord = deriveCoordinatorUrl()
    if (coord) env.COORDINATOR_URL = coord
    return env
  }
  return {}
}

// Static volumes the spawner injects per primitive kind. Resolved by the
// host docker daemon, so source paths are HOST paths (the spawner runs in
// a container itself but `docker compose up` is executed by the daemon).
// Prepended to user mounts so caller-supplied volumes win on path
// collisions (later compose-volume entries take precedence in docker).
const buildKindVolumes = (kind: string, name: string): string[] => {
  if (kind === 'developer') {
    return [
      // Live OAuth token mirrored by claude-token-broker on the host.
      '/var/lib/claude-creds/credentials.json:/home/agent/.claude/.credentials.json:ro',
      // SSH keys for git over SSH. The container entrypoint copies these
      // from /mnt/ssh-src into /home/agent/.ssh with 600/700 perms; the
      // mount stays RO so the original keys can't be modified.
      '/root/.ssh:/mnt/ssh-src:ro',
      // Persistent memory for Claude CLI. Same path encoding as oracle
      // (WORKDIR=/workspace → ~/.claude/projects/-workspace/memory).
      `./${name}/memories:/home/agent/.claude/projects/-workspace/memory:rw`,
    ]
  }
  if (kind === 'researcher') {
    return [
      // OAuth token for Claude CLI.
      '/var/lib/claude-creds/credentials.json:/home/agent/.claude/.credentials.json:ro',
      // Persistent memory across runs.
      `./${name}/memories:/home/agent/.claude/projects/-workspace/memory:rw`,
      // Results directory for research output.
      `./${name}/results:/workspace/results:rw`,
    ]
  }
  if (kind === 'oracle') {
    // Mount layout (paths are relative to the spawner's compose file dir,
    // same convention as the base volumes):
    //   <name>/data      → /data       (staging area for migrate mode)
    //   <name>/memories  → /home/agent/.claude/projects/-workspace/memory
    // The Claude CLI encodes cwd `/workspace` as `-workspace` under
    // ~/.claude/projects/, so the memory mount target is that exact path.
    // Same OAuth token mount as developer — the CLI needs it at runtime.
    return [
      '/var/lib/claude-creds/credentials.json:/home/agent/.claude/.credentials.json:ro',
      `./${name}/data:/data:rw`,
      `./${name}/memories:/home/agent/.claude/projects/-workspace/memory:rw`,
    ]
  }
  return []
}

interface ComposeNetwork {
  external?: boolean
  name?: string
}

interface ComposeFile {
  name: string
  services: Record<string, ComposeService>
  networks?: Record<string, ComposeNetwork>
  // version intentionally omitted — modern compose ignores it.
}

// Logical network alias used inside this compose file. The actual docker
// network it points to is configured via NTFR_PRIMITIVE_NETWORK.
const PRIMITIVE_NETWORK_ALIAS = 'agentforge-net'

const ensurePrimitiveNetwork = (file: ComposeFile): ComposeFile => {
  if (!file.networks) file.networks = {}
  file.networks[PRIMITIVE_NETWORK_ALIAS] = {
    external: true,
    name: config.NTFR_PRIMITIVE_NETWORK,
  }
  return file
}

const empty = (): ComposeFile =>
  ensurePrimitiveNetwork({ name: 'ntfr', services: {} })

export const readCompose = async (): Promise<ComposeFile> => {
  if (!existsSync(paths.composeFile)) return empty()
  const txt = await readFile(paths.composeFile, 'utf8')
  if (!txt.trim()) return empty()
  try {
    const parsed = yamlParse(txt) as ComposeFile | null
    if (!parsed || typeof parsed !== 'object') return empty()
    if (!parsed.services) parsed.services = {}
    if (!parsed.name) parsed.name = 'ntfr'
    return ensurePrimitiveNetwork(parsed)
  } catch (err) {
    logger.error('Failed to parse compose.yml — refusing to overwrite', { err: String(err) })
    throw err
  }
}

export const writeCompose = async (file: ComposeFile): Promise<void> => {
  const txt = yamlStringify(file)
  await writeFile(paths.composeFile, txt, 'utf8')
}

/**
 * Build the service block for a primitive. Every primitive runs with
 * `restart: always` per locked design decision.
 *
 * Volumes are the union of per-kind static mounts (memory/credentials for
 * oracle, credentials/ssh for developer) and any caller-supplied mounts.
 */
export const buildServiceBlock = (req: SpawnRequest): ComposeService => {
  const kindVolumes = buildKindVolumes(req.kind, req.name)
  const extraVolumes = (req.mounts ?? []).map((m) => {
    const ro = m.readOnly ? ':ro' : ':rw'
    return `${m.source}:${m.target}${ro}`
  })

  const svc: ComposeService = {
    container_name: `ntfr-${req.name}`,
    restart: 'always',
    volumes: [...kindVolumes, ...extraVolumes],
    // Join the same external docker network the spawner itself is on, so
    // the primitive can reach `backend` (and other named services) by
    // hostname. Without this, primitives land on the auto-created
    // `ntfr_default` network and DNS for `backend` fails.
    networks: [PRIMITIVE_NETWORK_ALIAS],
  }

  if (req.image) {
    svc.image = req.image
  } else {
    const ctx = KIND_BUILD_CONTEXT[req.kind]
    if (!ctx) {
      throw new Error(
        `no build context registered for kind=${req.kind} and no image provided`
      )
    }
    svc.build = { context: ctx }
    // Pin a stable image tag so subsequent `docker compose up -d` reuses
    // the cached build instead of rebuilding from scratch every time.
    svc.image = `ntfr-${req.kind}:${req.name}`
  }

  // Merge static per-kind env (e.g. COORDINATOR_URL/WORKSPACE_PATH for
  // developers) under any caller-provided env, so callers can override.
  const kindEnv = buildKindEnv(req.kind)
  const mergedEnv = { ...kindEnv, ...(req.env ?? {}) }
  if (Object.keys(mergedEnv).length > 0) {
    svc.environment = mergedEnv
  }

  if (req.command !== undefined) svc.command = req.command
  if (req.args !== undefined && !req.command) svc.command = req.args

  return svc
}
