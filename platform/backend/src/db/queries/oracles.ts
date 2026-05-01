import { randomBytes } from 'crypto'
import { db, DbOracle, DbOracleQuery, DbOracleLog, DbOracleChat } from '../connection.js'
import {
  Oracle,
  CreateOracle,
  UpdateOracle,
  OracleQuery,
  OracleQueryStatus,
  OracleMode,
  OracleLog,
  OracleChat,
  CreateOracleChat,
  UpdateOracleChat,
} from '../../schemas/oracle.js'
import { v4 as uuid } from 'uuid'
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'

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

const toOracle = (row: DbOracle): Oracle => ({
  id: row.id,
  scopeId: row.scope_id,
  name: row.name,
  domain: row.domain,
  description: row.description,
  stateDir: row.state_dir,
  status: row.status as Oracle['status'],
  secret: row.secret ?? null,
  config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export const generateSecret = (): string => randomBytes(32).toString('hex')

const toOracleQuery = (row: DbOracleQuery): OracleQuery => ({
  id: row.id,
  oracleId: row.oracle_id,
  mode: (row.mode || 'read') as OracleMode,
  message: row.message,
  response: row.response,
  status: row.status as OracleQueryStatus,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  errorMessage: row.error_message,
  provider: row.provider,
  model: row.model,
  sessionId: row.session_id,
  totalCostUsd: row.total_cost_usd,
  durationMs: row.duration_ms,
  durationApiMs: row.duration_api_ms,
  stopReason: row.stop_reason,
  trailer: parseNullableJson(row.trailer),
  resumeContext: row.resume_context,
  parentQueryId: row.parent_query_id,
  chatId: row.chat_id ?? null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const toOracleChat = (row: DbOracleChat): OracleChat => ({
  id: row.id,
  oracleId: row.oracle_id,
  title: row.title,
  claudeSessionId: row.claude_session_id,
  lastMessageAt: row.last_message_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const toOracleLog = (row: DbOracleLog): OracleLog => ({
  id: row.id,
  queryId: row.query_id,
  timestamp: row.timestamp,
  eventType: row.event_type,
  data: parseJson(row.data),
})

export const createOracle = async (data: CreateOracle): Promise<Oracle> => {
  const [row] = await db<DbOracle>('oracles')
    .insert({
      id: uuid(),
      scope_id: data.scopeId || null,
      name: data.name,
      domain: data.domain,
      description: data.description || null,
      state_dir: data.stateDir,
      secret: generateSecret(),
      config: JSON.stringify(data.config || {}),
    })
    .returning('*')
  return toOracle(row)
}

export const getOracleByName = async (name: string): Promise<Oracle | null> => {
  const row = await db<DbOracle>('oracles').where({ name }).first()
  return row ? toOracle(row) : null
}

export const getOracleByDomain = async (domain: string): Promise<Oracle | null> => {
  const row = await db<DbOracle>('oracles').where({ domain }).first()
  return row ? toOracle(row) : null
}

// Lazily generate + persist a secret for legacy rows that pre-date the
// secret column. Returns the up-to-date secret (existing or newly minted).
export const ensureOracleSecret = async (id: string): Promise<string | null> => {
  const oracle = await getOracle(id)
  if (!oracle) return null
  if (oracle.secret) return oracle.secret
  const secret = generateSecret()
  await db<DbOracle>('oracles')
    .where({ id })
    .update({ secret, updated_at: new Date() })
  return secret
}

export const listOracles = async (): Promise<Oracle[]> => {
  const rows = await db<DbOracle>('oracles').orderBy('created_at', 'desc')
  return rows.map(toOracle)
}

export const getOracle = async (id: string): Promise<Oracle | null> => {
  const row = await db<DbOracle>('oracles').where({ id }).first()
  return row ? toOracle(row) : null
}

export const updateOracle = async (
  id: string,
  data: UpdateOracle
): Promise<Oracle | null> => {
  const updateData: Partial<DbOracle> = {}
  if (data.scopeId !== undefined) updateData.scope_id = data.scopeId
  if (data.name !== undefined) updateData.name = data.name
  if (data.domain !== undefined) updateData.domain = data.domain
  if (data.description !== undefined) updateData.description = data.description
  if (data.stateDir !== undefined) updateData.state_dir = data.stateDir
  if (data.status !== undefined) updateData.status = data.status
  if (data.config !== undefined) updateData.config = JSON.stringify(data.config) as any

  const [row] = await db<DbOracle>('oracles')
    .where({ id })
    .update({ ...updateData, updated_at: new Date() })
    .returning('*')
  return row ? toOracle(row) : null
}

export const deleteOracle = async (id: string): Promise<boolean> => {
  const count = await db<DbOracle>('oracles').where({ id }).delete()
  return count > 0
}

export interface OracleStateFile {
  name: string
  content: string
}

// Recursively walk stateDir and return all .md files with their relative
// paths. Used by the UI to render the file tree (index.md + topic files +
// subdirectories).
export const getOracleStateFiles = async (stateDir: string): Promise<OracleStateFile[]> => {
  const out: OracleStateFile[] = []
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries: import('fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true }) as import('fs').Dirent[]
    } catch {
      return
    }
    for (const entry of entries) {
      const name = entry.name as string
      const rel = prefix ? `${prefix}/${name}` : name
      const abs = join(dir, name)
      if (entry.isDirectory()) {
        await walk(abs, rel)
      } else if (entry.isFile() && name.endsWith('.md')) {
        try {
          const content = await readFile(abs, 'utf-8')
          out.push({ name: rel, content })
        } catch { /* skip */ }
      }
    }
  }
  await walk(stateDir, '')
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

// Backward-compatible: concatenate all files into one big markdown blob.
export const getOracleState = async (stateDir: string): Promise<string> => {
  const files = await getOracleStateFiles(stateDir)
  return files.map((f) => `# ${f.name}\n\n${f.content}`).join('\n\n---\n\n')
}

// --- Oracle query CRUD ---

export interface CreateOracleQueryInput {
  oracleId: string
  mode: OracleMode
  message: string
  status: OracleQueryStatus
  resumeContext?: string | null
  parentQueryId?: string | null
  chatId?: string | null
}

export const createOracleQuery = async (
  input: CreateOracleQueryInput
): Promise<OracleQuery> => {
  const [row] = await db<DbOracleQuery>('oracle_queries')
    .insert({
      id: uuid(),
      oracle_id: input.oracleId,
      mode: input.mode,
      message: input.message,
      response: null,
      duration_ms: null,
      status: input.status,
      resume_context: input.resumeContext ?? null,
      parent_query_id: input.parentQueryId ?? null,
      chat_id: input.chatId ?? null,
    })
    .returning('*')
  return toOracleQuery(row)
}

export const getOracleQuery = async (id: string): Promise<OracleQuery | null> => {
  const row = await db<DbOracleQuery>('oracle_queries').where({ id }).first()
  return row ? toOracleQuery(row) : null
}

export const listOracleQueries = async (oracleId: string): Promise<OracleQuery[]> => {
  const rows = await db<DbOracleQuery>('oracle_queries')
    .where({ oracle_id: oracleId })
    .orderBy('created_at', 'desc')
  return rows.map(toOracleQuery)
}

export const getNextQueuedOracleQuery = async (
  oracleId: string
): Promise<OracleQuery | null> => {
  const row = await db<DbOracleQuery>('oracle_queries')
    .where({ oracle_id: oracleId, status: 'queued' })
    .orderBy('created_at', 'asc')
    .first()
  return row ? toOracleQuery(row) : null
}

export const listQueuedOracleQueries = async (
  oracleId: string
): Promise<OracleQuery[]> => {
  const rows = await db<DbOracleQuery>('oracle_queries')
    .where({ oracle_id: oracleId, status: 'queued' })
    .orderBy('created_at', 'asc')
  return rows.map(toOracleQuery)
}

export const findActiveChildOracleQuery = async (
  parentQueryId: string
): Promise<OracleQuery | null> => {
  const row = await db<DbOracleQuery>('oracle_queries')
    .where({ parent_query_id: parentQueryId })
    .whereIn('status', ['pending', 'queued', 'running'])
    .orderBy('created_at', 'asc')
    .first()
  return row ? toOracleQuery(row) : null
}

export const updateOracleQueryMessage = async (
  id: string,
  message: string
): Promise<OracleQuery | null> => {
  const [row] = await db<DbOracleQuery>('oracle_queries')
    .where({ id })
    .update({ message, updated_at: new Date() })
    .returning('*')
  return row ? toOracleQuery(row) : null
}

export interface UpdateOracleQueryInput {
  status?: OracleQueryStatus
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

export const updateOracleQuery = async (
  id: string,
  data: UpdateOracleQueryInput
): Promise<OracleQuery | null> => {
  const update: Partial<DbOracleQuery> = {}
  if (data.status !== undefined) update.status = data.status
  if (data.response !== undefined) update.response = data.response
  if (data.startedAt !== undefined) update.started_at = data.startedAt
  if (data.finishedAt !== undefined) update.finished_at = data.finishedAt
  if (data.errorMessage !== undefined) update.error_message = data.errorMessage
  if (data.provider !== undefined) update.provider = data.provider
  if (data.model !== undefined) update.model = data.model
  if (data.sessionId !== undefined) update.session_id = data.sessionId
  if (data.totalCostUsd !== undefined) update.total_cost_usd = data.totalCostUsd
  if (data.durationMs !== undefined) update.duration_ms = data.durationMs
  if (data.durationApiMs !== undefined) update.duration_api_ms = data.durationApiMs
  if (data.stopReason !== undefined) update.stop_reason = data.stopReason
  if (data.trailer !== undefined) {
    update.trailer = (data.trailer === null ? null : JSON.stringify(data.trailer)) as any
  }

  const [row] = await db<DbOracleQuery>('oracle_queries')
    .where({ id })
    .update({ ...update, updated_at: new Date() })
    .returning('*')
  return row ? toOracleQuery(row) : null
}

// --- Oracle log CRUD ---

export const createOracleLog = async (
  queryId: string,
  eventType: string,
  data: Record<string, unknown>
): Promise<OracleLog> => {
  const [row] = await db<DbOracleLog>('oracle_logs')
    .insert({
      id: uuid(),
      query_id: queryId,
      event_type: eventType,
      data: JSON.stringify(data) as any,
      timestamp: new Date(),
    })
    .returning('*')
  return toOracleLog(row)
}

export const listOracleLogs = async (queryId: string): Promise<OracleLog[]> => {
  const rows = await db<DbOracleLog>('oracle_logs')
    .where({ query_id: queryId })
    .orderBy('timestamp', 'asc')
  return rows.map(toOracleLog)
}

export const getOracleQueryLastAssistantText = async (
  queryId: string
): Promise<string | null> => {
  const row = await db<DbOracleLog>('oracle_logs')
    .where({ query_id: queryId, event_type: 'assistant' })
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

// --- Oracle chat CRUD ---

export const createOracleChat = async (
  data: CreateOracleChat & { claudeSessionId?: string | null; firstMessageAt?: Date | null }
): Promise<OracleChat> => {
  const [row] = await db<DbOracleChat>('oracle_chats')
    .insert({
      id: uuid(),
      oracle_id: data.oracleId,
      title: data.title ?? null,
      claude_session_id: data.claudeSessionId ?? null,
      last_message_at: data.firstMessageAt ?? null,
    })
    .returning('*')
  return toOracleChat(row)
}

export const getOracleChat = async (id: string): Promise<OracleChat | null> => {
  const row = await db<DbOracleChat>('oracle_chats').where({ id }).first()
  return row ? toOracleChat(row) : null
}

export const listOracleChats = async (oracleId: string): Promise<OracleChat[]> => {
  const rows = await db<DbOracleChat>('oracle_chats')
    .where({ oracle_id: oracleId })
    .orderBy('last_message_at', 'desc')
    .orderBy('created_at', 'desc')
  return rows.map(toOracleChat)
}

export const updateOracleChat = async (
  id: string,
  data: UpdateOracleChat & {
    claudeSessionId?: string | null
    lastMessageAt?: Date | null
  }
): Promise<OracleChat | null> => {
  const update: Partial<DbOracleChat> = {}
  if (data.title !== undefined) update.title = data.title
  if (data.claudeSessionId !== undefined) update.claude_session_id = data.claudeSessionId
  if (data.lastMessageAt !== undefined) update.last_message_at = data.lastMessageAt

  const [row] = await db<DbOracleChat>('oracle_chats')
    .where({ id })
    .update({ ...update, updated_at: new Date() })
    .returning('*')
  return row ? toOracleChat(row) : null
}

export const deleteOracleChat = async (id: string): Promise<boolean> => {
  const count = await db<DbOracleChat>('oracle_chats').where({ id }).delete()
  return count > 0
}

// Pick the most recent terminal query in a chat that captured a session_id —
// that's the resume point for the next turn. Falls back to chat.claude_session_id
// (set when chat was created from an existing query).
export const getChatResumeSessionId = async (chatId: string): Promise<string | null> => {
  const row = await db<DbOracleQuery>('oracle_queries')
    .where({ chat_id: chatId })
    .whereNotNull('session_id')
    .orderBy('created_at', 'desc')
    .first()
  if (row?.session_id) return row.session_id
  const chat = await db<DbOracleChat>('oracle_chats').where({ id: chatId }).first()
  return chat?.claude_session_id ?? null
}

export const listOracleChatQueries = async (chatId: string): Promise<OracleQuery[]> => {
  const rows = await db<DbOracleQuery>('oracle_queries')
    .where({ chat_id: chatId })
    .orderBy('created_at', 'asc')
  return rows.map(toOracleQuery)
}

// Attach an existing query to a chat (used by promote-to-chat). Plain
// chat_id update — separate helper because UpdateOracleQueryInput
// intentionally doesn't expose chat_id (chats are owned, not retargeted).
export const setQueryChatId = async (
  queryId: string,
  chatId: string
): Promise<OracleQuery | null> => {
  const [row] = await db<DbOracleQuery>('oracle_queries')
    .where({ id: queryId })
    .update({ chat_id: chatId, updated_at: new Date() })
    .returning('*')
  return row ? toOracleQuery(row) : null
}
