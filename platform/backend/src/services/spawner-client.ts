import { SpawnSpec, spawnSpecSchema } from '../schemas/spawner.js'

export interface SpawnerClientOptions {
  baseUrl: string
  timeoutMs?: number
  retries?: number
  retryBackoffMs?: number
  fetchImpl?: typeof fetch
}

export interface SpawnerHealth {
  status: 'ok'
  timestamp: string
}

export interface SpawnerInfo {
  host_id: string
  version: string
  capabilities: string[]
  primitive_count: number
  uptime_ms: number
  server_url_configured: boolean
}

export interface PrimitiveStateRecord {
  name: string
  kind: string
  state: string
  image: string
  container_id: string | null
  created_at: string
  updated_at: string
  last_event_at: string | null
  last_event_id: string | null
  spec: Record<string, unknown>
}

export interface DestroyResult {
  ok: boolean
  archive_path: string
  archive_bytes: number
  compose_rm_code: number
}

export interface LogsResult {
  service: string
  tail: number
  since: string | null
  exit_code: number
  stdout: string
  stderr: string
}

export interface InspectResult {
  state: PrimitiveStateRecord
  folder: string
  history: Array<{
    event_id: string
    state: string
    prev_state: string | null
    timestamp: string
    delivered: boolean
    attempts: number
    last_error: string | null
  }>
  last_event: { id: string; at: string; delivered: boolean } | null
}

export type ProbeResult =
  | {
      status: 'online'
      version: string
      capabilities: string[]
      primitiveCount: number
      latencyMs: number
    }
  | { status: 'offline'; reason: string }
  | { status: 'error'; httpStatus: number; reason: string }

export class SpawnerHttpError extends Error {
  constructor(public status: number, public bodyText: string, public code?: string) {
    super(`spawner HTTP ${status}: ${bodyText.slice(0, 200)}`)
    this.name = 'SpawnerHttpError'
  }
}

export class SpawnerTransportError extends Error {
  constructor(public cause: unknown) {
    super(
      `spawner transport: ${cause instanceof Error ? cause.message : String(cause)}`
    )
    this.name = 'SpawnerTransportError'
  }
}

const DEFAULT_TIMEOUT = 5000
const DEFAULT_RETRIES = 2
const DEFAULT_BACKOFF = 250
const HEALTH_TIMEOUT = 2000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const isRetryableStatus = (s: number) => s >= 500 || s === 408 || s === 429

export class SpawnerClient {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly retries: number
  private readonly retryBackoffMs: number
  private readonly fetchImpl: typeof fetch

  constructor(opts: SpawnerClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT
    this.retries = opts.retries ?? DEFAULT_RETRIES
    this.retryBackoffMs = opts.retryBackoffMs ?? DEFAULT_BACKOFF
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    overrideTimeoutMs?: number
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const timeout = overrideTimeoutMs ?? this.timeoutMs
    let lastErr: unknown = null

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), timeout)
      try {
        const res = await this.fetchImpl(url, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: ac.signal,
        })
        clearTimeout(timer)
        const text = await res.text()
        if (!res.ok) {
          let code: string | undefined
          try {
            const j = JSON.parse(text) as { error?: { code?: string } }
            code = j?.error?.code
          } catch {
            /* ignore */
          }
          if (isRetryableStatus(res.status) && attempt < this.retries) {
            await sleep(this.backoff(attempt))
            continue
          }
          throw new SpawnerHttpError(res.status, text, code)
        }
        return text ? (JSON.parse(text) as T) : (undefined as unknown as T)
      } catch (err) {
        clearTimeout(timer)
        if (err instanceof SpawnerHttpError) throw err
        lastErr = err
        if (attempt < this.retries) {
          await sleep(this.backoff(attempt))
          continue
        }
      }
    }
    throw new SpawnerTransportError(lastErr)
  }

  private backoff(attempt: number): number {
    const base = this.retryBackoffMs * Math.pow(2, attempt)
    return Math.floor(base * (0.8 + Math.random() * 0.4))
  }

  health(): Promise<SpawnerHealth> {
    return this.request('GET', '/health', undefined, HEALTH_TIMEOUT)
  }

  info(): Promise<SpawnerInfo> {
    return this.request('GET', '/info')
  }

  listSpawns(): Promise<PrimitiveStateRecord[]> {
    return this.request('GET', '/spawns')
  }

  inspectSpawn(name: string): Promise<InspectResult> {
    return this.request('GET', `/spawns/${encodeURIComponent(name)}`)
  }

  async spawn(spec: SpawnSpec): Promise<PrimitiveStateRecord> {
    spawnSpecSchema.parse(spec)
    return this.request('POST', '/spawns', spec)
  }

  destroySpawn(name: string): Promise<DestroyResult> {
    return this.request('POST', `/spawns/${encodeURIComponent(name)}/destroy`)
  }

  logs(
    name: string,
    opts?: { tail?: number | 'all'; since?: string }
  ): Promise<LogsResult> {
    const params = new URLSearchParams()
    if (opts?.tail !== undefined) params.set('tail', String(opts.tail))
    if (opts?.since !== undefined) params.set('since', opts.since)
    const qs = params.toString()
    return this.request(
      'GET',
      `/spawns/${encodeURIComponent(name)}/logs${qs ? `?${qs}` : ''}`
    )
  }

  async probe(): Promise<ProbeResult> {
    const startedAt = Date.now()
    try {
      await this.health()
      const info = await this.info()
      return {
        status: 'online',
        version: info.version,
        capabilities: info.capabilities,
        primitiveCount: info.primitive_count,
        latencyMs: Date.now() - startedAt,
      }
    } catch (err) {
      if (err instanceof SpawnerHttpError) {
        return {
          status: 'error',
          httpStatus: err.status,
          reason: err.bodyText.slice(0, 200) || err.message,
        }
      }
      return {
        status: 'offline',
        reason: err instanceof Error ? err.message : String(err),
      }
    }
  }
}

import * as queries from '../db/queries/spawners.js'

export const clientForHost = async (hostInternalId: string): Promise<SpawnerClient> => {
  const host = await queries.getSpawnerHost(hostInternalId)
  if (!host) {
    throw new Error(`spawner_host not found: ${hostInternalId}`)
  }
  return new SpawnerClient({ baseUrl: host.baseUrl })
}
