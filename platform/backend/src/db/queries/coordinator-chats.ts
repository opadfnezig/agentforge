import { db, DbCoordinatorChat, DbCoordinatorMessage } from '../connection.js'
import { v4 as uuid } from 'uuid'

export interface Chat {
  id: string
  title: string
  createdAt: Date
  updatedAt: Date
  totalCostUsd: number
  totalDurationMs: number
  billedMessageCount: number
}

export interface Message {
  id: string
  chatId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: Date
  provider: string | null
  model: string | null
  totalCostUsd: number | null
  durationMs: number | null
  stopReason: string | null
  trailer: Record<string, unknown> | null
}

const parseNullableJson = (
  v: Record<string, unknown> | string | null | undefined,
): Record<string, unknown> | null => {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') {
    if (!v) return null
    try { return JSON.parse(v) } catch { return null }
  }
  return v
}

const toChat = (row: DbCoordinatorChat): Chat => ({
  id: row.id,
  title: row.title,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  totalCostUsd: Number(row.total_cost_usd ?? 0),
  totalDurationMs: Number(row.total_duration_ms ?? 0),
  billedMessageCount: row.billed_message_count ?? 0,
})

const toMessage = (row: DbCoordinatorMessage): Message => ({
  id: row.id,
  chatId: row.chat_id,
  role: row.role,
  content: row.content,
  createdAt: row.created_at,
  provider: row.provider ?? null,
  model: row.model ?? null,
  totalCostUsd: row.total_cost_usd ?? null,
  durationMs: row.duration_ms ?? null,
  stopReason: row.stop_reason ?? null,
  trailer: parseNullableJson(row.trailer),
})

export const createChat = async (title: string): Promise<Chat> => {
  const [row] = await db<DbCoordinatorChat>('coordinator_chats')
    .insert({ id: uuid(), title })
    .returning('*')
  return toChat(row)
}

export const listChats = async (): Promise<Chat[]> => {
  const rows = await db<DbCoordinatorChat>('coordinator_chats')
    .orderBy('updated_at', 'desc')
  return rows.map(toChat)
}

export const getChat = async (id: string): Promise<Chat | null> => {
  const row = await db<DbCoordinatorChat>('coordinator_chats').where({ id }).first()
  return row ? toChat(row) : null
}

export const deleteChat = async (id: string): Promise<boolean> => {
  const count = await db<DbCoordinatorChat>('coordinator_chats').where({ id }).delete()
  return count > 0
}

export interface TouchChatAggregates {
  addCostUsd?: number
  addDurationMs?: number
}

export const touchChat = async (
  id: string,
  aggregates: TouchChatAggregates = {},
): Promise<void> => {
  const cost = aggregates.addCostUsd ?? 0
  const dur = aggregates.addDurationMs ?? 0
  if (cost === 0 && dur === 0) {
    await db<DbCoordinatorChat>('coordinator_chats')
      .where({ id })
      .update({ updated_at: new Date() })
    return
  }
  await db<DbCoordinatorChat>('coordinator_chats')
    .where({ id })
    .update({
      updated_at: new Date(),
      total_cost_usd: db.raw('total_cost_usd + ?', [cost]),
      total_duration_ms: db.raw('total_duration_ms + ?', [dur]),
      billed_message_count: db.raw('billed_message_count + 1'),
    })
}

export interface AddMessageTrailer {
  provider?: string | null
  model?: string | null
  totalCostUsd?: number | null
  durationMs?: number | null
  stopReason?: string | null
  trailer?: Record<string, unknown> | null
}

export const addMessage = async (
  chatId: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
  trailerInfo: AddMessageTrailer = {},
): Promise<Message> => {
  const insert: Partial<DbCoordinatorMessage> & { id: string; chat_id: string; role: string; content: string } = {
    id: uuid(),
    chat_id: chatId,
    role,
    content,
  }
  if (trailerInfo.provider !== undefined) insert.provider = trailerInfo.provider
  if (trailerInfo.model !== undefined) insert.model = trailerInfo.model
  if (trailerInfo.totalCostUsd !== undefined) insert.total_cost_usd = trailerInfo.totalCostUsd
  if (trailerInfo.durationMs !== undefined) insert.duration_ms = trailerInfo.durationMs
  if (trailerInfo.stopReason !== undefined) insert.stop_reason = trailerInfo.stopReason
  if (trailerInfo.trailer !== undefined) {
    insert.trailer = (trailerInfo.trailer === null
      ? null
      : JSON.stringify(trailerInfo.trailer)) as any
  }
  const [row] = await db<DbCoordinatorMessage>('coordinator_messages')
    .insert(insert as any)
    .returning('*')
  return toMessage(row)
}

export const getMessages = async (chatId: string): Promise<Message[]> => {
  const rows = await db<DbCoordinatorMessage>('coordinator_messages')
    .where({ chat_id: chatId })
    .orderBy('created_at', 'asc')
  return rows.map(toMessage)
}

// Deletes the message and every message after it in the same chat (rewind).
// Returns number of rows deleted, or null if the anchor message wasn't found.
export const deleteMessageAndAfter = async (
  chatId: string,
  messageId: string
): Promise<number | null> => {
  const anchor = await db<DbCoordinatorMessage>('coordinator_messages')
    .where({ id: messageId, chat_id: chatId })
    .first()
  if (!anchor) return null
  const count = await db<DbCoordinatorMessage>('coordinator_messages')
    .where('chat_id', chatId)
    .andWhere('created_at', '>=', anchor.created_at)
    .delete()
  return count
}
