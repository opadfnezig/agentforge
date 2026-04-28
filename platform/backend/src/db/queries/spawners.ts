import { v4 as uuid } from 'uuid'
import { db, DbSpawnerHost, DbSpawn, DbSpawnEvent, DbSpawnIntent, DbDeveloper } from '../connection.js'
import {
  SpawnerHost,
  CreateSpawnerHost,
  UpdateSpawnerHost,
  SpawnerHostStatus,
  PrimitiveKind,
  PrimitiveState,
  LifecycleEvent,
  SpawnIntent,
  SpawnIntentStatus,
  SpawnSpec,
} from '../../schemas/spawner.js'

const parseJson = <T>(v: T | string | null | undefined, fallback: T): T => {
  if (v === null || v === undefined) return fallback
  if (typeof v === 'string') {
    if (!v) return fallback
    try {
      return JSON.parse(v) as T
    } catch {
      return fallback
    }
  }
  return v
}

const toDate = (v: Date | string | null | undefined): Date | null => {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v
  return new Date(v)
}

const toHost = (row: DbSpawnerHost): SpawnerHost => ({
  id: row.id,
  hostId: row.host_id,
  name: row.name,
  baseUrl: row.base_url,
  status: row.status as SpawnerHostStatus,
  version: row.version,
  capabilities: parseJson<string[]>(row.capabilities as string[] | string | null, []),
  lastSeenAt: toDate(row.last_seen_at),
  lastEventAt: toDate(row.last_event_at),
  lastError: row.last_error,
  config: parseJson<Record<string, unknown>>(row.config, {}),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export interface Spawn {
  id: string
  spawnerHostId: string
  primitiveName: string
  primitiveKind: PrimitiveKind
  state: PrimitiveState
  prevState: PrimitiveState | null
  lastEventId: string | null
  lastEventAt: Date
  payload: Record<string, unknown>
  createdAt: Date
  updatedAt: Date
}

const toSpawn = (row: DbSpawn): Spawn => ({
  id: row.id,
  spawnerHostId: row.spawner_host_id,
  primitiveName: row.primitive_name,
  primitiveKind: row.primitive_kind as PrimitiveKind,
  state: row.state as PrimitiveState,
  prevState: row.prev_state as PrimitiveState | null,
  lastEventId: row.last_event_id,
  lastEventAt: toDate(row.last_event_at) as Date,
  payload: parseJson<Record<string, unknown>>(row.payload, {}),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

// --- spawner_hosts CRUD ---

export const createSpawnerHost = async (data: CreateSpawnerHost): Promise<SpawnerHost> => {
  const [row] = await db<DbSpawnerHost>('spawner_hosts')
    .insert({
      id: uuid(),
      host_id: data.hostId,
      name: data.name,
      base_url: data.baseUrl,
      status: 'unknown',
      capabilities: JSON.stringify([]) as unknown as string[],
      config: JSON.stringify(data.config || {}) as unknown as Record<string, unknown>,
    })
    .returning('*')
  return toHost(row)
}

export const listSpawnerHosts = async (): Promise<SpawnerHost[]> => {
  const rows = await db<DbSpawnerHost>('spawner_hosts').orderBy('created_at', 'desc')
  return rows.map(toHost)
}

export const getSpawnerHost = async (id: string): Promise<SpawnerHost | null> => {
  const row = await db<DbSpawnerHost>('spawner_hosts').where({ id }).first()
  return row ? toHost(row) : null
}

export const getSpawnerHostByHostId = async (
  hostId: string
): Promise<SpawnerHost | null> => {
  const row = await db<DbSpawnerHost>('spawner_hosts').where({ host_id: hostId }).first()
  return row ? toHost(row) : null
}

export interface UpdateSpawnerHostInput extends UpdateSpawnerHost {
  status?: SpawnerHostStatus
  version?: string | null
  capabilities?: string[]
  lastSeenAt?: Date | null
  lastEventAt?: Date | null
  lastError?: string | null
}

export const updateSpawnerHost = async (
  id: string,
  data: UpdateSpawnerHostInput
): Promise<SpawnerHost | null> => {
  const update: Partial<DbSpawnerHost> = {}
  if (data.name !== undefined) update.name = data.name
  if (data.baseUrl !== undefined) update.base_url = data.baseUrl
  if (data.config !== undefined) {
    update.config = JSON.stringify(data.config) as unknown as Record<string, unknown>
  }
  if (data.status !== undefined) update.status = data.status
  if (data.version !== undefined) update.version = data.version
  if (data.capabilities !== undefined) {
    update.capabilities = JSON.stringify(data.capabilities) as unknown as string[]
  }
  if (data.lastSeenAt !== undefined) update.last_seen_at = data.lastSeenAt
  if (data.lastEventAt !== undefined) update.last_event_at = data.lastEventAt
  if (data.lastError !== undefined) update.last_error = data.lastError

  const [row] = await db<DbSpawnerHost>('spawner_hosts')
    .where({ id })
    .update({ ...update, updated_at: new Date() })
    .returning('*')
  return row ? toHost(row) : null
}

export const deleteSpawnerHost = async (id: string): Promise<boolean> => {
  const count = await db<DbSpawnerHost>('spawner_hosts').where({ id }).delete()
  return count > 0
}

// --- spawns / spawn_events ---

export interface IngestResult {
  deduped: boolean
  eventRowId: string | null
}

// Insert a lifecycle event (idempotent on event_id) and upsert the latest
// state into `spawns` with last-event-timestamp-wins. Spawn-row update only
// applies when the incoming event is newer than what's stored, so out-of-
// order retries don't trample current state.
export const ingestLifecycleEvent = async (
  spawnerHostId: string,
  event: LifecycleEvent
): Promise<IngestResult> => {
  return db.transaction(async (trx) => {
    const existing = await trx<DbSpawnEvent>('spawn_events')
      .where({ event_id: event.event_id })
      .first()
    if (existing) return { deduped: true, eventRowId: existing.id }

    const eventRowId = uuid()
    const eventTs = new Date(event.timestamp)
    await trx<DbSpawnEvent>('spawn_events').insert({
      id: eventRowId,
      spawner_host_id: spawnerHostId,
      event_id: event.event_id,
      primitive_name: event.primitive_name,
      primitive_kind: event.primitive_kind,
      state: event.state,
      prev_state: event.prev_state,
      event_timestamp: eventTs,
      payload: JSON.stringify(event.payload || {}) as unknown as Record<string, unknown>,
      received_at: new Date(),
    })

    const existingSpawn = await trx<DbSpawn>('spawns')
      .where({ spawner_host_id: spawnerHostId, primitive_name: event.primitive_name })
      .first()

    if (!existingSpawn) {
      await trx<DbSpawn>('spawns').insert({
        id: uuid(),
        spawner_host_id: spawnerHostId,
        primitive_name: event.primitive_name,
        primitive_kind: event.primitive_kind,
        state: event.state,
        prev_state: event.prev_state,
        last_event_id: event.event_id,
        last_event_at: eventTs,
        payload: JSON.stringify(event.payload || {}) as unknown as Record<string, unknown>,
      })
    } else {
      const existingTs = toDate(existingSpawn.last_event_at) ?? new Date(0)
      if (eventTs > existingTs) {
        await trx<DbSpawn>('spawns')
          .where({ id: existingSpawn.id })
          .update({
            primitive_kind: event.primitive_kind,
            state: event.state,
            prev_state: event.prev_state,
            last_event_id: event.event_id,
            last_event_at: eventTs,
            payload: JSON.stringify(event.payload || {}) as unknown as Record<string, unknown>,
            updated_at: new Date(),
          })
      }
    }

    await trx<DbSpawnerHost>('spawner_hosts')
      .where({ id: spawnerHostId })
      .update({
        last_seen_at: new Date(),
        last_event_at: new Date(),
        updated_at: new Date(),
      })

    // Side effect: when a developer-kind primitive transitions to
    // `destroyed`, flag the matching developer row so its slug can be
    // re-used and run history is preserved. We never delete developer
    // rows — the destroyed status is the audit signal.
    if (event.state === 'destroyed' && event.primitive_kind === 'developer') {
      await trx<DbDeveloper>('developers')
        .where({ name: event.primitive_name })
        .whereNot({ status: 'destroyed' })
        .update({ status: 'destroyed', updated_at: new Date() })
    }

    return { deduped: false, eventRowId }
  })
}

export const listSpawnsForHost = async (spawnerHostId: string): Promise<Spawn[]> => {
  const rows = await db<DbSpawn>('spawns')
    .where({ spawner_host_id: spawnerHostId })
    .orderBy('updated_at', 'desc')
  return rows.map(toSpawn)
}

export const getSpawn = async (
  spawnerHostId: string,
  primitiveName: string
): Promise<Spawn | null> => {
  const row = await db<DbSpawn>('spawns')
    .where({ spawner_host_id: spawnerHostId, primitive_name: primitiveName })
    .first()
  return row ? toSpawn(row) : null
}

// --- spawn_intents ---

const toIntent = (row: DbSpawnIntent): SpawnIntent => {
  const fallbackSpec: SpawnSpec = {
    name: row.primitive_name,
    kind: row.primitive_kind as SpawnIntent['primitiveKind'],
    image: row.image,
  }
  let spec: SpawnSpec = fallbackSpec
  if (row.spec) {
    if (typeof row.spec === 'string') {
      try {
        spec = JSON.parse(row.spec) as SpawnSpec
      } catch {
        spec = fallbackSpec
      }
    } else {
      spec = row.spec as unknown as SpawnSpec
    }
  }
  return {
    id: row.id,
    spawnerHostId: row.spawner_host_id,
    primitiveName: row.primitive_name,
    primitiveKind: row.primitive_kind as SpawnIntent['primitiveKind'],
    image: row.image,
    spec,
    status: row.status as SpawnIntentStatus,
    errorMessage: row.error_message,
    approvedAt: toDate(row.approved_at),
    cancelledAt: toDate(row.cancelled_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export const createSpawnIntent = async (
  spawnerHostId: string,
  spec: SpawnSpec
): Promise<SpawnIntent> => {
  const [row] = await db<DbSpawnIntent>('spawn_intents')
    .insert({
      id: uuid(),
      spawner_host_id: spawnerHostId,
      primitive_name: spec.name,
      primitive_kind: spec.kind,
      // image is now optional in the spec (kind-based local build); the
      // DB column is still NOT NULL, so synthesize a human-readable label
      // that makes it obvious in listings that this was a local build.
      image: spec.image ?? `local-build:${spec.kind}`,
      spec: JSON.stringify(spec) as unknown as Record<string, unknown>,
      status: 'pending',
    })
    .returning('*')
  return toIntent(row)
}

export const getSpawnIntent = async (id: string): Promise<SpawnIntent | null> => {
  const row = await db<DbSpawnIntent>('spawn_intents').where({ id }).first()
  return row ? toIntent(row) : null
}

export type IntentStatusQuery = SpawnIntentStatus

export const listSpawnIntentsForHost = async (
  spawnerHostId: string,
  status?: SpawnIntentStatus
): Promise<SpawnIntent[]> => {
  let q = db<DbSpawnIntent>('spawn_intents').where({ spawner_host_id: spawnerHostId })
  if (status) q = q.where({ status })
  const rows = await q.orderBy('created_at', 'desc')
  return rows.map(toIntent)
}

export const updateSpawnIntent = async (
  id: string,
  data: {
    status?: SpawnIntentStatus
    errorMessage?: string | null
    approvedAt?: Date | null
    cancelledAt?: Date | null
  }
): Promise<SpawnIntent | null> => {
  const update: Partial<DbSpawnIntent> = {}
  if (data.status !== undefined) update.status = data.status
  if (data.errorMessage !== undefined) update.error_message = data.errorMessage
  if (data.approvedAt !== undefined) update.approved_at = data.approvedAt
  if (data.cancelledAt !== undefined) update.cancelled_at = data.cancelledAt

  const [row] = await db<DbSpawnIntent>('spawn_intents')
    .where({ id })
    .update({ ...update, updated_at: new Date() })
    .returning('*')
  return row ? toIntent(row) : null
}
