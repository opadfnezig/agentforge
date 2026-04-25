import { existsSync } from 'fs'
import { paths } from '../config.js'
import { logger } from '../lib/logger.js'
import { composeMutex } from '../lib/mutex.js'
import {
  buildServiceBlock,
  readCompose,
  writeCompose,
} from '../lib/compose-file.js'
import {
  composeLogs,
  composePsIds,
  composeRmService,
  composeServiceState,
  composeUp,
  DockerExecResult,
} from '../lib/docker.js'
import {
  ensurePrimitiveDirs,
  initialState,
  primitiveExists,
  readState,
  writeState,
  listStates,
} from './primitive-state.js'
import { archivePrimitive, removePrimitiveDir } from './archive.js'
import { enqueueEvent, recordTransition } from './lifecycle-events.js'
import { lifecycleHistory } from '../lib/db.js'
import { SpawnRequest, PrimitiveState_t, LifecycleHistoryEntry } from '../lib/types.js'

export class SpawnError extends Error {
  constructor(public statusCode: number, message: string, public code: string) {
    super(message)
    this.name = 'SpawnError'
  }
}

export const spawnPrimitive = async (req: SpawnRequest): Promise<PrimitiveState_t> => {
  return composeMutex.run(async () => {
    if (await primitiveExists(req.name)) {
      throw new SpawnError(409, `Primitive '${req.name}' already exists`, 'PRIMITIVE_EXISTS')
    }

    // 1. Create folder layout + initial state.json (state=creating) +
    //    enqueue the null→creating lifecycle event.
    await ensurePrimitiveDirs(req.name)
    const state = initialState(req)
    const creatingEventId = enqueueEvent(req.name, req.kind, 'creating', null, {
      image: req.image,
    })
    state.last_event_id = creatingEventId
    state.last_event_at = new Date().toISOString()
    await writeState(state)

    // 2. Patch compose.yml.
    const compose = await readCompose()
    if (compose.services[req.name]) {
      throw new SpawnError(
        409,
        `compose.yml already has service '${req.name}'`,
        'COMPOSE_SERVICE_EXISTS'
      )
    }
    compose.services[req.name] = buildServiceBlock(req)
    await writeCompose(compose)

    // 3. Bring up the service.
    const up = await composeUp([req.name])
    if (up.code !== 0) {
      // Roll back compose.yml so we don't leave a broken entry behind.
      const rollback = await readCompose()
      delete rollback.services[req.name]
      await writeCompose(rollback)
      // Mark the primitive crashed and emit an event so the server knows.
      const cur = await readState(req.name)
      if (cur) {
        await recordTransition(req.name, 'crashed', {
          reason: 'compose up failed',
          stderr: up.stderr.slice(0, 500),
        })
      }
      throw new SpawnError(
        500,
        `docker compose up failed: ${up.stderr.slice(0, 300)}`,
        'COMPOSE_UP_FAILED'
      )
    }

    // 4. Capture container id and flip state -> running.
    const svc = await composeServiceState(req.name)
    const containerId = svc?.id ?? null
    await recordTransition(
      req.name,
      'running',
      { container_id: containerId },
      { container_id: containerId }
    )
    const final = await readState(req.name)
    return final!
  })
}

/**
 * Destroy: archive folder → docker compose rm -fsv <service> → remove
 * compose entry → remove folder. Archive must succeed before deletion.
 */
export const destroyPrimitive = async (
  name: string
): Promise<{ archivePath: string; bytes: number; rm: DockerExecResult }> => {
  return composeMutex.run(async () => {
    const cur = await readState(name)
    if (!cur) {
      throw new SpawnError(404, `Primitive '${name}' not found`, 'PRIMITIVE_NOT_FOUND')
    }

    const archive = await archivePrimitive(name)
    const rmRes = await composeRmService(name)
    // rm failures are reported but don't block: we still want to try to
    // tear down compose+folder. If a container is still bound, the folder
    // delete below will fail and surface that.

    // Remove the service entry from compose.yml.
    const compose = await readCompose()
    delete compose.services[name]
    await writeCompose(compose)

    // Update state to destroyed BEFORE removing folder (so the event is
    // recorded). Then delete the folder.
    await recordTransition(name, 'destroyed', {
      archive_path: archive.archivePath,
      archive_bytes: archive.bytes,
      compose_rm_code: rmRes.code,
    })

    await removePrimitiveDir(name)

    return { archivePath: archive.archivePath, bytes: archive.bytes, rm: rmRes }
  })
}

export const inspectPrimitive = async (
  name: string
): Promise<{
  state: PrimitiveState_t
  folder: string
  history: LifecycleHistoryEntry[]
  last_event: { id: string | null; at: string | null; delivered: boolean | null }
}> => {
  const s = await readState(name)
  if (!s) throw new SpawnError(404, `Primitive '${name}' not found`, 'PRIMITIVE_NOT_FOUND')

  const rows = lifecycleHistory(name)
  const history: LifecycleHistoryEntry[] = rows.map((r) => ({
    event_id: r.event_id,
    state: r.state as PrimitiveState_t['state'],
    prev_state: r.prev_state as PrimitiveState_t['state'] | null,
    timestamp: r.timestamp,
    delivered: r.delivered === 1,
    attempts: r.attempts,
    last_error: r.last_error,
  }))

  const lastRow = rows[rows.length - 1] ?? null
  return {
    state: s,
    folder: paths.primitiveDir(name),
    history,
    last_event: lastRow
      ? { id: lastRow.event_id, at: lastRow.timestamp, delivered: lastRow.delivered === 1 }
      : { id: null, at: null, delivered: null },
  }
}

export const listPrimitives = async (): Promise<PrimitiveState_t[]> => {
  return listStates()
}

export const tailPrimitiveLogs = async (
  name: string,
  opts: { tail?: number | 'all'; since?: string }
): Promise<DockerExecResult> => {
  if (!(await primitiveExists(name))) {
    throw new SpawnError(404, `Primitive '${name}' not found`, 'PRIMITIVE_NOT_FOUND')
  }
  return composeLogs(name, opts)
}

/**
 * Reconcile state.json vs `docker compose ps`. For each primitive whose
 * state is `running` but whose container is missing or non-running, attempt
 * `docker compose up -d <name>` up to NTFR_ORPHAN_RETRY_MAX times, each
 * separated by NTFR_ORPHAN_RETRY_BACKOFF_MS. If still failing, mark
 * `state: orphaned`, emit lifecycle event, leave it.
 */
export const recoverOrphans = async (
  retryMax: number,
  retryBackoffMs: number
): Promise<{ checked: number; recovered: string[]; orphaned: string[] }> => {
  const recovered: string[] = []
  const orphaned: string[] = []

  // Ensure compose file exists; if no compose at all, nothing to recover.
  if (!existsSync(paths.composeFile)) {
    logger.info('No compose.yml present — skipping orphan recovery')
    return { checked: 0, recovered, orphaned }
  }

  const states = await listStates()
  const ids = await composePsIds()

  for (const s of states) {
    if (s.state !== 'running') continue
    const cur = ids.get(s.name)
    const isRunning = cur && /running/i.test(await statusFromPs(s.name))
    if (isRunning) continue

    logger.warn('Orphan detected; attempting recovery', { name: s.name, expected: 'running', has_container: !!cur })
    let success = false
    for (let attempt = 1; attempt <= retryMax; attempt++) {
      const up = await composeUp([s.name])
      if (up.code === 0) {
        const svc = await composeServiceState(s.name)
        if (svc && /running/i.test(svc.state)) {
          success = true
          await recordTransition(
            s.name,
            'running',
            { recovered: true, attempts: attempt },
            { container_id: svc.id }
          )
          recovered.push(s.name)
          break
        }
      } else {
        logger.warn('Orphan recovery attempt failed', {
          name: s.name,
          attempt,
          stderr: up.stderr.slice(0, 200),
        })
      }
      if (attempt < retryMax) await sleep(retryBackoffMs)
    }
    if (!success) {
      await recordTransition(s.name, 'orphaned', {
        reason: 'container missing after orphan-recovery attempts',
        attempts: retryMax,
      })
      orphaned.push(s.name)
    }
  }

  return { checked: states.length, recovered, orphaned }
}

const statusFromPs = async (name: string): Promise<string> => {
  const svc = await composeServiceState(name)
  return svc?.state ?? ''
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
