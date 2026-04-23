import { Router, Request, Response, NextFunction } from 'express'
import * as buildQueries from '../db/queries/builds.js'
import * as actionQueries from '../db/queries/actions.js'
import { executeDag, cancelBuild } from '../services/orchestrator.js'
import { AppError } from '../utils/error-handler.js'
import { logger } from '../utils/logger.js'

interface ProjectParams {
  projectId: string
}

interface BuildParams extends ProjectParams {
  bid: string
}

interface RunParams extends BuildParams {
  rid: string
}

export const buildRouter = Router({ mergeParams: true })

// Start build (execute DAG)
buildRouter.post('/', async (req: Request<ProjectParams>, res: Response, next: NextFunction) => {
  try {
    const { projectId } = req.params

    // Validate DAG first
    const dag = await actionQueries.getDag(projectId)
    const validation = actionQueries.validateDag(dag.actions, dag.edges)
    if (!validation.valid) {
      throw new AppError(400, 'Invalid DAG configuration', 'INVALID_DAG')
    }

    // Create build
    const build = await buildQueries.createBuild(projectId)
    logger.info({ projectId, buildId: build.id }, 'Build started')

    // Start execution asynchronously
    executeDag(projectId, build.id).catch((error) => {
      logger.error({ error, buildId: build.id }, 'Build execution failed')
    })

    res.status(201).json(build)
  } catch (error) {
    next(error)
  }
})

// Get build status
buildRouter.get('/:bid', async (req: Request<BuildParams>, res: Response, next: NextFunction) => {
  try {
    const { projectId, bid } = req.params
    const build = await buildQueries.getBuild(projectId, bid)
    if (!build) {
      throw new AppError(404, 'Build not found', 'BUILD_NOT_FOUND')
    }
    res.json(build)
  } catch (error) {
    next(error)
  }
})

// Cancel build
buildRouter.post('/:bid/cancel', async (req: Request<BuildParams>, res: Response, next: NextFunction) => {
  try {
    const { projectId, bid } = req.params
    const build = await buildQueries.getBuild(projectId, bid)
    if (!build) {
      throw new AppError(404, 'Build not found', 'BUILD_NOT_FOUND')
    }

    await cancelBuild(bid)
    const updated = await buildQueries.updateBuild(bid, {
      status: 'cancelled',
      finishedAt: new Date(),
    })
    logger.info({ projectId, buildId: bid }, 'Build cancelled')
    res.json(updated)
  } catch (error) {
    next(error)
  }
})

// List action runs for build
buildRouter.get('/:bid/runs', async (req: Request<BuildParams>, res: Response, next: NextFunction) => {
  try {
    const { bid } = req.params
    const runs = await buildQueries.listActionRuns(bid)
    res.json(runs)
  } catch (error) {
    next(error)
  }
})

// Get action run details
buildRouter.get('/:bid/runs/:rid', async (req: Request<RunParams>, res: Response, next: NextFunction) => {
  try {
    const { rid } = req.params
    const run = await buildQueries.getActionRun(rid)
    if (!run) {
      throw new AppError(404, 'Action run not found', 'RUN_NOT_FOUND')
    }
    res.json(run)
  } catch (error) {
    next(error)
  }
})

// Get agent logs for run
buildRouter.get('/:bid/runs/:rid/logs', async (req: Request<RunParams>, res: Response, next: NextFunction) => {
  try {
    const { rid } = req.params
    const limit = parseInt(req.query.limit as string) || 100
    const offset = parseInt(req.query.offset as string) || 0
    const logs = await buildQueries.listAgentLogs(rid, limit, offset)
    res.json(logs)
  } catch (error) {
    next(error)
  }
})

// Get file changes for run
buildRouter.get('/:bid/runs/:rid/files', async (req: Request<RunParams>, res: Response, next: NextFunction) => {
  try {
    const { rid } = req.params
    const changes = await buildQueries.listFileChanges(rid)
    res.json(changes)
  } catch (error) {
    next(error)
  }
})

// WebSocket for streaming build events
// TODO: Phase 3-4 - requires express-ws setup on the main app
// buildRouter.ws('/:bid/stream', (ws, req) => {
//   const { bid } = req.params
//   const emitter = getBuildEventEmitter(bid)
//
//   if (!emitter) {
//     ws.close(1008, 'Build not found or not running')
//     return
//   }
//
//   const handleEvent = (event: unknown) => {
//     try {
//       ws.send(JSON.stringify(event))
//     } catch {
//       // Client disconnected
//     }
//   }
//
//   emitter.on('event', handleEvent)
//
//   ws.on('close', () => {
//     emitter.off('event', handleEvent)
//   })
// })
