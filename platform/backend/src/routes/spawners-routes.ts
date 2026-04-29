import { Router } from 'express'
import {
  createSpawnerHostSchema,
  updateSpawnerHostSchema,
  lifecycleEventSchema,
} from '../schemas/spawner.js'
import * as queries from '../db/queries/spawners.js'
import * as developerQueries from '../db/queries/developers.js'
import * as oracleQueries from '../db/queries/oracles.js'
import {
  SpawnerClient,
  SpawnerHttpError,
  SpawnerTransportError,
} from '../services/spawner-client.js'
import { spawnerRegistry } from '../services/spawner-registry.js'
import { AppError } from '../utils/error-handler.js'
import { logger } from '../utils/logger.js'
import { config } from '../config.js'

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

    // For developer-kind spawns: create the backing developer row up front
    // so we can pass DEVELOPER_ID + DEVELOPER_SECRET to the container as env.
    // The developer process inside the container connects back to the
    // backend WS with these credentials and registers itself. COORDINATOR_URL
    // and WORKSPACE_PATH are injected by the spawner per kind.
    let createdDeveloperId: string | null = null
    let spec = intent.spec
    if (intent.primitiveKind === 'developer') {
      const dev = await developerQueries.createDeveloper({
        name: intent.primitiveName,
        workspacePath: '/workspace',
      })
      createdDeveloperId = dev.id
      spec = {
        ...intent.spec,
        env: {
          ...(intent.spec.env ?? {}),
          DEVELOPER_ID: dev.id,
          DEVELOPER_SECRET: dev.secret,
        },
      }
    }

    // For oracle-kind spawns: spawn = create-from-nothing, mirror the
    // developer flow above. If a row with this name already exists (e.g.
    // user POSTed /api/oracles first to pin a non-default state_dir) we
    // reuse it — makes the operation idempotent and respects pre-existing
    // customisations. Otherwise we create with sensible defaults:
    // domain = oracleName, stateDir = ${ORACLE_STATE_DIR}/${oracleName}.
    //
    // The primitive (container) name is `oracle-<name>` for grep-ability
    // on the host; the underlying oracle row uses the unprefixed name as
    // its identity. Strip the prefix here so DB rows and on-disk state
    // dirs stay clean (`hearth`, not `oracle-hearth`).
    let createdOracleId: string | null = null
    if (intent.primitiveKind === 'oracle') {
      const oracleName = intent.primitiveName.replace(/^oracle-/, '')
      let oracle = await oracleQueries.getOracleByName(oracleName)
      if (!oracle) {
        oracle = await oracleQueries.createOracle({
          name: oracleName,
          domain: oracleName,
          stateDir: `${config.ORACLE_STATE_DIR}/${oracleName}`,
        })
        createdOracleId = oracle.id
        logger.info({ oracleId: oracle.id, name: oracle.name, primitiveName: intent.primitiveName, stateDir: oracle.stateDir }, 'Oracle row auto-created on spawn')
      }
      const oracleSecret = await oracleQueries.ensureOracleSecret(oracle.id)
      if (!oracleSecret) {
        throw new AppError(500, 'failed to mint oracle secret', 'ORACLE_SECRET_FAILED')
      }
      // Auto-inject the two persistence mounts every oracle worker needs.
      // Without these the worker writes to its overlay filesystem and
      // loses everything on destroy (= the "oracle didn't want to write
      // its state" symptom).
      //
      // Layout, all under the spawner's workdir:
      //   ./oracles/<primitiveName>/memory ↔ /home/agent/.claude/projects/-workspace/memory
      //     (claude memory dir — the worker's actual state)
      //   ./oracles/<primitiveName>/data   ↔ /data
      //     (migration staging — operator drops files here, worker
      //      ingests into memory and deletes them)
      //
      // The /home/... target is dictated by oracle/Dockerfile pinning
      // WORKDIR=/workspace, which makes claude resolve its memory dir
      // to ~/.claude/projects/-workspace/memory. Don't change this path
      // without changing the Dockerfile.
      //
      // Sources are relative-to-spawner-workdir; the spawner expands
      // them when generating compose for the primitive. User-supplied
      // mounts in the original spec are preserved and take precedence
      // (defensive: if the operator wants to pin memory elsewhere they
      // can pass a mount with the same target).
      const userMountTargets = new Set((intent.spec.mounts ?? []).map((m) => m.target))
      const defaultMounts = [
        {
          source: `./oracles/${intent.primitiveName}/memory`,
          target: '/home/agent/.claude/projects/-workspace/memory',
          readOnly: false,
        },
        {
          source: `./oracles/${intent.primitiveName}/data`,
          target: '/data',
          readOnly: false,
        },
      ].filter((m) => !userMountTargets.has(m.target))

      spec = {
        ...intent.spec,
        env: {
          ...(intent.spec.env ?? {}),
          ORACLE_ID: oracle.id,
          ORACLE_SECRET: oracleSecret,
        },
        mounts: [...(intent.spec.mounts ?? []), ...defaultMounts],
      }
    }

    // First-time spawn includes compose-up + image build (e.g. ntfr-oracle
    // takes ~2min on hearth). 30s used to be the timeout — that aborted on
    // the backend mid-build, which then ran createdOracleId cleanup, which
    // left the container with a deleted ORACLE_ID once it eventually came
    // up (4004 "Oracle not found" forever in the worker logs). 5min covers
    // the build path comfortably.
    const client = new SpawnerClient({ baseUrl: host.baseUrl, timeoutMs: 300_000 })
    let primitive
    try {
      primitive = await client.spawn(spec)
    } catch (err) {
      const isHttpError = err instanceof SpawnerHttpError
      const isTransportError = err instanceof SpawnerTransportError
      const message = isHttpError
        ? `spawner ${err.status}: ${err.bodyText.slice(0, 300)}`
        : isTransportError
        ? `spawner transport: ${err.cause instanceof Error ? err.cause.message : String(err.cause)}`
        : err instanceof Error
        ? err.message
        : String(err)
      await queries.updateSpawnIntent(intent.id, {
        status: 'failed',
        errorMessage: message,
      })
      // Cleanup of auto-created rows is gated on confirmed-failure (the
      // spawner responded with an HTTP error). Transport-level errors
      // (timeout / abort / connection-reset) might mean the spawn is
      // still in progress on the host — deleting the oracle/developer row
      // here would orphan the container with a now-invalid ID and the
      // worker would 4004-loop forever on connect. Better to leave the
      // row and let the user clean it up manually if the spawn never
      // actually lands.
      const safeToCleanup = isHttpError
      if (createdDeveloperId && safeToCleanup) {
        try {
          await developerQueries.updateDeveloper(createdDeveloperId, { status: 'destroyed' })
        } catch (cleanupErr) {
          logger.warn(
            { developerId: createdDeveloperId, err: cleanupErr },
            'Failed to mark developer row destroyed after spawner error'
          )
        }
      }
      if (createdOracleId && safeToCleanup) {
        try {
          await oracleQueries.deleteOracle(createdOracleId)
        } catch (cleanupErr) {
          logger.warn(
            { oracleId: createdOracleId, err: cleanupErr },
            'Failed to delete auto-created oracle row after spawner error'
          )
        }
      }
      if (!safeToCleanup && (createdDeveloperId || createdOracleId)) {
        logger.warn(
          { intentId: intent.id, createdDeveloperId, createdOracleId, err: message },
          'Transport error during spawn — leaving auto-created rows in place (spawn may still complete)'
        )
      }
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
