import { db, DbBuild, DbActionRun, DbAgentLog, DbFileChange } from '../connection.js'
import { Build, ActionRun, AgentLog, FileChange } from '../../schemas/build.js'
import { v4 as uuid } from 'uuid'

const toBuild = (row: DbBuild): Build => ({
  id: row.id,
  projectId: row.project_id,
  status: row.status as Build['status'],
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const toActionRun = (row: DbActionRun): ActionRun => ({
  id: row.id,
  actionId: row.action_id,
  buildId: row.build_id,
  status: row.status as ActionRun['status'],
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  errorMessage: row.error_message,
  retryCount: row.retry_count,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const toAgentLog = (row: DbAgentLog): AgentLog => ({
  id: row.id,
  actionRunId: row.action_run_id,
  timestamp: row.timestamp,
  eventType: row.event_type as AgentLog['eventType'],
  data: row.data,
})

const toFileChange = (row: DbFileChange): FileChange => ({
  id: row.id,
  actionRunId: row.action_run_id,
  timestamp: row.timestamp,
  filePath: row.file_path,
  changeType: row.change_type as FileChange['changeType'],
  diff: row.diff,
  contentSnapshot: row.content_snapshot,
})

// Builds
export const createBuild = async (projectId: string): Promise<Build> => {
  const [row] = await db<DbBuild>('builds')
    .insert({
      id: uuid(),
      project_id: projectId,
    })
    .returning('*')
  return toBuild(row)
}

export const getBuild = async (
  projectId: string,
  buildId: string
): Promise<Build | null> => {
  const row = await db<DbBuild>('builds')
    .where({ id: buildId, project_id: projectId })
    .first()
  return row ? toBuild(row) : null
}

export const listBuilds = async (projectId: string): Promise<Build[]> => {
  const rows = await db<DbBuild>('builds')
    .where({ project_id: projectId })
    .orderBy('created_at', 'desc')
  return rows.map(toBuild)
}

export const updateBuild = async (
  buildId: string,
  data: Partial<Pick<Build, 'status' | 'startedAt' | 'finishedAt'>>
): Promise<Build | null> => {
  const updateData: Partial<DbBuild> = {}
  if (data.status !== undefined) updateData.status = data.status
  if (data.startedAt !== undefined) updateData.started_at = data.startedAt
  if (data.finishedAt !== undefined) updateData.finished_at = data.finishedAt

  const [row] = await db<DbBuild>('builds')
    .where({ id: buildId })
    .update({ ...updateData, updated_at: new Date() })
    .returning('*')
  return row ? toBuild(row) : null
}

// Action Runs
export const createActionRun = async (
  actionId: string,
  buildId: string
): Promise<ActionRun> => {
  const [row] = await db<DbActionRun>('action_runs')
    .insert({
      id: uuid(),
      action_id: actionId,
      build_id: buildId,
    })
    .returning('*')
  return toActionRun(row)
}

export const getActionRun = async (runId: string): Promise<ActionRun | null> => {
  const row = await db<DbActionRun>('action_runs').where({ id: runId }).first()
  return row ? toActionRun(row) : null
}

export const listActionRuns = async (buildId: string): Promise<ActionRun[]> => {
  const rows = await db<DbActionRun>('action_runs')
    .where({ build_id: buildId })
    .orderBy('created_at', 'asc')
  return rows.map(toActionRun)
}

export const updateActionRun = async (
  runId: string,
  data: Partial<Pick<ActionRun, 'status' | 'startedAt' | 'finishedAt' | 'errorMessage' | 'retryCount'>>
): Promise<ActionRun | null> => {
  const updateData: Partial<DbActionRun> = {}
  if (data.status !== undefined) updateData.status = data.status
  if (data.startedAt !== undefined) updateData.started_at = data.startedAt
  if (data.finishedAt !== undefined) updateData.finished_at = data.finishedAt
  if (data.errorMessage !== undefined) updateData.error_message = data.errorMessage
  if (data.retryCount !== undefined) updateData.retry_count = data.retryCount

  const [row] = await db<DbActionRun>('action_runs')
    .where({ id: runId })
    .update({ ...updateData, updated_at: new Date() })
    .returning('*')
  return row ? toActionRun(row) : null
}

// Agent Logs
export const createAgentLog = async (
  actionRunId: string,
  eventType: string,
  data: Record<string, unknown>
): Promise<AgentLog> => {
  const [row] = await db<DbAgentLog>('agent_logs')
    .insert({
      id: uuid(),
      action_run_id: actionRunId,
      event_type: eventType,
      data,
    })
    .returning('*')
  return toAgentLog(row)
}

export const listAgentLogs = async (
  actionRunId: string,
  limit = 100,
  offset = 0
): Promise<AgentLog[]> => {
  const rows = await db<DbAgentLog>('agent_logs')
    .where({ action_run_id: actionRunId })
    .orderBy('timestamp', 'asc')
    .limit(limit)
    .offset(offset)
  return rows.map(toAgentLog)
}

export const getRecentLogs = async (
  actionRunId: string,
  count = 50
): Promise<AgentLog[]> => {
  const rows = await db<DbAgentLog>('agent_logs')
    .where({ action_run_id: actionRunId })
    .orderBy('timestamp', 'desc')
    .limit(count)
  return rows.reverse().map(toAgentLog)
}

// File Changes
export const createFileChange = async (
  actionRunId: string,
  data: {
    filePath: string
    changeType: 'create' | 'modify' | 'delete'
    diff?: string
    contentSnapshot?: string
  }
): Promise<FileChange> => {
  const [row] = await db<DbFileChange>('file_changes')
    .insert({
      id: uuid(),
      action_run_id: actionRunId,
      file_path: data.filePath,
      change_type: data.changeType,
      diff: data.diff || null,
      content_snapshot: data.contentSnapshot || null,
    })
    .returning('*')
  return toFileChange(row)
}

export const listFileChanges = async (actionRunId: string): Promise<FileChange[]> => {
  const rows = await db<DbFileChange>('file_changes')
    .where({ action_run_id: actionRunId })
    .orderBy('timestamp', 'asc')
  return rows.map(toFileChange)
}
