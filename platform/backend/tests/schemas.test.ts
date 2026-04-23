import { describe, it, expect } from 'vitest'
import { createProjectSchema, updateProjectSchema } from '../src/schemas/project'
import { createServiceSchema, serviceTemplateSchema } from '../src/schemas/service'
import { createActionSchema, actionTypeSchema } from '../src/schemas/action'
import { createEdgeSchema, edgeTypeSchema } from '../src/schemas/edge'

describe('Project Schema', () => {
  it('validates a valid create project request', () => {
    const data = { name: 'Test Project', slug: 'test-project' }
    const result = createProjectSchema.safeParse(data)
    expect(result.success).toBe(true)
  })

  it('rejects invalid slug format', () => {
    const data = { name: 'Test', slug: 'Invalid Slug!' }
    const result = createProjectSchema.safeParse(data)
    expect(result.success).toBe(false)
  })

  it('allows optional description', () => {
    const data = { name: 'Test', description: 'A test project' }
    const result = createProjectSchema.safeParse(data)
    expect(result.success).toBe(true)
  })

  it('validates update project request', () => {
    const data = { name: 'Updated Name', status: 'ready' }
    const result = updateProjectSchema.safeParse(data)
    expect(result.success).toBe(true)
  })

  it('rejects invalid status', () => {
    const data = { status: 'invalid-status' }
    const result = updateProjectSchema.safeParse(data)
    expect(result.success).toBe(false)
  })
})

describe('Service Schema', () => {
  it('validates all service templates', () => {
    const templates = ['node', 'next', 'python', 'go', 'static', 'database', 'custom']
    templates.forEach(template => {
      const result = serviceTemplateSchema.safeParse(template)
      expect(result.success).toBe(true)
    })
  })

  it('validates a valid create service request', () => {
    const data = { name: 'backend', template: 'node' }
    const result = createServiceSchema.safeParse(data)
    expect(result.success).toBe(true)
  })

  it('rejects invalid service name', () => {
    const data = { name: 'Invalid Name!', template: 'node' }
    const result = createServiceSchema.safeParse(data)
    expect(result.success).toBe(false)
  })

  it('accepts optional mdspec', () => {
    const data = { name: 'backend', template: 'node', mdspec: '# Spec' }
    const result = createServiceSchema.safeParse(data)
    expect(result.success).toBe(true)
  })
})

describe('Action Schema', () => {
  it('validates all action types', () => {
    const types = ['build', 'unit-test', 'api-test', 'integration-test', 'e2e-test', 'fixer', 'router', 'custom']
    types.forEach(type => {
      const result = actionTypeSchema.safeParse(type)
      expect(result.success).toBe(true)
    })
  })

  it('validates a valid create action request', () => {
    const data = { name: 'Build Backend', type: 'build' }
    const result = createActionSchema.safeParse(data)
    expect(result.success).toBe(true)
  })

  it('accepts config options', () => {
    const data = {
      name: 'Build',
      type: 'build',
      config: { maxRetries: 3, timeoutMinutes: 30 }
    }
    const result = createActionSchema.safeParse(data)
    expect(result.success).toBe(true)
  })

  it('accepts position', () => {
    const data = {
      name: 'Build',
      type: 'build',
      position: { x: 100, y: 200 }
    }
    const result = createActionSchema.safeParse(data)
    expect(result.success).toBe(true)
  })
})

describe('Edge Schema', () => {
  it('validates edge types', () => {
    expect(edgeTypeSchema.safeParse('success').success).toBe(true)
    expect(edgeTypeSchema.safeParse('failure').success).toBe(true)
    expect(edgeTypeSchema.safeParse('invalid').success).toBe(false)
  })

  it('validates a valid create edge request', () => {
    const data = {
      sourceActionId: '550e8400-e29b-41d4-a716-446655440000',
      targetActionId: '550e8400-e29b-41d4-a716-446655440001',
    }
    const result = createEdgeSchema.safeParse(data)
    expect(result.success).toBe(true)
  })

  it('defaults to success type', () => {
    const data = {
      sourceActionId: '550e8400-e29b-41d4-a716-446655440000',
      targetActionId: '550e8400-e29b-41d4-a716-446655440001',
    }
    const result = createEdgeSchema.parse(data)
    expect(result.type).toBe('success')
  })
})
