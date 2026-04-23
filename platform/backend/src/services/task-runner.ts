import { EventEmitter } from 'events'
import { spawn } from 'child_process'
import { createInterface } from 'readline'
import { join } from 'path'
import { v4 as uuid } from 'uuid'
import { config } from '../config.js'
import { db } from '../db/connection.js'
import { CreateTask } from '../schemas/api.js'
import * as projectQueries from '../db/queries/projects.js'
import * as serviceQueries from '../db/queries/services.js'
import { logger } from '../utils/logger.js'

interface Task {
  id: string
  projectId: string
  serviceId: string | null
  prompt: string
  scope: 'project' | 'service'
  readAccess: string[]
  writeAccess: string[]
  status: 'pending' | 'running' | 'success' | 'failure' | 'cancelled'
  startedAt: Date | null
  finishedAt: Date | null
  errorMessage: string | null
  createdAt: Date
  updatedAt: Date
}

interface TaskLog {
  id: string
  taskId: string
  timestamp: Date
  eventType: string
  data: Record<string, unknown>
}

// Store active task emitters
const taskEmitters = new Map<string, EventEmitter>()

export const runTask = async (
  projectId: string,
  data: CreateTask
): Promise<Task> => {
  const project = await projectQueries.getProject(projectId)
  if (!project) {
    throw new Error('Project not found')
  }

  const taskId = uuid()

  // Insert task into database
  const [task] = await db('tasks')
    .insert({
      id: taskId,
      project_id: projectId,
      service_id: data.serviceId || null,
      prompt: data.prompt,
      scope: data.scope,
      read_access: JSON.stringify(data.readAccess || []),
      write_access: JSON.stringify(data.writeAccess || []),
      status: 'pending',
    })
    .returning('*')

  // Start execution asynchronously
  executeTask(taskId, project, data).catch((error) => {
    logger.error({ error, taskId }, 'Task execution failed')
  })

  return mapTask(task)
}

const executeTask = async (
  taskId: string,
  project: { id: string; slug: string },
  data: CreateTask
): Promise<void> => {
  const emitter = new EventEmitter()
  taskEmitters.set(taskId, emitter)

  // Update status to running
  await db('tasks')
    .where({ id: taskId })
    .update({
      status: 'running',
      started_at: new Date(),
      updated_at: new Date(),
    })

  try {
    const projectDir = join(config.DATA_DIR, 'projects', project.slug)
    let workdir = projectDir

    if (data.scope === 'service' && data.serviceId) {
      const service = await serviceQueries.getService(project.id, data.serviceId)
      if (service) {
        workdir = join(projectDir, service.directory)
      }
    }

    // Run Claude
    const args = [
      '--dangerously-skip-permissions',
      '--verbose',
      '--print',
      '--output-format', 'stream-json',
      '--max-turns', '100',
      data.prompt,
    ]

    const proc = spawn('claude', args, {
      cwd: workdir,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: config.ANTHROPIC_API_KEY,
      },
    })

    const rl = createInterface({ input: proc.stdout })

    for await (const line of rl) {
      try {
        const event = JSON.parse(line)
        await createTaskLog(taskId, event.type || 'message', event)
        emitter.emit('log', event)
      } catch {
        if (line.trim()) {
          await createTaskLog(taskId, 'message', { raw: line })
        }
      }
    }

    const exitCode = await new Promise<number>((resolve) => {
      proc.on('close', resolve)
    })

    const status = exitCode === 0 ? 'success' : 'failure'

    await db('tasks')
      .where({ id: taskId })
      .update({
        status,
        finished_at: new Date(),
        error_message: exitCode !== 0 ? `Exit code: ${exitCode}` : null,
        updated_at: new Date(),
      })

    logger.info({ taskId, status }, 'Task completed')
  } catch (error) {
    logger.error({ error, taskId }, 'Task execution error')

    await db('tasks')
      .where({ id: taskId })
      .update({
        status: 'failure',
        finished_at: new Date(),
        error_message: error instanceof Error ? error.message : 'Unknown error',
        updated_at: new Date(),
      })
  } finally {
    taskEmitters.delete(taskId)
  }
}

export const getTaskStatus = async (taskId: string): Promise<Task | null> => {
  const row = await db('tasks').where({ id: taskId }).first()
  return row ? mapTask(row) : null
}

export const getTaskLogs = async (
  taskId: string,
  limit: number,
  offset: number
): Promise<TaskLog[]> => {
  const rows = await db('task_logs')
    .where({ task_id: taskId })
    .orderBy('timestamp', 'asc')
    .limit(limit)
    .offset(offset)

  return rows.map(mapTaskLog)
}

const createTaskLog = async (
  taskId: string,
  eventType: string,
  data: Record<string, unknown>
): Promise<void> => {
  await db('task_logs').insert({
    id: uuid(),
    task_id: taskId,
    event_type: eventType,
    data: JSON.stringify(data),
  })
}

const mapTask = (row: Record<string, unknown>): Task => ({
  id: row.id as string,
  projectId: row.project_id as string,
  serviceId: row.service_id as string | null,
  prompt: row.prompt as string,
  scope: row.scope as 'project' | 'service',
  readAccess: JSON.parse(row.read_access as string || '[]'),
  writeAccess: JSON.parse(row.write_access as string || '[]'),
  status: row.status as Task['status'],
  startedAt: row.started_at as Date | null,
  finishedAt: row.finished_at as Date | null,
  errorMessage: row.error_message as string | null,
  createdAt: row.created_at as Date,
  updatedAt: row.updated_at as Date,
})

const mapTaskLog = (row: Record<string, unknown>): TaskLog => ({
  id: row.id as string,
  taskId: row.task_id as string,
  timestamp: row.timestamp as Date,
  eventType: row.event_type as string,
  data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data as Record<string, unknown>,
})
