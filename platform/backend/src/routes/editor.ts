import { Router, Request, Response, NextFunction } from 'express'
import { startEditorSchema } from '../schemas/api.js'
import { startCodeServer, stopCodeServer, getCodeServerUrl } from '../services/code-server.js'
import * as projectQueries from '../db/queries/projects.js'
import * as serviceQueries from '../db/queries/services.js'
import { AppError } from '../utils/error-handler.js'
import { logger } from '../utils/logger.js'

interface ProjectParams {
  projectId: string
}

interface ServiceParams extends ProjectParams {
  sid: string
}

export const editorRouter = Router({ mergeParams: true })

// Start code-server for project
editorRouter.post('/', async (req: Request<ProjectParams>, res: Response, next: NextFunction) => {
  try {
    const { projectId } = req.params
    const data = startEditorSchema.parse(req.body)

    const project = await projectQueries.getProject(projectId)
    if (!project) {
      throw new AppError(404, 'Project not found', 'PROJECT_NOT_FOUND')
    }

    let workdir = project.slug
    if (data.serviceId) {
      const service = await serviceQueries.getService(projectId, data.serviceId)
      if (!service) {
        throw new AppError(404, 'Service not found', 'SERVICE_NOT_FOUND')
      }
      workdir = `${project.slug}/${service.directory}`
    }

    const url = await startCodeServer(projectId, workdir)
    logger.info({ projectId, url }, 'Code-server started')
    res.json({ url })
  } catch (error) {
    next(error)
  }
})

// Start code-server for specific service
editorRouter.post('/service/:sid', async (req: Request<ServiceParams>, res: Response, next: NextFunction) => {
  try {
    const { projectId, sid } = req.params

    const project = await projectQueries.getProject(projectId)
    if (!project) {
      throw new AppError(404, 'Project not found', 'PROJECT_NOT_FOUND')
    }

    const service = await serviceQueries.getService(projectId, sid)
    if (!service) {
      throw new AppError(404, 'Service not found', 'SERVICE_NOT_FOUND')
    }

    const workdir = `${project.slug}/${service.directory}`
    const url = await startCodeServer(projectId, workdir)
    logger.info({ projectId, serviceId: sid, url }, 'Code-server started for service')
    res.json({ url })
  } catch (error) {
    next(error)
  }
})

// Stop code-server
editorRouter.delete('/', async (req: Request<ProjectParams>, res: Response, next: NextFunction) => {
  try {
    const { projectId } = req.params
    await stopCodeServer(projectId)
    logger.info({ projectId }, 'Code-server stopped')
    res.status(204).send()
  } catch (error) {
    next(error)
  }
})

// Get code-server URL
editorRouter.get('/url', async (req: Request<ProjectParams>, res: Response, next: NextFunction) => {
  try {
    const { projectId } = req.params
    const url = await getCodeServerUrl(projectId)
    if (!url) {
      throw new AppError(404, 'Code-server not running', 'EDITOR_NOT_RUNNING')
    }
    res.json({ url })
  } catch (error) {
    next(error)
  }
})
