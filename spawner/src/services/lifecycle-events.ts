import { v4 as uuidv4 } from 'uuid'
import { config } from '../config.js'
import { logger } from '../lib/logger.js'
import {
  insertOutboxEvent,
  dueOutboxEvents,
  markDelivered,
  markFailedAttempt,
  markDropped,
  OutboxRow,
} from '../lib/db.js'
import { transition } from './primitive-state.js'
import { LifecycleEvent, PrimitiveState, PrimitiveKind } from '../lib/types.js'

const lastEventByPrimitive = new Map<string, { id: string; at: string }>()

/**
 * Record a state transition: write state.json + insert outbox event. The
 * delivery loop picks it up asynchronously. Returns the event id.
 */
export const recordTransition = async (
  name: string,
  next: PrimitiveState,
  payload: Record<string, unknown> = {},
  patchExtra: Record<string, unknown> = {}
): Promise<string | null> => {
  const eventId = uuidv4()
  const timestamp = new Date().toISOString()

  const result = await transition(name, next, {
    ...patchExtra,
    last_event_at: timestamp,
    last_event_id: eventId,
  })
  if (!result) return null

  insertOutboxEvent({
    event_id: eventId,
    primitive_name: name,
    primitive_kind: result.state.kind,
    state: next,
    prev_state: result.from,
    timestamp,
    payload: {
      ...payload,
      image: result.state.image,
      container_id: result.state.container_id,
    },
  })

  lastEventByPrimitive.set(name, { id: eventId, at: timestamp })
  logger.info('lifecycle transition', { name, from: result.from, to: next, event_id: eventId })
  return eventId
}

/**
 * For internal cases where we want to enqueue an event without touching
 * state.json (e.g. orphan recovery flips state directly via transition()).
 */
export const enqueueEvent = (
  name: string,
  kind: PrimitiveKind,
  state: PrimitiveState,
  prevState: PrimitiveState | null,
  payload: Record<string, unknown> = {}
): string => {
  const eventId = uuidv4()
  const timestamp = new Date().toISOString()
  insertOutboxEvent({
    event_id: eventId,
    primitive_name: name,
    primitive_kind: kind,
    state,
    prev_state: prevState,
    timestamp,
    payload,
  })
  lastEventByPrimitive.set(name, { id: eventId, at: timestamp })
  return eventId
}

const buildPayload = (row: OutboxRow): LifecycleEvent => ({
  event_id: row.event_id,
  primitive_name: row.primitive_name,
  primitive_kind: row.primitive_kind,
  state: row.state as PrimitiveState,
  prev_state: (row.prev_state as PrimitiveState | null) ?? null,
  timestamp: row.timestamp,
  host_id: config.NTFR_HOST_ID,
  payload: JSON.parse(row.payload_json),
})

const deliverOne = async (row: OutboxRow): Promise<boolean> => {
  if (!config.NTFR_SERVER_URL) {
    // No server configured — best-effort drop with explanatory error.
    markDropped(row.event_id, 'NTFR_SERVER_URL not set')
    logger.warn('Dropping lifecycle event: NTFR_SERVER_URL not set', {
      event_id: row.event_id,
      primitive: row.primitive_name,
    })
    return false
  }

  const url = `${config.NTFR_SERVER_URL.replace(/\/+$/, '')}/spawners/${encodeURIComponent(
    config.NTFR_HOST_ID
  )}/events`
  const body = JSON.stringify(buildPayload(row))

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    if (res.ok) {
      markDelivered(row.event_id)
      logger.debug('lifecycle event delivered', { event_id: row.event_id })
      return true
    }
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
  } catch (err) {
    return handleFailure(row, err)
  }
}

const handleFailure = (row: OutboxRow, err: unknown): boolean => {
  const errMsg = err instanceof Error ? err.message : String(err)
  const nextAttempts = row.attempts + 1
  if (nextAttempts >= config.NTFR_LIFECYCLE_RETRY_MAX) {
    markDropped(row.event_id, errMsg)
    logger.error('Lifecycle event dropped after retry exhaustion', {
      event_id: row.event_id,
      primitive: row.primitive_name,
      state: row.state,
      attempts: nextAttempts,
      last_error: errMsg,
    })
    return false
  }
  // Exponential backoff: base * 2^attempts
  const delayMs =
    config.NTFR_LIFECYCLE_RETRY_BACKOFF_MS * Math.pow(2, nextAttempts - 1)
  const next = new Date(Date.now() + delayMs)
  markFailedAttempt(row.event_id, errMsg, next)
  logger.warn('lifecycle event retry scheduled', {
    event_id: row.event_id,
    attempts: nextAttempts,
    next_attempt_at: next.toISOString(),
    error: errMsg,
  })
  return false
}

let deliveryLoopHandle: NodeJS.Timeout | null = null

export const startLifecycleDelivery = (intervalMs = 1000): void => {
  if (deliveryLoopHandle) return
  const tick = async () => {
    try {
      const due = dueOutboxEvents(50)
      for (const row of due) await deliverOne(row)
    } catch (err) {
      logger.error('Lifecycle delivery loop tick failed', { err: String(err) })
    }
  }
  deliveryLoopHandle = setInterval(tick, intervalMs)
  // Kick once immediately so events queued while server was down get retried fast
  void tick()
  logger.info('Lifecycle delivery loop started', { intervalMs })
}

export const stopLifecycleDelivery = (): void => {
  if (deliveryLoopHandle) {
    clearInterval(deliveryLoopHandle)
    deliveryLoopHandle = null
  }
}
