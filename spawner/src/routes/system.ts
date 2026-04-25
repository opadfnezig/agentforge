import { Router } from 'express'
import { config } from '../config.js'
import { listPrimitives } from '../services/lifecycle.js'

export const systemRouter = Router()
let bootedAt = Date.now()

export const markBooted = () => {
  bootedAt = Date.now()
}

systemRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

systemRouter.get('/info', async (_req, res, next) => {
  try {
    const primitives = await listPrimitives()
    res.json({
      host_id: config.NTFR_HOST_ID,
      version: config.NTFR_VERSION,
      capabilities: ['spawn', 'destroy', 'list', 'inspect', 'logs'],
      primitive_count: primitives.length,
      uptime_ms: Date.now() - bootedAt,
      server_url_configured: !!config.NTFR_SERVER_URL,
    })
  } catch (err) {
    next(err)
  }
})

/**
 * Future work — primitive update/reconfiguration. Returns 501 explicitly so
 * callers can detect the unimplemented surface deterministically rather
 * than getting a 404.
 */
systemRouter.post('/update', (_req, res) => {
  res.status(501).json({
    error: {
      message: 'POST /update is not yet implemented',
      code: 'NOT_IMPLEMENTED',
      future_work: true,
    },
  })
})
