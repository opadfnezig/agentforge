'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import { developersApi, type DeveloperRun } from '@/lib/api'

interface Chat {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

interface OracleResponse {
  domain: string
  question: string
  response: string
}

interface DispatchInfo {
  developer: string
  developerId: string
  mode: 'implement' | 'clarify'
  runId: string
  instructions: string
  queued: boolean
}

interface Message {
  id?: string
  role: 'user' | 'assistant' | 'system'
  content: string
  oracles?: OracleResponse[]
  dispatches?: DispatchInfo[]
  status?: string
}

const SAVE_REGEX = /\[save,\s*[^\]]+\]\s*\n[\s\S]*?\n\[end\]/gi
const hasSaveCommands = (text: string): boolean => {
  SAVE_REGEX.lastIndex = 0
  return SAVE_REGEX.test(text)
}

// Strip oracle/dispatch-data sentinels (HTML comment)
const ORACLE_SENTINEL_REGEX = /\n*<!--ORACLES:[\s\S]*?:ORACLES-->\s*$/
const DISPATCH_SENTINEL_REGEX = /\n*<!--DISPATCHES:[\s\S]*?:DISPATCHES-->\s*$/g
const stripSentinel = (text: string): string =>
  text.replace(ORACLE_SENTINEL_REGEX, '').replace(DISPATCH_SENTINEL_REGEX, '')

export default function CoordinatorPage() {
  const [chats, setChats] = useState<Chat[]>([])
  const [activeChatId, setActiveChatId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [statusText, setStatusText] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  const loadChats = useCallback(async () => {
    const res = await fetch('/api/coordinator/chats')
    if (res.ok) setChats(await res.json())
  }, [])

  const loadChat = useCallback(async (id: string) => {
    const res = await fetch(`/api/coordinator/chats/${id}`)
    if (res.ok) {
      const data = await res.json()
      const rawMessages = (data.messages || []) as { id: string; role: Message['role']; content: string }[]
      const restored: Message[] = rawMessages.map((m) => {
        if (m.role !== 'assistant') return { id: m.id, role: m.role, content: m.content }
        let content = m.content
        let oracles: OracleResponse[] | undefined
        let dispatches: DispatchInfo[] | undefined
        const oracleMatch = content.match(/<!--ORACLES:([\s\S]*?):ORACLES-->/)
        if (oracleMatch) {
          try { oracles = JSON.parse(oracleMatch[1]) as OracleResponse[] } catch { /* ignore */ }
        }
        const dispatchMatch = content.match(/<!--DISPATCHES:([\s\S]*?):DISPATCHES-->/)
        if (dispatchMatch) {
          try { dispatches = JSON.parse(dispatchMatch[1]) as DispatchInfo[] } catch { /* ignore */ }
        }
        content = content
          .replace(/\n*<!--ORACLES:[\s\S]*?:ORACLES-->\s*/g, '')
          .replace(/\n*<!--DISPATCHES:[\s\S]*?:DISPATCHES-->\s*/g, '')
        return { id: m.id, role: 'assistant', content, oracles, dispatches }
      })
      setMessages(restored)
      setActiveChatId(id)
    }
  }, [])

  const rewindFromMessage = useCallback(async (messageId: string) => {
    if (!activeChatId) return
    const res = await fetch(`/api/coordinator/chats/${activeChatId}/messages/${messageId}`, {
      method: 'DELETE',
    })
    if (res.ok) {
      await loadChat(activeChatId)
      loadChats()
    }
  }, [activeChatId, loadChat, loadChats])

  useEffect(() => { loadChats() }, [loadChats])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, statusText])

  const createChat = async () => {
    const res = await fetch('/api/coordinator/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New chat' }),
    })
    if (res.ok) {
      const chat = await res.json()
      setChats(prev => [chat, ...prev])
      setActiveChatId(chat.id)
      setMessages([])
    }
  }

  const deleteChat = async (id: string) => {
    await fetch(`/api/coordinator/chats/${id}`, { method: 'DELETE' })
    setChats(prev => prev.filter(c => c.id !== id))
    if (activeChatId === id) {
      setActiveChatId(null)
      setMessages([])
    }
  }

  const handleSave = async (text: string) => {
    if (!activeChatId) return
    setMessages(prev => [...prev, { role: 'user', content: text }])
    setLoading(true)
    try {
      const res = await fetch(`/api/coordinator/chats/${activeChatId}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      })
      const data = await res.json()
      const results = data.results as { domain: string; status: string; error?: string }[]
      const summary = results
        .map(r => r.status === 'merged' ? `[${r.domain}] merged` : `[${r.domain}] error: ${r.error}`)
        .join('\n')
      setMessages(prev => [...prev, { role: 'system', content: summary }])
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'system',
        content: `Save failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      }])
    } finally {
      setLoading(false)
      loadChats()
    }
  }

  const handleChat = async (text: string) => {
    if (!activeChatId) return
    setMessages(prev => [...prev, { role: 'user', content: text }])
    setLoading(true)
    setStatusText('')

    // Add placeholder assistant message
    const assistantIdx = { current: -1 }
    setMessages(prev => {
      assistantIdx.current = prev.length
      return [...prev, { role: 'assistant', content: '', oracles: [], dispatches: [], status: '' }]
    })

    try {
      const res = await fetch(`/api/coordinator/chats/${activeChatId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      })

      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      if (!res.body) throw new Error('No response body')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let accText = ''
      const accOracles: OracleResponse[] = []
      const accDispatches: DispatchInfo[] = []
      let currentStatus = ''

      const updateAssistant = () => {
        setMessages(prev => {
          const updated = [...prev]
          const idx = assistantIdx.current
          if (idx >= 0 && idx < updated.length) {
            updated[idx] = {
              role: 'assistant',
              content: accText,
              oracles: [...accOracles],
              dispatches: [...accDispatches],
              status: currentStatus,
            }
          }
          return updated
        })
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const event = JSON.parse(line.slice(6))
            if (event.type === 'status') {
              currentStatus = event.message
              setStatusText(event.message)
              updateAssistant()
            } else if (event.type === 'oracle') {
              accOracles.push({
                domain: event.domain,
                question: event.question,
                response: event.response,
              })
              currentStatus = `Got response from ${event.domain}`
              updateAssistant()
            } else if (event.type === 'dispatch') {
              accDispatches.push({
                developer: event.developer,
                developerId: event.developerId,
                mode: event.mode,
                runId: event.runId,
                instructions: event.instructions,
                queued: !!event.queued,
              })
              currentStatus = event.queued
                ? `Queued for ${event.developer}`
                : `Dispatched to ${event.developer}`
              updateAssistant()
            } else if (event.type === 'text') {
              accText += event.text
              currentStatus = ''
              updateAssistant()
            } else if (event.type === 'done') {
              currentStatus = ''
              updateAssistant()
            }
          } catch {
            // skip malformed
          }
        }
      }
    } catch (err) {
      setMessages(prev => {
        const updated = [...prev]
        const idx = assistantIdx.current
        if (idx >= 0 && idx < updated.length) {
          updated[idx] = {
            role: 'assistant',
            content: `Error: ${err instanceof Error ? err.message : 'Request failed'}`,
          }
        }
        return updated
      })
    } finally {
      setLoading(false)
      setStatusText('')
      loadChats()
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const text = input.trim()
    if (!text || loading || !activeChatId) return
    setInput('')
    if (hasSaveCommands(text)) {
      await handleSave(text)
    } else {
      await handleChat(text)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Ctrl+Enter / Cmd+Enter sends. Plain Enter inserts newline (default textarea behavior).
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      handleSubmit(e)
    }
  }

  return (
    <div className="flex h-[calc(100vh-3.5rem)] bg-zinc-950">
      {/* Sidebar */}
      <div className="w-64 border-r border-zinc-800 flex flex-col">
        <div className="p-3 border-b border-zinc-800">
          <Button onClick={createChat} className="w-full" variant="outline" size="sm">
            + New chat
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {chats.map(chat => (
            <div
              key={chat.id}
              className={`group flex items-center gap-2 px-3 py-2 cursor-pointer text-sm border-b border-zinc-900 hover:bg-zinc-900 ${
                activeChatId === chat.id ? 'bg-zinc-900 text-white' : 'text-zinc-400'
              }`}
              onClick={() => loadChat(chat.id)}
            >
              <span className="flex-1 truncate">{chat.title}</span>
              <button
                onClick={(e) => { e.stopPropagation(); deleteChat(chat.id) }}
                className="opacity-0 group-hover:opacity-100 text-zinc-600 hover:text-red-400 text-xs"
              >
                x
              </button>
            </div>
          ))}
          {chats.length === 0 && (
            <p className="text-xs text-zinc-600 p-3">No chats yet</p>
          )}
        </div>
      </div>

      {/* Chat area */}
      <div className="flex-1 flex flex-col">
        {!activeChatId ? (
          <div className="flex-1 flex items-center justify-center text-zinc-600">
            <div className="text-center">
              <p className="text-lg font-medium mb-2">Coordinator</p>
              <p className="text-sm mb-4">Create a new chat to start</p>
              <div className="text-left text-xs text-zinc-600 space-y-2 max-w-sm">
                <p className="font-medium text-zinc-500">Save to an oracle:</p>
                <pre className="bg-zinc-900 border border-zinc-800 rounded p-3">{`[save, hearth]
Bonfire architecture now uses 4 stages
[end]`}</pre>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
              {messages.map((msg, i) => (
                <div key={msg.id || i} className={`group relative max-w-2xl ${msg.role === 'user' ? 'ml-auto' : 'mr-auto'}`}>
                  <div className="flex items-center gap-2 mb-1">
                    <div className="text-xs text-zinc-500">
                      {msg.role === 'user' ? 'You' : msg.role === 'system' ? 'System' : 'Coordinator'}
                    </div>
                    {msg.id && !loading && (
                      <button
                        onClick={() => {
                          if (confirm('Delete this message and everything after it?')) {
                            rewindFromMessage(msg.id!)
                          }
                        }}
                        className="opacity-0 group-hover:opacity-100 text-[10px] text-zinc-600 hover:text-red-400 transition-opacity"
                        title="Delete this and all following messages"
                      >
                        rewind from here
                      </button>
                    )}
                  </div>

                  {/* Status spinner */}
                  {msg.role === 'assistant' && msg.status && !msg.content && (
                    <div className="flex items-center gap-2 text-xs text-zinc-500 mb-2 px-4 py-2 bg-zinc-900/50 rounded border border-zinc-800">
                      <span className="animate-spin inline-block w-3 h-3 border border-zinc-500 border-t-transparent rounded-full" />
                      {msg.status}
                    </div>
                  )}

                  {/* Oracle responses (collapsible) — shows outgoing query + incoming response */}
                  {msg.oracles && msg.oracles.length > 0 && (
                    <div className="mb-2 space-y-1">
                      {msg.oracles.map((oracle, j) => (
                        <details key={j} className="bg-zinc-900 border border-zinc-800 rounded text-xs">
                          <summary className="px-3 py-1.5 cursor-pointer text-zinc-400 hover:text-zinc-200">
                            Oracle: <span className="font-medium text-amber-400">{oracle.domain}</span>
                            <span className="text-zinc-600 ml-2">Q: {oracle.question.slice(0, 60)}{oracle.question.length > 60 ? '...' : ''}</span>
                          </summary>
                          <div className="border-t border-zinc-800 divide-y divide-zinc-800 max-h-96 overflow-y-auto">
                            <div className="px-3 py-2">
                              <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">Query sent</div>
                              <div className="text-zinc-300 prose prose-sm prose-invert max-w-none prose-p:my-1 prose-pre:bg-zinc-800 prose-code:text-emerald-400">
                                <ReactMarkdown remarkPlugins={[remarkGfm]}>{oracle.question}</ReactMarkdown>
                              </div>
                            </div>
                            <div className="px-3 py-2">
                              <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">Response</div>
                              <div className="text-zinc-300 prose prose-sm prose-invert max-w-none prose-p:my-1 prose-pre:bg-zinc-800 prose-code:text-emerald-400">
                                <ReactMarkdown remarkPlugins={[remarkGfm]}>{oracle.response}</ReactMarkdown>
                              </div>
                            </div>
                          </div>
                        </details>
                      ))}
                    </div>
                  )}

                  {/* Dispatch badges (collapsible, live-tracked) */}
                  {msg.dispatches && msg.dispatches.length > 0 && (
                    <div className="mb-2 space-y-1">
                      {msg.dispatches.map((d) => (
                        <DispatchBadge key={d.runId} dispatch={d} />
                      ))}
                    </div>
                  )}

                  {/* Message content */}
                  <div
                    className={`rounded-lg px-4 py-3 text-sm ${
                      msg.role === 'user'
                        ? 'bg-zinc-800 text-zinc-100 whitespace-pre-wrap'
                        : msg.role === 'system'
                        ? 'bg-emerald-950 border border-emerald-800 text-emerald-300 font-mono whitespace-pre-wrap'
                        : 'bg-zinc-900 border border-zinc-800 text-zinc-300 prose prose-sm prose-invert max-w-none prose-p:my-2 prose-headings:my-3 prose-ul:my-2 prose-ol:my-2 prose-li:my-0 prose-pre:bg-zinc-800 prose-pre:border prose-pre:border-zinc-700 prose-code:text-emerald-400 prose-strong:text-zinc-100'
                    }`}
                  >
                    {msg.role === 'assistant' && msg.content ? (
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {stripSentinel(msg.content)}
                      </ReactMarkdown>
                    ) : msg.role === 'assistant' && !msg.content && !msg.status ? (
                      loading && i === messages.length - 1 ? (
                        <span className="text-zinc-600">Querying oracles...</span>
                      ) : null
                    ) : (
                      msg.content || null
                    )}
                  </div>
                </div>
              ))}
            </div>

            <form onSubmit={handleSubmit} className="border-t border-zinc-800 px-6 py-4 flex gap-3">
              <textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask the coordinator... or [save, domain] to save (Ctrl+Enter to send)"
                className="flex-1 bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm text-zinc-100 resize-none min-h-[40px] max-h-[200px] focus:outline-none focus:ring-1 focus:ring-zinc-500"
                rows={input.includes('\n') ? Math.min(input.split('\n').length, 8) : 1}
                disabled={loading}
              />
              <Button type="submit" disabled={loading || !input.trim()} className="self-end">
                {loading ? '...' : hasSaveCommands(input) ? 'Save' : 'Send'}
              </Button>
            </form>
          </>
        )}
      </div>
    </div>
  )
}

const TERMINAL_RUN_STATUSES = new Set(['success', 'failure', 'cancelled', 'no_changes'])

function DispatchBadge({ dispatch }: { dispatch: DispatchInfo }) {
  const [run, setRun] = useState<DeveloperRun | null>(null)
  const [now, setNow] = useState<number>(() => Date.now())

  // Poll the run until it reaches a terminal status; re-poll on mount so
  // reloading the chat also shows the up-to-date state for historical runs.
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = async () => {
      try {
        const r = await developersApi.getRun(dispatch.developerId, dispatch.runId)
        if (cancelled) return
        setRun(r)
        if (!TERMINAL_RUN_STATUSES.has(r.status)) {
          timer = setTimeout(tick, 1500)
        }
      } catch {
        if (!cancelled) timer = setTimeout(tick, 3000)
      }
    }
    tick()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [dispatch.developerId, dispatch.runId])

  // Wall-clock tick for live timer while running.
  useEffect(() => {
    if (run && TERMINAL_RUN_STATUSES.has(run.status)) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [run])

  const status = run?.status ?? (dispatch.queued ? 'pending' : 'running')
  const isTerminal = TERMINAL_RUN_STATUSES.has(status)
  const startedAt = run?.startedAt ? new Date(run.startedAt).getTime() : null
  const finishedAt = run?.finishedAt ? new Date(run.finishedAt).getTime() : null
  const elapsed = startedAt ? ((finishedAt ?? now) - startedAt) : null

  const statusColor: Record<string, string> = {
    pending: 'text-zinc-400',
    running: 'text-yellow-400',
    success: 'text-green-400',
    failure: 'text-red-400',
    cancelled: 'text-zinc-400',
    no_changes: 'text-blue-400',
  }

  const trailer = (run?.trailer || {}) as Record<string, unknown>
  const pickStr = (k: string) => (typeof trailer[k] === 'string' ? (trailer[k] as string) : undefined)
  const pickNum = (k: string) => (typeof trailer[k] === 'number' ? (trailer[k] as number) : undefined)

  return (
    <details className="bg-zinc-900 border border-zinc-800 rounded text-xs">
      <summary className="px-3 py-1.5 cursor-pointer text-zinc-400 hover:text-zinc-200 flex items-center gap-2 flex-wrap">
        <span>Dispatch:</span>
        <span className="font-medium text-indigo-400">{dispatch.developer}</span>
        <span className="px-1 py-0.5 rounded bg-zinc-800 text-zinc-400 font-mono">{dispatch.mode}</span>
        <span className={`font-medium ${statusColor[status] || 'text-zinc-400'}`}>{status}</span>
        {run?.model && <span className="text-zinc-500 font-mono">{run.model}</span>}
        {elapsed !== null && (
          <span className="text-zinc-500 font-mono">{formatElapsed(elapsed)}</span>
        )}
        {typeof run?.totalCostUsd === 'number' && (
          <span className="text-zinc-500 font-mono">${run.totalCostUsd.toFixed(4)}</span>
        )}
        <a
          href={`/developers/${dispatch.developerId}`}
          className="text-zinc-500 hover:text-zinc-300 underline-offset-2 hover:underline ml-auto"
          onClick={(e) => e.stopPropagation()}
        >
          view
        </a>
      </summary>
      <div className="border-t border-zinc-800 divide-y divide-zinc-800 max-h-[32rem] overflow-y-auto">
        {/* Data in: instructions + mode + developer */}
        <div className="px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">
            Dispatched to <span className="text-indigo-400">{dispatch.developer}</span> · mode <span className="text-zinc-300 font-mono">{dispatch.mode}</span>
            {run?.provider && <> · provider <span className="text-zinc-300 font-mono">{run.provider}</span></>}
            {run?.model && <> · model <span className="text-zinc-300 font-mono">{run.model}</span></>}
          </div>
          <div className="text-zinc-300 prose prose-sm prose-invert max-w-none prose-p:my-1 prose-pre:bg-zinc-800 prose-code:text-emerald-400">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{dispatch.instructions}</ReactMarkdown>
          </div>
        </div>

        {/* Data out: current status / final report / trailer */}
        <div className="px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">
            {isTerminal ? 'Result' : 'Current status'}
          </div>
          {run?.response ? (
            <div className="text-zinc-300 prose prose-sm prose-invert max-w-none prose-p:my-1 prose-pre:bg-zinc-800 prose-code:text-emerald-400">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{run.response}</ReactMarkdown>
            </div>
          ) : run?.errorMessage ? (
            <pre className="text-red-400 whitespace-pre-wrap break-words font-mono">{run.errorMessage}</pre>
          ) : (
            <p className="text-zinc-500">
              {status === 'pending' ? 'Waiting for an idle developer…' : 'Running…'}
            </p>
          )}

          {isTerminal && run && (
            <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px] font-mono text-zinc-400">
              {typeof run.totalCostUsd === 'number' && (
                <><span className="text-zinc-500">cost</span><span>${run.totalCostUsd.toFixed(4)}</span></>
              )}
              {typeof run.durationMs === 'number' && (
                <><span className="text-zinc-500">duration</span><span>{formatElapsed(run.durationMs)}</span></>
              )}
              {typeof run.durationApiMs === 'number' && (
                <><span className="text-zinc-500">duration_api</span><span>{formatElapsed(run.durationApiMs)}</span></>
              )}
              {run.stopReason && (
                <><span className="text-zinc-500">stop_reason</span><span>{run.stopReason}</span></>
              )}
              {run.sessionId && (
                <><span className="text-zinc-500">session_id</span><span className="truncate">{run.sessionId}</span></>
              )}
              {pickStr('terminal_reason') && (
                <><span className="text-zinc-500">terminal_reason</span><span>{pickStr('terminal_reason')}</span></>
              )}
              {pickNum('num_turns') !== undefined && (
                <><span className="text-zinc-500">num_turns</span><span>{pickNum('num_turns')}</span></>
              )}
              {trailer.fast_mode_state !== undefined && (
                <><span className="text-zinc-500">fast_mode_state</span><span>{JSON.stringify(trailer.fast_mode_state)}</span></>
              )}
              {trailer.api_error_status !== undefined && (
                <><span className="text-zinc-500">api_error_status</span><span>{JSON.stringify(trailer.api_error_status)}</span></>
              )}
              {trailer.permission_denials !== undefined && (
                <><span className="text-zinc-500">permission_denials</span><span>{JSON.stringify(trailer.permission_denials)}</span></>
              )}
            </div>
          )}

          {isTerminal && run?.trailer && (
            <details className="mt-2">
              <summary className="text-[10px] text-zinc-500 cursor-pointer hover:text-zinc-300">
                Full trailer
              </summary>
              <pre className="mt-1 text-[11px] text-zinc-500 whitespace-pre-wrap break-words font-mono">
                {JSON.stringify(run.trailer, null, 2)}
              </pre>
            </details>
          )}
        </div>
      </div>
    </details>
  )
}

function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return `${m}m ${rem}s`
}
