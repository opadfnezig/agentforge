import { Router } from 'express'
import { createProjectSchema, updateProjectSchema } from '../schemas/project.js'
import * as projectQueries from '../db/queries/projects.js'
import { generateCompose } from '../services/docker.js'
import { startContainers, stopContainers, rebuildContainers } from '../services/docker.js'
import { AppError } from '../utils/error-handler.js'
import { logger } from '../utils/logger.js'

export const projectsRouter = Router()

// Create project
projectsRouter.post('/', async (req, res, next) => {
  try {
    const data = createProjectSchema.parse(req.body)
    const project = await projectQueries.createProject(data)
    logger.info({ projectId: project.id }, 'Project created')
    res.status(201).json(project)
  } catch (error) {
    next(error)
  }
})

// List projects
projectsRouter.get('/', async (_req, res, next) => {
  try {
    const projects = await projectQueries.listProjects()
    res.json(projects)
  } catch (error) {
    next(error)
  }
})

// Get project
projectsRouter.get('/:id', async (req, res, next) => {
  try {
    const project = await projectQueries.getProject(req.params.id)
    if (!project) {
      throw new AppError(404, 'Project not found', 'PROJECT_NOT_FOUND')
    }
    res.json(project)
  } catch (error) {
    next(error)
  }
})

// Update project
projectsRouter.patch('/:id', async (req, res, next) => {
  try {
    const data = updateProjectSchema.parse(req.body)
    const project = await projectQueries.updateProject(req.params.id, data)
    if (!project) {
      throw new AppError(404, 'Project not found', 'PROJECT_NOT_FOUND')
    }
    logger.info({ projectId: project.id }, 'Project updated')
    res.json(project)
  } catch (error) {
    next(error)
  }
})

// Delete project
projectsRouter.delete('/:id', async (req, res, next) => {
  try {
    // Stop containers first
    const project = await projectQueries.getProject(req.params.id)
    if (project) {
      try {
        await stopContainers(project)
      } catch {
        // Ignore errors if containers don't exist
      }
    }

    const deleted = await projectQueries.deleteProject(req.params.id)
    if (!deleted) {
      throw new AppError(404, 'Project not found', 'PROJECT_NOT_FOUND')
    }
    logger.info({ projectId: req.params.id }, 'Project deleted')
    res.status(204).send()
  } catch (error) {
    next(error)
  }
})

// Generate docker-compose
projectsRouter.post('/:id/compose', async (req, res, next) => {
  try {
    const project = await projectQueries.getProject(req.params.id)
    if (!project) {
      throw new AppError(404, 'Project not found', 'PROJECT_NOT_FOUND')
    }

    const composeConfig = await generateCompose(project)
    const updated = await projectQueries.updateProject(project.id, { composeConfig })
    logger.info({ projectId: project.id }, 'Docker compose generated')
    res.json(updated)
  } catch (error) {
    next(error)
  }
})

// Start project containers
projectsRouter.post('/:id/start', async (req, res, next) => {
  try {
    const project = await projectQueries.getProject(req.params.id)
    if (!project) {
      throw new AppError(404, 'Project not found', 'PROJECT_NOT_FOUND')
    }

    await startContainers(project)
    const updated = await projectQueries.updateProject(project.id, { status: 'ready' })
    logger.info({ projectId: project.id }, 'Project started')
    res.json(updated)
  } catch (error) {
    next(error)
  }
})

// Stop project containers
projectsRouter.post('/:id/stop', async (req, res, next) => {
  try {
    const project = await projectQueries.getProject(req.params.id)
    if (!project) {
      throw new AppError(404, 'Project not found', 'PROJECT_NOT_FOUND')
    }

    await stopContainers(project)
    const updated = await projectQueries.updateProject(project.id, { status: 'stopped' })
    logger.info({ projectId: project.id }, 'Project stopped')
    res.json(updated)
  } catch (error) {
    next(error)
  }
})

// Rebuild project containers
projectsRouter.post('/:id/rebuild', async (req, res, next) => {
  try {
    const project = await projectQueries.getProject(req.params.id)
    if (!project) {
      throw new AppError(404, 'Project not found', 'PROJECT_NOT_FOUND')
    }

    await rebuildContainers(project)
    const updated = await projectQueries.updateProject(project.id, { status: 'ready' })
    logger.info({ projectId: project.id }, 'Project rebuilt')
    res.json(updated)
  } catch (error) {
    next(error)
  }
})
