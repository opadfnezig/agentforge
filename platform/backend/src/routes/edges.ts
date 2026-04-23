import { Router, Request, Response, NextFunction } from 'express'
import { createEdgeSchema } from '../schemas/edge.js'
import * as actionQueries from '../db/queries/actions.js'
import { AppError } from '../utils/error-handler.js'
import { logger } from '../utils/logger.js'

interface ProjectParams {
  projectId: string
}

interface EdgeParams extends ProjectParams {
  eid: string
}

export const edgesRouter = Router({ mergeParams: true })

// Create edge
edgesRouter.post('/', async (req: Request<ProjectParams>, res: Response, next: NextFunction) => {
  try {
    const { projectId } = req.params
    const data = createEdgeSchema.parse(req.body)
    const edge = await actionQueries.createEdge(projectId, data)
    logger.info({ projectId, edgeId: edge.id }, 'Edge created')
    res.status(201).json(edge)
  } catch (error) {
    next(error)
  }
})

// Delete edge
edgesRouter.delete('/:eid', async (req: Request<EdgeParams>, res: Response, next: NextFunction) => {
  try {
    const { projectId, eid } = req.params
    const deleted = await actionQueries.deleteEdge(projectId, eid)
    if (!deleted) {
      throw new AppError(404, 'Edge not found', 'EDGE_NOT_FOUND')
    }
    logger.info({ projectId, edgeId: eid }, 'Edge deleted')
    res.status(204).send()
  } catch (error) {
    next(error)
  }
})
