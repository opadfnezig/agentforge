// Vendored from core/src/providers/anthropic.js — that file is the authoritative
// reference contract for the OAuth bypass (see docs/oauth-bypass.md). We vendor
// because core's package.json `exports` map only exposes "." and "./server", so
// the provider can't be deep-imported as @hearth/core/providers/anthropic.js,
// and core/ is read-only. Mirror behavioural changes from upstream when they
// land. Two intentional deltas vs upstream:
//   1. TypeScript instead of JS.
//   2. Streaming function returns a richer trailer (input/output/cache token
//      counts, stop_reason, model, message_id, duration_ms) so the coordinator
//      can persist per-turn cost/duration without re-implementing SSE parsing.
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const DEFAULT_BASE_URL = 'https://api.anthropic.com'
const API_VERSION = '2023-06-01'
const MAX_RETRIES = 3
const CC_BILLING_HEADER =
  'x-anthropic-billing-header: cc_version=2.1.77.e19; cc_entrypoint=claude-vscode; cch=2976e;'
const OAUTH_BETA_FLAGS =
  'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advanced-tool-use-2025-11-20,effort-2025-11-24'

const OAUTH_SESSION_TTL_MS = 10 * 60 * 1000
const CRED_CACHE_TTL_MS = 60 * 1000

interface OauthCreds { key: string; isOAuth: true; expiresAt: number; readAt: number }
interface ApiKeyCreds { key: string; isOAuth: false }
type Creds = OauthCreds | ApiKeyCreds

let credCache: OauthCreds | null = null
let oauthSessionActive = false
let oauthSessionTime = 0

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const log = (...args: unknown[]) => {
  // Match upstream's console.log surface — pino is wired by callers; this
  // keeps the vendored module dependency-free and easy to re-sync.
  // eslint-disable-next-line no-console
  console.log('[anthropic-oauth]', ...args)
}
const warn = (...args: unknown[]) => {
  // eslint-disable-next-line no-console
  console.warn('[anthropic-oauth]', ...args)
}
const err = (...args: unknown[]) => {
  // eslint-disable-next-line no-console
  console.error('[anthropic-oauth]', ...args)
}

const getCredentials = (): Creds | null => {
  if (process.env.ANTHROPIC_API_KEY) {
    return { key: process.env.ANTHROPIC_API_KEY, isOAuth: false }
  }

  if (credCache && credCache.readAt > Date.now() - CRED_CACHE_TTL_MS) {
    return credCache
  }

  try {
    const credPath = join(homedir(), '.claude', '.credentials.json')
    const raw = JSON.parse(readFileSync(credPath, 'utf8')) as {
      claudeAiOauth?: { accessToken?: string; refreshToken?: string; expiresAt?: number }
    }
    const oauth = raw.claudeAiOauth
    if (oauth?.accessToken) {
      const isNewToken = credCache?.key !== oauth.accessToken
      credCache = {
        key: oauth.accessToken,
        isOAuth: true,
        expiresAt: oauth.expiresAt ?? Number.POSITIVE_INFINITY,
        readAt: Date.now(),
      }
      if (isNewToken) {
        oauthSessionActive = false
        log('OAuth token refreshed from credentials file')
      }
      return credCache
    }
  } catch {
    // No credentials file — fall through.
  }
  return null
}

const activateOAuthSession = async (token: string, force = false): Promise<void> => {
  if (oauthSessionActive && !force && Date.now() - oauthSessionTime < OAUTH_SESSION_TTL_MS) {
    return
  }
  try {
    const axiosHeaders = {
      Accept: 'application/json, text/plain, */*',
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'axios/1.8.4',
    }
    const cliHeaders = { ...axiosHeaders, 'User-Agent': 'claude-code/2.1.76' }
    const jsonHeaders = { ...cliHeaders, 'Content-Type': 'application/json' }
    const groveHeaders = {
      ...axiosHeaders,
      'User-Agent': 'claude-cli/2.1.76 (external, claude-vscode, agent-sdk/0.2.73)',
    }

    await Promise.all([
      fetch(`${DEFAULT_BASE_URL}/api/claude_code_penguin_mode`, { headers: axiosHeaders }),
      fetch(`${DEFAULT_BASE_URL}/api/oauth/claude_cli/client_data`, { headers: jsonHeaders }),
      fetch(`${DEFAULT_BASE_URL}/api/oauth/account/settings`, { headers: cliHeaders }),
      fetch(`${DEFAULT_BASE_URL}/api/claude_code_grove`, { headers: groveHeaders }),
    ])

    oauthSessionActive = true
    oauthSessionTime = Date.now()
    log('OAuth session activated (full handshake)')
  } catch (e) {
    warn('OAuth session activation failed:', (e as Error).message)
  }
}

const refreshOAuthToken = async (): Promise<string | null> => {
  try {
    const credPath = join(homedir(), '.claude', '.credentials.json')
    const creds = JSON.parse(readFileSync(credPath, 'utf8')) as {
      claudeAiOauth?: { accessToken?: string; refreshToken?: string }
    }
    const oauth = creds.claudeAiOauth
    if (!oauth?.refreshToken) {
      warn('No refresh token available')
      return null
    }

    log('Attempting OAuth token refresh via claude CLI...')
    const { execSync } = await import('child_process')
    try {
      execSync('claude -p "ok" --max-turns 1', {
        timeout: 30_000,
        stdio: 'pipe',
        env: { ...process.env, HOME: homedir() },
      })
    } catch {
      // The actual call may fail; only the credential file mutation matters.
    }

    const fresh = JSON.parse(readFileSync(credPath, 'utf8')) as {
      claudeAiOauth?: { accessToken?: string }
    }
    const freshToken = fresh.claudeAiOauth?.accessToken
    if (freshToken && freshToken !== oauth.accessToken) {
      log('OAuth token refreshed successfully')
      credCache = null
      oauthSessionActive = false
      return freshToken
    }
    warn('Token refresh did not produce a new token')
    return null
  } catch (e) {
    err('Token refresh failed:', (e as Error).message)
    return null
  }
}

interface RequestOptions {
  method?: 'POST' | 'GET'
  body?: Record<string, unknown>
  baseUrl?: string
  timeout?: number
  retries?: number
  apiKey?: string
}

const request = async (endpoint: string, options: RequestOptions = {}): Promise<Response> => {
  const {
    method = 'POST',
    body,
    baseUrl = DEFAULT_BASE_URL,
    timeout = 120_000,
    retries = MAX_RETRIES,
  } = options

  const creds: Creds | null = options.apiKey
    ? { key: options.apiKey, isOAuth: false }
    : getCredentials()

  if (!creds) {
    throw new Error(
      'No Anthropic API key found — set ANTHROPIC_API_KEY or install Claude Code with OAuth',
    )
  }

  if (creds.isOAuth) await activateOAuthSession(creds.key)

  const url = `${baseUrl}${endpoint}`
  let lastError: Error | undefined

  for (let attempt = 1; attempt <= retries; attempt++) {
    const startTime = Date.now()
    try {
      log(`${method} ${endpoint} attempt=${attempt}`, {
        model: body?.model,
        stream: body?.stream,
      })

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeout)

      const authHeaders: Record<string, string> = creds.isOAuth
        ? {
            Authorization: `Bearer ${creds.key}`,
            'anthropic-beta': OAUTH_BETA_FLAGS,
            'anthropic-dangerous-direct-browser-access': 'true',
            'User-Agent': 'claude-cli/2.1.77 (external, claude-vscode, agent-sdk/0.2.73)',
            'x-app': 'cli',
            'X-Stainless-Arch': 'x64',
            'X-Stainless-Lang': 'js',
            'X-Stainless-OS': 'Linux',
            'X-Stainless-Package-Version': '0.74.0',
            'X-Stainless-Retry-Count': '0',
            'X-Stainless-Runtime': 'node',
            'X-Stainless-Runtime-Version': 'v24.3.0',
            'X-Stainless-Timeout': '600',
          }
        : { 'x-api-key': creds.key }

      const fetchUrl = creds.isOAuth ? `${url}?beta=true` : url
      let requestBody: Record<string, unknown> | undefined = body
      if (creds.isOAuth && body) {
        requestBody = { ...body }
        const billingBlock = { type: 'text', text: CC_BILLING_HEADER }
        const sys = requestBody.system
        if (sys === undefined) {
          requestBody.system = [billingBlock]
        } else if (typeof sys === 'string') {
          requestBody.system = [billingBlock, { type: 'text', text: sys }]
        } else if (Array.isArray(sys)) {
          requestBody.system = [billingBlock, ...sys]
        }
      }

      const response = await fetch(fetchUrl, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders,
          'anthropic-version': API_VERSION,
        },
        body: requestBody ? JSON.stringify(requestBody) : undefined,
        signal: controller.signal,
      })

      clearTimeout(timeoutId)
      const durationMs = Date.now() - startTime

      if (!response.ok) {
        const errorText = await response.text()
        err(`error status=${response.status} duration=${durationMs}ms`, {
          error: errorText.substring(0, 500),
        })

        if (response.status === 429) {
          const backoff = Math.min(1000 * 2 ** attempt, 30_000)
          log(`Rate limited, waiting ${backoff}ms`)
          await sleep(backoff)
          lastError = new Error('Rate limited')
          continue
        }
        if (response.status === 529) {
          const backoff = Math.min(2000 * 2 ** attempt, 30_000)
          log(`Overloaded, waiting ${backoff}ms`)
          await sleep(backoff)
          lastError = new Error('API overloaded')
          continue
        }
        if (response.status === 401) {
          warn('401 — clearing cached token, will re-read credentials')
          credCache = null
          oauthSessionActive = false
          if (attempt < retries && creds.isOAuth) {
            if (attempt >= 2) await refreshOAuthToken()
            await sleep(1000)
            lastError = new Error('Authentication failed')
            continue
          }
        }
        if (response.status >= 500 && creds.isOAuth) {
          warn('5xx with OAuth — re-activating session')
          oauthSessionActive = false
          await activateOAuthSession(creds.key, true)
          const backoff = Math.min(1000 * 2 ** attempt, 10_000)
          await sleep(backoff)
          lastError = new Error(`Server error: ${response.status}`)
          continue
        }
        if (response.status >= 500) {
          const backoff = Math.min(1000 * 2 ** attempt, 10_000)
          await sleep(backoff)
          lastError = new Error(`Server error: ${response.status}`)
          continue
        }
        throw new Error(`Anthropic API error: ${response.status} - ${errorText}`)
      }

      log(`success status=${response.status} duration=${durationMs}ms`)
      return response
    } catch (e) {
      const durationMs = Date.now() - startTime
      const error = e as Error
      if (error.name === 'AbortError') {
        err(`timeout after ${durationMs}ms`)
        lastError = new Error('Request timeout')
      } else if (error.message?.startsWith('Anthropic API error')) {
        throw error
      } else {
        err(`error duration=${durationMs}ms`, { error: error.message })
        lastError = error
      }
      if (attempt < retries) {
        const backoff = Math.min(1000 * 2 ** attempt, 10_000)
        await sleep(backoff)
      }
    }
  }

  throw lastError ?? new Error('Anthropic request failed')
}

// --- Public surface (coordinator-shaped) -----------------------------------

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface MessageTrailer {
  model: string | null
  message_id: string | null
  stop_reason: string | null
  stop_sequence: string | null
  duration_ms: number
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  cost_usd: number
}

export interface CompletionParams {
  model: string
  messages: ChatMessage[]
  systemPrompt?: string
  maxTokens?: number
  temperature?: number
}

export interface CompletionResult {
  content: string
  trailer: MessageTrailer
}

const DEFAULT_MAX_TOKENS = 64_000

// Per-million-token prices (USD). Conservative defaults — extend as new model
// ids land. Unknown models fall back to opus pricing so we never under-report.
const PRICE_TABLE_PER_MTOK: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
  'claude-opus-4-7':    { input: 15.0, output: 75.0, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-opus-4-6':    { input: 15.0, output: 75.0, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-opus-4':      { input: 15.0, output: 75.0, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-sonnet-4-6':  { input:  3.0, output: 15.0, cacheWrite:  3.75, cacheRead: 0.3 },
  'claude-sonnet-4-5':  { input:  3.0, output: 15.0, cacheWrite:  3.75, cacheRead: 0.3 },
  'claude-sonnet-4':    { input:  3.0, output: 15.0, cacheWrite:  3.75, cacheRead: 0.3 },
  'claude-haiku-4-5':   { input:  1.0, output:  5.0, cacheWrite:  1.25, cacheRead: 0.1 },
}
const FALLBACK_PRICE = PRICE_TABLE_PER_MTOK['claude-opus-4-7']

const computeCostUsd = (
  model: string | null,
  usage: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number },
): number => {
  const key = (model ?? '').replace(/-(\d{8})$/, '') // strip optional date suffix
  const price = PRICE_TABLE_PER_MTOK[key] ?? FALLBACK_PRICE
  const input = usage.input_tokens ?? 0
  const output = usage.output_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? 0
  return (
    (input * price.input +
      output * price.output +
      cacheWrite * price.cacheWrite +
      cacheRead * price.cacheRead) /
    1_000_000
  )
}

const buildBody = (params: CompletionParams, stream: boolean): Record<string, unknown> => {
  const body: Record<string, unknown> = {
    model: params.model,
    messages: params.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content })),
    max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
  }
  if (stream) body.stream = true
  if (params.temperature !== undefined) body.temperature = params.temperature
  // System messages from `messages` are merged with the explicit systemPrompt.
  const sysFromMessages = params.messages.filter((m) => m.role === 'system').map((m) => m.content)
  const sysParts: string[] = []
  if (params.systemPrompt) sysParts.push(params.systemPrompt)
  sysParts.push(...sysFromMessages)
  if (sysParts.length > 0) body.system = sysParts.join('\n\n')
  return body
}

// Non-streaming chat completion. Used for the coordinator's first pass — the
// existing subprocess shape (`claude --print`) was non-streaming too.
export const chatCompletion = async (params: CompletionParams): Promise<CompletionResult> => {
  const startTime = Date.now()
  const body = buildBody(params, false)
  const response = await request('/v1/messages', { body })
  const data = (await response.json()) as {
    id?: string
    model?: string
    stop_reason?: string
    stop_sequence?: string
    content?: Array<{ type: string; text?: string }>
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }

  const content = (data.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')

  const trailer: MessageTrailer = {
    model: data.model ?? params.model,
    message_id: data.id ?? null,
    stop_reason: data.stop_reason ?? null,
    stop_sequence: data.stop_sequence ?? null,
    duration_ms: Date.now() - startTime,
    input_tokens: data.usage?.input_tokens ?? 0,
    output_tokens: data.usage?.output_tokens ?? 0,
    cache_creation_input_tokens: data.usage?.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: data.usage?.cache_read_input_tokens ?? 0,
    cost_usd: 0,
  }
  trailer.cost_usd = computeCostUsd(trailer.model, {
    input_tokens: trailer.input_tokens,
    output_tokens: trailer.output_tokens,
    cache_creation_input_tokens: trailer.cache_creation_input_tokens,
    cache_read_input_tokens: trailer.cache_read_input_tokens,
  })
  return { content, trailer }
}

// Streaming chat completion. Used for the coordinator's second pass — emits
// per-token text via `onText` and returns the full text + trailer at the end.
export const chatCompletionStream = async (
  params: CompletionParams,
  onText: (text: string) => void,
): Promise<CompletionResult> => {
  const startTime = Date.now()
  const body = buildBody(params, true)
  const response = await request('/v1/messages', { body })
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Anthropic stream returned no body')

  const decoder = new TextDecoder()
  let buffer = ''
  let fullContent = ''

  let messageId: string | null = null
  let model: string | null = null
  let stopReason: string | null = null
  let stopSequence: string | null = null
  let inputTokens = 0
  let outputTokens = 0
  let cacheCreationInputTokens = 0
  let cacheReadInputTokens = 0

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6)
      if (data === '[DONE]') continue
      let parsed: any
      try { parsed = JSON.parse(data) } catch { continue }

      if (parsed.type === 'message_start' && parsed.message) {
        messageId = parsed.message.id ?? null
        model = parsed.message.model ?? null
        if (parsed.message.usage) {
          inputTokens = parsed.message.usage.input_tokens ?? 0
          cacheCreationInputTokens = parsed.message.usage.cache_creation_input_tokens ?? 0
          cacheReadInputTokens = parsed.message.usage.cache_read_input_tokens ?? 0
          outputTokens = parsed.message.usage.output_tokens ?? 0
        }
      } else if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
        const text = parsed.delta.text as string
        fullContent += text
        onText(text)
      } else if (parsed.type === 'message_delta') {
        if (parsed.delta?.stop_reason) stopReason = parsed.delta.stop_reason
        if (parsed.delta?.stop_sequence) stopSequence = parsed.delta.stop_sequence
        if (parsed.usage?.output_tokens !== undefined) outputTokens = parsed.usage.output_tokens
      }
    }
  }

  const trailer: MessageTrailer = {
    model: model ?? params.model,
    message_id: messageId,
    stop_reason: stopReason,
    stop_sequence: stopSequence,
    duration_ms: Date.now() - startTime,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation_input_tokens: cacheCreationInputTokens,
    cache_read_input_tokens: cacheReadInputTokens,
    cost_usd: 0,
  }
  trailer.cost_usd = computeCostUsd(trailer.model, {
    input_tokens: trailer.input_tokens,
    output_tokens: trailer.output_tokens,
    cache_creation_input_tokens: trailer.cache_creation_input_tokens,
    cache_read_input_tokens: trailer.cache_read_input_tokens,
  })
  return { content: fullContent, trailer }
}
