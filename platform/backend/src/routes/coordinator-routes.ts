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
      // Strip persisted oracle/dispatch/read sentinels so they don't leak into
      // the next prompt. Reads in particular are pull-only — re-injecting prior
      // read results would recreate the auto-injection problem we explicitly
      // avoided. The coordinator must re-issue [read, ...] if it needs the data.
      content: m.content
        .replace(/\n*<!--ORACLES:[\s\S]*?:ORACLES-->\s*/g, '')
        .replace(/\n*<!--DISPATCHES:[\s\S]*?:DISPATCHES-->\s*/g, '')
        .replace(/\n*<!--READS:[\s\S]*?:READS-->\s*/g, ''),
    }))

    await chatDb.addMessage(chat.id, 'user', message)

    logger.info({ chatId: chat.id, historyLength: history.length }, 'Coordinator message')

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')

    const collectedOracles: { domain: string; question: string; response: string }[] = []
    const collectedDispatches: {
      developer: string
      developerId: string
      mode: string
      runId: string
      instructions: string
      queued: boolean
      pending: boolean
    }[] = []
    const collectedReads: {
      runId: string
      found: boolean
      status: string | null
      developerName: string | null
      report: string
    }[] = []

    const { text: fullText, trailer } = await run(message, history, (event) => {
      if (event.type === 'oracle') {
        collectedOracles.push({ domain: event.domain, question: event.question, response: event.response })
      } else if (event.type === 'dispatch') {
        collectedDispatches.push({
          developer: event.developer,
          developerId: event.developerId,
          mode: event.mode,
          runId: event.runId,
          instructions: event.instructions,
          queued: event.queued,
          pending: event.pending,
        })
      } else if (event.type === 'read') {
        collectedReads.push({
          runId: event.runId,
          found: event.found,
          status: event.status,
          developerName: event.developerName,
          report: event.report,
        })
      }
      sendSSE(res, event)
    })

    // Persist — append oracle/dispatch/read data as JSON sentinels so badges expand on reload
    if (fullText) {
      let stored = fullText
      if (collectedOracles.length > 0) {
        stored += `\n\n<!--ORACLES:${JSON.stringify(collectedOracles)}:ORACLES-->`
      }
      if (collectedDispatches.length > 0) {
        stored += `\n\n<!--DISPATCHES:${JSON.stringify(collectedDispatches)}:DISPATCHES-->`
      }
      if (collectedReads.length > 0) {
        stored += `\n\n<!--READS:${JSON.stringify(collectedReads)}:READS-->`
      }
      // Roll up both passes into the message-level summary; second pass is the
      // user-facing one when present, else we attribute everything to the first.
      const primary = trailer.second_pass ?? trailer.first_pass
      const totalCostUsd = trailer.first_pass.cost_usd + (trailer.second_pass?.cost_usd ?? 0)
      const totalDurationMs = trailer.first_pass.duration_ms + (trailer.second_pass?.duration_ms ?? 0)
      await chatDb.addMessage(chat.id, 'assistant', stored, {
        provider: 'anthropic-oauth',
        model: primary.model,
        totalCostUsd,
        durationMs: totalDurationMs,
        stopReason: primary.stop_reason,
        trailer: trailer as unknown as Record<string, unknown>,
      })
      await chatDb.touchChat(chat.id, { addCostUsd: totalCostUsd, addDurationMs: totalDurationMs })
    }

    res.end()
    logger.info({ chatId: chat.id, totalCostUsd: trailer.first_pass.cost_usd + (trailer.second_pass?.cost_usd ?? 0) }, 'Coordinator completed')
  } catch (error) {
    if (res.headersSent) {
      sendSSE(res, { type: 'status', message: `Error: ${error instanceof Error ? error.message : 'Unknown'}` })
      res.end()
    } else {
      next(error)
    }
  }
})
