import { describe, it, expect, vi, beforeEach } from 'vitest'
import { projectsApi, servicesApi, actionsApi } from '@/lib/api'

describe('API Client', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  describe('Projects API', () => {
    it('lists projects', async () => {
      const mockProjects = [
        { id: '1', name: 'Project 1', slug: 'project-1' },
        { id: '2', name: 'Project 2', slug: 'project-2' },
      ]

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockProjects),
      })

      const result = await projectsApi.list()
      expect(result).toEqual(mockProjects)
      expect(fetch).toHaveBeenCalledWith('/api/projects', expect.any(Object))
    })

    it('creates a project', async () => {
      const newProject = { name: 'New Project', slug: 'new-project' }
      const createdProject = { id: '3', ...newProject, status: 'draft' }

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(createdProject),
      })

      const result = await projectsApi.create(newProject)
      expect(result).toEqual(createdProject)
      expect(fetch).toHaveBeenCalledWith(
        '/api/projects',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify(newProject),
        })
      )
    })

    it('handles API errors', async () => {
      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: { message: 'Not found' } }),
      })

      await expect(projectsApi.get('non-existent')).rejects.toThrow('Not found')
    })
  })

  describe('Services API', () => {
    it('lists services for a project', async () => {
      const mockServices = [
        { id: '1', name: 'backend', template: 'node' },
      ]

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockServices),
      })

      const result = await servicesApi.list('project-1')
      expect(result).toEqual(mockServices)
      expect(fetch).toHaveBeenCalledWith(
        '/api/projects/project-1/services',
        expect.any(Object)
      )
    })

    it('creates a service', async () => {
      const newService = { name: 'frontend', template: 'next' as const }
      const createdService = { id: '2', projectId: 'project-1', ...newService }

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(createdService),
      })

      const result = await servicesApi.create('project-1', newService)
      expect(result).toEqual(createdService)
    })
  })

  describe('Actions API', () => {
    it('gets DAG for a project', async () => {
      const mockDag = {
        actions: [{ id: '1', name: 'Build', type: 'build' }],
        edges: [],
      }

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockDag),
      })

      const result = await actionsApi.getDag('project-1')
      expect(result).toEqual(mockDag)
    })

    it('validates DAG', async () => {
      const validationResult = { valid: true, errors: [] }

      global.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(validationResult),
      })

      const result = await actionsApi.validateDag('project-1')
      expect(result.valid).toBe(true)
    })
  })
})
