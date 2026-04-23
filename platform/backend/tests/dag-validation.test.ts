import { describe, it, expect } from 'vitest'
import { validateDag } from '../src/db/queries/actions'
import { Action } from '../src/schemas/action'
import { Edge } from '../src/schemas/edge'

const createAction = (id: string, name: string, type: string = 'build'): Action => ({
  id,
  projectId: 'test-project',
  name,
  type: type as Action['type'],
  serviceId: null,
  config: {},
  position: { x: 0, y: 0 },
  createdAt: new Date(),
})

const createEdge = (sourceId: string, targetId: string, type: 'success' | 'failure' = 'success'): Edge => ({
  id: `edge-${sourceId}-${targetId}`,
  projectId: 'test-project',
  sourceActionId: sourceId,
  targetActionId: targetId,
  type,
  createdAt: new Date(),
})

describe('DAG Validation', () => {
  it('validates an empty DAG', () => {
    const result = validateDag([], [])
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a simple linear DAG', () => {
    const actions = [
      createAction('1', 'Build'),
      createAction('2', 'Test'),
      createAction('3', 'Deploy'),
    ]
    const edges = [
      createEdge('1', '2'),
      createEdge('2', '3'),
    ]

    const result = validateDag(actions, edges)
    expect(result.valid).toBe(true)
  })

  it('validates a DAG with parallel branches', () => {
    const actions = [
      createAction('1', 'Build'),
      createAction('2', 'Unit Test'),
      createAction('3', 'Integration Test'),
      createAction('4', 'Deploy'),
    ]
    const edges = [
      createEdge('1', '2'),
      createEdge('1', '3'),
      createEdge('2', '4'),
      createEdge('3', '4'),
    ]

    const result = validateDag(actions, edges)
    expect(result.valid).toBe(true)
  })

  it('validates a DAG with success and failure edges (no cycle)', () => {
    const actions = [
      createAction('1', 'Build'),
      createAction('2', 'Test'),
      createAction('3', 'Fixer', 'fixer'),
      createAction('4', 'Deploy'),
    ]
    // Valid DAG with failure edge going to fixer, but no cycle back
    const edges = [
      createEdge('1', '2'),
      createEdge('2', '4', 'success'),
      createEdge('2', '3', 'failure'),
      createEdge('3', '4'), // Fixer goes to deploy instead of back to test
    ]

    const result = validateDag(actions, edges)
    expect(result.valid).toBe(true)
  })

  it('detects cycle in fixer loop pattern', () => {
    const actions = [
      createAction('1', 'Build'),
      createAction('2', 'Test'),
      createAction('3', 'Fixer', 'fixer'),
      createAction('4', 'Deploy'),
    ]
    // This creates a cycle: 2 -> 3 -> 2
    const edges = [
      createEdge('1', '2'),
      createEdge('2', '4', 'success'),
      createEdge('2', '3', 'failure'),
      createEdge('3', '2'), // Creates cycle back to test
    ]

    const result = validateDag(actions, edges)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.type === 'cycle')).toBe(true)
  })

  it('detects a cycle in the DAG', () => {
    const actions = [
      createAction('1', 'A'),
      createAction('2', 'B'),
      createAction('3', 'C'),
    ]
    const edges = [
      createEdge('1', '2'),
      createEdge('2', '3'),
      createEdge('3', '1'), // Creates cycle
    ]

    const result = validateDag(actions, edges)
    expect(result.valid).toBe(false)
    expect(result.errors.some(e => e.type === 'cycle')).toBe(true)
  })

  it('detects missing start node', () => {
    const actions = [
      createAction('1', 'A'),
      createAction('2', 'B'),
    ]
    const edges = [
      createEdge('1', '2'),
      createEdge('2', '1'), // Both have incoming edges
    ]

    const result = validateDag(actions, edges)
    expect(result.valid).toBe(false)
  })

  it('handles single node DAG', () => {
    const actions = [createAction('1', 'Single')]
    const edges: Edge[] = []

    const result = validateDag(actions, edges)
    expect(result.valid).toBe(true)
  })

  it('handles disconnected nodes', () => {
    const actions = [
      createAction('1', 'A'),
      createAction('2', 'B'),
      createAction('3', 'C'), // Disconnected
    ]
    const edges = [
      createEdge('1', '2'),
    ]

    // Disconnected nodes are valid (they're just not part of the main flow)
    const result = validateDag(actions, edges)
    expect(result.valid).toBe(true)
  })
})
