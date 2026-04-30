import { EventEmitter } from 'events'
import * as researcherQueries from '../db/queries/researchers.js'
import { ResearcherRunStatus } from '../schemas/researcher.js'
import { logger } from '../utils/logger.js'

export interface ResearcherWebSocket {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  on(event: string, listener: (...args: any[]) => void): void
}

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
      status: ResearcherRunStatus
      response?: string | null
      error_message?: string | null
    }
  | { type: 'heartbeat' }

export interface ResearcherDispatchMessage {
  type: 'dispatch'
  runId: string
  instructions: string
  resumeContext?: string | null
}

class ResearcherRegistry {
  private sockets = new Map<string, ResearcherWebSocket>()
  readonly events = new EventEmitter()

  constructor() {
    this.events.setMaxListeners(0)
  }

  async register(researcherId: string, ws: ResearcherWebSocket): Promise<void> {
    const existing = this.sockets.get(researcherId)
    if (existing && existing !== ws) {
      try { existing.close(4001, 'Superseded by new connection') } catch { /* ignore */ }
    }
    this.sockets.set(researcherId, ws)
    await researcherQueries.updateResearcher(researcherId, {
      status: 'idle',
      lastHeartbeat: new Date(),
    })
    logger.info({ researcherId }, 'Researcher registered')

    this.assignNextQueued(researcherId).catch((err) => {
      logger.error({ err, researcherId }, 'Queue drain on register failed')
    })
  }

  async assignNextQueued(researcherId: string): Promise<void> {
    const ws = this.sockets.get(researcherId)
    if (!ws || ws.readyState !== 1) return
    const researcher = await researcherQueries.getResearcher(researcherId)
    if (!researcher || researcher.status !== 'idle') return

    const next = await researcherQueries.getNextQueuedRun(researcherId)
    if (!next) return

    logger.info({ researcherId, runId: next.id }, 'Assigning queued run')
    this.dispatch(researcherId, next.id, next.instructions, next.resumeContext).catch(async (err) => {
      logger.error({ err, runId: next.id }, 'Queued dispatch failed')
      await researcherQueries.updateRun(next.id, {
        status: 'failure',
        errorMessage: err instanceof Error ? err.message : String(err),
        finishedAt: new Date(),
      })
    })
  }

  async unregister(researcherId: string): Promise<void> {
    this.sockets.delete(researcherId)
    await researcherQueries.updateResearcher(researcherId, { status: 'offline' })
    logger.info({ researcherId }, 'Researcher unregistered')
  }

  isOnline(researcherId: string): boolean {
    const ws = this.sockets.get(researcherId)
    if (!ws) return false
    return ws.readyState === 1
  }

  async dispatch(
    researcherId: string,
    runId: string,
    instructions: string,
    resumeContext?: string | null
  ): Promise<void> {
    const ws = this.sockets.get(researcherId)
    if (!ws || ws.readyState !== 1) {
      throw new Error(`Researcher ${researcherId} is not online`)
    }

    const message: ResearcherDispatchMessage = { type: 'dispatch', runId, instructions }
    if (resumeContext) message.resumeContext = resumeContext
    ws.send(JSON.stringify(message))
    logger.info({ researcherId, runId }, 'Dispatched research run')

    await researcherQueries.updateResearcher(researcherId, { status: 'busy' })
    await researcherQueries.updateRun(runId, {
      status: 'running',
      startedAt: new Date(),
    })

    return new Promise((resolve) => {
      const handler = () => {
        this.events.off(`complete:${runId}`, handler)
        resolve()
      }
      this.events.on(`complete:${runId}`, handler)
    })
  }

  async captureRunMetadataFromEvent(
    runId: string,
    eventType: string,
    data: Record<string, unknown>
  ): Promise<import('../schemas/researcher.js').ResearcherRun | null> {
    if (eventType === 'system' && pickString(data, 'subtype') === 'init') {
      const model = pickString(data, 'model')
      const sessionId = pickString(data, 'session_id')
      const provider = providerFromModel(model)
      if (model || sessionId) {
        return researcherQueries.updateRun(runId, {
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
      return researcherQueries.updateRun(runId, {
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

  async handleMessage(researcherId: string, raw: string | Buffer): Promise<void> {
    let msg: IncomingMessage
    try {
      msg = JSON.parse(raw.toString()) as IncomingMessage
    } catch (err) {
      logger.warn({ researcherId, err }, 'Invalid JSON from researcher')
      return
    }

    try {
      switch (msg.type) {
        case 'heartbeat': {
          await researcherQueries.updateResearcher(researcherId, {
            lastHeartbeat: new Date(),
          })
          break
        }
        case 'event': {
          const log = await researcherQueries.createLog(
            msg.runId,
            msg.event_type,
            msg.data || {}
          )
          this.events.emit(`log:${msg.runId}`, log)
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
          const updated = await researcherQueries.updateRun(msg.runId, {
            status: msg.status,
            response: msg.response ?? undefined,
            errorMessage: msg.error_message ?? undefined,
            finishedAt: isTerminal(msg.status) ? new Date() : undefined,
          })
          if (updated) {
            this.events.emit(`update:${msg.runId}`, updated)
            if (isTerminal(msg.status)) {
              await researcherQueries.updateResearcher(researcherId, { status: 'idle' })
              this.events.emit(`complete:${msg.runId}`, updated)
              this.assignNextQueued(researcherId).catch((err) => {
                logger.error({ err, researcherId }, 'Queue drain after complete failed')
              })
            }
          }
          break
        }
        default: {
          logger.warn({ researcherId, msg }, 'Unknown message type from researcher')
        }
      }
    } catch (err) {
      logger.error({ err, researcherId, msg }, 'Error handling researcher message')
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

const isTerminal = (status: ResearcherRunStatus): boolean =>
  status === 'success' ||
  status === 'failure' ||
  status === 'cancelled'

export const researcherRegistry = new ResearcherRegistry()
