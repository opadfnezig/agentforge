import { describe, it, expect, vi, beforeEach } from 'vitest'
import request from 'supertest'
import express from 'express'
import { errorHandler } from '../src/utils/error-handler'

vi.mock('../src/db/queries/spawners', () => {
  return {
    listSpawnerHosts: vi.fn(),
    createSpawnerHost: vi.fn(),
    getSpawnerHost: vi.fn(),
    getSpawnerHostByHostId: vi.fn(),
    updateSpawnerHost: vi.fn(),
    deleteSpawnerHost: vi.fn(),
    ingestLifecycleEvent: vi.fn(),
    listSpawnsForHost: vi.fn(),
    getSpawn: vi.fn(),
  }
})

vi.mock('../src/services/spawner-client', () => {
  const probe = vi.fn()
  class SpawnerClient {
    constructor(public opts: unknown) {}
    probe = probe
  }
  return { SpawnerClient, __probe: probe }
})

import * as queries from '../src/db/queries/spawners'
import { spawnersRouter } from '../src/routes/spawners-routes'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const probeMock = (await import('../src/services/spawner-client')) as any

const buildApp = () => {
  const app = express()
  app.use(express.json())
  app.use('/api/spawners', spawnersRouter)
  app.use(errorHandler)
  return app
}

const sampleHost = {
  id: 'host-uuid-1',
  hostId: 'host-eu-1',
  name: 'EU 1',
  baseUrl: 'http://10.0.5.7:9898',
  status: 'unknown' as const,
  version: null,
  capabilities: [],
  lastSeenAt: null,
  lastEventAt: null,
  lastError: null,
  config: {},
  createdAt: new Date(),
  updatedAt: new Date(),
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('spawners CRUD', () => {
  it('GET / returns the list', async () => {
    vi.mocked(queries.listSpawnerHosts).mockResolvedValue([sampleHost])
    const res = await request(buildApp()).get('/api/spawners')
    expect(res.status).toBe(200)
    expect(res.body).toHaveLength(1)
    expect(res.body[0].hostId).toBe('host-eu-1')
  })

  it('POST / creates a host', async () => {
    vi.mocked(queries.getSpawnerHostByHostId).mockResolvedValue(null)
    vi.mocked(queries.createSpawnerHost).mockResolvedValue(sampleHost)
    const res = await request(buildApp())
      .post('/api/spawners')
      .send({ hostId: 'host-eu-1', name: 'EU 1', baseUrl: 'http://10.0.5.7:9898' })
    expect(res.status).toBe(201)
    expect(res.body.hostId).toBe('host-eu-1')
  })

  it('POST / rejects duplicate host_id with 409', async () => {
    vi.mocked(queries.getSpawnerHostByHostId).mockResolvedValue(sampleHost)
    const res = await request(buildApp())
      .post('/api/spawners')
      .send({ hostId: 'host-eu-1', name: 'EU 1', baseUrl: 'http://10.0.5.7:9898' })
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('SPAWNER_EXISTS')
  })

  it('POST / rejects invalid baseUrl', async () => {
    const res = await request(buildApp())
      .post('/api/spawners')
      .send({ hostId: 'host-eu-1', name: 'EU 1', baseUrl: 'not-a-url' })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('GET /:id returns 404 when missing', async () => {
    vi.mocked(queries.getSpawnerHost).mockResolvedValue(null)
    const res = await request(buildApp()).get('/api/spawners/missing')
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('SPAWNER_HOST_NOT_FOUND')
  })

  it('PATCH /:id updates a host', async () => {
    vi.mocked(queries.updateSpawnerHost).mockResolvedValue({ ...sampleHost, name: 'renamed' })
    const res = await request(buildApp())
      .patch('/api/spawners/host-uuid-1')
      .send({ name: 'renamed' })
    expect(res.status).toBe(200)
    expect(res.body.name).toBe('renamed')
  })

  it('DELETE /:id returns 204 on success', async () => {
    vi.mocked(queries.deleteSpawnerHost).mockResolvedValue(true)
    const res = await request(buildApp()).delete('/api/spawners/host-uuid-1')
    expect(res.status).toBe(204)
  })
})

describe('spawners probe', () => {
  it('online probe → 200 + writes status=online', async () => {
    vi.mocked(queries.getSpawnerHost).mockResolvedValue(sampleHost)
    probeMock.__probe.mockResolvedValue({
      status: 'online',
      version: '0.1.0',
      capabilities: ['spawn'],
      primitiveCount: 0,
      latencyMs: 12,
    })
    vi.mocked(queries.updateSpawnerHost).mockResolvedValue({ ...sampleHost, status: 'online' })
    const res = await request(buildApp()).post('/api/spawners/host-uuid-1/probe')
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('online')
    const updateCall = vi.mocked(queries.updateSpawnerHost).mock.calls[0]
    expect(updateCall[1]).toMatchObject({ status: 'online', version: '0.1.0' })
  })

  it('offline probe → 502 + writes status=offline', async () => {
    vi.mocked(queries.getSpawnerHost).mockResolvedValue(sampleHost)
    probeMock.__probe.mockResolvedValue({ status: 'offline', reason: 'ECONNREFUSED' })
    vi.mocked(queries.updateSpawnerHost).mockResolvedValue({ ...sampleHost, status: 'offline' })
    const res = await request(buildApp()).post('/api/spawners/host-uuid-1/probe')
    expect(res.status).toBe(502)
    expect(res.body.error.code).toBe('SPAWNER_UNREACHABLE')
    expect(res.body.error.probe.status).toBe('offline')
  })
})

describe('lifecycle ingest', () => {
  const validBody = () => ({
    event_id: '11111111-1111-4111-8111-111111111111',
    primitive_name: 'dev-alpha',
    primitive_kind: 'developer',
    state: 'running',
    prev_state: 'creating',
    timestamp: '2026-04-25T12:00:00.000Z',
    host_id: 'host-eu-1',
    payload: { image: 'ghcr.io/x/y:tag', container_id: 'abc123' },
  })

  it('valid event → 200 deduped=false', async () => {
    vi.mocked(queries.getSpawnerHostByHostId).mockResolvedValue(sampleHost)
    vi.mocked(queries.ingestLifecycleEvent).mockResolvedValue({
      deduped: false,
      eventRowId: 'event-row-1',
    })
    const res = await request(buildApp())
      .post('/api/spawners/host-eu-1/events')
      .send(validBody())
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, deduped: false })
  })

  it('replay → 200 deduped=true', async () => {
    vi.mocked(queries.getSpawnerHostByHostId).mockResolvedValue(sampleHost)
    vi.mocked(queries.ingestLifecycleEvent).mockResolvedValue({
      deduped: true,
      eventRowId: 'event-row-1',
    })
    const res = await request(buildApp())
      .post('/api/spawners/host-eu-1/events')
      .send(validBody())
    expect(res.status).toBe(200)
    expect(res.body.deduped).toBe(true)
  })

  it('unknown :hostId → 404', async () => {
    vi.mocked(queries.getSpawnerHostByHostId).mockResolvedValue(null)
    const res = await request(buildApp())
      .post('/api/spawners/host-eu-1/events')
      .send(validBody())
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('SPAWNER_HOST_NOT_FOUND')
  })

  it('body host_id mismatch with URL → 409', async () => {
    vi.mocked(queries.getSpawnerHostByHostId).mockResolvedValue(sampleHost)
    const body = { ...validBody(), host_id: 'host-us-1' }
    const res = await request(buildApp())
      .post('/api/spawners/host-eu-1/events')
      .send(body)
    expect(res.status).toBe(409)
    expect(res.body.error.code).toBe('HOST_ID_MISMATCH')
  })

  it('invalid event_id → 400', async () => {
    vi.mocked(queries.getSpawnerHostByHostId).mockResolvedValue(sampleHost)
    const body = { ...validBody(), event_id: 'not-a-uuid' }
    const res = await request(buildApp())
      .post('/api/spawners/host-eu-1/events')
      .send(body)
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('invalid state enum → 400', async () => {
    vi.mocked(queries.getSpawnerHostByHostId).mockResolvedValue(sampleHost)
    const body = { ...validBody(), state: 'bogus' }
    const res = await request(buildApp())
      .post('/api/spawners/host-eu-1/events')
      .send(body)
    expect(res.status).toBe(400)
  })
})
