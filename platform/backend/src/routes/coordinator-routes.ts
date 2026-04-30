import { Router } from 'express'
import { run, resumeRun, type CoordinatorEvent } from '../services/coordinator.js'
import { mergeIntoState } from '../services/oracle-engine.js'
import * as oracleQueries from '../db/queries/oracles.js'
import * as chatDb from '../db/queries/coordinator-chats.js'
import { chatCompletion } from '../lib/anthropic-oauth.js'
import { AppError } from '../utils/error-handler.js'
import { logger } from '../utils/logger.js'

// Cheapest tier — used only for the fire-and-forget chat-naming call after the
// first user message. Title generation must never delay the SSE stream the
// user is actively waiting on, so this runs detached from the request handler.
const CHAT_NAME_MODEL = 'claude-haiku-4-5'
const CHAT_NAME_SYSTEM_PROMPT =
  "Generate a 2-3 word title for this chat based on the user's first message. Return only the title, no punctuation, no quotes."

const generateChatNameAsync = (chatId: string, firstMessage: string): void => {
  void (async () => {
    try {
      const result = await chatCompletion({
        model: CHAT_NAME_MODEL,
        systemPrompt: CHAT_NAME_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: firstMessage }],
        maxTokens: 32,
      })
      const title = result.content.trim().replace(/^["'`]+|["'`]+$/g, '').trim().slice(0, 120)
      if (!title) return
      await chatDb.updateChatTitle(chatId, title)
      logger.info({ chatId, title }, 'Chat name generated')
    } catch (err) {
      logger.warn(
        { chatId, error: err instanceof Error ? err.message : String(err) },
        'Chat name generation failed',
      )
    }
  })()
}

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

// Transform the persisted assistant message before it goes back into the
// coordinator's prompt as conversation history.
//
// ORACLES and READS are stripped entirely: oracles must be re-queried each turn,
// and read results are pull-only (auto-injecting prior reports would recreate
// the auto-injection problem we explicitly avoided).
//
// DISPATCHES are NOT stripped — the runId UUID inside the sentinel JSON is the
// only durable carrier of the assigned id across turns. Synthesis prose
// typically describes the dispatch without quoting the UUID, so without this
// rewrite the coordinator can never recover the runId for a later [read, run-id].
// We replace the JSON sentinel with a compact line per dispatch the model can
// read naturally.
//
// SPAWNS share the same structural pattern but no coordinator command currently
// consumes spawnIntentId, so the sentinel stays stripped; revisit if a
// spawn-status read primitive is added.
const rewriteSentinelsForHistory = (content: string): string => {
  let out = content
    .replace(/\n*<!--ORACLES:[\s\S]*?:ORACLES-->\s*/g, '')
    .replace(/\n*<!--READS:[\s\S]*?:READS-->\s*/g, '')
    .replace(/\n*<!--SPAWNS:[\s\S]*?:SPAWNS-->\s*/g, '')
  out = out.replace(/\n*<!--DISPATCHES:([\s\S]*?):DISPATCHES-->\s*/g, (_, json) => {
    try {
      const items = JSON.parse(json) as Array<{
        developer: string
        mode: string
        runId: string
      }>
      if (!Array.isArray(items) || items.length === 0) return ''
      const lines = items.map(
        (d) => `- developer=${d.developer} mode=${d.mode} runId=${d.runId}`
      )
      return `\n\n[Dispatches emitted in this turn (use runId in [read, run-id]):\n${lines.join('\n')}]`
    } catch {
      return ''
    }
  })
  return out
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

// Rename a chat. Body uses `name` (the user-facing label) but the underlying
// column has always been `title`; the names are synonyms here.
coordinatorRouter.patch('/chats/:id', async (req, res, next) => {
  try {
    const { name } = req.body ?? {}
    if (typeof name !== 'string' || !name.trim()) {
      throw new AppError(400, 'name must be a non-empty string', 'INVALID_INPUT')
    }
    const updated = await chatDb.updateChatTitle(req.params.id, name.trim().slice(0, 120))
    if (!updated) throw new AppError(404, 'Chat not found', 'NOT_FOUND')
    res.json(updated)
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

// Chat ID + outcome of the multi-stage run, used by both POST /message
// (fresh turn) and POST /continue (resume after approval window). Persistence
// of the assistant message ONLY happens on completion; pauses leave nothing
// on disk because the in-memory continuation carries forward state.
const persistAssistantMessage = async (
  chatId: string,
  fullText: string,
  accumulator: import('../services/coordinator.js').StageAccumulator,
  trailer: import('../services/coordinator.js').TurnTrailer,
) => {
  if (!fullText) return
  // Map accumulator → existing badge shapes the FE renders. Dispatch results
  // include a developerId in the SSE event but accumulator only stores the
  // backend-shaped DispatchResult — we drop developerId from sentinel here
  // because the FE polls runs by developerId/runId and gets that from the
  // SSE-attached badge state, NOT from the persisted sentinel. After reload
  // the FE reconstructs the badge by looking up the run's developer from the
  // run record itself. (developerId is preserved in the live SSE event so
  // active sessions still get instant badge polling.)
  const dispatches = accumulator.dispatchResults
    .filter((d) => !d.error && d.runId && d.developerId)
    .map((d) => ({
      developer: d.developer,
      developerId: d.developerId!,
      mode: d.mode,
      runId: d.runId!,
      instructions: d.instructions,
      queued: false,
      pending: true,
    }))
  const oracles = accumulator.oracleResponses
  const reads = accumulator.readResults.map((r) => ({
    runId: r.runId,
    found: r.found,
    status: r.status,
    developerName: r.developerName,
    report: r.report,
  }))
  const spawns = accumulator.spawnResults
    .filter((s) => !s.error && s.intentId && s.primitiveKind && s.spawnerHostId)
    .map((s) => ({
      spawnerHostId: s.spawnerHostId!,
      hostId: s.hostId,
      primitiveName: s.primitiveName,
      primitiveKind: s.primitiveKind!,
      image: s.image ?? '',
      spawnIntentId: s.intentId!,
      pending: true,
      queued: false,
    }))

  let stored = fullText
  if (oracles.length > 0) stored += `\n\n<!--ORACLES:${JSON.stringify(oracles)}:ORACLES-->`
  if (dispatches.length > 0) stored += `\n\n<!--DISPATCHES:${JSON.stringify(dispatches)}:DISPATCHES-->`
  if (reads.length > 0) stored += `\n\n<!--READS:${JSON.stringify(reads)}:READS-->`
  if (spawns.length > 0) stored += `\n\n<!--SPAWNS:${JSON.stringify(spawns)}:SPAWNS-->`

  const primary = trailer.second_pass ?? trailer.first_pass
  const totalCostUsd = trailer.first_pass.cost_usd + (trailer.second_pass?.cost_usd ?? 0)
  const totalDurationMs = trailer.first_pass.duration_ms + (trailer.second_pass?.duration_ms ?? 0)
  await chatDb.addMessage(chatId, 'assistant', stored, {
    provider: 'anthropic-oauth',
    model: primary.model,
    totalCostUsd,
    durationMs: totalDurationMs,
    stopReason: primary.stop_reason,
    trailer: trailer as unknown as Record<string, unknown>,
  })
  await chatDb.touchChat(chatId, { addCostUsd: totalCostUsd, addDurationMs: totalDurationMs })
}

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
      content: rewriteSentinelsForHistory(m.content),
    }))

    await chatDb.addMessage(chat.id, 'user', message)

    // Fire-and-forget Haiku title generation on the first user message of a
    // chat. Detached so it never blocks the SSE stream the user is waiting on;
    // the new title is picked up the next time the frontend refetches the
    // chat list (which it does after every send).
    if (priorMessages.length === 0) {
      generateChatNameAsync(chat.id, message)
    }

    logger.info({ chatId: chat.id, historyLength: history.length }, 'Coordinator message')

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')

    const result = await run(message, history, (event) => {
      sendSSE(res, event)
    })

    if (!result.paused) {
      await persistAssistantMessage(chat.id, result.text, result.accumulator, result.trailer)
    }

    res.end()
    logger.info({
      chatId: chat.id,
      paused: result.paused,
      totalCostUsd: result.trailer.first_pass.cost_usd + (result.trailer.second_pass?.cost_usd ?? 0),
    }, result.paused ? 'Coordinator paused for approval' : 'Coordinator completed')
  } catch (error) {
    if (res.headersSent) {
      sendSSE(res, { type: 'status', message: `Error: ${error instanceof Error ? error.message : 'Unknown'}` })
      res.end()
    } else {
      next(error)
    }
  }
})

// --- Continue paused multi-stage run (SSE stream) ---
//
// Called when the user clicks "Approve next stages" on a paused turn. The
// continuationId references in-memory state held in the coordinator service
// (consumed one-shot — re-clicking is a no-op 410). The same SSE stream
// shape as /message is used; persistence here covers events from ALL
// windows because the accumulator is carried forward in the continuation.
coordinatorRouter.post('/chats/:id/continue', async (req, res, next) => {
  try {
    const { continuationId } = req.body
    if (!continuationId || typeof continuationId !== 'string') {
      throw new AppError(400, 'continuationId is required', 'INVALID_INPUT')
    }

    const chat = await chatDb.getChat(req.params.id)
    if (!chat) throw new AppError(404, 'Chat not found', 'NOT_FOUND')

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')

    let result
    try {
      result = await resumeRun(continuationId, (event) => {
        sendSSE(res, event)
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown'
      sendSSE(res, { type: 'status', message: `Error: ${msg}` })
      sendSSE(res, { type: 'done' })
      res.end()
      logger.warn({ chatId: chat.id, error: msg }, 'Coordinator resume failed')
      return
    }

    if (!result.paused) {
      await persistAssistantMessage(chat.id, result.text, result.accumulator, result.trailer)
    }

    res.end()
    logger.info({
      chatId: chat.id,
      paused: result.paused,
      totalCostUsd: result.trailer.first_pass.cost_usd + (result.trailer.second_pass?.cost_usd ?? 0),
    }, result.paused ? 'Coordinator paused again' : 'Coordinator completed after resume')
  } catch (error) {
    if (res.headersSent) {
      sendSSE(res, { type: 'status', message: `Error: ${error instanceof Error ? error.message : 'Unknown'}` })
      res.end()
    } else {
      next(error)
    }
  }
})
