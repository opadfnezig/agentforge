import { Request, Response, NextFunction } from 'express'
import { ZodError } from 'zod'
import { SpawnError } from '../services/lifecycle.js'
import { logger } from './logger.js'

export const errorHandler = (
  err: Error,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction
) => {
  if (err instanceof SpawnError) {
    return res.status(err.statusCode).json({
      error: { message: err.message, code: err.code },
    })
  }
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        message: 'Validation error',
        code: 'VALIDATION_ERROR',
        details: err.errors,
      },
    })
  }
  logger.error('Unhandled request error', { err: String(err), stack: (err as Error).stack })
  return res.status(500).json({
    error: { message: 'Internal server error', code: 'INTERNAL_ERROR' },
  })
}
