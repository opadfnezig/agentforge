import { db, DbCoordinatorChat, DbCoordinatorMessage } from '../connection.js'
import { v4 as uuid } from 'uuid'

export interface Chat {
  id: string
  title: string
  createdAt: Date
  updatedAt: Date
}

export interface Message {
  id: string
  chatId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: Date
}

const toChat = (row: DbCoordinatorChat): Chat => ({
  id: row.id,
  title: row.title,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const toMessage = (row: DbCoordinatorMessage): Message => ({
  id: row.id,
  chatId: row.chat_id,
  role: row.role,
  content: row.content,
  createdAt: row.created_at,
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

export const touchChat = async (id: string): Promise<void> => {
  await db<DbCoordinatorChat>('coordinator_chats')
    .where({ id })
    .update({ updated_at: new Date() })
}

export const addMessage = async (
  chatId: string,
  role: 'user' | 'assistant' | 'system',
  content: string
): Promise<Message> => {
  const [row] = await db<DbCoordinatorMessage>('coordinator_messages')
    .insert({ id: uuid(), chat_id: chatId, role, content })
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
