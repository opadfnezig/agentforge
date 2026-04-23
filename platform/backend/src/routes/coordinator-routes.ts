import { Router } from 'express'
import { run, type CoordinatorEvent } from '../services/coordinator.js'
import { mergeIntoState } from '../services/oracle-engine.js'
import * as oracleQueries from '../db/queries/oracles.js'
import * as chatDb from '../db/queries/coordinator-chats.js'
import { AppError } from '../utils/error-handler.js'
import { logger } from '../utils/logger.js'

export const coordinatorRouter = Router()

interface SaveCommand {
  domain: string
  data: string
}

const parseSaveCommands = (message: string): { saves: SaveCommand[]; remaining: string } => {
  const saves: SaveCommand[] = []
  const remaining = message.replace(
    /\[save,\s*([^\]]+)\]\s*\n([\s\S]*?)\n\[end\]/gi,
    (_, domain, data) => {
      saves.push({ domain: domain.trim(), data: data.trim() })
      return ''
    }
  ).trim()
  return { saves, remaining }
}

const sendSSE = (res: any, event: CoordinatorEvent) => {
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

// --- Chat CRUD ---

coordinatorRouter.get('/chats', async (_req, res, next) => {
  try {
    res.json(await chatDb.listChats())
  } catch (error) { next(error) }
})

coordinatorRouter.post('/chats', async (req, res, next) => {
  try {
    const chat = await chatDb.createChat(req.body.title || 'New chat')
    res.status(201).json(chat)
  } catch (error) { next(error) }
})

coordinatorRouter.get('/chats/:id', async (req, res, next) => {
  try {
    const chat = await chatDb.getChat(req.params.id)
    if (!chat) throw new AppError(404, 'Chat not found', 'NOT_FOUND')
    const messages = await chatDb.getMessages(chat.id)
    res.json({ ...chat, messages })
  } catch (error) { next(error) }
})

coordinatorRouter.delete('/chats/:id', async (req, res, next) => {
  try {
    const deleted = await chatDb.deleteChat(req.params.id)
    if (!deleted) throw new AppError(404, 'Chat not found', 'NOT_FOUND')
    res.json({ ok: true })
  } catch (error) { next(error) }
})

// Rewind: delete a message and all subsequent messages in the chat
coordinatorRouter.delete('/chats/:id/messages/:messageId', async (req, res, next) => {
  try {
    const count = await chatDb.deleteMessageAndAfter(req.params.id, req.params.messageId)
    if (count === null) throw new AppError(404, 'Message not found', 'NOT_FOUND')
    await chatDb.touchChat(req.params.id)
    res.json({ deleted: count })
  } catch (error) { next(error) }
})

// --- Save to oracles ---

coordinatorRouter.post('/chats/:id/save', async (req, res, next) => {
  try {
    const { message } = req.body
    if (!message || typeof message !== 'string') {
      throw new AppError(400, 'message is required', 'INVALID_INPUT')
    }

    const chat = await chatDb.getChat(req.params.id)
    if (!chat) throw new AppError(404, 'Chat not found', 'NOT_FOUND')

    const { saves } = parseSaveCommands(message)
    if (saves.length === 0) {
      throw new AppError(400, 'No [save, domain] commands found', 'NO_SAVE_COMMANDS')
    }

    await chatDb.addMessage(chat.id, 'user', message)

    const allOracles = await oracleQueries.listOracles()
    const oraclesByDomain = new Map(allOracles.map((o) => [o.domain, o]))

    const results: { domain: string; status: string; error?: string }[] = []

    for (const save of saves) {
      const oracle = oraclesByDomain.get(save.domain)
      if (!oracle) {
        results.push({ domain: save.domain, status: 'error', error: `Oracle "${save.domain}" not found` })
        continue
      }
      try {
        await mergeIntoState(oracle.id, save.data)
        results.push({ domain: save.domain, status: 'merged' })
        logger.info({ domain: save.domain }, 'Save processed')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        results.push({ domain: save.domain, status: 'error', error: msg })
      }
    }

    const summary = results
      .map((r) => r.status === 'merged' ? `[${r.domain}] merged` : `[${r.domain}] error: ${r.error}`)
      .join('\n')
    await chatDb.addMessage(chat.id, 'system', summary)
    await chatDb.touchChat(chat.id)

    res.json({ results })
  } catch (error) { next(error) }
})

// --- Chat message (SSE stream) ---

coordinatorRouter.post('/chats/:id/message', async (req, res, next) => {
  try {
    const { message } = req.body
    if (!message || typeof message !== 'string') {
      throw new AppError(400, 'message is required', 'INVALID_INPUT')
    }

    const chat = await chatDb.getChat(req.params.id)
    if (!chat) throw new AppError(404, 'Chat not found', 'NOT_FOUND')

    const priorMessages = await chatDb.getMessages(chat.id)
    const history = priorMessages.map((m) => ({
      role: m.role,
      // Strip persisted oracle sentinel so it doesn't leak into the next prompt
      content: m.content.replace(/\n\n<!--ORACLES:[\s\S]*?:ORACLES-->\s*$/, ''),
    }))

    await chatDb.addMessage(chat.id, 'user', message)

    logger.info({ chatId: chat.id, historyLength: history.length }, 'Coordinator message')

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')

    const collectedOracles: { domain: string; question: string; response: string }[] = []

    const fullText = await run(message, history, (event) => {
      if (event.type === 'oracle') {
        collectedOracles.push({ domain: event.domain, question: event.question, response: event.response })
      }
      sendSSE(res, event)
    })

    // Persist — append oracle data as JSON sentinel so citations expand on reload
    if (fullText) {
      let stored = fullText
      if (collectedOracles.length > 0) {
        stored += `\n\n<!--ORACLES:${JSON.stringify(collectedOracles)}:ORACLES-->`
      }
      await chatDb.addMessage(chat.id, 'assistant', stored)
      await chatDb.touchChat(chat.id)
    }

    res.end()
    logger.info({ chatId: chat.id }, 'Coordinator completed')
  } catch (error) {
    if (res.headersSent) {
      sendSSE(res, { type: 'status', message: `Error: ${error instanceof Error ? error.message : 'Unknown'}` })
      res.end()
    } else {
      next(error)
    }
  }
})
