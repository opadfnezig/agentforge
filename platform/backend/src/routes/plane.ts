import { Router } from 'express'
import { PlaneClient } from '../services/plane-client.js'
import { config } from '../config.js'
import { AppError } from '../utils/error-handler.js'

export const planeRouter = Router()

const getPlaneClient = () => {
  if (!config.PLANE_API_URL || !config.PLANE_API_KEY || !config.PLANE_WORKSPACE) {
    throw new AppError(503, 'Plane integration not configured', 'PLANE_NOT_CONFIGURED')
  }
  return new PlaneClient({
    apiUrl: config.PLANE_API_URL,
    apiKey: config.PLANE_API_KEY,
    workspace: config.PLANE_WORKSPACE,
  })
}

// List Plane projects
planeRouter.get('/projects', async (_req, res, next) => {
  try {
    const client = getPlaneClient()
    const projects = await client.listProjects()
    res.json(projects)
  } catch (error) {
    next(error)
  }
})

// List issues from Plane
planeRouter.get('/issues', async (req, res, next) => {
  try {
    const client = getPlaneClient()
    const projectId = req.query.projectId as string
    if (!projectId) {
      throw new AppError(400, 'projectId query parameter required', 'MISSING_PROJECT_ID')
    }
    const issues = await client.listIssues(projectId)
    res.json(issues)
  } catch (error) {
    next(error)
  }
})

// Create issue in Plane
planeRouter.post('/issues', async (req, res, next) => {
  try {
    const client = getPlaneClient()
    const { projectId, title, description, priority, state } = req.body
    if (!projectId || !title) {
      throw new AppError(400, 'projectId and title required', 'MISSING_FIELDS')
    }
    const issue = await client.createIssue(projectId, { title, description, priority, state })
    res.status(201).json(issue)
  } catch (error) {
    next(error)
  }
})

// Update issue status
planeRouter.patch('/issues/:id', async (req, res, next) => {
  try {
    const client = getPlaneClient()
    const { projectId, state } = req.body
    if (!projectId) {
      throw new AppError(400, 'projectId required', 'MISSING_PROJECT_ID')
    }
    const issue = await client.updateIssue(projectId, req.params.id, { state })
    res.json(issue)
  } catch (error) {
    next(error)
  }
})
