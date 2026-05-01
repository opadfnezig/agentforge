import { EventEmitter } from 'events'
import { logger } from '../utils/logger.js'
import * as oracleQueries from '../db/queries/oracles.js'
import { OracleQueryStatus, OracleMode } from '../schemas/oracle.js'

/**
 * Minimal WebSocket shape we rely on. Matches both `ws.WebSocket` and the
 * browser WebSocket interface for the methods we actually use.
 */
export interface OracleWebSocket {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  on(event: string, listener: (...args: any[]) => void): void
}

interface IncomingRunUpdate {
  type: 'run_update'
  runId: string
  status: 'running' | 'success' | 'failure'
  response?: string | null
  error?: string | null
}

interface IncomingEvent {
  type: 'event'
  runId: string
  event_type: string
  data?: Record<string, unknown>
}

interface IncomingHeartbeat {
  type: 'heartbeat'
}

type IncomingMessage = IncomingRunUpdate | IncomingEvent | IncomingHeartbeat

interface DispatchMessage {
  type: 'dispatch'
  runId: string
  mode: OracleMode
  payload: string
  sessionId?: string | null
}

class OracleRegistry {
  private sockets = new Map<string, OracleWebSocket>()
  // Track oracle's current busy-state and the queryId in flight per oracle.
  private busy = new Map<string, string>()
  readonly events = new EventEmitter()

  constructor() {
    this.events.setMaxListeners(0)
  }

  async register(oracleId: string, ws: OracleWebSocket): Promise<void> {
    const existing = this.sockets.get(oracleId)
    if (existing && existing !== ws) {
      try { existing.close(4001, 'Superseded by new connection') } catch { /* ignore */ }
    }
    this.sockets.set(oracleId, ws)
    logger.info({ oracleId }, 'Oracle registered')
    // Drain any queued runs that arrived while offline.
    this.assignNextQueued(oracleId).catch((err) => {
      logger.error({ err, oracleId }, 'Queue drain on register failed')
    })
  }

  async unregister(oracleId: string, ws: OracleWebSocket): Promise<void> {
    if (this.sockets.get(oracleId) === ws) {
      this.sockets.delete(oracleId)
      logger.info({ oracleId }, 'Oracle unregistered')
    }
    // Mark any in-flight query as failed so callers/UI know the run died
    // with the connection.
    const inFlightQueryId = this.busy.get(oracleId)
    if (inFlightQueryId) {
      this.busy.delete(oracleId)
      const updated = await oracleQueries.updateOracleQuery(inFlightQueryId, {
        status: 'failure',
        errorMessage: 'Oracle disconnected before run completed',
        finishedAt: new Date(),
      })
      if (updated) {
        this.events.emit(`update:${inFlightQueryId}`, updated)
        this.events.emit(`complete:${inFlightQueryId}`, updated)
      }
    }
  }

  isOnline(oracleId: string): boolean {
    const ws = this.sockets.get(oracleId)
    return !!ws && ws.readyState === 1
  }

  isBusy(oracleId: string): boolean {
    return this.busy.has(oracleId)
  }

  /**
   * Pick the oldest queued query for this oracle and dispatch it if the
   * oracle is online and idle.
   */
  async assignNextQueued(oracleId: string): Promise<void> {
    if (!this.isOnline(oracleId) || this.isBusy(oracleId)) return
    const next = await oracleQueries.getNextQueuedOracleQuery(oracleId)
    if (!next) return

    // For chat queries, find the resume session id from prior turns in the
    // same chat. The worker passes this to claude --resume so the model
    // continues the conversation instead of starting cold.
    let resumeSessionId: string | null = null
    if (next.chatId) {
      resumeSessionId = await oracleQueries.getChatResumeSessionId(next.chatId)
    }

    logger.info({ oracleId, queryId: next.id, mode: next.mode, resumeSessionId }, 'Assigning queued oracle query')
    this.dispatch(oracleId, next.id, next.mode, next.message, resumeSessionId).catch(async (err) => {
      logger.error({ err, queryId: next.id }, 'Queued oracle dispatch failed')
      const updated = await oracleQueries.updateOracleQuery(next.id, {
        status: 'failure',
        errorMessage: err instanceof Error ? err.message : String(err),
        finishedAt: new Date(),
      })
      if (updated) {
        this.events.emit(`update:${updated.id}`, updated)
        this.events.emit(`complete:${updated.id}`, updated)
      }
      this.busy.delete(oracleId)
      // Try the next one in case this was a transient failure on a single
      // run rather than the oracle going down.
      this.assignNextQueued(oracleId).catch(() => { /* ignore */ })
    })
  }

  /**
   * Send the dispatch message to the oracle worker. Marks the oracle busy
   * and the query running. Resolves when terminal status is recorded
   * (success/failure/cancelled). Mirrors the developer registry contract.
   */
  async dispatch(
    oracleId: string,
    queryId: string,
    mode: OracleMode,
    message: string,
    sessionId?: string | null
  ): Promise<void> {
    const ws = this.sockets.get(oracleId)
    if (!ws || ws.readyState !== 1) {
      throw new Error(`Oracle ${oracleId} is not online`)
    }
    if (this.busy.has(oracleId)) {
      throw new Error(`Oracle ${oracleId} is busy with another query`)
    }

    this.busy.set(oracleId, queryId)
    const dispatchMsg: DispatchMessage = {
      type: 'dispatch',
      runId: queryId,
      mode,
      payload: message,
      sessionId: sessionId ?? null,
    }
    ws.send(JSON.stringify(dispatchMsg))
    logger.info({ oracleId, queryId, mode, sessionId }, 'Oracle dispatch sent')

    const updated = await oracleQueries.updateOracleQuery(queryId, {
      status: 'running',
      startedAt: new Date(),
    })
    if (updated) this.events.emit(`update:${queryId}`, updated)

    return new Promise((resolve) => {
      const handler = () => {
        this.events.off(`complete:${queryId}`, handler)
        resolve()
      }
      this.events.on(`complete:${queryId}`, handler)
    })
  }

  async captureMetadataFromEvent(
    queryId: string,
    eventType: string,
    data: Record<string, unknown>
  ): Promise<import('../schemas/oracle.js').OracleQuery | null> {
    if (eventType === 'system' && pickString(data, 'subtype') === 'init') {
      const model = pickString(data, 'model')
      const sessionId = pickString(data, 'session_id')
      const provider = providerFromModel(model)
      if (model || sessionId) {
        return oracleQueries.updateOracleQuery(queryId, {
          model: model ?? undefined,
          sessionId: sessionId ?? undefined,
          provider: provider ?? undefined,
        })
      }
    }
    if (eventType === 'result') {
      const trailer: Record<string, unknown> = {
        session_id: pickString(data, 'session_id'),
        duration_ms: pickNumber(data, 'duration_ms'),
        duration_api_ms: pickNumber(data, 'duration_api_ms'),
        stop_reason: pickString(data, 'stop_reason'),
        total_cost_usd: pickNumber(data, 'total_cost_usd'),
        num_turns: pickNumber(data, 'num_turns'),
        is_error: data['is_error'],
        usage: data['usage'],
      }
      for (const k of Object.keys(trailer)) {
        if (trailer[k] === undefined) delete trailer[k]
      }
      return oracleQueries.updateOracleQuery(queryId, {
        trailer,
        sessionId: (trailer.session_id as string | undefined) ?? undefined,
        durationApiMs: (trailer.duration_api_ms as number | undefined) ?? undefined,
        stopReason: (trailer.stop_reason as string | undefined) ?? undefined,
        totalCostUsd: (trailer.total_cost_usd as number | undefined) ?? undefined,
      })
    }
    return null
  }

  async handleMessage(oracleId: string, raw: string | Buffer): Promise<void> {
    let msg: IncomingMessage
    try {
      msg = JSON.parse(raw.toString()) as IncomingMessage
    } catch (err) {
      logger.warn({ oracleId, err }, 'Invalid JSON from oracle')
      return
    }

    try {
      switch (msg.type) {
        case 'heartbeat':
          return

        case 'event': {
          const log = await oracleQueries.createOracleLog(
            msg.runId,
            msg.event_type,
            msg.data || {}
          )
          this.events.emit(`log:${msg.runId}`, log)
          const updated = await this.captureMetadataFromEvent(
            msg.runId,
            msg.event_type,
            msg.data || {}
          )
          if (updated) this.events.emit(`update:${msg.runId}`, updated)
          return
        }

        case 'run_update': {
          if (msg.status === 'running') return
          const startedAtRow = await oracleQueries.getOracleQuery(msg.runId)
          const durationMs =
            startedAtRow?.startedAt
              ? Date.now() - new Date(startedAtRow.startedAt).getTime()
              : null
          const finalStatus: OracleQueryStatus =
            msg.status === 'success' ? 'success' : 'failure'
          const updated = await oracleQueries.updateOracleQuery(msg.runId, {
            status: finalStatus,
            response: msg.response ?? null,
            errorMessage: msg.status === 'failure' ? (msg.error || 'Oracle run failed') : null,
            finishedAt: new Date(),
            durationMs: durationMs ?? undefined,
          })
          if (updated) {
            this.events.emit(`update:${msg.runId}`, updated)
            this.events.emit(`complete:${msg.runId}`, updated)
          }
          this.busy.delete(oracleId)
          // Drain next queued query if any.
          this.assignNextQueued(oracleId).catch((err) => {
            logger.error({ err, oracleId }, 'Queue drain after complete failed')
          })
          return
        }

        default: {
          logger.warn({ oracleId, msg }, 'Unknown message type from oracle')
        }
      }
    } catch (err) {
      logger.error({ err, oracleId, msg }, 'Error handling oracle message')
    }
  }
}

const pickString = (o: Record<string, unknown>, k: string): string | undefined => {
  const v = o[k]
  return typeof v === 'string' ? v : undefined
}
const pickNumber = (o: Record<string, unknown>, k: string): number | undefined => {
  const v = o[k]
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

const providerFromModel = (model: string | undefined): string | undefined => {
  if (!model) return undefined
  if (/^claude[-_]/i.test(model)) return 'anthropic'
  return undefined
}

export const oracleRegistry = new OracleRegistry()
