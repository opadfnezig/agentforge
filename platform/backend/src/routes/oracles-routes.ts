import { Router } from 'express'
import type { Request, Response, Application } from 'express'
import {
  createOracleSchema,
  updateOracleSchema,
  oracleDispatchSchema,
  editOracleQueryMessageSchema,
  OracleMode,
} from '../schemas/oracle.js'
import * as oracleQueries from '../db/queries/oracles.js'
import { queryOracle } from '../services/oracle-engine.js'
import { oracleRegistry } from '../services/oracle-registry.js'
import { AppError } from '../utils/error-handler.js'
import { logger } from '../utils/logger.js'

export const oraclesRouter = Router()

// ---------------------------------------------------------------------------
// WebSocket: oracle worker connects here
// Mirrors the developer WS handshake — oracle id in the path, shared secret
// as a query param. Same broker pattern: register on open, route incoming
// messages through OracleRegistry, unregister on close.
// ---------------------------------------------------------------------------
export const registerOracleWs = (app: Application & { ws?: Function }) => {
  if (typeof app.ws !== 'function') {
    throw new Error('app.ws is not a function — express-ws must be applied to the app')
  }
  app.ws('/api/oracles/connect/:id', async (ws: any, req: Request) => {
    const oracleId = req.params.id
    const secret = (req.query.secret as string | undefined) || ''

    try {
      const oracle = await oracleQueries.getOracle(oracleId)
      if (!oracle) {
        ws.close(4004, 'Oracle not found')
        return
      }
      if (!oracle.secret || !secret || secret !== oracle.secret) {
        ws.close(4003, 'Invalid secret')
        return
      }

      await oracleRegistry.register(oracleId, ws as any)

      ws.on('message', (data: Buffer) => {
        oracleRegistry.handleMessage(oracleId, data).catch((err) => {
          logger.error({ err, oracleId }, 'oracle handleMessage failed')
        })
      })

      ws.on('close', () => {
        oracleRegistry.unregister(oracleId, ws as any).catch((err) => {
          logger.error({ err, oracleId }, 'oracle unregister failed')
        })
      })

      ws.on('error', (err: Error) => {
        logger.warn({ err, oracleId }, 'Oracle WS error')
      })
    } catch (err) {
      logger.error({ err, oracleId }, 'Oracle WS connect error')
      try { ws.close(1011, 'Server error') } catch { /* ignore */ }
    }
  })
}

// Strip the secret from default responses; expose it only on POST / and the
// dedicated /:id/secret endpoints (mirrors developer serialization).
const serialize = (
  oracle: Awaited<ReturnType<typeof oracleQueries.getOracle>>,
) => {
  if (!oracle) return null
  const { secret: _s, ...rest } = oracle
  return { ...rest, online: oracleRegistry.isOnline(oracle.id) }
}

// List oracles
oraclesRouter.get('/', async (_req, res, next) => {
  try {
    const oracles = await oracleQueries.listOracles()
    res.json(oracles.map((o) => serialize(o)))
  } catch (error) {
    next(error)
  }
})

// Create oracle (secret returned ONCE)
oraclesRouter.post('/', async (req, res, next) => {
  try {
    const data = createOracleSchema.parse(req.body)
    const oracle = await oracleQueries.createOracle(data)
    logger.info({ oracleId: oracle.id, domain: oracle.domain }, 'Oracle created')
    res.status(201).json({ ...oracle, online: false })
  } catch (error) {
    next(error)
  }
})

// Get oracle
oraclesRouter.get('/:id', async (req, res, next) => {
  try {
    const oracle = await oracleQueries.getOracle(req.params.id)
    if (!oracle) {
      throw new AppError(404, 'Oracle not found', 'ORACLE_NOT_FOUND')
    }
    res.json(serialize(oracle))
  } catch (error) {
    next(error)
  }
})

// Update oracle
oraclesRouter.patch('/:id', async (req, res, next) => {
  try {
    const data = updateOracleSchema.parse(req.body)
    const oracle = await oracleQueries.updateOracle(req.params.id, data)
    if (!oracle) {
      throw new AppError(404, 'Oracle not found', 'ORACLE_NOT_FOUND')
    }
    logger.info({ oracleId: oracle.id }, 'Oracle updated')
    res.json(serialize(oracle))
  } catch (error) {
    next(error)
  }
})

// Delete oracle
oraclesRouter.delete('/:id', async (req, res, next) => {
  try {
    const deleted = await oracleQueries.deleteOracle(req.params.id)
    if (!deleted) {
      throw new AppError(404, 'Oracle not found', 'ORACLE_NOT_FOUND')
    }
    logger.info({ oracleId: req.params.id }, 'Oracle deleted')
    res.status(204).send()
  } catch (error) {
    next(error)
  }
})

// Reveal the secret. New oracles get a secret on creation; legacy rows
// (pre-012_oracle_secret migration) get one minted on first call here.
// Mirrors the developer /:id/secret pattern.
oraclesRouter.get('/:id/secret', async (req, res, next) => {
  try {
    const existing = await oracleQueries.getOracle(req.params.id)
    if (!existing) {
      throw new AppError(404, 'Oracle not found', 'ORACLE_NOT_FOUND')
    }
    const secret = await oracleQueries.ensureOracleSecret(existing.id)
    if (!secret) {
      throw new AppError(404, 'Oracle not found', 'ORACLE_NOT_FOUND')
    }
    res.json({ id: existing.id, secret })
  } catch (error) {
    next(error)
  }
})

// Get oracle state — returns the file tree (matches frontend expectation of
// { files: OracleStateFile[] }). Each entry is { name: <relative path>,
// content: <full text> } so the UI can render index.md plus topic files
// (and subdirectories) the way they live on disk.
oraclesRouter.get('/:id/state', async (req, res, next) => {
  try {
    const oracle = await oracleQueries.getOracle(req.params.id)
    if (!oracle) {
      throw new AppError(404, 'Oracle not found', 'ORACLE_NOT_FOUND')
    }
    const files = await oracleQueries.getOracleStateFiles(oracle.stateDir)
    res.json({ oracleId: oracle.id, files })
  } catch (error) {
    next(error)
  }
})

// Legacy /query endpoint — synchronous. Kept for the coordinator's
// [query, ...] block (oracle-engine's queryOracle) but the page UI uses
// /dispatch instead.
oraclesRouter.post('/:id/query', async (req, res, next) => {
  try {
    const { message } = req.body
    if (!message || typeof message !== 'string') {
      throw new AppError(400, 'message is required', 'INVALID_INPUT')
    }
    const response = await queryOracle(req.params.id, message)
    res.json({ oracleId: req.params.id, message, response })
  } catch (error) {
    next(error)
  }
})

// Dispatch a query (read/write/migrate). Direct HTTP dispatches default to
// autoApprove=true and insert as 'queued' (immediately fired if idle, else
// drained when the worker connects/finishes prior work). Coordinator-driven
// callers can pass autoApprove=false to require user approval.
oraclesRouter.post('/:id/dispatch', async (req, res, next) => {
  try {
    const { message, mode, autoApprove } = oracleDispatchSchema.parse(req.body)
    const oracle = await oracleQueries.getOracle(req.params.id)
    if (!oracle) {
      throw new AppError(404, 'Oracle not found', 'ORACLE_NOT_FOUND')
    }

    const finalMode: OracleMode = mode || 'read'
    const shouldApprove = autoApprove !== false
    const initialStatus = shouldApprove ? 'queued' : 'pending'
    const query = await oracleQueries.createOracleQuery({
      oracleId: oracle.id,
      mode: finalMode,
      message,
      status: initialStatus,
    })

    if (shouldApprove) {
      oracleRegistry.assignNextQueued(oracle.id).catch((err) => {
        logger.error({ err, oracleId: oracle.id }, 'Queue drain after dispatch failed')
      })
    } else {
      logger.info(
        { oracleId: oracle.id, queryId: query.id, mode: finalMode },
        'Oracle dispatch awaiting approval'
      )
    }

    res.status(202).json({
      queryId: query.id,
      status: query.status,
      mode: query.mode,
      pending: !shouldApprove,
    })
  } catch (error) {
    next(error)
  }
})

// Queue inspection — only 'queued' entries (not pending).
oraclesRouter.get('/:id/queue', async (req, res, next) => {
  try {
    const oracle = await oracleQueries.getOracle(req.params.id)
    if (!oracle) {
      throw new AppError(404, 'Oracle not found', 'ORACLE_NOT_FOUND')
    }
    const queued = await oracleQueries.listQueuedOracleQueries(oracle.id)
    res.json(queued)
  } catch (error) {
    next(error)
  }
})

// Approve a pending query.
oraclesRouter.post('/:id/queries/:queryId/approve', async (req, res, next) => {
  try {
    const query = await oracleQueries.getOracleQuery(req.params.queryId)
    if (!query || query.oracleId !== req.params.id) {
      throw new AppError(404, 'Query not found', 'QUERY_NOT_FOUND')
    }
    if (query.status !== 'pending') {
      throw new AppError(409, `Query is ${query.status}, cannot approve`, 'QUERY_NOT_PENDING')
    }
    const updated = await oracleQueries.updateOracleQuery(query.id, { status: 'queued' })
    if (updated) oracleRegistry.events.emit(`update:${query.id}`, updated)
    logger.info({ oracleId: req.params.id, queryId: query.id }, 'Query approved')
    oracleRegistry.assignNextQueued(req.params.id).catch((err) => {
      logger.error({ err, oracleId: req.params.id }, 'Queue drain after approve failed')
    })
    res.json(updated)
  } catch (error) {
    next(error)
  }
})

// Cancel a pending or queued query (running queries can't be cancelled
// remotely yet — same as developers).
oraclesRouter.post('/:id/queries/:queryId/cancel', async (req, res, next) => {
  try {
    const query = await oracleQueries.getOracleQuery(req.params.queryId)
    if (!query || query.oracleId !== req.params.id) {
      throw new AppError(404, 'Query not found', 'QUERY_NOT_FOUND')
    }
    if (query.status !== 'pending' && query.status !== 'queued') {
      throw new AppError(409, `Query is ${query.status}, cannot cancel`, 'QUERY_NOT_CANCELLABLE')
    }
    const updated = await oracleQueries.updateOracleQuery(query.id, {
      status: 'cancelled',
      finishedAt: new Date(),
    })
    if (updated) {
      oracleRegistry.events.emit(`update:${query.id}`, updated)
      oracleRegistry.events.emit(`complete:${query.id}`, updated)
    }
    logger.info({ oracleId: req.params.id, queryId: query.id }, 'Query cancelled')
    res.json(updated)
  } catch (error) {
    next(error)
  }
})

const dispatchRetryOrContinue = async (
  req: Request,
  res: Response,
  next: (err: unknown) => void,
  withResumeContext: boolean
): Promise<void> => {
  try {
    const source = await oracleQueries.getOracleQuery(req.params.queryId)
    if (!source || source.oracleId !== req.params.id) {
      throw new AppError(404, 'Query not found', 'QUERY_NOT_FOUND')
    }
    if (source.status !== 'failure') {
      throw new AppError(400, `Query is ${source.status}, only failed queries can be retried`, 'QUERY_NOT_FAILED')
    }
    const activeChild = await oracleQueries.findActiveChildOracleQuery(source.id)
    if (activeChild) {
      throw new AppError(409, `A retry is already ${activeChild.status} (query ${activeChild.id})`, 'RETRY_ALREADY_IN_FLIGHT')
    }

    let resumeContext: string | null = null
    if (withResumeContext) {
      const lastAssistant = await oracleQueries.getOracleQueryLastAssistantText(source.id)
      resumeContext = [
        'Previous run failed.',
        `stop_reason: ${source.stopReason || 'unknown'}`,
        `error: ${source.errorMessage || 'none captured'}`,
        'last assistant message:',
        lastAssistant && lastAssistant.length > 0 ? lastAssistant : 'none captured',
      ].join('\n')
    }

    const child = await oracleQueries.createOracleQuery({
      oracleId: source.oracleId,
      mode: source.mode,
      message: source.message,
      status: 'queued',
      resumeContext,
      parentQueryId: source.id,
    })

    logger.info({
      oracleId: source.oracleId,
      sourceQueryId: source.id,
      childQueryId: child.id,
      kind: withResumeContext ? 'continue' : 'retry',
    }, 'Oracle query retry/continue created')

    oracleRegistry.assignNextQueued(source.oracleId).catch((err) => {
      logger.error({ err, oracleId: source.oracleId }, 'Queue drain after retry/continue failed')
    })

    res.status(202).json(child)
  } catch (error) {
    next(error)
  }
}

oraclesRouter.post('/:id/queries/:queryId/retry', (req, res, next) =>
  dispatchRetryOrContinue(req, res, next, false)
)
oraclesRouter.post('/:id/queries/:queryId/continue', (req, res, next) =>
  dispatchRetryOrContinue(req, res, next, true)
)

// Edit a pending query's message before approval.
oraclesRouter.patch('/:id/queries/:queryId', async (req, res, next) => {
  try {
    const { message } = editOracleQueryMessageSchema.parse(req.body)
    const query = await oracleQueries.getOracleQuery(req.params.queryId)
    if (!query || query.oracleId !== req.params.id) {
      throw new AppError(404, 'Query not found', 'QUERY_NOT_FOUND')
    }
    if (query.status !== 'pending') {
      throw new AppError(409, `Query is ${query.status}, message is immutable`, 'QUERY_NOT_EDITABLE')
    }
    const updated = await oracleQueries.updateOracleQueryMessage(query.id, message)
    if (updated) oracleRegistry.events.emit(`update:${query.id}`, updated)
    logger.info({ oracleId: req.params.id, queryId: query.id }, 'Query message edited')
    res.json(updated)
  } catch (error) {
    next(error)
  }
})

// List queries.
oraclesRouter.get('/:id/queries', async (req, res, next) => {
  try {
    const oracle = await oracleQueries.getOracle(req.params.id)
    if (!oracle) {
      throw new AppError(404, 'Oracle not found', 'ORACLE_NOT_FOUND')
    }
    const queries = await oracleQueries.listOracleQueries(req.params.id)
    res.json(queries)
  } catch (error) {
    next(error)
  }
})

// Single query.
oraclesRouter.get('/:id/queries/:queryId', async (req, res, next) => {
  try {
    const query = await oracleQueries.getOracleQuery(req.params.queryId)
    if (!query || query.oracleId !== req.params.id) {
      throw new AppError(404, 'Query not found', 'QUERY_NOT_FOUND')
    }
    res.json(query)
  } catch (error) {
    next(error)
  }
})

// List logs for a query.
oraclesRouter.get('/:id/queries/:queryId/logs', async (req, res, next) => {
  try {
    const query = await oracleQueries.getOracleQuery(req.params.queryId)
    if (!query || query.oracleId !== req.params.id) {
      throw new AppError(404, 'Query not found', 'QUERY_NOT_FOUND')
    }
    const logs = await oracleQueries.listOracleLogs(query.id)
    res.json(logs)
  } catch (error) {
    next(error)
  }
})

// SSE stream of logs + run updates.
oraclesRouter.get('/:id/queries/:queryId/stream', async (req: Request, res: Response, next) => {
  try {
    const query = await oracleQueries.getOracleQuery(req.params.queryId)
    if (!query || query.oracleId !== req.params.id) {
      throw new AppError(404, 'Query not found', 'QUERY_NOT_FOUND')
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders?.()

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`)
      res.write(`data: ${JSON.stringify(data)}\n\n`)
    }

    const existing = await oracleQueries.listOracleLogs(query.id)
    for (const log of existing) send('log', log)
    send('query', query)

    const logHandler = (log: unknown) => send('log', log)
    const updateHandler = (q: unknown) => send('query', q)
    const completeHandler = (q: unknown) => {
      send('query', q)
      send('complete', { queryId: query.id })
      cleanup()
      res.end()
    }
    const cleanup = () => {
      oracleRegistry.events.off(`log:${query.id}`, logHandler)
      oracleRegistry.events.off(`update:${query.id}`, updateHandler)
      oracleRegistry.events.off(`complete:${query.id}`, completeHandler)
    }

    oracleRegistry.events.on(`log:${query.id}`, logHandler)
    oracleRegistry.events.on(`update:${query.id}`, updateHandler)
    oracleRegistry.events.on(`complete:${query.id}`, completeHandler)

    req.on('close', () => { cleanup() })

    if (
      query.status === 'success' ||
      query.status === 'failure' ||
      query.status === 'cancelled'
    ) {
      send('complete', { queryId: query.id })
      cleanup()
      res.end()
    }
  } catch (error) {
    next(error)
  }
})
