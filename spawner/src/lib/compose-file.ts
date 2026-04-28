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
// host's source tree at /ntfr/agentforge (see spawner/deploy/docker-compose.yml,
// NTFR_HOST_SRC), so these paths are visible to the compose CLI inside
// the spawner. This is intentionally simple — once we have a real image
// registry, switch the spawner to pull-by-tag and remove this map.
export const KIND_BUILD_CONTEXT: Record<string, string | undefined> = {
  developer: '/ntfr/agentforge/developer',
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
// + DEVELOPER_SECRET are intentionally NOT here — those are caller-supplied
// because they require backend-side developer registration.
const buildKindEnv = (kind: string): Record<string, string> => {
  if (kind === 'developer') {
    const env: Record<string, string> = { WORKSPACE_PATH: '/workspace' }
    const coord = deriveCoordinatorUrl()
    if (coord) env.COORDINATOR_URL = coord
    return env
  }
  return {}
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
 * Volume layout (mandatory):
 *   - <primitive>/workspace:/workspace:rw  — primitive's R/W folder
 *   - <primitive>/.meta:/meta:ro           — spawner-owned metadata, primitive RO
 * Plus any extra mounts the caller provided (passed through verbatim).
 */
export const buildServiceBlock = (req: SpawnRequest): ComposeService => {
  const baseVolumes = [
    `./${req.name}/workspace:/workspace:rw`,
    `./${req.name}/.meta:/meta:ro`,
  ]
  const extraVolumes = (req.mounts ?? []).map((m) => {
    const ro = m.readOnly ? ':ro' : ':rw'
    return `${m.source}:${m.target}${ro}`
  })

  const svc: ComposeService = {
    container_name: `ntfr-${req.name}`,
    restart: 'always',
    volumes: [...baseVolumes, ...extraVolumes],
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
