import { Router } from 'express'
import type { Request, Response, Application } from 'express'
import {
  createDeveloperSchema,
  updateDeveloperSchema,
  dispatchSchema,
  editRunInstructionsSchema,
} from '../schemas/developer.js'
import * as developerQueries from '../db/queries/developers.js'
import { developerRegistry } from '../services/developer-registry.js'
import { AppError } from '../utils/error-handler.js'
import { logger } from '../utils/logger.js'

export const developersRouter = Router()

// ---------------------------------------------------------------------------
// WebSocket: developer worker connects here
// Registered directly on the app in index.ts since express-ws requires
// the app-level instance to be applied to the router.
// ---------------------------------------------------------------------------
export const registerDeveloperWs = (app: Application & { ws?: Function }) => {
  if (typeof app.ws !== 'function') {
    throw new Error('app.ws is not a function — express-ws must be applied to the app')
  }
  app.ws('/api/developers/connect/:id', async (ws: any, req: Request) => {
    const developerId = req.params.id
    const secret = (req.query.secret as string | undefined) || ''

    try {
      const developer = await developerQueries.getDeveloper(developerId)
      if (!developer) {
        ws.close(4004, 'Developer not found')
        return
      }
      if (!secret || secret !== developer.secret) {
        ws.close(4003, 'Invalid secret')
        return
      }

      await developerRegistry.register(developerId, ws as any)

      ws.on('message', (data: Buffer) => {
        developerRegistry.handleMessage(developerId, data).catch((err) => {
          logger.error({ err, developerId }, 'handleMessage failed')
        })
      })

      ws.on('close', () => {
        developerRegistry.unregister(developerId).catch((err) => {
          logger.error({ err, developerId }, 'unregister failed')
        })
      })

      ws.on('error', (err: Error) => {
        logger.warn({ err, developerId }, 'Developer WS error')
      })
    } catch (err) {
      logger.error({ err, developerId }, 'WS connect error')
      try { ws.close(1011, 'Server error') } catch { /* ignore */ }
    }
  })
}

// ---------------------------------------------------------------------------
// HTTP endpoints
// ---------------------------------------------------------------------------

// Strip secret from responses by default; secret is only returned on POST / and /:id/secret
const serialize = (dev: Awaited<ReturnType<typeof developerQueries.getDeveloper>>) => {
  if (!dev) return null
  const { secret: _s, ...rest } = dev
  return {
    ...rest,
    online: developerRegistry.isOnline(dev.id),
  }
}

// List developers
developersRouter.get('/', async (_req, res, next) => {
  try {
    const developers = await developerQueries.listDevelopers()
    res.json(developers.map((d) => serialize(d)))
  } catch (error) {
    next(error)
  }
})

// Create developer (secret returned ONCE)
developersRouter.post('/', async (req, res, next) => {
  try {
    const data = createDeveloperSchema.parse(req.body)
    const developer = await developerQueries.createDeveloper(data)
    logger.info({ developerId: developer.id, name: developer.name }, 'Developer created')
    // Return full record (including secret) exactly once.
    res.status(201).json({
      ...developer,
      online: false,
    })
  } catch (error) {
    next(error)
  }
})

// Get developer
developersRouter.get('/:id', async (req, res, next) => {
  try {
    const developer = await developerQueries.getDeveloper(req.params.id)
    if (!developer) {
      throw new AppError(404, 'Developer not found', 'DEVELOPER_NOT_FOUND')
    }
    res.json(serialize(developer))
  } catch (error) {
    next(error)
  }
})

// Update developer
developersRouter.patch('/:id', async (req, res, next) => {
  try {
    const data = updateDeveloperSchema.parse(req.body)
    const developer = await developerQueries.updateDeveloper(req.params.id, data)
    if (!developer) {
      throw new AppError(404, 'Developer not found', 'DEVELOPER_NOT_FOUND')
    }
    logger.info({ developerId: developer.id }, 'Developer updated')
    res.json(serialize(developer))
  } catch (error) {
    next(error)
  }
})

// Delete developer
developersRouter.delete('/:id', async (req, res, next) => {
  try {
    const deleted = await developerQueries.deleteDeveloper(req.params.id)
    if (!deleted) {
      throw new AppError(404, 'Developer not found', 'DEVELOPER_NOT_FOUND')
    }
    logger.info({ developerId: req.params.id }, 'Developer deleted')
    res.status(204).send()
  } catch (error) {
    next(error)
  }
})

// Regenerate secret (returns the new secret ONCE)
developersRouter.get('/:id/secret', async (req, res, next) => {
  try {
    const existing = await developerQueries.getDeveloper(req.params.id)
    if (!existing) {
      throw new AppError(404, 'Developer not found', 'DEVELOPER_NOT_FOUND')
    }
    const secret = developerQueries.generateSecret()
    await developerQueries.updateDeveloper(req.params.id, { secret })
    logger.info({ developerId: req.params.id }, 'Developer secret regenerated')
    res.json({ id: req.params.id, secret })
  } catch (error) {
    next(error)
  }
})

// Dispatch a run (fire-and-forget; returns runId immediately).
// Direct HTTP dispatches default to autoApprove=true and insert as 'queued'
// (immediately dispatched if the developer is idle, otherwise drained when
// they become idle). Callers that want the approval gate (coordinator) pass
// autoApprove=false, inserting as 'pending' — the run will sit awaiting
// user action from the coordinator chat badge.
developersRouter.post('/:id/dispatch', async (req, res, next) => {
  try {
    const { instructions, mode, autoApprove, chatId } = dispatchSchema.parse(req.body)
    const developer = await developerQueries.getDeveloper(req.params.id)
    if (!developer) {
      throw new AppError(404, 'Developer not found', 'DEVELOPER_NOT_FOUND')
    }

    // Chat-mode wiring: validate chatId belongs to this developer and
    // force mode=chat (a single chat can't mix implement/clarify with
    // chat — they have different post-run semantics).
    let finalChatId: string | null = null
    if (chatId) {
      const chat = await developerQueries.getDeveloperChat(chatId)
      if (!chat || chat.developerId !== developer.id) {
        throw new AppError(404, 'Chat not found', 'CHAT_NOT_FOUND')
      }
      finalChatId = chat.id
    }

    const finalMode = finalChatId ? 'chat' : (mode || 'implement')
    const shouldApprove = autoApprove !== false
    const initialStatus = shouldApprove ? 'queued' : 'pending'
    const run = await developerQueries.createRun(developer.id, instructions, finalMode, initialStatus, { chatId: finalChatId })

    if (finalChatId) {
      await developerQueries.updateDeveloperChat(finalChatId, { lastMessageAt: new Date() })
    }

    const online = developerRegistry.isOnline(developer.id)
    const idle = online && developer.status === 'idle'

    if (shouldApprove && idle) {
      // Immediate dispatch; resolution handled via registry events
      developerRegistry
        .dispatch(developer.id, run.id, instructions, finalMode)
        .catch(async (err) => {
          logger.error({ err, runId: run.id }, 'Dispatch failed')
          await developerQueries.updateRun(run.id, {
            status: 'failure',
            errorMessage: err instanceof Error ? err.message : String(err),
            finishedAt: new Date(),
          })
        })
    } else {
      logger.info(
        { developerId: developer.id, runId: run.id, online, status: developer.status, pending: !shouldApprove },
        shouldApprove ? 'Dispatch queued (developer not idle)' : 'Dispatch awaiting approval'
      )
    }

    res.status(202).json({
      runId: run.id,
      status: run.status,
      mode: run.mode,
      queued: shouldApprove && !idle,
      pending: !shouldApprove,
    })
  } catch (error) {
    next(error)
  }
})

// List queued (approved, waiting) runs for a developer.
developersRouter.get('/:id/queue', async (req, res, next) => {
  try {
    const developer = await developerQueries.getDeveloper(req.params.id)
    if (!developer) {
      throw new AppError(404, 'Developer not found', 'DEVELOPER_NOT_FOUND')
    }
    const queued = await developerQueries.listQueuedRuns(developer.id)
    res.json(queued)
  } catch (error) {
    next(error)
  }
})

// Approve a pending run — flips pending → queued and tries to drain the
// queue immediately if the developer is idle.
developersRouter.post('/:id/runs/:runId/approve', async (req, res, next) => {
  try {
    const run = await developerQueries.getRun(req.params.runId)
    if (!run || run.developerId !== req.params.id) {
      throw new AppError(404, 'Run not found', 'RUN_NOT_FOUND')
    }
    if (run.status !== 'pending') {
      throw new AppError(409, `Run is ${run.status}, cannot approve`, 'RUN_NOT_PENDING')
    }
    const updated = await developerQueries.updateRun(run.id, { status: 'queued' })
    if (updated) developerRegistry.events.emit(`update:${run.id}`, updated)
    logger.info({ developerId: req.params.id, runId: run.id }, 'Run approved')
    developerRegistry.assignNextQueued(req.params.id).catch((err) => {
      logger.error({ err, developerId: req.params.id }, 'Queue drain after approve failed')
    })
    res.json(updated)
  } catch (error) {
    next(error)
  }
})

// Cancel a pending or queued run — flips status → cancelled. Running runs
// are left alone; use the worker-side cancellation path for those.
developersRouter.post('/:id/runs/:runId/cancel', async (req, res, next) => {
  try {
    const run = await developerQueries.getRun(req.params.runId)
    if (!run || run.developerId !== req.params.id) {
      throw new AppError(404, 'Run not found', 'RUN_NOT_FOUND')
    }
    if (run.status !== 'pending' && run.status !== 'queued') {
      throw new AppError(409, `Run is ${run.status}, cannot cancel`, 'RUN_NOT_CANCELLABLE')
    }
    const updated = await developerQueries.updateRun(run.id, {
      status: 'cancelled',
      finishedAt: new Date(),
    })
    if (updated) {
      developerRegistry.events.emit(`update:${run.id}`, updated)
      developerRegistry.events.emit(`complete:${run.id}`, updated)
    }
    logger.info({ developerId: req.params.id, runId: run.id }, 'Run cancelled')
    res.json(updated)
  } catch (error) {
    next(error)
  }
})

// Re-dispatch a failed run with the same instructions but no carry-over
// context. Inserts as 'queued' (deliberate user action — skip pending
// approval), links via parent_run_id. 409 if a child is already in-flight.
const dispatchRetryOrContinue = async (
  req: Request,
  res: Response,
  next: (err: unknown) => void,
  withResumeContext: boolean
): Promise<void> => {
  try {
    const source = await developerQueries.getRun(req.params.runId)
    if (!source || source.developerId !== req.params.id) {
      throw new AppError(404, 'Run not found', 'RUN_NOT_FOUND')
    }
    if (source.status !== 'failure') {
      throw new AppError(
        400,
        `Run is ${source.status}, only failed runs can be retried`,
        'RUN_NOT_FAILED'
      )
    }
    const activeChild = await developerQueries.findActiveChildRun(source.id)
    if (activeChild) {
      throw new AppError(
        409,
        `A retry is already ${activeChild.status} (run ${activeChild.id})`,
        'RETRY_ALREADY_IN_FLIGHT'
      )
    }

    let resumeContext: string | null = null
    if (withResumeContext) {
      const lastAssistant = await developerQueries.getLastAssistantText(source.id)
      const lines = [
        'Previous run failed.',
        `stop_reason: ${source.stopReason || 'unknown'}`,
        `error: ${source.errorMessage || 'none captured'}`,
        'last assistant message:',
        lastAssistant && lastAssistant.length > 0 ? lastAssistant : 'none captured',
      ]
      resumeContext = lines.join('\n')
    }

    const child = await developerQueries.createRun(
      source.developerId,
      source.instructions,
      source.mode,
      'queued',
      { resumeContext, parentRunId: source.id }
    )

    logger.info(
      {
        developerId: source.developerId,
        sourceRunId: source.id,
        childRunId: child.id,
        kind: withResumeContext ? 'continue' : 'retry',
      },
      'Run retry/continue created'
    )

    // Drain immediately if developer is idle; otherwise the existing queue
    // picker will handle it on the next idle window.
    developerRegistry.assignNextQueued(source.developerId).catch((err) => {
      logger.error(
        { err, developerId: source.developerId },
        'Queue drain after retry/continue failed'
      )
    })

    res.status(202).json(child)
  } catch (error) {
    next(error)
  }
}

developersRouter.post('/:id/runs/:runId/retry', (req, res, next) =>
  dispatchRetryOrContinue(req, res, next, false)
)
developersRouter.post('/:id/runs/:runId/continue', (req, res, next) =>
  dispatchRetryOrContinue(req, res, next, true)
)

// Edit a pending run's instructions (pre-approval tweak). Only allowed while
// status === 'pending' — once queued or running, instructions are immutable.
developersRouter.patch('/:id/runs/:runId', async (req, res, next) => {
  try {
    const { instructions } = editRunInstructionsSchema.parse(req.body)
    const run = await developerQueries.getRun(req.params.runId)
    if (!run || run.developerId !== req.params.id) {
      throw new AppError(404, 'Run not found', 'RUN_NOT_FOUND')
    }
    if (run.status !== 'pending') {
      throw new AppError(409, `Run is ${run.status}, instructions are immutable`, 'RUN_NOT_EDITABLE')
    }
    const updated = await developerQueries.updateRunInstructions(run.id, instructions)
    if (updated) developerRegistry.events.emit(`update:${run.id}`, updated)
    logger.info({ developerId: req.params.id, runId: run.id }, 'Run instructions edited')
    res.json(updated)
  } catch (error) {
    next(error)
  }
})

// List runs
developersRouter.get('/:id/runs', async (req, res, next) => {
  try {
    const developer = await developerQueries.getDeveloper(req.params.id)
    if (!developer) {
      throw new AppError(404, 'Developer not found', 'DEVELOPER_NOT_FOUND')
    }
    const runs = await developerQueries.listRuns(developer.id)
    res.json(runs)
  } catch (error) {
    next(error)
  }
})

// Get single run
developersRouter.get('/:id/runs/:runId', async (req, res, next) => {
  try {
    const run = await developerQueries.getRun(req.params.runId)
    if (!run || run.developerId !== req.params.id) {
      throw new AppError(404, 'Run not found', 'RUN_NOT_FOUND')
    }
    res.json(run)
  } catch (error) {
    next(error)
  }
})

// List logs for a run
developersRouter.get('/:id/runs/:runId/logs', async (req, res, next) => {
  try {
    const run = await developerQueries.getRun(req.params.runId)
    if (!run || run.developerId !== req.params.id) {
      throw new AppError(404, 'Run not found', 'RUN_NOT_FOUND')
    }
    const logs = await developerQueries.listLogs(run.id)
    res.json(logs)
  } catch (error) {
    next(error)
  }
})

// Stream run logs via SSE. Replays existing logs, then streams new ones until
// the run reaches a terminal status (or the client disconnects).
developersRouter.get('/:id/runs/:runId/stream', async (req: Request, res: Response, next) => {
  try {
    const run = await developerQueries.getRun(req.params.runId)
    if (!run || run.developerId !== req.params.id) {
      throw new AppError(404, 'Run not found', 'RUN_NOT_FOUND')
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders?.()

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`)
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    }

    // Replay existing logs first
    const existing = await developerQueries.listLogs(run.id)
    for (const log of existing) send('log', log)
    send('run', run)

    const logHandler = (log: unknown) => send('log', log)
    const updateHandler = (r: unknown) => send('run', r)
    const completeHandler = (r: unknown) => {
      send('run', r)
      send('complete', { runId: run.id })
      cleanup()
      res.end()
    }
    const cleanup = () => {
      developerRegistry.events.off(`log:${run.id}`, logHandler)
      developerRegistry.events.off(`update:${run.id}`, updateHandler)
      developerRegistry.events.off(`complete:${run.id}`, completeHandler)
    }

    developerRegistry.events.on(`log:${run.id}`, logHandler)
    developerRegistry.events.on(`update:${run.id}`, updateHandler)
    developerRegistry.events.on(`complete:${run.id}`, completeHandler)

    req.on('close', () => {
      cleanup()
    })

    // If already terminal, close immediately
    if (
      run.status === 'success' ||
      run.status === 'failure' ||
      run.status === 'cancelled' ||
      run.status === 'no_changes'
    ) {
      send('complete', { runId: run.id })
      cleanup()
      res.end()
    }
  } catch (error) {
    next(error)
  }
})

// --- Developer chat endpoints ---

developersRouter.post('/:id/chats', async (req, res, next) => {
  try {
    const developer = await developerQueries.getDeveloper(req.params.id)
    if (!developer) {
      throw new AppError(404, 'Developer not found', 'DEVELOPER_NOT_FOUND')
    }
    const title = typeof req.body?.title === 'string' ? req.body.title : undefined
    const chat = await developerQueries.createDeveloperChat({
      developerId: developer.id,
      title,
    })
    logger.info({ developerId: developer.id, chatId: chat.id }, 'Developer chat created')
    res.status(201).json(chat)
  } catch (error) {
    next(error)
  }
})

developersRouter.post('/:id/runs/:runId/promote-to-chat', async (req, res, next) => {
  try {
    const developer = await developerQueries.getDeveloper(req.params.id)
    if (!developer) {
      throw new AppError(404, 'Developer not found', 'DEVELOPER_NOT_FOUND')
    }
    const run = await developerQueries.getRun(req.params.runId)
    if (!run || run.developerId !== developer.id) {
      throw new AppError(404, 'Run not found', 'RUN_NOT_FOUND')
    }
    if (run.chatId) {
      throw new AppError(409, 'Run already part of a chat', 'RUN_ALREADY_IN_CHAT')
    }
    if (!run.sessionId) {
      throw new AppError(
        400,
        'Run has no captured session_id, cannot resume — let it complete once before promoting',
        'NO_SESSION_ID'
      )
    }
    const title = (run.instructions || 'Chat').slice(0, 80)
    const chat = await developerQueries.createDeveloperChat({
      developerId: developer.id,
      title,
      claudeSessionId: run.sessionId,
      firstMessageAt: run.startedAt ?? run.createdAt,
    })
    await developerQueries.setRunChatId(run.id, chat.id)
    logger.info(
      { developerId: developer.id, chatId: chat.id, sourceRunId: run.id },
      'Run promoted to chat'
    )
    res.status(201).json(chat)
  } catch (error) {
    next(error)
  }
})

developersRouter.get('/:id/chats', async (req, res, next) => {
  try {
    const developer = await developerQueries.getDeveloper(req.params.id)
    if (!developer) {
      throw new AppError(404, 'Developer not found', 'DEVELOPER_NOT_FOUND')
    }
    const chats = await developerQueries.listDeveloperChats(developer.id)
    res.json(chats)
  } catch (error) {
    next(error)
  }
})

developersRouter.get('/:id/chats/:chatId', async (req, res, next) => {
  try {
    const chat = await developerQueries.getDeveloperChat(req.params.chatId)
    if (!chat || chat.developerId !== req.params.id) {
      throw new AppError(404, 'Chat not found', 'CHAT_NOT_FOUND')
    }
    const messages = await developerQueries.listDeveloperChatRuns(chat.id)
    res.json({ chat, messages })
  } catch (error) {
    next(error)
  }
})

developersRouter.patch('/:id/chats/:chatId', async (req, res, next) => {
  try {
    const chat = await developerQueries.getDeveloperChat(req.params.chatId)
    if (!chat || chat.developerId !== req.params.id) {
      throw new AppError(404, 'Chat not found', 'CHAT_NOT_FOUND')
    }
    const title = req.body?.title ?? null
    if (typeof title !== 'string' && title !== null) {
      throw new AppError(400, 'title must be a string or null', 'INVALID_INPUT')
    }
    const updated = await developerQueries.updateDeveloperChat(chat.id, { title: title as string | null })
    res.json(updated)
  } catch (error) {
    next(error)
  }
})

developersRouter.delete('/:id/chats/:chatId', async (req, res, next) => {
  try {
    const chat = await developerQueries.getDeveloperChat(req.params.chatId)
    if (!chat || chat.developerId !== req.params.id) {
      throw new AppError(404, 'Chat not found', 'CHAT_NOT_FOUND')
    }
    await developerQueries.deleteDeveloperChat(chat.id)
    logger.info({ developerId: req.params.id, chatId: chat.id }, 'Developer chat deleted')
    res.status(204).send()
  } catch (error) {
    next(error)
  }
})

// --- Developer state files (memory dir on host) ---
//
// Mirrors oracle's /state route: walks the dev's memory dir on the host
// (mounted from <name>/state/memory) and returns markdown contents. Lets
// the UI render what the dev knows for that scope.
developersRouter.get('/:id/state', async (req, res, next) => {
  try {
    const developer = await developerQueries.getDeveloper(req.params.id)
    if (!developer) {
      throw new AppError(404, 'Developer not found', 'DEVELOPER_NOT_FOUND')
    }
    // Each dev's memory lives at <NTFR_HOST_WORKDIR>/<dev-name>-dev/state/memory
    // on the host; the spawner created it via the chained mount layout.
    // Backend can read it directly because backend + spawner are on the
    // same host. (Multi-host support will eventually hit the worker via
    // an embedded HTTP endpoint instead.)
    const { promises: fsp } = await import('fs')
    const path = await import('path')
    // Allow override via NTFR_HOST_WORKDIR env (matches spawner).
    const root = process.env.NTFR_HOST_WORKDIR || '/ntfr/ntfr'
    const memoryDir = path.join(root, `${developer.name}-dev`, 'state', 'memory')
    type FileOut = { name: string; content: string }
    const out: FileOut[] = []
    const walk = async (dir: string, prefix: string): Promise<void> => {
      let entries
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const name = e.name as string
        const rel = prefix ? `${prefix}/${name}` : name
        const abs = path.join(dir, name)
        if (e.isDirectory()) {
          await walk(abs, rel)
        } else if (e.isFile() && name.endsWith('.md')) {
          try {
            const content = await fsp.readFile(abs, 'utf-8')
            out.push({ name: rel, content })
          } catch { /* skip */ }
        }
      }
    }
    await walk(memoryDir, '')
    out.sort((a, b) => a.name.localeCompare(b.name))
    res.json({ developerId: developer.id, files: out })
  } catch (error) {
    next(error)
  }
})
