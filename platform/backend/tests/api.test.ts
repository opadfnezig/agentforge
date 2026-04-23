import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import { projectsRouter } from '../src/routes/projects'
import { errorHandler } from '../src/utils/error-handler'

// Mock database queries
vi.mock('../src/db/queries/projects', () => ({
  createProject: vi.fn().mockResolvedValue({
    id: 'test-id',
    name: 'Test Project',
    slug: 'test-project',
    description: null,
    status: 'draft',
    composeConfig: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }),
  listProjects: vi.fn().mockResolvedValue([]),
  getProject: vi.fn().mockImplementation((id) => {
    if (id === 'test-id') {
      return Promise.resolve({
        id: 'test-id',
        name: 'Test Project',
        slug: 'test-project',
        description: null,
        status: 'draft',
        composeConfig: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    }
    return Promise.resolve(null)
  }),
  updateProject: vi.fn().mockResolvedValue({
    id: 'test-id',
    name: 'Updated Project',
    slug: 'test-project',
    description: null,
    status: 'draft',
    composeConfig: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }),
  deleteProject: vi.fn().mockResolvedValue(true),
}))

// Mock docker service
vi.mock('../src/services/docker', () => ({
  generateCompose: vi.fn().mockResolvedValue('version: "3.8"'),
  startContainers: vi.fn().mockResolvedValue(undefined),
  stopContainers: vi.fn().mockResolvedValue(undefined),
  rebuildContainers: vi.fn().mockResolvedValue(undefined),
}))

describe('Projects API', () => {
  const app = express()
  app.use(express.json())
  app.use('/api/projects', projectsRouter)
  app.use(errorHandler) // Add error handler for proper error responses

  it('POST /api/projects - creates a project', async () => {
    const response = await request(app)
      .post('/api/projects')
      .send({ name: 'Test Project', slug: 'test-project' })
      .expect(201)

    expect(response.body).toHaveProperty('id')
    expect(response.body.name).toBe('Test Project')
    expect(response.body.slug).toBe('test-project')
  })

  it('POST /api/projects - validates input', async () => {
    const response = await request(app)
      .post('/api/projects')
      .send({ name: '' }) // Empty name should fail
      .expect(400)

    expect(response.body).toHaveProperty('error')
  })

  it('GET /api/projects - lists projects', async () => {
    const response = await request(app)
      .get('/api/projects')
      .expect(200)

    expect(Array.isArray(response.body)).toBe(true)
  })

  it('GET /api/projects/:id - gets a project', async () => {
    const response = await request(app)
      .get('/api/projects/test-id')
      .expect(200)

    expect(response.body.id).toBe('test-id')
  })

  it('GET /api/projects/:id - returns 404 for non-existent project', async () => {
    const response = await request(app)
      .get('/api/projects/non-existent')
      .expect(404)

    expect(response.body).toHaveProperty('error')
  })

  it('PATCH /api/projects/:id - updates a project', async () => {
    const response = await request(app)
      .patch('/api/projects/test-id')
      .send({ name: 'Updated Project' })
      .expect(200)

    expect(response.body.name).toBe('Updated Project')
  })

  it('DELETE /api/projects/:id - deletes a project', async () => {
    await request(app)
      .delete('/api/projects/test-id')
      .expect(204)
  })
})
