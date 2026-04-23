import { Router, Request, Response, NextFunction } from 'express'
import * as actionQueries from '../db/queries/actions.js'

interface ProjectParams {
  projectId: string
}

export const dagRouter = Router({ mergeParams: true })

// Get full DAG
dagRouter.get('/', async (req: Request<ProjectParams>, res: Response, next: NextFunction) => {
  try {
    const { projectId } = req.params
    const dag = await actionQueries.getDag(projectId)
    res.json(dag)
  } catch (error) {
    next(error)
  }
})

// Validate DAG
dagRouter.post('/validate', async (req: Request<ProjectParams>, res: Response, next: NextFunction) => {
  try {
    const { projectId } = req.params
    const dag = await actionQueries.getDag(projectId)
    const validation = actionQueries.validateDag(dag.actions, dag.edges)
    res.json(validation)
  } catch (error) {
    next(error)
  }
})
