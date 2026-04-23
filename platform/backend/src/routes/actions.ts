import { Router, Request, Response, NextFunction } from 'express'
import { readdir, readFile, writeFile, unlink, mkdir, stat } from 'fs/promises'
import { join } from 'path'
import { createActionSchema, updateActionSchema } from '../schemas/action.js'
import { createEdgeSchema } from '../schemas/edge.js'
import * as actionQueries from '../db/queries/actions.js'
import * as actionChatQueries from '../db/queries/action-chats.js'
import * as projectQueries from '../db/queries/projects.js'
import { config } from '../config.js'
import { AppError } from '../utils/error-handler.js'
import { logger } from '../utils/logger.js'

interface ProjectParams {
  projectId: string
}

interface ActionParams extends ProjectParams {
  aid: string
}

interface EdgeParams extends ProjectParams {
  eid: string
}

export const actionsRouter = Router({ mergeParams: true })

// Create action
actionsRouter.post('/', async (req: Request<ProjectParams>, res: Response, next: NextFunction) => {
  try {
    const { projectId } = req.params
    const data = createActionSchema.parse(req.body)
    const action = await actionQueries.createAction(projectId, data)
    logger.info({ projectId, actionId: action.id }, 'Action created')
    res.status(201).json(action)
  } catch (error) {
    next(error)
  }
})

// List actions
actionsRouter.get('/', async (req: Request<ProjectParams>, res: Response, next: NextFunction) => {
  try {
    const { projectId } = req.params
    const actions = await actionQueries.listActions(projectId)
    res.json(actions)
  } catch (error) {
    next(error)
  }
})

// Get action
actionsRouter.get('/:aid', async (req: Request<ActionParams>, res: Response, next: NextFunction) => {
  try {
    const { projectId, aid } = req.params
    const action = await actionQueries.getAction(projectId, aid)
    if (!action) {
      throw new AppError(404, 'Action not found', 'ACTION_NOT_FOUND')
    }
    res.json(action)
  } catch (error) {
    next(error)
  }
})

// Update action
actionsRouter.patch('/:aid', async (req: Request<ActionParams>, res: Response, next: NextFunction) => {
  try {
    const { projectId, aid } = req.params
    const data = updateActionSchema.parse(req.body)
    const action = await actionQueries.updateAction(projectId, aid, data)
    if (!action) {
      throw new AppError(404, 'Action not found', 'ACTION_NOT_FOUND')
    }
    logger.info({ projectId, actionId: action.id }, 'Action updated')
    res.json(action)
  } catch (error) {
    next(error)
  }
})

// Delete action
actionsRouter.delete('/:aid', async (req: Request<ActionParams>, res: Response, next: NextFunction) => {
  try {
    const { projectId, aid } = req.params
    const deleted = await actionQueries.deleteAction(projectId, aid)
    if (!deleted) {
      throw new AppError(404, 'Action not found', 'ACTION_NOT_FOUND')
    }
    logger.info({ projectId, actionId: aid }, 'Action deleted')
    res.status(204).send()
  } catch (error) {
    next(error)
  }
})

// === Edge routes ===

// Create edge (mounted at /api/projects/:projectId/edges)
actionsRouter.post('/edges', async (req: Request<ProjectParams>, res: Response, next: NextFunction) => {
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
actionsRouter.delete('/edges/:eid', async (req: Request<EdgeParams>, res: Response, next: NextFunction) => {
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

// === DAG routes ===

// Get full DAG
actionsRouter.get('/dag', async (req: Request<ProjectParams>, res: Response, next: NextFunction) => {
  try {
    const { projectId } = req.params
    const dag = await actionQueries.getDag(projectId)
    res.json(dag)
  } catch (error) {
    next(error)
  }
})

// Validate DAG
actionsRouter.post('/dag/validate', async (req: Request<ProjectParams>, res: Response, next: NextFunction) => {
  try {
    const { projectId } = req.params
    const dag = await actionQueries.getDag(projectId)
    const validation = actionQueries.validateDag(dag.actions, dag.edges)
    res.json(validation)
  } catch (error) {
    next(error)
  }
})

// === Chat routes ===

// Get chat messages for an action
actionsRouter.get('/:aid/chat', async (req: Request<ActionParams>, res: Response, next: NextFunction) => {
  try {
    const { aid } = req.params
    const messages = await actionChatQueries.listMessages(aid)
    res.json(messages)
  } catch (error) {
    next(error)
  }
})

// Add chat message
actionsRouter.post('/:aid/chat', async (req: Request<ActionParams>, res: Response, next: NextFunction) => {
  try {
    const { aid } = req.params
    const { role, content } = req.body
    if (!role || !content) {
      throw new AppError(400, 'Role and content are required', 'INVALID_INPUT')
    }
    const message = await actionChatQueries.createMessage(aid, { role, content })
    logger.info({ actionId: aid, messageId: message.id }, 'Chat message created')
    res.status(201).json(message)
  } catch (error) {
    next(error)
  }
})

// Delete all chat messages for an action
actionsRouter.delete('/:aid/chat', async (req: Request<ActionParams>, res: Response, next: NextFunction) => {
  try {
    const { aid } = req.params
    await actionChatQueries.deleteMessages(aid)
    logger.info({ actionId: aid }, 'Chat messages cleared')
    res.status(204).send()
  } catch (error) {
    next(error)
  }
})

// === File routes ===

// Helper to get action directory path
const getActionDir = async (projectId: string, actionId: string): Promise<string | null> => {
  const project = await projectQueries.getProject(projectId)
  if (!project) return null
  return join(config.DATA_DIR, 'projects', project.slug, 'actions', actionId)
}

// List files in action directory
actionsRouter.get('/:aid/files', async (req: Request<ActionParams>, res: Response, next: NextFunction) => {
  try {
    const { projectId, aid } = req.params
    const actionDir = await getActionDir(projectId, aid)
    if (!actionDir) {
      throw new AppError(404, 'Project not found', 'PROJECT_NOT_FOUND')
    }

    try {
      const entries = await readdir(actionDir, { withFileTypes: true })
      const files = await Promise.all(
        entries.map(async (entry) => {
          const filePath = join(actionDir, entry.name)
          const stats = await stat(filePath)
          return {
            name: entry.name,
            isDirectory: entry.isDirectory(),
            size: stats.size,
            modifiedAt: stats.mtime,
          }
        })
      )
      res.json(files)
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        // Directory doesn't exist yet
        res.json([])
      } else {
        throw err
      }
    }
  } catch (error) {
    next(error)
  }
})

// Get file content
actionsRouter.get('/:aid/files/:filename', async (req: Request<ActionParams & { filename: string }>, res: Response, next: NextFunction) => {
  try {
    const { projectId, aid, filename } = req.params
    const actionDir = await getActionDir(projectId, aid)
    if (!actionDir) {
      throw new AppError(404, 'Project not found', 'PROJECT_NOT_FOUND')
    }

    const filePath = join(actionDir, filename)
    try {
      const content = await readFile(filePath, 'utf-8')
      res.json({ name: filename, content })
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new AppError(404, 'File not found', 'FILE_NOT_FOUND')
      }
      throw err
    }
  } catch (error) {
    next(error)
  }
})

// Create/update file
actionsRouter.post('/:aid/files', async (req: Request<ActionParams>, res: Response, next: NextFunction) => {
  try {
    const { projectId, aid } = req.params
    const { name, content } = req.body
    if (!name || content === undefined) {
      throw new AppError(400, 'Name and content are required', 'INVALID_INPUT')
    }

    const actionDir = await getActionDir(projectId, aid)
    if (!actionDir) {
      throw new AppError(404, 'Project not found', 'PROJECT_NOT_FOUND')
    }

    await mkdir(actionDir, { recursive: true })
    const filePath = join(actionDir, name)
    await writeFile(filePath, content, 'utf-8')
    logger.info({ actionId: aid, filename: name }, 'File created/updated')
    res.status(201).json({ name, content })
  } catch (error) {
    next(error)
  }
})

// Delete file
actionsRouter.delete('/:aid/files/:filename', async (req: Request<ActionParams & { filename: string }>, res: Response, next: NextFunction) => {
  try {
    const { projectId, aid, filename } = req.params
    const actionDir = await getActionDir(projectId, aid)
    if (!actionDir) {
      throw new AppError(404, 'Project not found', 'PROJECT_NOT_FOUND')
    }

    const filePath = join(actionDir, filename)
    try {
      await unlink(filePath)
      logger.info({ actionId: aid, filename }, 'File deleted')
      res.status(204).send()
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new AppError(404, 'File not found', 'FILE_NOT_FOUND')
      }
      throw err
    }
  } catch (error) {
    next(error)
  }
})
