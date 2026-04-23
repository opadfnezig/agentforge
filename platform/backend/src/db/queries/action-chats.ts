import { db, DbActionChat } from '../connection.js'
import { v4 as uuid } from 'uuid'

export interface ChatMessage {
  id: string
  actionId: string
  role: 'user' | 'assistant'
  content: string
  createdAt: Date
}

export interface CreateChatMessage {
  role: 'user' | 'assistant'
  content: string
}

const toChatMessage = (row: DbActionChat): ChatMessage => ({
  id: row.id,
  actionId: row.action_id,
  role: row.role,
  content: row.content,
  createdAt: row.created_at,
})

export const createMessage = async (
  actionId: string,
  data: CreateChatMessage
): Promise<ChatMessage> => {
  const [row] = await db<DbActionChat>('action_chats')
    .insert({
      id: uuid(),
      action_id: actionId,
      role: data.role,
      content: data.content,
    })
    .returning('*')
  return toChatMessage(row)
}

export const listMessages = async (actionId: string): Promise<ChatMessage[]> => {
  const rows = await db<DbActionChat>('action_chats')
    .where({ action_id: actionId })
    .orderBy('created_at', 'asc')
  return rows.map(toChatMessage)
}

export const deleteMessages = async (actionId: string): Promise<boolean> => {
  const count = await db<DbActionChat>('action_chats')
    .where({ action_id: actionId })
    .delete()
  return count > 0
}
