import { db, DbAction, DbEdge } from '../connection.js'
import { Action, CreateAction, UpdateAction } from '../../schemas/action.js'
import { Edge, CreateEdge } from '../../schemas/edge.js'
import { v4 as uuid } from 'uuid'
import { mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { config } from '../../config.js'
import * as projectQueries from './projects.js'

const toAction = (row: DbAction): Action => ({
  id: row.id,
  projectId: row.project_id,
  name: row.name,
  type: row.type as Action['type'],
  serviceId: row.service_id,
  config: row.config as Action['config'],
  position: row.position,
  createdAt: row.created_at,
})

const toEdge = (row: DbEdge): Edge => ({
  id: row.id,
  projectId: row.project_id,
  sourceActionId: row.source_action_id,
  targetActionId: row.target_action_id,
  type: row.type as Edge['type'],
  createdAt: row.created_at,
})

// Actions
export const createAction = async (
  projectId: string,
  data: CreateAction
): Promise<Action> => {
  const actionId = uuid()

  const [row] = await db<DbAction>('actions')
    .insert({
      id: actionId,
      project_id: projectId,
      name: data.name,
      type: data.type,
      service_id: data.serviceId || null,
      config: data.config || {},
      position: data.position || { x: 0, y: 0 },
    })
    .returning('*')

  // Create action directory
  const project = await projectQueries.getProject(projectId)
  if (project) {
    const actionDir = join(config.DATA_DIR, 'projects', project.slug, 'actions', actionId)
    await mkdir(actionDir, { recursive: true })
  }

  return toAction(row)
}

export const listActions = async (projectId: string): Promise<Action[]> => {
  const rows = await db<DbAction>('actions')
    .where({ project_id: projectId })
    .orderBy('created_at', 'asc')
  return rows.map(toAction)
}

export const getAction = async (
  projectId: string,
  actionId: string
): Promise<Action | null> => {
  const row = await db<DbAction>('actions')
    .where({ id: actionId, project_id: projectId })
    .first()
  return row ? toAction(row) : null
}

export const updateAction = async (
  projectId: string,
  actionId: string,
  data: UpdateAction
): Promise<Action | null> => {
  const updateData: Partial<Record<string, unknown>> = {}
  if (data.name !== undefined) updateData.name = data.name
  if (data.type !== undefined) updateData.type = data.type
  if (data.serviceId !== undefined) updateData.service_id = data.serviceId
  if (data.config !== undefined) updateData.config = data.config
  if (data.position !== undefined) updateData.position = data.position

  const [row] = await db<DbAction>('actions')
    .where({ id: actionId, project_id: projectId })
    .update(updateData)
    .returning('*')
  return row ? toAction(row) : null
}

export const deleteAction = async (
  projectId: string,
  actionId: string
): Promise<boolean> => {
  const count = await db<DbAction>('actions')
    .where({ id: actionId, project_id: projectId })
    .delete()

  // Clean up action directory
  if (count > 0) {
    const project = await projectQueries.getProject(projectId)
    if (project) {
      const actionDir = join(config.DATA_DIR, 'projects', project.slug, 'actions', actionId)
      await rm(actionDir, { recursive: true, force: true }).catch(() => {})
    }
  }

  return count > 0
}

// Edges
export const createEdge = async (
  projectId: string,
  data: CreateEdge
): Promise<Edge> => {
  const [row] = await db<DbEdge>('edges')
    .insert({
      id: uuid(),
      project_id: projectId,
      source_action_id: data.sourceActionId,
      target_action_id: data.targetActionId,
      type: data.type || 'success',
    })
    .returning('*')
  return toEdge(row)
}

export const listEdges = async (projectId: string): Promise<Edge[]> => {
  const rows = await db<DbEdge>('edges')
    .where({ project_id: projectId })
    .orderBy('created_at', 'asc')
  return rows.map(toEdge)
}

export const deleteEdge = async (
  projectId: string,
  edgeId: string
): Promise<boolean> => {
  const count = await db<DbEdge>('edges')
    .where({ id: edgeId, project_id: projectId })
    .delete()
  return count > 0
}

// DAG
export const getDag = async (projectId: string) => {
  const [actions, edges] = await Promise.all([
    listActions(projectId),
    listEdges(projectId),
  ])
  return { actions, edges }
}

// Validate DAG - check for cycles and orphan nodes
export const validateDag = (
  actions: Action[],
  edges: Edge[]
): { valid: boolean; errors: Array<{ type: string; message: string; nodeIds?: string[] }> } => {
  const errors: Array<{ type: string; message: string; nodeIds?: string[] }> = []

  if (actions.length === 0) {
    return { valid: true, errors: [] }
  }

  // Build adjacency list
  const adj = new Map<string, string[]>()
  const inDegree = new Map<string, number>()

  actions.forEach((a) => {
    adj.set(a.id, [])
    inDegree.set(a.id, 0)
  })

  edges.forEach((e) => {
    if (adj.has(e.sourceActionId) && adj.has(e.targetActionId)) {
      adj.get(e.sourceActionId)!.push(e.targetActionId)
      inDegree.set(e.targetActionId, (inDegree.get(e.targetActionId) || 0) + 1)
    }
  })

  // Find start nodes (no incoming edges)
  const startNodes = actions.filter((a) => (inDegree.get(a.id) || 0) === 0)
  if (startNodes.length === 0 && actions.length > 0) {
    errors.push({
      type: 'missing_start',
      message: 'No start node found (all nodes have incoming edges)',
    })
  }

  // Cycle detection using Kahn's algorithm
  const queue = startNodes.map((n) => n.id)
  const visited = new Set<string>()

  while (queue.length > 0) {
    const node = queue.shift()!
    visited.add(node)

    for (const neighbor of adj.get(node) || []) {
      inDegree.set(neighbor, (inDegree.get(neighbor) || 0) - 1)
      if (inDegree.get(neighbor) === 0) {
        queue.push(neighbor)
      }
    }
  }

  if (visited.size !== actions.length) {
    const cycleNodes = actions
      .filter((a) => !visited.has(a.id))
      .map((a) => a.id)
    errors.push({
      type: 'cycle',
      message: 'DAG contains a cycle',
      nodeIds: cycleNodes,
    })
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}
