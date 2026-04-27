import { describe, it, expect, vi } from 'vitest'
import {
  SpawnerClient,
  SpawnerHttpError,
  SpawnerTransportError,
} from '../src/services/spawner-client'

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response => {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

describe('SpawnerClient.health', () => {
  it('returns parsed body on 200', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ status: 'ok', timestamp: '2026-04-25T00:00:00Z' }))
    const c = new SpawnerClient({ baseUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch })
    const out = await c.health()
    expect(out.status).toBe('ok')
    expect(fetchImpl.mock.calls[0][0]).toBe('http://x/health')
  })
})

describe('SpawnerClient retries', () => {
  it('retries on 503 then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({}, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ host_id: 'h1', version: '0.1.0', capabilities: [], primitive_count: 0, uptime_ms: 1, server_url_configured: true }))
    const c = new SpawnerClient({
      baseUrl: 'http://x',
      retries: 2,
      retryBackoffMs: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const info = await c.info()
    expect(info.host_id).toBe('h1')
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('does NOT retry on 400', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ error: { code: 'VALIDATION_ERROR', message: 'bad' } }, { status: 400 })
      )
    const c = new SpawnerClient({
      baseUrl: 'http://x',
      retries: 3,
      retryBackoffMs: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await expect(c.info()).rejects.toBeInstanceOf(SpawnerHttpError)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('throws SpawnerHttpError with extracted code', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { error: { code: 'PRIMITIVE_EXISTS', message: 'dup' } },
          { status: 409 }
        )
      )
    const c = new SpawnerClient({
      baseUrl: 'http://x',
      retries: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    try {
      await c.spawn({ name: 'dev-1', kind: 'developer', image: 'x:1' })
      throw new Error('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(SpawnerHttpError)
      const e = err as SpawnerHttpError
      expect(e.status).toBe(409)
      expect(e.code).toBe('PRIMITIVE_EXISTS')
    }
  })

  it('exhausts retries on transport failure → SpawnerTransportError', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const c = new SpawnerClient({
      baseUrl: 'http://x',
      retries: 2,
      retryBackoffMs: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    await expect(c.health()).rejects.toBeInstanceOf(SpawnerTransportError)
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })
})

describe('SpawnerClient.spawn', () => {
  it('validates spec before calling', async () => {
    const fetchImpl = vi.fn()
    const c = new SpawnerClient({ baseUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch })
    // Bad name (uppercase + bad chars)
    await expect(
      c.spawn({ name: 'BAD NAME', kind: 'developer', image: 'x:1' } as never)
    ).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('SpawnerClient.probe', () => {
  it('online when health + info both succeed', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: 'ok', timestamp: 't' }))
      .mockResolvedValueOnce(
        jsonResponse({
          host_id: 'h1',
          version: '0.1.0',
          capabilities: ['spawn'],
          primitive_count: 2,
          uptime_ms: 100,
          server_url_configured: true,
        })
      )
    const c = new SpawnerClient({
      baseUrl: 'http://x',
      retries: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const r = await c.probe()
    expect(r.status).toBe('online')
    if (r.status === 'online') {
      expect(r.version).toBe('0.1.0')
      expect(r.primitiveCount).toBe(2)
    }
  })

  it('offline on transport failure', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const c = new SpawnerClient({
      baseUrl: 'http://x',
      retries: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const r = await c.probe()
    expect(r.status).toBe('offline')
  })

  it('error on HTTP 500', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { code: 'BOOM' } }, { status: 500 }))
    const c = new SpawnerClient({
      baseUrl: 'http://x',
      retries: 0,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    const r = await c.probe()
    expect(r.status).toBe('error')
    if (r.status === 'error') {
      expect(r.httpStatus).toBe(500)
    }
  })
})
