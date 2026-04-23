import { Router } from 'express'
import { createScopeSchema, updateScopeSchema } from '../schemas/scope.js'
import * as scopeQueries from '../db/queries/scopes.js'
import { AppError } from '../utils/error-handler.js'
import { logger } from '../utils/logger.js'

export const scopesRouter = Router()

// List scopes
scopesRouter.get('/', async (_req, res, next) => {
  try {
    const scopes = await scopeQueries.listScopes()
    res.json(scopes)
  } catch (error) {
    next(error)
  }
})

// Create scope
scopesRouter.post('/', async (req, res, next) => {
  try {
    const data = createScopeSchema.parse(req.body)
    const scope = await scopeQueries.createScope(data)
    logger.info({ scopeId: scope.id }, 'Scope created')
    res.status(201).json(scope)
  } catch (error) {
    next(error)
  }
})

// Get scope
scopesRouter.get('/:id', async (req, res, next) => {
  try {
    const scope = await scopeQueries.getScope(req.params.id)
    if (!scope) {
      throw new AppError(404, 'Scope not found', 'SCOPE_NOT_FOUND')
    }
    res.json(scope)
  } catch (error) {
    next(error)
  }
})

// Update scope
scopesRouter.patch('/:id', async (req, res, next) => {
  try {
    const data = updateScopeSchema.parse(req.body)
    const scope = await scopeQueries.updateScope(req.params.id, data)
    if (!scope) {
      throw new AppError(404, 'Scope not found', 'SCOPE_NOT_FOUND')
    }
    logger.info({ scopeId: scope.id }, 'Scope updated')
    res.json(scope)
  } catch (error) {
    next(error)
  }
})

// Delete scope
scopesRouter.delete('/:id', async (req, res, next) => {
  try {
    const deleted = await scopeQueries.deleteScope(req.params.id)
    if (!deleted) {
      throw new AppError(404, 'Scope not found', 'SCOPE_NOT_FOUND')
    }
    logger.info({ scopeId: req.params.id }, 'Scope deleted')
    res.status(204).send()
  } catch (error) {
    next(error)
  }
})
