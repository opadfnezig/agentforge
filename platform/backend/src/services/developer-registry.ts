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
          break
        }
        case 'run_update': {
          const updated = await developerQueries.updateRun(msg.runId, {
            status: msg.status,
            gitShaStart: msg.git_sha_start ?? undefined,
            gitShaEnd: msg.git_sha_end ?? undefined,
            response: msg.response ?? undefined,
            errorMessage: msg.error ?? undefined,
            finishedAt: isTerminal(msg.status) ? new Date() : undefined,
          })
          if (updated) {
            this.events.emit(`update:${msg.runId}`, updated)
            if (isTerminal(msg.status)) {
              // Mark developer idle again
              await developerQueries.updateDeveloper(developerId, { status: 'idle' })
              this.events.emit(`complete:${msg.runId}`, updated)
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

const isTerminal = (status: RunStatus): boolean =>
  status === 'success' ||
  status === 'failure' ||
  status === 'cancelled' ||
  status === 'no_changes'

export const developerRegistry = new DeveloperRegistry()
