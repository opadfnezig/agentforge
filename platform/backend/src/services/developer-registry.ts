import { EventEmitter } from 'events'
import * as developerQueries from '../db/queries/developers.js'
import { RunMode, RunStatus } from '../schemas/developer.js'
import { logger } from '../utils/logger.js'

/**
 * Minimal WebSocket shape we rely on. Matches both `ws.WebSocket` and the
 * browser WebSocket interface for the methods we actually use.
 */
export interface DevWebSocket {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  on(event: string, listener: (...args: any[]) => void): void
}

/**
 * Incoming WS message types from developer worker.
 */
type IncomingMessage =
  | {
      type: 'event'
      runId: string
      event_type: string
      data?: Record<string, unknown>
    }
  | {
      type: 'run_update'
      runId: string
      status: RunStatus
      git_sha_start?: string | null
      git_sha_end?: string | null
      response?: string | null
      error?: string | null
      push_status?: 'pushed' | 'failed' | 'not_attempted' | null
      push_error?: string | null
    }
  | { type: 'heartbeat' }

/**
 * Outgoing dispatch message sent to developer worker.
 */
export interface DispatchMessage {
  type: 'dispatch'
  runId: string
  instructions: string
  mode: RunMode
}

/**
 * Events emitted on the registry's emitter, keyed by eventName:
 *   `log:<runId>`      -> DeveloperLog (new log event persisted)
 *   `update:<runId>`   -> DeveloperRun (run status changed)
 *   `complete:<runId>` -> DeveloperRun (terminal status reached)
 */
class DeveloperRegistry {
  private sockets = new Map<string, DevWebSocket>()
  readonly events = new EventEmitter()

  constructor() {
    // Prevent MaxListenersExceededWarning for busy runs with many SSE subscribers
    this.events.setMaxListeners(0)
  }

  /**
   * Register a connected developer. Updates DB status to 'idle' and stores the socket.
   * Also drains any queued (pending) runs for this developer.
   */
  async register(developerId: string, ws: DevWebSocket): Promise<void> {
    const existing = this.sockets.get(developerId)
    if (existing && existing !== ws) {
      try { existing.close(4001, 'Superseded by new connection') } catch { /* ignore */ }
    }
    this.sockets.set(developerId, ws)
    await developerQueries.updateDeveloper(developerId, {
      status: 'idle',
      lastHeartbeat: new Date(),
    })
    logger.info({ developerId }, 'Developer registered')

    // Drain any runs that were queued while the developer was offline.
    this.assignNextPending(developerId).catch((err) => {
      logger.error({ err, developerId }, 'Queue drain on register failed')
    })
  }

  /**
   * Try to dispatch the next pending (queued) run for a developer, if any.
   * Called on register and after each run completes. No-op if none queued
   * or the developer is not currently idle/online.
   */
  async assignNextPending(developerId: string): Promise<void> {
    const ws = this.sockets.get(developerId)
    if (!ws || ws.readyState !== 1) return
    const dev = await developerQueries.getDeveloper(developerId)
    if (!dev || dev.status !== 'idle') return

    const next = await developerQueries.getNextPendingRun(developerId)
    if (!next) return

    logger.info({ developerId, runId: next.id }, 'Assigning queued run')
    // Fire-and-forget; dispatch waits internally for completion.
    this.dispatch(developerId, next.id, next.instructions, next.mode).catch(async (err) => {
      logger.error({ err, runId: next.id }, 'Queued dispatch failed')
      await developerQueries.updateRun(next.id, {
        status: 'failure',
        errorMessage: err instanceof Error ? err.message : String(err),
        finishedAt: new Date(),
      })
    })
  }

  /**
   * Remove a developer from the registry and mark offline.
   */
  async unregister(developerId: string): Promise<void> {
    this.sockets.delete(developerId)
    await developerQueries.updateDeveloper(developerId, { status: 'offline' })
    logger.info({ developerId }, 'Developer unregistered')
  }

  isOnline(developerId: string): boolean {
    const ws = this.sockets.get(developerId)
    if (!ws) return false
    // ws.OPEN = 1
    return ws.readyState === 1
  }

  getSocket(developerId: string): DevWebSocket | undefined {
    return this.sockets.get(developerId)
  }

  /**
   * Dispatch a run to the developer. Returns a promise that resolves when the run
   * reaches a terminal status.
   */
  async dispatch(
    developerId: string,
    runId: string,
    instructions: string,
    mode: RunMode
  ): Promise<void> {
    const ws = this.sockets.get(developerId)
    if (!ws || ws.readyState !== 1) {
      throw new Error(`Developer ${developerId} is not online`)
    }

    const message: DispatchMessage = { type: 'dispatch', runId, instructions, mode }
    ws.send(JSON.stringify(message))
    logger.info({ developerId, runId, mode }, 'Dispatched run')

    // Mark developer busy, run running
    await developerQueries.updateDeveloper(developerId, { status: 'busy' })
    await developerQueries.updateRun(runId, {
      status: 'running',
      startedAt: new Date(),
    })

    // Wait for terminal status
    return new Promise((resolve) => {
      const handler = () => {
        this.events.off(`complete:${runId}`, handler)
        resolve()
      }
      this.events.on(`complete:${runId}`, handler)
    })
  }

  /**
   * Extract provider/model (from system/init) or the session trailer
   * (from result) on an incoming event and persist to the run row.
   * Returns the updated DeveloperRun if fields were written, null otherwise.
   */
  async captureRunMetadataFromEvent(
    runId: string,
    eventType: string,
    data: Record<string, unknown>
  ): Promise<import('../schemas/developer.js').DeveloperRun | null> {
    if (eventType === 'system' && pickString(data, 'subtype') === 'init') {
      const model = pickString(data, 'model')
      const sessionId = pickString(data, 'session_id')
      const provider = providerFromModel(model)
      if (model || sessionId) {
        return developerQueries.updateRun(runId, {
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
        fast_mode_state: data['fast_mode_state'],
        terminal_reason: pickString(data, 'terminal_reason'),
        api_error_status: data['api_error_status'],
        permission_denials: data['permission_denials'],
        num_turns: pickNumber(data, 'num_turns'),
        is_error: data['is_error'],
        usage: data['usage'],
      }
      for (const k of Object.keys(trailer)) {
        if (trailer[k] === undefined) delete trailer[k]
      }
      return developerQueries.updateRun(runId, {
        trailer,
        sessionId: (trailer.session_id as string | undefined) ?? undefined,
        durationMs: (trailer.duration_ms as number | undefined) ?? undefined,
        durationApiMs: (trailer.duration_api_ms as number | undefined) ?? undefined,
        stopReason: (trailer.stop_reason as string | undefined) ?? undefined,
        totalCostUsd: (trailer.total_cost_usd as number | undefined) ?? undefined,
      })
    }
    return null
  }

  /**
   * Handle a raw incoming WS message from a developer worker.
   */
  async handleMessage(developerId: string, raw: string | Buffer): Promise<void> {
    let msg: IncomingMessage
    try {
      msg = JSON.parse(raw.toString()) as IncomingMessage
    } catch (err) {
      logger.warn({ developerId, err }, 'Invalid JSON from developer')
      return
    }

    try {
      switch (msg.type) {
        case 'heartbeat': {
          await developerQueries.updateDeveloper(developerId, {
            lastHeartbeat: new Date(),
          })
          break
        }
        case 'event': {
          const log = await developerQueries.createLog(
            msg.runId,
            msg.event_type,
            msg.data || {}
          )
          this.events.emit(`log:${msg.runId}`, log)
          // Capture provider/model from Claude 'system/init' event, and
          // session/cost/duration trailer from 'result' event.
          const updated = await this.captureRunMetadataFromEvent(
            msg.runId,
            msg.event_type,
            msg.data || {}
          )
          if (updated) {
            this.events.emit(`update:${msg.runId}`, updated)
          }
          break
        }
        case 'run_update': {
          const updated = await developerQueries.updateRun(msg.runId, {
            status: msg.status,
            gitShaStart: msg.git_sha_start ?? undefined,
            gitShaEnd: msg.git_sha_end ?? undefined,
            response: msg.response ?? undefined,
            errorMessage: msg.error ?? undefined,
            pushStatus: msg.push_status ?? undefined,
            pushError: msg.push_error ?? undefined,
            finishedAt: isTerminal(msg.status) ? new Date() : undefined,
          })
          if (updated) {
            this.events.emit(`update:${msg.runId}`, updated)
            if (isTerminal(msg.status)) {
              // Mark developer idle again
              await developerQueries.updateDeveloper(developerId, { status: 'idle' })
              this.events.emit(`complete:${msg.runId}`, updated)
              // Drain next queued run if any
              this.assignNextPending(developerId).catch((err) => {
                logger.error({ err, developerId }, 'Queue drain after complete failed')
              })
            }
          }
          break
        }
        default: {
          logger.warn({ developerId, msg }, 'Unknown message type from developer')
        }
      }
    } catch (err) {
      logger.error({ err, developerId, msg }, 'Error handling developer message')
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

// Derive provider from a Claude model id. Anthropic SDK emits ids like
// "claude-opus-4-7-20251001"; treat any "claude-*" as provider=anthropic.
const providerFromModel = (model: string | undefined): string | undefined => {
  if (!model) return undefined
  if (/^claude[-_]/i.test(model)) return 'anthropic'
  return undefined
}

const isTerminal = (status: RunStatus): boolean =>
  status === 'success' ||
  status === 'failure' ||
  status === 'cancelled' ||
  status === 'no_changes'

export const developerRegistry = new DeveloperRegistry()
