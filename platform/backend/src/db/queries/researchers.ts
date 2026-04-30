import { randomBytes } from 'crypto'
import { v4 as uuid } from 'uuid'
import { db } from '../connection.js'
import {
  Researcher,
  CreateResearcher,
  UpdateResearcher,
  ResearcherRun,
  ResearcherRunStatus,
  ResearcherLog,
  ResearcherStatus,
} from '../../schemas/researcher.js'

// --- DB row interfaces (snake_case) ---

interface DbResearcher {
  id: string
  name: string
  scope_id: string | null
  secret: string
  status: string
  last_heartbeat: Date | null
  config: Record<string, unknown> | string
  created_at: Date
  updated_at: Date
}

interface DbResearcherRun {
  id: string
  researcher_id: string
  instructions: string
  status: string
  response: string | null
  started_at: Date | null
  finished_at: Date | null
  error_message: string | null
  provider: string | null
  model: string | null
  session_id: string | null
  total_cost_usd: number | null
  duration_ms: number | null
  duration_api_ms: number | null
  stop_reason: string | null
  trailer: Record<string, unknown> | string | null
  resume_context: string | null
  parent_run_id: string | null
  created_at: Date
  updated_at: Date
}

interface DbResearcherLog {
  id: string
  run_id: string
  timestamp: Date
  event_type: string
  data: Record<string, unknown> | string
}

// --- Row mappers ---

const parseJson = (v: Record<string, unknown> | string | null | undefined): Record<string, unknown> => {
  if (!v) return {}
  if (typeof v === 'string') {
    try { return JSON.parse(v) } catch { return {} }
  }
  return v
}

const parseNullableJson = (
  v: Record<string, unknown> | string | null | undefined
): Record<string, unknown> | null => {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') {
    if (!v) return null
    try { return JSON.parse(v) } catch { return null }
  }
  return v
}

const toResearcher = (row: DbResearcher): Researcher => ({
  id: row.id,
  name: row.name,
  scopeId: row.scope_id,
  secret: row.secret,
  status: row.status as ResearcherStatus,
  lastHeartbeat: row.last_heartbeat,
  config: parseJson(row.config),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const toRun = (row: DbResearcherRun): ResearcherRun => ({
  id: row.id,
  researcherId: row.researcher_id,
  instructions: row.instructions,
  status: row.status as ResearcherRunStatus,
  response: row.response,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  errorMessage: row.error_message,
  provider: row.provider ?? null,
  model: row.model ?? null,
  sessionId: row.session_id ?? null,
  totalCostUsd: row.total_cost_usd ?? null,
  durationMs: row.duration_ms ?? null,
  durationApiMs: row.duration_api_ms ?? null,
  stopReason: row.stop_reason ?? null,
  trailer: parseNullableJson(row.trailer),
  resumeContext: row.resume_context ?? null,
  parentRunId: row.parent_run_id ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const toLog = (row: DbResearcherLog): ResearcherLog => ({
  id: row.id,
  runId: row.run_id,
  timestamp: row.timestamp,
  eventType: row.event_type,
  data: parseJson(row.data),
})

// --- Secret helper ---

export const generateSecret = (): string => randomBytes(32).toString('hex')

// --- Researcher CRUD ---

export const createResearcher = async (data: CreateResearcher): Promise<Researcher> => {
  const [row] = await db<DbResearcher>('researchers')
    .insert({
      id: uuid(),
      name: data.name,
      scope_id: data.scopeId || null,
      secret: generateSecret(),
      status: 'offline',
      config: JSON.stringify(data.config || {}),
    })
    .returning('*')
  return toResearcher(row)
}

export const listResearchers = async (): Promise<Researcher[]> => {
  const rows = await db<DbResearcher>('researchers').orderBy('created_at', 'desc')
  return rows.map(toResearcher)
}

export const getResearcher = async (id: string): Promise<Researcher | null> => {
  const row = await db<DbResearcher>('researchers').where({ id }).first()
  return row ? toResearcher(row) : null
}

export const updateResearcher = async (
  id: string,
  data: UpdateResearcher & {
    secret?: string
    lastHeartbeat?: Date | null
  }
): Promise<Researcher | null> => {
  const updateData: Partial<DbResearcher> = {}
  if (data.name !== undefined) updateData.name = data.name
  if (data.scopeId !== undefined) updateData.scope_id = data.scopeId
  if (data.status !== undefined) updateData.status = data.status
  if (data.secret !== undefined) updateData.secret = data.secret
  if (data.lastHeartbeat !== undefined) updateData.last_heartbeat = data.lastHeartbeat
  if (data.config !== undefined) updateData.config = JSON.stringify(data.config) as any

  const [row] = await db<DbResearcher>('researchers')
    .where({ id })
    .update({ ...updateData, updated_at: new Date() })
    .returning('*')
  return row ? toResearcher(row) : null
}

export const deleteResearcher = async (id: string): Promise<boolean> => {
  const count = await db<DbResearcher>('researchers').where({ id }).delete()
  return count > 0
}

export const markResearcherDestroyedByName = async (name: string): Promise<number> => {
  return db<DbResearcher>('researchers')
    .where({ name })
    .whereNot({ status: 'destroyed' })
    .update({ status: 'destroyed', updated_at: new Date() })
}

// --- Run CRUD ---

export const createRun = async (
  researcherId: string,
  instructions: string,
  initialStatus: ResearcherRunStatus = 'queued',
  extras: { resumeContext?: string | null; parentRunId?: string | null } = {}
): Promise<ResearcherRun> => {
  const [row] = await db<DbResearcherRun>('researcher_runs')
    .insert({
      id: uuid(),
      researcher_id: researcherId,
      instructions,
      status: initialStatus,
      resume_context: extras.resumeContext ?? null,
      parent_run_id: extras.parentRunId ?? null,
    })
    .returning('*')
  return toRun(row)
}

export const findActiveChildRun = async (
  parentRunId: string
): Promise<ResearcherRun | null> => {
  const row = await db<DbResearcherRun>('researcher_runs')
    .where({ parent_run_id: parentRunId })
    .whereIn('status', ['pending', 'queued', 'running'])
    .orderBy('created_at', 'asc')
    .first()
  return row ? toRun(row) : null
}

export const getLastAssistantText = async (runId: string): Promise<string | null> => {
  const row = await db<DbResearcherLog>('researcher_logs')
    .where({ run_id: runId, event_type: 'assistant' })
    .orderBy('timestamp', 'desc')
    .first()
  if (!row) return null
  const data = parseJson(row.data) as {
    message?: { content?: Array<{ type?: string; text?: string }> }
  }
  const content = data?.message?.content
  if (!Array.isArray(content)) return null
  const text = content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n')
    .trim()
  return text.length > 0 ? text : null
}

export const updateRunInstructions = async (
  id: string,
  instructions: string
): Promise<ResearcherRun | null> => {
  const [row] = await db<DbResearcherRun>('researcher_runs')
    .where({ id })
    .update({ instructions, updated_at: new Date() })
    .returning('*')
  return row ? toRun(row) : null
}

export const getRun = async (id: string): Promise<ResearcherRun | null> => {
  const row = await db<DbResearcherRun>('researcher_runs').where({ id }).first()
  return row ? toRun(row) : null
}

export const listRuns = async (researcherId: string): Promise<ResearcherRun[]> => {
  const rows = await db<DbResearcherRun>('researcher_runs')
    .where({ researcher_id: researcherId })
    .orderBy('created_at', 'desc')
  return rows.map(toRun)
}

export interface UpdateRunInput {
  status?: ResearcherRunStatus
  response?: string | null
  startedAt?: Date | null
  finishedAt?: Date | null
  errorMessage?: string | null
  provider?: string | null
  model?: string | null
  sessionId?: string | null
  totalCostUsd?: number | null
  durationMs?: number | null
  durationApiMs?: number | null
  stopReason?: string | null
  trailer?: Record<string, unknown> | null
}

export const updateRun = async (id: string, data: UpdateRunInput): Promise<ResearcherRun | null> => {
  const updateData: Partial<DbResearcherRun> = {}
  if (data.status !== undefined) updateData.status = data.status
  if (data.response !== undefined) updateData.response = data.response
  if (data.startedAt !== undefined) updateData.started_at = data.startedAt
  if (data.finishedAt !== undefined) updateData.finished_at = data.finishedAt
  if (data.errorMessage !== undefined) updateData.error_message = data.errorMessage
  if (data.provider !== undefined) updateData.provider = data.provider
  if (data.model !== undefined) updateData.model = data.model
  if (data.sessionId !== undefined) updateData.session_id = data.sessionId
  if (data.totalCostUsd !== undefined) updateData.total_cost_usd = data.totalCostUsd
  if (data.durationMs !== undefined) updateData.duration_ms = data.durationMs
  if (data.durationApiMs !== undefined) updateData.duration_api_ms = data.durationApiMs
  if (data.stopReason !== undefined) updateData.stop_reason = data.stopReason
  if (data.trailer !== undefined) {
    updateData.trailer = (data.trailer === null ? null : JSON.stringify(data.trailer)) as any
  }

  const [row] = await db<DbResearcherRun>('researcher_runs')
    .where({ id })
    .update({ ...updateData, updated_at: new Date() })
    .returning('*')
  return row ? toRun(row) : null
}

export const getNextQueuedRun = async (
  researcherId: string
): Promise<ResearcherRun | null> => {
  const row = await db<DbResearcherRun>('researcher_runs')
    .where({ researcher_id: researcherId, status: 'queued' })
    .orderBy('created_at', 'asc')
    .first()
  return row ? toRun(row) : null
}

export const listQueuedRuns = async (researcherId: string): Promise<ResearcherRun[]> => {
  const rows = await db<DbResearcherRun>('researcher_runs')
    .where({ researcher_id: researcherId, status: 'queued' })
    .orderBy('created_at', 'asc')
  return rows.map(toRun)
}

// --- Log CRUD ---

export const createLog = async (
  runId: string,
  eventType: string,
  data: Record<string, unknown>
): Promise<ResearcherLog> => {
  const [row] = await db<DbResearcherLog>('researcher_logs')
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

export const listLogs = async (runId: string): Promise<ResearcherLog[]> => {
  const rows = await db<DbResearcherLog>('researcher_logs')
    .where({ run_id: runId })
    .orderBy('timestamp', 'asc')
  return rows.map(toLog)
}
