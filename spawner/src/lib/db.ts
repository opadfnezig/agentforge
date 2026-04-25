import Database from 'better-sqlite3'
import { paths } from '../config.js'

let _db: Database.Database | null = null

export const db = (): Database.Database => {
  if (_db) return _db
  const conn = new Database(paths.spawnerDb)
  conn.pragma('journal_mode = WAL')
  conn.pragma('synchronous = NORMAL')
  conn.exec(`
    CREATE TABLE IF NOT EXISTS event_outbox (
      event_id        TEXT PRIMARY KEY,
      primitive_name  TEXT NOT NULL,
      primitive_kind  TEXT NOT NULL,
      state           TEXT NOT NULL,
      prev_state      TEXT,
      timestamp       TEXT NOT NULL,
      payload_json    TEXT NOT NULL,
      attempts        INTEGER NOT NULL DEFAULT 0,
      delivered       INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_error      TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_pending
      ON event_outbox(delivered, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_outbox_primitive
      ON event_outbox(primitive_name, timestamp);

    CREATE TABLE IF NOT EXISTS host_metadata (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
  _db = conn
  return conn
}

export interface OutboxRow {
  event_id: string
  primitive_name: string
  primitive_kind: string
  state: string
  prev_state: string | null
  timestamp: string
  payload_json: string
  attempts: number
  delivered: number
  next_attempt_at: string | null
  last_error: string | null
}

export const insertOutboxEvent = (row: {
  event_id: string
  primitive_name: string
  primitive_kind: string
  state: string
  prev_state: string | null
  timestamp: string
  payload: Record<string, unknown>
}): void => {
  db()
    .prepare(
      `INSERT INTO event_outbox
       (event_id, primitive_name, primitive_kind, state, prev_state, timestamp, payload_json, next_attempt_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    )
    .run(
      row.event_id,
      row.primitive_name,
      row.primitive_kind,
      row.state,
      row.prev_state,
      row.timestamp,
      JSON.stringify(row.payload)
    )
}

export const dueOutboxEvents = (limit = 50): OutboxRow[] => {
  return db()
    .prepare(
      `SELECT * FROM event_outbox
       WHERE delivered = 0
         AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now'))
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .all(limit) as OutboxRow[]
}

export const markDelivered = (eventId: string): void => {
  db()
    .prepare(
      `UPDATE event_outbox
       SET delivered = 1, updated_at = datetime('now'), last_error = NULL
       WHERE event_id = ?`
    )
    .run(eventId)
}

export const markFailedAttempt = (
  eventId: string,
  err: string,
  nextAttemptAt: Date | null
): void => {
  db()
    .prepare(
      `UPDATE event_outbox
       SET attempts = attempts + 1,
           last_error = ?,
           next_attempt_at = ?,
           updated_at = datetime('now')
       WHERE event_id = ?`
    )
    .run(err, nextAttemptAt ? nextAttemptAt.toISOString().replace('T', ' ').slice(0, 19) : null, eventId)
}

export const markDropped = (eventId: string, err: string): void => {
  db()
    .prepare(
      `UPDATE event_outbox
       SET delivered = 1,
           last_error = ?,
           updated_at = datetime('now')
       WHERE event_id = ?`
    )
    .run(`DROPPED: ${err}`, eventId)
}

export const getOutboxRow = (eventId: string): OutboxRow | undefined => {
  return db().prepare(`SELECT * FROM event_outbox WHERE event_id = ?`).get(eventId) as
    | OutboxRow
    | undefined
}

export const lifecycleHistory = (primitiveName: string): OutboxRow[] => {
  return db()
    .prepare(
      `SELECT * FROM event_outbox WHERE primitive_name = ? ORDER BY timestamp ASC`
    )
    .all(primitiveName) as OutboxRow[]
}

export const setHostMeta = (key: string, value: string): void => {
  db()
    .prepare(
      `INSERT INTO host_metadata (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, value)
}

export const getHostMeta = (key: string): string | null => {
  const row = db().prepare(`SELECT value FROM host_metadata WHERE key = ?`).get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}
