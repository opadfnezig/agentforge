import { Router, Request, Response, NextFunction } from 'express'
import { createServiceSchema, updateServiceSchema } from '../schemas/service.js'
import * as serviceQueries from '../db/queries/services.js'
import { getProjectFiles, getFileContent } from '../services/file-manager.js'
import { AppError } from '../utils/error-handler.js'
import { logger } from '../utils/logger.js'

interface ProjectParams {
  projectId: string
}

interface ServiceParams extends ProjectParams {
  sid: string
}

export const servicesRouter = Router({ mergeParams: true })

// Create service
servicesRouter.post('/', async (req: Request<ProjectParams>, res: Response, next: NextFunction) => {
  try {
    const { projectId } = req.params
    const data = createServiceSchema.parse(req.body)
    const service = await serviceQueries.createService(projectId, data)
    logger.info({ projectId, serviceId: service.id }, 'Service created')
    res.status(201).json(service)
  } catch (error) {
    next(error)
  }
})

// List services
servicesRouter.get('/', async (req: Request<ProjectParams>, res: Response, next: NextFunction) => {
  try {
    const { projectId } = req.params
    const services = await serviceQueries.listServices(projectId)
    res.json(services)
  } catch (error) {
    next(error)
  }
})

// Get service
servicesRouter.get('/:sid', async (req: Request<ServiceParams>, res: Response, next: NextFunction) => {
  try {
    const { projectId, sid } = req.params
    const service = await serviceQueries.getService(projectId, sid)
    if (!service) {
      throw new AppError(404, 'Service not found', 'SERVICE_NOT_FOUND')
    }
    res.json(service)
  } catch (error) {
    next(error)
  }
})

// Update service
servicesRouter.patch('/:sid', async (req: Request<ServiceParams>, res: Response, next: NextFunction) => {
  try {
    const { projectId, sid } = req.params
    const data = updateServiceSchema.parse(req.body)
    const service = await serviceQueries.updateService(projectId, sid, data)
    if (!service) {
      throw new AppError(404, 'Service not found', 'SERVICE_NOT_FOUND')
    }
    logger.info({ projectId, serviceId: service.id }, 'Service updated')
    res.json(service)
  } catch (error) {
    next(error)
  }
})

// Delete service
servicesRouter.delete('/:sid', async (req: Request<ServiceParams>, res: Response, next: NextFunction) => {
  try {
    const { projectId, sid } = req.params
    const deleted = await serviceQueries.deleteService(projectId, sid)
    if (!deleted) {
      throw new AppError(404, 'Service not found', 'SERVICE_NOT_FOUND')
    }
    logger.info({ projectId, serviceId: sid }, 'Service deleted')
    res.status(204).send()
  } catch (error) {
    next(error)
  }
})

// List files for service
servicesRouter.get('/:sid/files', async (req: Request<ServiceParams>, res: Response, next: NextFunction) => {
  try {
    const { projectId, sid } = req.params
    const service = await serviceQueries.getService(projectId, sid)
    if (!service) {
      throw new AppError(404, 'Service not found', 'SERVICE_NOT_FOUND')
    }
    const files = await getProjectFiles(projectId, service.directory)
    res.json(files)
  } catch (error) {
    next(error)
  }
})

// Get file content
servicesRouter.get('/:sid/files/*', async (req: Request<ServiceParams & { 0: string }>, res: Response, next: NextFunction) => {
  try {
    const { projectId, sid } = req.params
    const filePath = (req.params as unknown as Record<string, string>)[0] // Everything after /files/
    const service = await serviceQueries.getService(projectId, sid)
    if (!service) {
      throw new AppError(404, 'Service not found', 'SERVICE_NOT_FOUND')
    }
    const content = await getFileContent(projectId, service.directory, filePath)
    res.json({ path: filePath, content })
  } catch (error) {
    next(error)
  }
})
