import { EventEmitter } from 'events'
import { logger } from '../utils/logger.js'
import * as oracleQueries from '../db/queries/oracles.js'
import { v4 as uuid } from 'uuid'

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

export type OracleMode = 'read' | 'write' | 'migrate'

type OracleRunStatus = 'running' | 'success' | 'failure'

interface IncomingRunUpdate {
  type: 'run_update'
  runId: string
  status: OracleRunStatus
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
}

interface PendingRun {
  resolve: (value: { response: string; durationMs: number }) => void
  reject: (err: Error) => void
  startedAt: number
  oracleId: string
  mode: OracleMode
  message: string
}

class OracleRegistry {
  private sockets = new Map<string, OracleWebSocket>()
  private pending = new Map<string, PendingRun>()
  // Default per-run timeout (ms). The current in-process oracle runs
  // hold the request open while claude works; we mirror that by giving
  // each WS dispatch a generous deadline.
  private readonly runTimeoutMs = 5 * 60_000
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
  }

  async unregister(oracleId: string, ws: OracleWebSocket): Promise<void> {
    // Only remove if this socket is the currently-tracked one — a stale
    // close from a superseded socket must not evict the live one.
    if (this.sockets.get(oracleId) === ws) {
      this.sockets.delete(oracleId)
      logger.info({ oracleId }, 'Oracle unregistered')
    }
    // Reject any in-flight runs on this socket so callers don't hang.
    for (const [runId, p] of this.pending.entries()) {
      if (p.oracleId === oracleId) {
        this.pending.delete(runId)
        p.reject(new Error('Oracle disconnected before run completed'))
      }
    }
  }

  isOnline(oracleId: string): boolean {
    const ws = this.sockets.get(oracleId)
    return !!ws && ws.readyState === 1
  }

  /**
   * Dispatch a mode/payload to the oracle's WS and wait for the run_update
   * with terminal status. Returns the assistant response text.
   */
  async dispatch(
    oracleId: string,
    mode: OracleMode,
    message: string,
  ): Promise<{ response: string; durationMs: number }> {
    const ws = this.sockets.get(oracleId)
    if (!ws || ws.readyState !== 1) {
      throw new Error(`Oracle ${oracleId} is not online`)
    }

    const runId = uuid()
    const dispatchMsg: DispatchMessage = { type: 'dispatch', runId, mode, payload: message }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(runId)
        reject(new Error(`Oracle ${oracleId} run timed out after ${this.runTimeoutMs}ms`))
      }, this.runTimeoutMs)

      this.pending.set(runId, {
        oracleId,
        mode,
        message,
        startedAt: Date.now(),
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })

      try {
        ws.send(JSON.stringify(dispatchMsg))
        logger.info({ oracleId, runId, mode }, 'Oracle dispatch sent')
      } catch (err) {
        this.pending.delete(runId)
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  async handleMessage(oracleId: string, raw: string | Buffer): Promise<void> {
    let msg: IncomingMessage
    try {
      msg = JSON.parse(raw.toString()) as IncomingMessage
    } catch (err) {
      logger.warn({ oracleId, err }, 'Invalid JSON from oracle')
      return
    }

    switch (msg.type) {
      case 'heartbeat':
        return
      case 'event': {
        // Events are forwarded via the emitter for any subscribers (UI etc.).
        this.events.emit(`event:${msg.runId}`, msg)
        return
      }
      case 'run_update': {
        const pending = this.pending.get(msg.runId)
        if (!pending) {
          logger.warn({ oracleId, runId: msg.runId, status: msg.status }, 'Oracle run_update for unknown run')
          return
        }
        if (msg.status === 'running') return
        this.pending.delete(msg.runId)
        const durationMs = Date.now() - pending.startedAt
        if (msg.status === 'success') {
          const response = (msg.response ?? '').trim()
          // Only `read` runs persist queries — write/migrate are stateful
          // mutations of the oracle's memories, not Q&A history.
          if (pending.mode === 'read') {
            await safeRecordQuery(oracleId, pending.message, response, durationMs, 'completed')
          }
          pending.resolve({ response, durationMs })
        } else {
          if (pending.mode === 'read') {
            await safeRecordQuery(oracleId, pending.message, null, durationMs, 'error')
          }
          pending.reject(new Error(msg.error || 'Oracle run failed'))
        }
        return
      }
      default: {
        logger.warn({ oracleId, msg }, 'Unknown message type from oracle')
      }
    }
  }
}

const safeRecordQuery = async (
  oracleId: string,
  message: string,
  response: string | null,
  durationMs: number,
  status: string,
): Promise<void> => {
  try {
    await oracleQueries.createOracleQuery(oracleId, message, response, durationMs, status)
  } catch (err) {
    logger.warn({ oracleId, err }, 'Failed to record oracle query')
  }
}

export const oracleRegistry = new OracleRegistry()
