import { Router } from 'express'
import type { Request, Response, Application } from 'express'
import {
  createDeveloperSchema,
  updateDeveloperSchema,
  dispatchSchema,
} from '../schemas/developer.js'
import * as developerQueries from '../db/queries/developers.js'
import { developerRegistry } from '../services/developer-registry.js'
import { AppError } from '../utils/error-handler.js'
import { logger } from '../utils/logger.js'

export const developersRouter = Router()

// ---------------------------------------------------------------------------
// WebSocket: developer worker connects here
// Registered directly on the app in index.ts since express-ws requires
// the app-level instance to be applied to the router.
// ---------------------------------------------------------------------------
export const registerDeveloperWs = (app: Application & { ws?: Function }) => {
  if (typeof app.ws !== 'function') {
    throw new Error('app.ws is not a function — express-ws must be applied to the app')
  }
  app.ws('/api/developers/connect/:id', async (ws: any, req: Request) => {
    const developerId = req.params.id
    const secret = (req.query.secret as string | undefined) || ''

    try {
      const developer = await developerQueries.getDeveloper(developerId)
      if (!developer) {
        ws.close(4004, 'Developer not found')
        return
      }
      if (!secret || secret !== developer.secret) {
        ws.close(4003, 'Invalid secret')
        return
      }

      await developerRegistry.register(developerId, ws as any)

      ws.on('message', (data: Buffer) => {
        developerRegistry.handleMessage(developerId, data).catch((err) => {
          logger.error({ err, developerId }, 'handleMessage failed')
        })
      })

      ws.on('close', () => {
        developerRegistry.unregister(developerId).catch((err) => {
          logger.error({ err, developerId }, 'unregister failed')
        })
      })

      ws.on('error', (err: Error) => {
        logger.warn({ err, developerId }, 'Developer WS error')
      })
    } catch (err) {
      logger.error({ err, developerId }, 'WS connect error')
      try { ws.close(1011, 'Server error') } catch { /* ignore */ }
    }
  })
}

// ---------------------------------------------------------------------------
// HTTP endpoints
// ---------------------------------------------------------------------------

// Strip secret from responses by default; secret is only returned on POST / and /:id/secret
const serialize = (dev: Awaited<ReturnType<typeof developerQueries.getDeveloper>>) => {
  if (!dev) return null
  const { secret: _s, ...rest } = dev
  return {
    ...rest,
    online: developerRegistry.isOnline(dev.id),
  }
}

// List developers
developersRouter.get('/', async (_req, res, next) => {
  try {
    const developers = await developerQueries.listDevelopers()
    res.json(developers.map((d) => serialize(d)))
  } catch (error) {
    next(error)
  }
})

// Create developer (secret returned ONCE)
developersRouter.post('/', async (req, res, next) => {
  try {
    const data = createDeveloperSchema.parse(req.body)
    const developer = await developerQueries.createDeveloper(data)
    logger.info({ developerId: developer.id, name: developer.name }, 'Developer created')
    // Return full record (including secret) exactly once.
    res.status(201).json({
      ...developer,
      online: false,
    })
  } catch (error) {
    next(error)
  }
})

// Get developer
developersRouter.get('/:id', async (req, res, next) => {
  try {
    const developer = await developerQueries.getDeveloper(req.params.id)
    if (!developer) {
      throw new AppError(404, 'Developer not found', 'DEVELOPER_NOT_FOUND')
    }
    res.json(serialize(developer))
  } catch (error) {
    next(error)
  }
})

// Update developer
developersRouter.patch('/:id', async (req, res, next) => {
  try {
    const data = updateDeveloperSchema.parse(req.body)
    const developer = await developerQueries.updateDeveloper(req.params.id, data)
    if (!developer) {
      throw new AppError(404, 'Developer not found', 'DEVELOPER_NOT_FOUND')
    }
    logger.info({ developerId: developer.id }, 'Developer updated')
    res.json(serialize(developer))
  } catch (error) {
    next(error)
  }
})

// Delete developer
developersRouter.delete('/:id', async (req, res, next) => {
  try {
    const deleted = await developerQueries.deleteDeveloper(req.params.id)
    if (!deleted) {
      throw new AppError(404, 'Developer not found', 'DEVELOPER_NOT_FOUND')
    }
    logger.info({ developerId: req.params.id }, 'Developer deleted')
    res.status(204).send()
  } catch (error) {
    next(error)
  }
})

// Regenerate secret (returns the new secret ONCE)
developersRouter.get('/:id/secret', async (req, res, next) => {
  try {
    const existing = await developerQueries.getDeveloper(req.params.id)
    if (!existing) {
      throw new AppError(404, 'Developer not found', 'DEVELOPER_NOT_FOUND')
    }
    const secret = developerQueries.generateSecret()
    await developerQueries.updateDeveloper(req.params.id, { secret })
    logger.info({ developerId: req.params.id }, 'Developer secret regenerated')
    res.json({ id: req.params.id, secret })
  } catch (error) {
    next(error)
  }
})

// Dispatch a run (fire-and-forget; returns runId immediately)
developersRouter.post('/:id/dispatch', async (req, res, next) => {
  try {
    const { instructions, mode } = dispatchSchema.parse(req.body)
    const developer = await developerQueries.getDeveloper(req.params.id)
    if (!developer) {
      throw new AppError(404, 'Developer not found', 'DEVELOPER_NOT_FOUND')
    }
    if (!developerRegistry.isOnline(developer.id)) {
      throw new AppError(409, 'Developer is not online', 'DEVELOPER_OFFLINE')
    }

    const finalMode = mode || 'implement'
    const run = await developerQueries.createRun(developer.id, instructions, finalMode)

    // Dispatch in background; resolution handled via registry events
    developerRegistry
      .dispatch(developer.id, run.id, instructions, finalMode)
      .catch(async (err) => {
        logger.error({ err, runId: run.id }, 'Dispatch failed')
        await developerQueries.updateRun(run.id, {
          status: 'failure',
          errorMessage: err instanceof Error ? err.message : String(err),
          finishedAt: new Date(),
        })
      })

    res.status(202).json({ runId: run.id, status: run.status, mode: run.mode })
  } catch (error) {
    next(error)
  }
})

// List runs
developersRouter.get('/:id/runs', async (req, res, next) => {
  try {
    const developer = await developerQueries.getDeveloper(req.params.id)
    if (!developer) {
      throw new AppError(404, 'Developer not found', 'DEVELOPER_NOT_FOUND')
    }
    const runs = await developerQueries.listRuns(developer.id)
    res.json(runs)
  } catch (error) {
    next(error)
  }
})

// Get single run
developersRouter.get('/:id/runs/:runId', async (req, res, next) => {
  try {
    const run = await developerQueries.getRun(req.params.runId)
    if (!run || run.developerId !== req.params.id) {
      throw new AppError(404, 'Run not found', 'RUN_NOT_FOUND')
    }
    res.json(run)
  } catch (error) {
    next(error)
  }
})

// List logs for a run
developersRouter.get('/:id/runs/:runId/logs', async (req, res, next) => {
  try {
    const run = await developerQueries.getRun(req.params.runId)
    if (!run || run.developerId !== req.params.id) {
      throw new AppError(404, 'Run not found', 'RUN_NOT_FOUND')
    }
    const logs = await developerQueries.listLogs(run.id)
    res.json(logs)
  } catch (error) {
    next(error)
  }
})

// Stream run logs via SSE. Replays existing logs, then streams new ones until
// the run reaches a terminal status (or the client disconnects).
developersRouter.get('/:id/runs/:runId/stream', async (req: Request, res: Response, next) => {
  try {
    const run = await developerQueries.getRun(req.params.runId)
    if (!run || run.developerId !== req.params.id) {
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

    // Replay existing logs first
    const existing = await developerQueries.listLogs(run.id)
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
      developerRegistry.events.off(`log:${run.id}`, logHandler)
      developerRegistry.events.off(`update:${run.id}`, updateHandler)
      developerRegistry.events.off(`complete:${run.id}`, completeHandler)
    }

    developerRegistry.events.on(`log:${run.id}`, logHandler)
    developerRegistry.events.on(`update:${run.id}`, updateHandler)
    developerRegistry.events.on(`complete:${run.id}`, completeHandler)

    req.on('close', () => {
      cleanup()
    })

    // If already terminal, close immediately
    if (
      run.status === 'success' ||
      run.status === 'failure' ||
      run.status === 'cancelled' ||
      run.status === 'no_changes'
    ) {
      send('complete', { runId: run.id })
      cleanup()
      res.end()
    }
  } catch (error) {
    next(error)
  }
})
