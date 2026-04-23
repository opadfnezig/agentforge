import { Router, Request, Response, NextFunction } from 'express'
import { createTaskSchema } from '../schemas/api.js'
import { runTask, getTaskStatus, getTaskLogs } from '../services/task-runner.js'
import { AppError } from '../utils/error-handler.js'
import { logger } from '../utils/logger.js'

interface ProjectParams {
  projectId: string
}

interface TaskParams extends ProjectParams {
  tid: string
}

interface IssueParams extends ProjectParams {
  issueId: string
}

export const taskRouter = Router({ mergeParams: true })

// Run single agent task
taskRouter.post('/', async (req: Request<ProjectParams>, res: Response, next: NextFunction) => {
  try {
    const { projectId } = req.params
    const data = createTaskSchema.parse(req.body)
    const task = await runTask(projectId, data)
    logger.info({ projectId, taskId: task.id }, 'Task started')
    res.status(201).json(task)
  } catch (error) {
    next(error)
  }
})

// Get task status
taskRouter.get('/:tid', async (req: Request<TaskParams>, res: Response, next: NextFunction) => {
  try {
    const { tid } = req.params
    const task = await getTaskStatus(tid)
    if (!task) {
      throw new AppError(404, 'Task not found', 'TASK_NOT_FOUND')
    }
    res.json(task)
  } catch (error) {
    next(error)
  }
})

// Get task logs
taskRouter.get('/:tid/logs', async (req: Request<TaskParams>, res: Response, next: NextFunction) => {
  try {
    const { tid } = req.params
    const limit = parseInt(req.query.limit as string) || 100
    const offset = parseInt(req.query.offset as string) || 0
    const logs = await getTaskLogs(tid, limit, offset)
    res.json(logs)
  } catch (error) {
    next(error)
  }
})

// Create task from Plane issue
taskRouter.post('/from-plane/:issueId', async (req: Request<IssueParams>, res: Response, next: NextFunction) => {
  try {
    const { projectId, issueId } = req.params
    // This would fetch the issue from Plane and create a task
    // For now, just a placeholder
    logger.info({ projectId, issueId }, 'Task from Plane issue requested')
    res.status(501).json({ error: 'Not implemented yet' })
  } catch (error) {
    next(error)
  }
})
