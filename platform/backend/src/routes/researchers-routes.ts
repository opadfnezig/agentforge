import { Router } from 'express'
import type { Request, Response, Application } from 'express'
import {
  createResearcherSchema,
  updateResearcherSchema,
  researcherDispatchSchema,
  editResearcherRunInstructionsSchema,
} from '../schemas/researcher.js'
import * as researcherQueries from '../db/queries/researchers.js'
import { researcherRegistry } from '../services/researcher-registry.js'
import { AppError } from '../utils/error-handler.js'
import { logger } from '../utils/logger.js'

export const researchersRouter = Router()

// ---------------------------------------------------------------------------
// WebSocket: researcher worker connects here
// ---------------------------------------------------------------------------
export const registerResearcherWs = (app: Application & { ws?: Function }) => {
  if (typeof app.ws !== 'function') {
    throw new Error('app.ws is not a function — express-ws must be applied to the app')
  }
  app.ws('/api/researchers/connect/:id', async (ws: any, req: Request) => {
    const researcherId = req.params.id
    const secret = (req.query.secret as string | undefined) || ''

    try {
      const researcher = await researcherQueries.getResearcher(researcherId)
      if (!researcher) {
        ws.close(4004, 'Researcher not found')
        return
      }
      if (!secret || secret !== researcher.secret) {
        ws.close(4003, 'Invalid secret')
        return
      }

      await researcherRegistry.register(researcherId, ws as any)

      ws.on('message', (data: Buffer) => {
        researcherRegistry.handleMessage(researcherId, data).catch((err) => {
          logger.error({ err, researcherId }, 'handleMessage failed')
        })
      })

      ws.on('close', () => {
        researcherRegistry.unregister(researcherId).catch((err) => {
          logger.error({ err, researcherId }, 'unregister failed')
        })
      })

      ws.on('error', (err: Error) => {
        logger.warn({ err, researcherId }, 'Researcher WS error')
      })
    } catch (err) {
      logger.error({ err, researcherId }, 'WS connect error')
      try { ws.close(1011, 'Server error') } catch { /* ignore */ }
    }
  })
}

// ---------------------------------------------------------------------------
// HTTP endpoints
// ---------------------------------------------------------------------------

const serialize = (r: Awaited<ReturnType<typeof researcherQueries.getResearcher>>) => {
  if (!r) return null
  const { secret: _s, ...rest } = r
  return {
    ...rest,
    online: researcherRegistry.isOnline(r.id),
  }
}

researchersRouter.get('/', async (_req, res, next) => {
  try {
    const researchers = await researcherQueries.listResearchers()
    res.json(researchers.map((r) => serialize(r)))
  } catch (error) {
    next(error)
  }
})

researchersRouter.post('/', async (req, res, next) => {
  try {
    const data = createResearcherSchema.parse(req.body)
    const researcher = await researcherQueries.createResearcher(data)
    logger.info({ researcherId: researcher.id, name: researcher.name }, 'Researcher created')
    res.status(201).json({ ...researcher, online: false })
  } catch (error) {
    next(error)
  }
})

researchersRouter.get('/:id', async (req, res, next) => {
  try {
    const researcher = await researcherQueries.getResearcher(req.params.id)
    if (!researcher) {
      throw new AppError(404, 'Researcher not found', 'RESEARCHER_NOT_FOUND')
    }
    res.json(serialize(researcher))
  } catch (error) {
    next(error)
  }
})

researchersRouter.patch('/:id', async (req, res, next) => {
  try {
    const data = updateResearcherSchema.parse(req.body)
    const researcher = await researcherQueries.updateResearcher(req.params.id, data)
    if (!researcher) {
      throw new AppError(404, 'Researcher not found', 'RESEARCHER_NOT_FOUND')
    }
    logger.info({ researcherId: researcher.id }, 'Researcher updated')
    res.json(serialize(researcher))
  } catch (error) {
    next(error)
  }
})

researchersRouter.delete('/:id', async (req, res, next) => {
  try {
    const deleted = await researcherQueries.deleteResearcher(req.params.id)
    if (!deleted) {
      throw new AppError(404, 'Researcher not found', 'RESEARCHER_NOT_FOUND')
    }
    logger.info({ researcherId: req.params.id }, 'Researcher deleted')
    res.status(204).send()
  } catch (error) {
    next(error)
  }
})

researchersRouter.get('/:id/secret', async (req, res, next) => {
  try {
    const existing = await researcherQueries.getResearcher(req.params.id)
    if (!existing) {
      throw new AppError(404, 'Researcher not found', 'RESEARCHER_NOT_FOUND')
    }
    const secret = researcherQueries.generateSecret()
    await researcherQueries.updateResearcher(req.params.id, { secret })
    logger.info({ researcherId: req.params.id }, 'Researcher secret regenerated')
    res.json({ id: req.params.id, secret })
  } catch (error) {
    next(error)
  }
})

researchersRouter.post('/:id/dispatch', async (req, res, next) => {
  try {
    const { instructions, autoApprove } = researcherDispatchSchema.parse(req.body)
    const researcher = await researcherQueries.getResearcher(req.params.id)
    if (!researcher) {
      throw new AppError(404, 'Researcher not found', 'RESEARCHER_NOT_FOUND')
    }

    const shouldApprove = autoApprove !== false
    const initialStatus = shouldApprove ? 'queued' : 'pending'
    const run = await researcherQueries.createRun(researcher.id, instructions, initialStatus)

    const online = researcherRegistry.isOnline(researcher.id)
    const idle = online && researcher.status === 'idle'

    if (shouldApprove && idle) {
      researcherRegistry
        .dispatch(researcher.id, run.id, instructions)
        .catch(async (err) => {
          logger.error({ err, runId: run.id }, 'Dispatch failed')
          await researcherQueries.updateRun(run.id, {
            status: 'failure',
            errorMessage: err instanceof Error ? err.message : String(err),
            finishedAt: new Date(),
          })
        })
    } else {
      logger.info(
        { researcherId: researcher.id, runId: run.id, online, status: researcher.status, pending: !shouldApprove },
        shouldApprove ? 'Dispatch queued (researcher not idle)' : 'Dispatch awaiting approval'
      )
    }

    res.status(202).json({
      runId: run.id,
      status: run.status,
      queued: shouldApprove && !idle,
      pending: !shouldApprove,
    })
  } catch (error) {
    next(error)
  }
})

researchersRouter.get('/:id/queue', async (req, res, next) => {
  try {
    const researcher = await researcherQueries.getResearcher(req.params.id)
    if (!researcher) {
      throw new AppError(404, 'Researcher not found', 'RESEARCHER_NOT_FOUND')
    }
    const queued = await researcherQueries.listQueuedRuns(researcher.id)
    res.json(queued)
  } catch (error) {
    next(error)
  }
})

researchersRouter.post('/:id/runs/:runId/approve', async (req, res, next) => {
  try {
    const run = await researcherQueries.getRun(req.params.runId)
    if (!run || run.researcherId !== req.params.id) {
      throw new AppError(404, 'Run not found', 'RUN_NOT_FOUND')
    }
    if (run.status !== 'pending') {
      throw new AppError(409, `Run is ${run.status}, cannot approve`, 'RUN_NOT_PENDING')
    }
    const updated = await researcherQueries.updateRun(run.id, { status: 'queued' })
    if (updated) researcherRegistry.events.emit(`update:${run.id}`, updated)
    logger.info({ researcherId: req.params.id, runId: run.id }, 'Run approved')
    researcherRegistry.assignNextQueued(req.params.id).catch((err) => {
      logger.error({ err, researcherId: req.params.id }, 'Queue drain after approve failed')
    })
    res.json(updated)
  } catch (error) {
    next(error)
  }
})

researchersRouter.post('/:id/runs/:runId/cancel', async (req, res, next) => {
  try {
    const run = await researcherQueries.getRun(req.params.runId)
    if (!run || run.researcherId !== req.params.id) {
      throw new AppError(404, 'Run not found', 'RUN_NOT_FOUND')
    }
    if (run.status !== 'pending' && run.status !== 'queued') {
      throw new AppError(409, `Run is ${run.status}, cannot cancel`, 'RUN_NOT_CANCELLABLE')
    }
    const updated = await researcherQueries.updateRun(run.id, {
      status: 'cancelled',
      finishedAt: new Date(),
    })
    if (updated) {
      researcherRegistry.events.emit(`update:${run.id}`, updated)
      researcherRegistry.events.emit(`complete:${run.id}`, updated)
    }
    logger.info({ researcherId: req.params.id, runId: run.id }, 'Run cancelled')
    res.json(updated)
  } catch (error) {
    next(error)
  }
})

const dispatchRetryOrContinue = async (
  req: Request,
  res: Response,
  next: (err: unknown) => void,
  withResumeContext: boolean
): Promise<void> => {
  try {
    const source = await researcherQueries.getRun(req.params.runId)
    if (!source || source.researcherId !== req.params.id) {
      throw new AppError(404, 'Run not found', 'RUN_NOT_FOUND')
    }
    if (source.status !== 'failure') {
      throw new AppError(400, `Run is ${source.status}, only failed runs can be retried`, 'RUN_NOT_FAILED')
    }
    const activeChild = await researcherQueries.findActiveChildRun(source.id)
    if (activeChild) {
      throw new AppError(409, `A retry is already ${activeChild.status} (run ${activeChild.id})`, 'RETRY_ALREADY_IN_FLIGHT')
    }

    let resumeContext: string | null = null
    if (withResumeContext) {
      const lastAssistant = await researcherQueries.getLastAssistantText(source.id)
      resumeContext = [
        'Previous run failed.',
        `stop_reason: ${source.stopReason || 'unknown'}`,
        `error: ${source.errorMessage || 'none captured'}`,
        'last assistant message:',
        lastAssistant && lastAssistant.length > 0 ? lastAssistant : 'none captured',
      ].join('\n')
    }

    const child = await researcherQueries.createRun(
      source.researcherId,
      source.instructions,
      'queued',
      { resumeContext, parentRunId: source.id }
    )

    logger.info({
      researcherId: source.researcherId,
      sourceRunId: source.id,
      childRunId: child.id,
      kind: withResumeContext ? 'continue' : 'retry',
    }, 'Run retry/continue created')

    researcherRegistry.assignNextQueued(source.researcherId).catch((err) => {
      logger.error({ err, researcherId: source.researcherId }, 'Queue drain after retry/continue failed')
    })

    res.status(202).json(child)
  } catch (error) {
    next(error)
  }
}

researchersRouter.post('/:id/runs/:runId/retry', (req, res, next) =>
  dispatchRetryOrContinue(req, res, next, false)
)
researchersRouter.post('/:id/runs/:runId/continue', (req, res, next) =>
  dispatchRetryOrContinue(req, res, next, true)
)

researchersRouter.patch('/:id/runs/:runId', async (req, res, next) => {
  try {
    const { instructions } = editResearcherRunInstructionsSchema.parse(req.body)
    const run = await researcherQueries.getRun(req.params.runId)
    if (!run || run.researcherId !== req.params.id) {
      throw new AppError(404, 'Run not found', 'RUN_NOT_FOUND')
    }
    if (run.status !== 'pending') {
      throw new AppError(409, `Run is ${run.status}, instructions are immutable`, 'RUN_NOT_EDITABLE')
    }
    const updated = await researcherQueries.updateRunInstructions(run.id, instructions)
    if (updated) researcherRegistry.events.emit(`update:${run.id}`, updated)
    logger.info({ researcherId: req.params.id, runId: run.id }, 'Run instructions edited')
    res.json(updated)
  } catch (error) {
    next(error)
  }
})

researchersRouter.get('/:id/runs', async (req, res, next) => {
  try {
    const researcher = await researcherQueries.getResearcher(req.params.id)
    if (!researcher) {
      throw new AppError(404, 'Researcher not found', 'RESEARCHER_NOT_FOUND')
    }
    const runs = await researcherQueries.listRuns(researcher.id)
    res.json(runs)
  } catch (error) {
    next(error)
  }
})

researchersRouter.get('/:id/runs/:runId', async (req, res, next) => {
  try {
    const run = await researcherQueries.getRun(req.params.runId)
    if (!run || run.researcherId !== req.params.id) {
      throw new AppError(404, 'Run not found', 'RUN_NOT_FOUND')
    }
    res.json(run)
  } catch (error) {
    next(error)
  }
})

researchersRouter.get('/:id/runs/:runId/logs', async (req, res, next) => {
  try {
    const run = await researcherQueries.getRun(req.params.runId)
    if (!run || run.researcherId !== req.params.id) {
      throw new AppError(404, 'Run not found', 'RUN_NOT_FOUND')
    }
    const logs = await researcherQueries.listLogs(run.id)
    res.json(logs)
  } catch (error) {
    next(error)
  }
})

researchersRouter.get('/:id/runs/:runId/stream', async (req: Request, res: Response, next) => {
  try {
    const run = await researcherQueries.getRun(req.params.runId)
    if (!run || run.researcherId !== req.params.id) {
      throw new AppError(404, 'Run not found', 'RUN_NOT_FOUND')
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders?.()

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`)
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    }

    const existing = await researcherQueries.listLogs(run.id)
    for (const log of existing) send('log', log)
    send('run', run)

    const logHandler = (log: unknown) => send('log', log)
    const updateHandler = (r: unknown) => send('run', r)
    const completeHandler = (r: unknown) => {
      send('run', r)
      send('complete', { runId: run.id })
      cleanup()
      res.end()
    }
    const cleanup = () => {
      researcherRegistry.events.off(`log:${run.id}`, logHandler)
      researcherRegistry.events.off(`update:${run.id}`, updateHandler)
      researcherRegistry.events.off(`complete:${run.id}`, completeHandler)
    }

    researcherRegistry.events.on(`log:${run.id}`, logHandler)
    researcherRegistry.events.on(`update:${run.id}`, updateHandler)
    researcherRegistry.events.on(`complete:${run.id}`, completeHandler)

    req.on('close', () => { cleanup() })

    if (run.status === 'success' || run.status === 'failure' || run.status === 'cancelled') {
      send('complete', { runId: run.id })
      cleanup()
      res.end()
    }
  } catch (error) {
    next(error)
  }
})
