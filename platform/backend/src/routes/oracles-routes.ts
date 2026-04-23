import { Router } from 'express'
import { createOracleSchema, updateOracleSchema } from '../schemas/oracle.js'
import * as oracleQueries from '../db/queries/oracles.js'
import { queryOracle } from '../services/oracle-engine.js'
import { AppError } from '../utils/error-handler.js'
import { logger } from '../utils/logger.js'

export const oraclesRouter = Router()

// List oracles
oraclesRouter.get('/', async (_req, res, next) => {
  try {
    const oracles = await oracleQueries.listOracles()
    res.json(oracles)
  } catch (error) {
    next(error)
  }
})

// Create oracle
oraclesRouter.post('/', async (req, res, next) => {
  try {
    const data = createOracleSchema.parse(req.body)
    const oracle = await oracleQueries.createOracle(data)
    logger.info({ oracleId: oracle.id, domain: oracle.domain }, 'Oracle created')
    res.status(201).json(oracle)
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
    res.json(oracle)
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
    res.json(oracle)
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

// Query oracle
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
