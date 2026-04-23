import { randomBytes } from 'crypto'
import { v4 as uuid } from 'uuid'
import { db, DbDeveloper, DbDeveloperRun, DbDeveloperLog } from '../connection.js'
import {
  Developer,
  CreateDeveloper,
  UpdateDeveloper,
  DeveloperRun,
  DeveloperLog,
  RunMode,
  RunStatus,
  DeveloperStatus,
} from '../../schemas/developer.js'

// --- Row mappers (snake_case -> camelCase) ---

const parseJson = (v: Record<string, unknown> | string | null | undefined): Record<string, unknown> => {
  if (!v) return {}
  if (typeof v === 'string') {
    try { return JSON.parse(v) } catch { return {} }
  }
  return v
}

const toDeveloper = (row: DbDeveloper): Developer => ({
  id: row.id,
  name: row.name,
  scopeId: row.scope_id,
  workspacePath: row.workspace_path,
  gitRepo: row.git_repo,
  gitBranch: row.git_branch,
  secret: row.secret,
  status: row.status as DeveloperStatus,
  lastHeartbeat: row.last_heartbeat,
  config: parseJson(row.config),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const toRun = (row: DbDeveloperRun): DeveloperRun => ({
  id: row.id,
  developerId: row.developer_id,
  mode: row.mode as RunMode,
  instructions: row.instructions,
  status: row.status as RunStatus,
  gitShaStart: row.git_sha_start,
  gitShaEnd: row.git_sha_end,
  response: row.response,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  errorMessage: row.error_message,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const toLog = (row: DbDeveloperLog): DeveloperLog => ({
  id: row.id,
  runId: row.run_id,
  timestamp: row.timestamp,
  eventType: row.event_type,
  data: parseJson(row.data),
})

// --- Secret helper ---

export const generateSecret = (): string => randomBytes(32).toString('hex')

// --- Developer CRUD ---

export const createDeveloper = async (data: CreateDeveloper): Promise<Developer> => {
  const [row] = await db<DbDeveloper>('developers')
    .insert({
      id: uuid(),
      name: data.name,
      scope_id: data.scopeId || null,
      workspace_path: data.workspacePath,
      git_repo: data.gitRepo || null,
      git_branch: data.gitBranch || 'main',
      secret: generateSecret(),
      status: 'offline',
      config: JSON.stringify(data.config || {}),
    })
    .returning('*')
  return toDeveloper(row)
}

export const listDevelopers = async (): Promise<Developer[]> => {
  const rows = await db<DbDeveloper>('developers').orderBy('created_at', 'desc')
  return rows.map(toDeveloper)
}

export const getDeveloper = async (id: string): Promise<Developer | null> => {
  const row = await db<DbDeveloper>('developers').where({ id }).first()
  return row ? toDeveloper(row) : null
}

export const updateDeveloper = async (
  id: string,
  data: UpdateDeveloper & {
    secret?: string
    lastHeartbeat?: Date | null
  }
): Promise<Developer | null> => {
  const updateData: Partial<DbDeveloper> = {}
  if (data.name !== undefined) updateData.name = data.name
  if (data.scopeId !== undefined) updateData.scope_id = data.scopeId
  if (data.workspacePath !== undefined) updateData.workspace_path = data.workspacePath
  if (data.gitRepo !== undefined) updateData.git_repo = data.gitRepo
  if (data.gitBranch !== undefined) updateData.git_branch = data.gitBranch
  if (data.status !== undefined) updateData.status = data.status
  if (data.secret !== undefined) updateData.secret = data.secret
  if (data.lastHeartbeat !== undefined) updateData.last_heartbeat = data.lastHeartbeat
  if (data.config !== undefined) updateData.config = JSON.stringify(data.config) as any

  const [row] = await db<DbDeveloper>('developers')
    .where({ id })
    .update({ ...updateData, updated_at: new Date() })
    .returning('*')
  return row ? toDeveloper(row) : null
}

export const deleteDeveloper = async (id: string): Promise<boolean> => {
  const count = await db<DbDeveloper>('developers').where({ id }).delete()
  return count > 0
}

// --- Run CRUD ---

export const createRun = async (
  developerId: string,
  instructions: string,
  mode: RunMode = 'implement'
): Promise<DeveloperRun> => {
  const [row] = await db<DbDeveloperRun>('developer_runs')
    .insert({
      id: uuid(),
      developer_id: developerId,
      mode,
      instructions,
      status: 'pending',
    })
    .returning('*')
  return toRun(row)
}

export const getRun = async (id: string): Promise<DeveloperRun | null> => {
  const row = await db<DbDeveloperRun>('developer_runs').where({ id }).first()
  return row ? toRun(row) : null
}

export const listRuns = async (developerId: string): Promise<DeveloperRun[]> => {
  const rows = await db<DbDeveloperRun>('developer_runs')
    .where({ developer_id: developerId })
    .orderBy('created_at', 'desc')
  return rows.map(toRun)
}

export interface UpdateRunInput {
  status?: RunStatus
  gitShaStart?: string | null
  gitShaEnd?: string | null
  response?: string | null
  startedAt?: Date | null
  finishedAt?: Date | null
  errorMessage?: string | null
}

export const updateRun = async (id: string, data: UpdateRunInput): Promise<DeveloperRun | null> => {
  const updateData: Partial<DbDeveloperRun> = {}
  if (data.status !== undefined) updateData.status = data.status
  if (data.gitShaStart !== undefined) updateData.git_sha_start = data.gitShaStart
  if (data.gitShaEnd !== undefined) updateData.git_sha_end = data.gitShaEnd
  if (data.response !== undefined) updateData.response = data.response
  if (data.startedAt !== undefined) updateData.started_at = data.startedAt
  if (data.finishedAt !== undefined) updateData.finished_at = data.finishedAt
  if (data.errorMessage !== undefined) updateData.error_message = data.errorMessage

  const [row] = await db<DbDeveloperRun>('developer_runs')
    .where({ id })
    .update({ ...updateData, updated_at: new Date() })
    .returning('*')
  return row ? toRun(row) : null
}

// --- Log CRUD ---

export const createLog = async (
  runId: string,
  eventType: string,
  data: Record<string, unknown>
): Promise<DeveloperLog> => {
  const [row] = await db<DbDeveloperLog>('developer_logs')
    .insert({
      id: uuid(),
      run_id: runId,
      event_type: eventType,
      data: JSON.stringify(data) as any,
      timestamp: new Date(),
    })
    .returning('*')
  return toLog(row)
}

export const listLogs = async (runId: string): Promise<DeveloperLog[]> => {
  const rows = await db<DbDeveloperLog>('developer_logs')
    .where({ run_id: runId })
    .orderBy('timestamp', 'asc')
  return rows.map(toLog)
}
