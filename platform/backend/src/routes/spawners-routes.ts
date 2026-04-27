import { Router } from 'express'
import {
  createSpawnerHostSchema,
  updateSpawnerHostSchema,
  lifecycleEventSchema,
} from '../schemas/spawner.js'
import * as queries from '../db/queries/spawners.js'
import {
  SpawnerClient,
  SpawnerHttpError,
  SpawnerTransportError,
} from '../services/spawner-client.js'
import { spawnerRegistry } from '../services/spawner-registry.js'
import { AppError } from '../utils/error-handler.js'
import { logger } from '../utils/logger.js'

export const spawnersRouter = Router()

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

spawnersRouter.get('/', async (_req, res, next) => {
  try {
    const hosts = await queries.listSpawnerHosts()
    res.json(hosts)
  } catch (err) {
    next(err)
  }
})

spawnersRouter.post('/', async (req, res, next) => {
  try {
    const data = createSpawnerHostSchema.parse(req.body)
    const existing = await queries.getSpawnerHostByHostId(data.hostId)
    if (existing) {
      throw new AppError(
        409,
        `spawner host '${data.hostId}' already registered`,
        'SPAWNER_EXISTS'
      )
    }
    const host = await queries.createSpawnerHost(data)
    logger.info({ id: host.id, hostId: host.hostId }, 'Spawner host created')
    res.status(201).json(host)
  } catch (err) {
    next(err)
  }
})

spawnersRouter.get('/:id', async (req, res, next) => {
  try {
    const host = await queries.getSpawnerHost(req.params.id)
    if (!host) {
      throw new AppError(404, 'spawner host not found', 'SPAWNER_HOST_NOT_FOUND')
    }
    res.json(host)
  } catch (err) {
    next(err)
  }
})

spawnersRouter.patch('/:id', async (req, res, next) => {
  try {
    const data = updateSpawnerHostSchema.parse(req.body)
    const host = await queries.updateSpawnerHost(req.params.id, data)
    if (!host) {
      throw new AppError(404, 'spawner host not found', 'SPAWNER_HOST_NOT_FOUND')
    }
    logger.info({ id: host.id, hostId: host.hostId }, 'Spawner host updated')
    res.json(host)
  } catch (err) {
    next(err)
  }
})

spawnersRouter.delete('/:id', async (req, res, next) => {
  try {
    const ok = await queries.deleteSpawnerHost(req.params.id)
    if (!ok) {
      throw new AppError(404, 'spawner host not found', 'SPAWNER_HOST_NOT_FOUND')
    }
    logger.info({ id: req.params.id }, 'Spawner host deleted')
    res.status(204).send()
  } catch (err) {
    next(err)
  }
})

// Synchronous probe — contacts the spawner over HTTP and writes the result
// back onto the host row. 200 only if the spawner is reachable AND healthy;
// 502 with reason on transport failure or error response.
spawnersRouter.post('/:id/probe', async (req, res, next) => {
  try {
    const host = await queries.getSpawnerHost(req.params.id)
    if (!host) {
      throw new AppError(404, 'spawner host not found', 'SPAWNER_HOST_NOT_FOUND')
    }
    const client = new SpawnerClient({ baseUrl: host.baseUrl })
    const result = await client.probe()
    if (result.status === 'online') {
      await queries.updateSpawnerHost(host.id, {
        status: 'online',
        version: result.version,
        capabilities: result.capabilities,
        lastSeenAt: new Date(),
        lastError: null,
      })
      res.json(result)
      return
    }
    const newStatus = result.status === 'error' ? 'error' : 'offline'
    await queries.updateSpawnerHost(host.id, {
      status: newStatus,
      lastError: 'reason' in result ? result.reason : null,
    })
    res.status(502).json({
      error: {
        message: `spawner unreachable: ${'reason' in result ? result.reason : 'unknown'}`,
        code: 'SPAWNER_UNREACHABLE',
        probe: result,
      },
    })
  } catch (err) {
    next(err)
  }
})

// Read the latest known state of every primitive on a host (from ingested
// lifecycle events, not from a live call to the spawner).
spawnersRouter.get('/:id/spawns', async (req, res, next) => {
  try {
    const host = await queries.getSpawnerHost(req.params.id)
    if (!host) {
      throw new AppError(404, 'spawner host not found', 'SPAWNER_HOST_NOT_FOUND')
    }
    const spawns = await queries.listSpawnsForHost(host.id)
    res.json(spawns)
  } catch (err) {
    next(err)
  }
})

// Single-primitive read — used by the SpawnBadge polling loop. Returns the
// latest ingested state, or 404 if no events have arrived for this primitive.
spawnersRouter.get('/:id/spawns/:primitiveName', async (req, res, next) => {
  try {
    const host = await queries.getSpawnerHost(req.params.id)
    if (!host) {
      throw new AppError(404, 'spawner host not found', 'SPAWNER_HOST_NOT_FOUND')
    }
    const spawn = await queries.getSpawn(host.id, req.params.primitiveName)
    if (!spawn) {
      throw new AppError(
        404,
        `no spawn for '${req.params.primitiveName}' on this host`,
        'SPAWN_NOT_FOUND'
      )
    }
    res.json(spawn)
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// Spawn intents — pending [spawn, ...] commands awaiting user approval.
// Approve translates the intent into an HTTP call to the spawner; spawner's
// in-process composeMutex serializes concurrent spawns at the host level
// (verified in spawner/src/lib/mutex.ts + lifecycle.ts:39,110), so backend
// fires concurrent requests without queuing locally.
// ---------------------------------------------------------------------------

// List intents for a host, filterable by status.
spawnersRouter.get('/:id/spawn-intents', async (req, res, next) => {
  try {
    const host = await queries.getSpawnerHost(req.params.id)
    if (!host) {
      throw new AppError(404, 'spawner host not found', 'SPAWNER_HOST_NOT_FOUND')
    }
    const status = typeof req.query.status === 'string'
      ? (req.query.status as queries.IntentStatusQuery)
      : undefined
    const intents = await queries.listSpawnIntentsForHost(host.id, status)
    res.json(intents)
  } catch (err) {
    next(err)
  }
})

// Approve a pending intent. Synchronously calls SpawnerClient.spawn() — the
// spawner's POST /spawns is fast (bounded by `docker compose up -d`) and
// returning the resulting Spawn row to the caller is more useful than a 202
// fire-and-forget. On spawner error: intent is marked 'failed' with the
// error text, and 502 is returned to the client.
spawnersRouter.post('/:id/spawn-intents/:intentId/approve', async (req, res, next) => {
  try {
    const intent = await queries.getSpawnIntent(req.params.intentId)
    if (!intent || intent.spawnerHostId !== req.params.id) {
      throw new AppError(404, 'spawn intent not found', 'SPAWN_INTENT_NOT_FOUND')
    }
    if (intent.status !== 'pending') {
      throw new AppError(
        409,
        `intent is ${intent.status}, only pending intents can be approved`,
        'INTENT_NOT_PENDING'
      )
    }
    const host = await queries.getSpawnerHost(req.params.id)
    if (!host) {
      throw new AppError(404, 'spawner host not found', 'SPAWNER_HOST_NOT_FOUND')
    }

    const client = new SpawnerClient({ baseUrl: host.baseUrl, timeoutMs: 30_000 })
    let primitive
    try {
      primitive = await client.spawn(intent.spec)
    } catch (err) {
      const message =
        err instanceof SpawnerHttpError
          ? `spawner ${err.status}: ${err.bodyText.slice(0, 300)}`
          : err instanceof SpawnerTransportError
          ? `spawner transport: ${err.cause instanceof Error ? err.cause.message : String(err.cause)}`
          : err instanceof Error
          ? err.message
          : String(err)
      await queries.updateSpawnIntent(intent.id, {
        status: 'failed',
        errorMessage: message,
      })
      logger.warn(
        { intentId: intent.id, hostId: host.hostId, primitive: intent.primitiveName, err: message },
        'Spawn approval failed at spawner'
      )
      res.status(502).json({
        error: { message, code: 'SPAWN_FAILED' },
      })
      return
    }

    await queries.updateSpawnIntent(intent.id, {
      status: 'approved',
      approvedAt: new Date(),
      errorMessage: null,
    })
    logger.info(
      {
        intentId: intent.id,
        hostId: host.hostId,
        primitive: intent.primitiveName,
        containerId: primitive.container_id,
      },
      'Spawn intent approved'
    )
    res.json({ intent: { ...intent, status: 'approved', approvedAt: new Date() }, primitive })
  } catch (err) {
    next(err)
  }
})

// Cancel a pending intent. No spawner call; just marks the intent cancelled.
spawnersRouter.post('/:id/spawn-intents/:intentId/cancel', async (req, res, next) => {
  try {
    const intent = await queries.getSpawnIntent(req.params.intentId)
    if (!intent || intent.spawnerHostId !== req.params.id) {
      throw new AppError(404, 'spawn intent not found', 'SPAWN_INTENT_NOT_FOUND')
    }
    if (intent.status !== 'pending') {
      throw new AppError(
        409,
        `intent is ${intent.status}, only pending intents can be cancelled`,
        'INTENT_NOT_PENDING'
      )
    }
    const updated = await queries.updateSpawnIntent(intent.id, {
      status: 'cancelled',
      cancelledAt: new Date(),
    })
    logger.info({ intentId: intent.id }, 'Spawn intent cancelled')
    res.json(updated)
  } catch (err) {
    next(err)
  }
})

// Read a single intent. Used by the frontend after the badge has been
// re-rendered from a stored chat (where intent state may have advanced).
spawnersRouter.get('/:id/spawn-intents/:intentId', async (req, res, next) => {
  try {
    const intent = await queries.getSpawnIntent(req.params.intentId)
    if (!intent || intent.spawnerHostId !== req.params.id) {
      throw new AppError(404, 'spawn intent not found', 'SPAWN_INTENT_NOT_FOUND')
    }
    res.json(intent)
  } catch (err) {
    next(err)
  }
})

// ---------------------------------------------------------------------------
// Lifecycle event ingest — POST /api/spawners/:hostId/events
//
// AUTH: NONE for v1. The deferred ed25519 signing pass (see
// docs/spawner/architecture.md "Why no auth (yet)") will land for every
// primitive at once. Until then, deploy must keep this endpoint on a private
// network only. TODO: add ed25519 verify middleware when the auth pass lands.
//
// `:hostId` is the spawner-supplied host_id (e.g. "host-eu-1"), NOT the
// internal UUID. Set NTFR_SERVER_URL on the spawner side to include `/api`
// (e.g. https://ntfr.example.com/api) so the URL the spawner builds —
// `${NTFR_SERVER_URL}/spawners/{NTFR_HOST_ID}/events` — lands at this route.
// ---------------------------------------------------------------------------
spawnersRouter.post('/:hostId/events', async (req, res, next) => {
  try {
    const event = lifecycleEventSchema.parse(req.body)
    if (event.host_id !== req.params.hostId) {
      throw new AppError(
        409,
        `host_id in body ('${event.host_id}') does not match URL ('${req.params.hostId}')`,
        'HOST_ID_MISMATCH'
      )
    }
    const host = await queries.getSpawnerHostByHostId(req.params.hostId)
    if (!host) {
      throw new AppError(
        404,
        `spawner host '${req.params.hostId}' not registered (POST /api/spawners first)`,
        'SPAWNER_HOST_NOT_FOUND'
      )
    }
    const result = await queries.ingestLifecycleEvent(host.id, event)
    spawnerRegistry.events.emit(`event:${host.hostId}`, event)
    spawnerRegistry.events.emit(`event:${host.hostId}:${event.primitive_name}`, event)
    logger.info(
      {
        hostId: host.hostId,
        primitive: event.primitive_name,
        state: event.state,
        eventId: event.event_id,
        deduped: result.deduped,
      },
      'Lifecycle event ingested'
    )
    res.json({ ok: true, deduped: result.deduped })
  } catch (err) {
    next(err)
  }
})
