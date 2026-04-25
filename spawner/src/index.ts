import express from 'express'
import { mkdir, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { config, paths } from './config.js'
import { logger } from './lib/logger.js'
import { errorHandler } from './lib/error-handler.js'
import { spawnsRouter } from './routes/spawns.js'
import { systemRouter, markBooted } from './routes/system.js'
import { db, setHostMeta, getHostMeta } from './lib/db.js'
import { startLifecycleDelivery, stopLifecycleDelivery } from './services/lifecycle-events.js'
import { recoverOrphans } from './services/lifecycle.js'

const ensureWorkdir = async () => {
  await mkdir(paths.root, { recursive: true, mode: 0o755 })
  await mkdir(paths.spawnerDir, { recursive: true, mode: 0o755 })
  await mkdir(paths.archiveDir, { recursive: true, mode: 0o755 })
  if (!existsSync(paths.composeFile)) {
    // Seed an empty compose file so docker compose has something to read.
    await writeFile(paths.composeFile, 'name: ntfr\nservices: {}\n', 'utf8')
  }
}

const main = async () => {
  await ensureWorkdir()
  // Initialize sqlite (creates schema if needed).
  db()
  // Stamp host metadata (idempotent).
  if (!getHostMeta('host_id')) setHostMeta('host_id', config.NTFR_HOST_ID)
  setHostMeta('last_boot', new Date().toISOString())

  // Start lifecycle delivery loop BEFORE orphan recovery so any events the
  // recovery emits get picked up immediately.
  startLifecycleDelivery()

  // Orphan recovery on startup, in the background.
  recoverOrphans(config.NTFR_ORPHAN_RETRY_MAX, config.NTFR_ORPHAN_RETRY_BACKOFF_MS)
    .then((r) => logger.info('Orphan recovery complete', r))
    .catch((err) => logger.error('Orphan recovery failed', { err: String(err) }))

  const app = express()
  app.use(express.json({ limit: '2mb' }))

  app.use('/spawns', spawnsRouter)
  app.use('/', systemRouter)
  app.use(errorHandler)

  markBooted()
  const server = app.listen(config.NTFR_PORT, () => {
    logger.info('ntfr-spawner listening', {
      port: config.NTFR_PORT,
      host_id: config.NTFR_HOST_ID,
      workdir: paths.root,
      server_url: config.NTFR_SERVER_URL ?? null,
    })
  })

  const shutdown = (sig: string) => {
    logger.info('Shutdown signal received', { signal: sig })
    stopLifecycleDelivery()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 5000).unref()
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err) => {
  // Use console here in case logger isn't writable yet
  console.error('[spawner] fatal startup error', err)
  process.exit(1)
})
