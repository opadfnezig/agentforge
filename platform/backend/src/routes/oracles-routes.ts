import { Router } from 'express'
import type { Request, Application } from 'express'
import { createOracleSchema, updateOracleSchema } from '../schemas/oracle.js'
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

// Get oracle state (reads .md files from state_dir)
oraclesRouter.get('/:id/state', async (req, res, next) => {
  try {
    const oracle = await oracleQueries.getOracle(req.params.id)
    if (!oracle) {
      throw new AppError(404, 'Oracle not found', 'ORACLE_NOT_FOUND')
    }
    const state = await oracleQueries.getOracleState(oracle.stateDir)
    res.json({ oracleId: oracle.id, state })
  } catch (error) {
    next(error)
  }
})

// Query oracle. Routes through queryOracle which prefers the running
// container (via WS dispatch) and falls back to the in-process spawn for
// oracles whose container hasn't been spawned yet.
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

// List oracle queries
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
