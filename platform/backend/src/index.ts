import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import morgan from 'morgan'
import expressWs from 'express-ws'
import { config } from './config.js'
import { logger } from './utils/logger.js'
import { errorHandler } from './utils/error-handler.js'
import { projectsRouter } from './routes/projects.js'
import { servicesRouter } from './routes/services.js'
import { actionsRouter } from './routes/actions.js'
import { edgesRouter } from './routes/edges.js'
import { dagRouter } from './routes/dag.js'
import { buildRouter } from './routes/build.js'
import { taskRouter } from './routes/task.js'
import { editorRouter } from './routes/editor.js'
import { planeRouter } from './routes/plane.js'
import { chatRouter } from './routes/chat.js'
import { scopesRouter } from './routes/scopes.js'
import { oraclesRouter, registerOracleWs } from './routes/oracles-routes.js'
import { coordinatorRouter } from './routes/coordinator-routes.js'
import { developersRouter, registerDeveloperWs } from './routes/developers-routes.js'
import { researchersRouter, registerResearcherWs } from './routes/researchers-routes.js'
import { spawnersRouter } from './routes/spawners-routes.js'

const app: ReturnType<typeof express> = express()
const wsInstance = expressWs(app)

// Middleware
app.use(helmet({ contentSecurityPolicy: false }))
app.use(cors({ origin: config.FRONTEND_URL, credentials: true }))
app.use(morgan('combined'))
app.use(express.json({ limit: '10mb' }))

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// API routes
app.use('/api/projects', projectsRouter)
app.use('/api/projects/:projectId/services', servicesRouter)
app.use('/api/projects/:projectId/actions', actionsRouter)
app.use('/api/projects/:projectId/edges', edgesRouter)
app.use('/api/projects/:projectId/dag', dagRouter)
app.use('/api/projects/:projectId/build', buildRouter)
app.use('/api/projects/:projectId/task', taskRouter)
app.use('/api/projects/:projectId/editor', editorRouter)
app.use('/api/projects/:projectId/chat', chatRouter)
app.use('/api/integrations/plane', planeRouter)
app.use('/api/scopes', scopesRouter)
app.use('/api/oracles', oraclesRouter)
registerOracleWs(app as any)
app.use('/api/coordinator', coordinatorRouter)
app.use('/api/developers', developersRouter)
registerDeveloperWs(app as any)
app.use('/api/researchers', researchersRouter)
registerResearcherWs(app as any)
app.use('/api/spawners', spawnersRouter)

// Error handler
app.use(errorHandler)

// Start server
const server = app.listen(config.PORT, () => {
  logger.info(`AgentForge backend running on port ${config.PORT}`)
  logger.info(`Frontend URL: ${config.FRONTEND_URL}`)
  logger.info(`Data directory: ${config.DATA_DIR}`)
})

// Graceful shutdown
const shutdown = () => {
  logger.info('Shutting down...')
  server.close(() => {
    logger.info('Server closed')
    process.exit(0)
  })
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

export { app, wsInstance }
