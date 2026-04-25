'use client'

import { useState, useRef, useEffect, useCallback, memo } from 'react'
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
  pending?: boolean
}

interface ReadInfo {
  runId: string
  found: boolean
  status: string | null
  developerName: string | null
  report: string
}

interface Message {
  id?: string
  role: 'user' | 'assistant' | 'system'
  content: string
  oracles?: OracleResponse[]
  dispatches?: DispatchInfo[]
  reads?: ReadInfo[]
  status?: string
}

const SAVE_REGEX = /\[save,\s*[^\]]+\]\s*\n[\s\S]*?\n\[end\]/gi
const hasSaveCommands = (text: string): boolean => {
  SAVE_REGEX.lastIndex = 0
  return SAVE_REGEX.test(text)
}

// Per-chat draft persistence in localStorage. Key includes the chat id so each
// chat keeps its own unsent text across reloads / accidental nav-aways.
const DRAFT_KEY_PREFIX = 'agentforge:coordinator:draft:'
const DRAFT_DEBOUNCE_MS = 250
const draftKeyFor = (chatId: string) => `${DRAFT_KEY_PREFIX}${chatId}`

// Strip oracle/dispatch/read-data sentinels (HTML comment)
const ORACLE_SENTINEL_REGEX = /\n*<!--ORACLES:[\s\S]*?:ORACLES-->\s*$/
const DISPATCH_SENTINEL_REGEX = /\n*<!--DISPATCHES:[\s\S]*?:DISPATCHES-->\s*$/g
const READ_SENTINEL_REGEX = /\n*<!--READS:[\s\S]*?:READS-->\s*$/g
const stripSentinel = (text: string): string =>
  text
    .replace(ORACLE_SENTINEL_REGEX, '')
    .replace(DISPATCH_SENTINEL_REGEX, '')
    .replace(READ_SENTINEL_REGEX, '')

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
        let reads: ReadInfo[] | undefined
        const oracleMatch = content.match(/<!--ORACLES:([\s\S]*?):ORACLES-->/)
        if (oracleMatch) {
          try { oracles = JSON.parse(oracleMatch[1]) as OracleResponse[] } catch { /* ignore */ }
        }
        const dispatchMatch = content.match(/<!--DISPATCHES:([\s\S]*?):DISPATCHES-->/)
        if (dispatchMatch) {
          try { dispatches = JSON.parse(dispatchMatch[1]) as DispatchInfo[] } catch { /* ignore */ }
        }
        const readMatch = content.match(/<!--READS:([\s\S]*?):READS-->/)
        if (readMatch) {
          try { reads = JSON.parse(readMatch[1]) as ReadInfo[] } catch { /* ignore */ }
        }
        content = content
          .replace(/\n*<!--ORACLES:[\s\S]*?:ORACLES-->\s*/g, '')
          .replace(/\n*<!--DISPATCHES:[\s\S]*?:DISPATCHES-->\s*/g, '')
          .replace(/\n*<!--READS:[\s\S]*?:READS-->\s*/g, '')
        return { id: m.id, role: 'assistant', content, oracles, dispatches, reads }
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

  // Restore the per-chat draft when the active chat changes.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!activeChatId) {
      setInput('')
      return
    }
    try {
      setInput(localStorage.getItem(draftKeyFor(activeChatId)) ?? '')
    } catch {
      setInput('')
    }
  }, [activeChatId])

  // Persist the current draft (debounced). Skipped while loading so an
  // optimistic setInput('') during send doesn't clobber a draft we may need
  // to restore on send-failure.
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!activeChatId || loading) return
    const key = draftKeyFor(activeChatId)
    const t = setTimeout(() => {
      try {
        if (input) localStorage.setItem(key, input)
        else localStorage.removeItem(key)
      } catch { /* quota / disabled — best-effort */ }
    }, DRAFT_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [input, activeChatId, loading])

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

  const handleSave = async (text: string): Promise<boolean> => {
    if (!activeChatId) return false
    setMessages(prev => [...prev, { role: 'user', content: text }])
    setLoading(true)
    let ok = false
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
      ok = res.ok
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'system',
        content: `Save failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      }])
    } finally {
      setLoading(false)
      loadChats()
    }
    return ok
  }

  const handleChat = async (text: string): Promise<boolean> => {
    if (!activeChatId) return false
    setMessages(prev => [...prev, { role: 'user', content: text }])
    setLoading(true)
    setStatusText('')
    let messageAccepted = false

    // Add placeholder assistant message
    const assistantIdx = { current: -1 }
    setMessages(prev => {
      assistantIdx.current = prev.length
      return [...prev, { role: 'assistant', content: '', oracles: [], dispatches: [], reads: [], status: '' }]
    })

    try {
      const res = await fetch(`/api/coordinator/chats/${activeChatId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      })

      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      if (!res.body) throw new Error('No response body')
      // Server has accepted the user message at this point — even if the
      // streamed reply errors mid-flight, the original message is committed.
      messageAccepted = true

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let accText = ''
      let accOracles: OracleResponse[] = []
      let accDispatches: DispatchInfo[] = []
      let accReads: ReadInfo[] = []
      let currentStatus = ''

      // Coalesce bursts of stream chunks into a single setState per frame.
      // Without this, each text token triggers a full messages re-render;
      // react-markdown re-parses the growing body on every chunk which
      // pegs the main thread during long completions.
      let pendingFrame: number | null = null
      const flush = () => {
        pendingFrame = null
        setMessages(prev => {
          const updated = prev.slice()
          const idx = assistantIdx.current
          if (idx >= 0 && idx < updated.length) {
            updated[idx] = {
              role: 'assistant',
              content: accText,
              oracles: accOracles,
              dispatches: accDispatches,
              reads: accReads,
              status: currentStatus,
            }
          }
          return updated
        })
      }
      const schedule = () => {
        if (pendingFrame !== null) return
        if (typeof requestAnimationFrame === 'function') {
          pendingFrame = requestAnimationFrame(flush)
        } else {
          pendingFrame = window.setTimeout(flush, 16) as unknown as number
        }
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
              schedule()
            } else if (event.type === 'oracle') {
              // New array reference only when an entry is actually added —
              // lets memoized children skip when unrelated fields update.
              accOracles = [...accOracles, {
                domain: event.domain,
                question: event.question,
                response: event.response,
              }]
              currentStatus = `Got response from ${event.domain}`
              schedule()
            } else if (event.type === 'dispatch') {
              accDispatches = [...accDispatches, {
                developer: event.developer,
                developerId: event.developerId,
                mode: event.mode,
                runId: event.runId,
                instructions: event.instructions,
                queued: !!event.queued,
                pending: !!event.pending,
              }]
              currentStatus = event.pending
                ? `Awaiting approval: ${event.developer}`
                : event.queued
                ? `Queued for ${event.developer}`
                : `Dispatched to ${event.developer}`
              schedule()
            } else if (event.type === 'read') {
              accReads = [...accReads, {
                runId: event.runId,
                found: !!event.found,
                status: event.status ?? null,
                developerName: event.developerName ?? null,
                report: event.report,
              }]
              currentStatus = event.found
                ? `Read run ${String(event.runId).slice(0, 8)} (${event.status})`
                : `Read run ${String(event.runId).slice(0, 8)} not found`
              schedule()
            } else if (event.type === 'text') {
              accText += event.text
              currentStatus = ''
              schedule()
            } else if (event.type === 'done') {
              currentStatus = ''
              schedule()
            }
          } catch {
            // skip malformed
          }
        }
      }
      // Ensure the terminal state actually lands even if no events arrived
      // after the last scheduled frame.
      if (pendingFrame !== null) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(pendingFrame)
        else clearTimeout(pendingFrame)
      }
      flush()
    } catch (err) {
      setMessages(prev => {
        const updated = prev.slice()
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
    return messageAccepted
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const text = input.trim()
    if (!text || loading || !activeChatId) return
    const chatId = activeChatId
    setInput('')
    const sent = hasSaveCommands(text) ? await handleSave(text) : await handleChat(text)
    if (sent) {
      try { localStorage.removeItem(draftKeyFor(chatId)) } catch { /* best-effort */ }
    } else if (chatId === activeChatId) {
      // Send didn't go through — restore the unsent text so it isn't lost.
      // (Only if the user is still on the same chat; otherwise localStorage
      // already preserves the draft for when they navigate back.)
      setInput(text)
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
                <MessageRow
                  key={msg.id || i}
                  message={msg}
                  isLast={i === messages.length - 1}
                  loading={loading}
                  onRewind={rewindFromMessage}
                />
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

// ---------------------------------------------------------------------------
// Message row
//
// Memoized so that when one message mutates (e.g. a streaming assistant), the
// other messages in the list don't re-render. Relies on stable object
// references in the `messages` state — `handleChat` only replaces the single
// streaming row and leaves prior rows' references untouched.
// ---------------------------------------------------------------------------

interface MessageRowProps {
  message: Message
  isLast: boolean
  loading: boolean
  onRewind: (id: string) => void
}

const MessageRow = memo(function MessageRow({ message: msg, isLast, loading, onRewind }: MessageRowProps) {
  return (
    <div className={`group relative max-w-2xl ${msg.role === 'user' ? 'ml-auto' : 'mr-auto'}`}>
      <div className="flex items-center gap-2 mb-1">
        <div className="text-xs text-zinc-500">
          {msg.role === 'user' ? 'You' : msg.role === 'system' ? 'System' : 'Coordinator'}
        </div>
        {msg.id && !loading && (
          <button
            onClick={() => {
              if (confirm('Delete this message and everything after it?')) {
                onRewind(msg.id!)
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
            <OracleBlock key={j} oracle={oracle} />
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

      {/* Read badges — coordinator pulled a prior run's report on demand */}
      {msg.reads && msg.reads.length > 0 && (
        <div className="mb-2 space-y-1">
          {msg.reads.map((r, j) => (
            <ReadBlock key={`${r.runId}-${j}`} read={r} />
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
          <AssistantMarkdown content={msg.content} />
        ) : msg.role === 'assistant' && !msg.content && !msg.status ? (
          loading && isLast ? (
            <span className="text-zinc-600">Querying oracles...</span>
          ) : null
        ) : (
          msg.content || null
        )}
      </div>
    </div>
  )
})

// Heavy markdown pipeline — memoize by content so we don't re-parse during
// unrelated parent re-renders. React-markdown renders synchronously on the
// main thread; on long messages this is the biggest per-frame cost.
const AssistantMarkdown = memo(function AssistantMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]}>
      {stripSentinel(content)}
    </ReactMarkdown>
  )
})

const OracleBlock = memo(function OracleBlock({ oracle }: { oracle: OracleResponse }) {
  return (
    <details className="bg-zinc-900 border border-zinc-800 rounded text-xs">
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
  )
})

const ReadBlock = memo(function ReadBlock({ read }: { read: ReadInfo }) {
  const shortId = read.runId.length >= 8 ? read.runId.slice(0, 8) : read.runId
  const statusColor = read.found
    ? read.status === 'success' || read.status === 'no_changes'
      ? 'text-green-400'
      : read.status === 'failure'
      ? 'text-red-400'
      : read.status === 'running'
      ? 'text-yellow-400'
      : 'text-zinc-400'
    : 'text-red-400'
  return (
    <details className="bg-zinc-900 border border-zinc-800 rounded text-xs">
      <summary className="px-3 py-1.5 cursor-pointer text-zinc-400 hover:text-zinc-200 flex items-center gap-2 flex-wrap">
        <span>Read run:</span>
        <span className="font-mono text-zinc-300">{shortId}</span>
        {read.developerName && <span className="text-indigo-400">{read.developerName}</span>}
        <span className={`font-medium ${statusColor}`}>{read.found ? read.status ?? 'unknown' : 'not found'}</span>
      </summary>
      <div className="border-t border-zinc-800 px-3 py-2 max-h-96 overflow-y-auto">
        <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">Report</div>
        <pre className="text-zinc-300 whitespace-pre-wrap break-words font-mono text-[11px]">{read.report}</pre>
      </div>
    </details>
  )
})

const TERMINAL_RUN_STATUSES = new Set(['success', 'failure', 'cancelled', 'no_changes'])

const DispatchBadge = memo(function DispatchBadge({ dispatch }: { dispatch: DispatchInfo }) {
  const [run, setRun] = useState<DeveloperRun | null>(null)
  const [now, setNow] = useState<number>(() => Date.now())
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState(dispatch.instructions)
  const [actionBusy, setActionBusy] = useState<null | 'approve' | 'cancel' | 'edit'>(null)
  const [actionError, setActionError] = useState<string | null>(null)

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
    if (!run) return
    if (TERMINAL_RUN_STATUSES.has(run.status)) return
    if (run.status !== 'running') return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [run])

  // Seed edit field from the authoritative run.instructions once we have it.
  useEffect(() => {
    if (run && !editing) setEditText(run.instructions)
  }, [run, editing])

  const status = run?.status ?? (dispatch.pending ? 'pending' : dispatch.queued ? 'queued' : 'running')
  const isTerminal = TERMINAL_RUN_STATUSES.has(status)
  const isPending = status === 'pending'
  const startedAt = run?.startedAt ? new Date(run.startedAt).getTime() : null
  const finishedAt = run?.finishedAt ? new Date(run.finishedAt).getTime() : null
  const elapsed = startedAt ? ((finishedAt ?? now) - startedAt) : null

  const statusColor: Record<string, string> = {
    pending: 'text-amber-400',
    queued: 'text-zinc-400',
    running: 'text-yellow-400',
    success: 'text-green-400',
    failure: 'text-red-400',
    cancelled: 'text-zinc-400',
    no_changes: 'text-blue-400',
  }

  const approve = async () => {
    setActionBusy('approve')
    setActionError(null)
    try {
      const updated = await developersApi.approveRun(dispatch.developerId, dispatch.runId)
      setRun(updated)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Approve failed')
    } finally {
      setActionBusy(null)
    }
  }

  const cancel = async () => {
    if (!confirm('Cancel this dispatch? This cannot be undone.')) return
    setActionBusy('cancel')
    setActionError(null)
    try {
      const updated = await developersApi.cancelRun(dispatch.developerId, dispatch.runId)
      setRun(updated)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Cancel failed')
    } finally {
      setActionBusy(null)
    }
  }

  const saveEdit = async () => {
    const next = editText.trim()
    if (!next) return
    setActionBusy('edit')
    setActionError(null)
    try {
      const updated = await developersApi.editRunInstructions(dispatch.developerId, dispatch.runId, next)
      setRun(updated)
      setEditing(false)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Edit failed')
    } finally {
      setActionBusy(null)
    }
  }

  const trailer = (run?.trailer || {}) as Record<string, unknown>
  const pickStr = (k: string) => (typeof trailer[k] === 'string' ? (trailer[k] as string) : undefined)
  const pickNum = (k: string) => (typeof trailer[k] === 'number' ? (trailer[k] as number) : undefined)
  const instructionsDisplay = run?.instructions ?? dispatch.instructions

  return (
    <details className="bg-zinc-900 border border-zinc-800 rounded text-xs" open={isPending}>
      <summary className="px-3 py-1.5 cursor-pointer text-zinc-400 hover:text-zinc-200 flex items-center gap-2 flex-wrap">
        <span>Dispatch:</span>
        <span className="font-medium text-indigo-400">{dispatch.developer}</span>
        <span className="px-1 py-0.5 rounded bg-zinc-800 text-zinc-400 font-mono">{dispatch.mode}</span>
        <span className={`font-medium ${statusColor[status] || 'text-zinc-400'}`}>{status}</span>
        <RunIdChip runId={dispatch.runId} />

        {run?.pushStatus && run.pushStatus !== 'not_attempted' && (
          <PushStatusBadge pushStatus={run.pushStatus} pushError={run.pushError} />
        )}
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
        {/* Approval controls (pending only). Badge opens by default when pending. */}
        {isPending && (
          <div className="px-3 py-2 bg-amber-950/20">
            <div className="text-[10px] uppercase tracking-wide text-amber-400 mb-1">
              Awaiting your approval
            </div>
            <div className="text-zinc-300">
              Review the dispatch below, then approve to send it to <span className="text-indigo-400">{dispatch.developer}</span> for execution. Cancel skips execution entirely.
            </div>
            <div className="flex gap-2 mt-2 items-center" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                onClick={approve}
                disabled={!!actionBusy || editing}
                className="px-2 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-white text-xs disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {actionBusy === 'approve' ? 'Approving…' : 'Approve'}
              </button>
              <button
                type="button"
                onClick={cancel}
                disabled={!!actionBusy || editing}
                className="px-2 py-1 rounded bg-red-900 hover:bg-red-800 text-white text-xs disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {actionBusy === 'cancel' ? 'Cancelling…' : 'Cancel'}
              </button>
              <button
                type="button"
                onClick={() => setEditing((v) => !v)}
                disabled={!!actionBusy}
                className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {editing ? 'Discard edit' : 'Edit'}
              </button>
              {actionError && <span className="text-red-400 text-[11px]">{actionError}</span>}
            </div>
          </div>
        )}

        {/* Data in: instructions + mode + developer */}
        <div className="px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">
            Dispatched to <span className="text-indigo-400">{dispatch.developer}</span> · mode <span className="text-zinc-300 font-mono">{dispatch.mode}</span>
            {run?.provider && <> · provider <span className="text-zinc-300 font-mono">{run.provider}</span></>}
            {run?.model && <> · model <span className="text-zinc-300 font-mono">{run.model}</span></>}
          </div>
          {editing && isPending ? (
            <div onClick={(e) => e.stopPropagation()}>
              <textarea
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                className="w-full min-h-[180px] bg-zinc-950 border border-zinc-700 rounded-md px-2 py-1.5 text-zinc-100 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-zinc-500"
                disabled={!!actionBusy}
              />
              <div className="flex gap-2 mt-1">
                <button
                  type="button"
                  onClick={saveEdit}
                  disabled={!!actionBusy || !editText.trim() || editText.trim() === instructionsDisplay}
                  className="px-2 py-1 rounded bg-emerald-800 hover:bg-emerald-700 text-white text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {actionBusy === 'edit' ? 'Saving…' : 'Save edit'}
                </button>
                <button
                  type="button"
                  onClick={() => { setEditing(false); setEditText(instructionsDisplay) }}
                  disabled={!!actionBusy}
                  className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Cancel edit
                </button>
              </div>
            </div>
          ) : (
            <ExpandableMarkdown source={instructionsDisplay} />
          )}
        </div>

        {/* Data out: current status / final report / trailer */}
        <div className="px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">
            {isTerminal ? 'Result' : 'Current status'}
          </div>
          {run?.response ? (
            <ExpandableMarkdown source={run.response} maxChars={400} />
          ) : run?.errorMessage ? (
            <pre className="text-red-400 whitespace-pre-wrap break-words font-mono">{run.errorMessage}</pre>
          ) : (
            <p className="text-zinc-500">
              {status === 'pending'
                ? 'Awaiting your approval.'
                : status === 'queued'
                ? 'Queued — waiting for an idle developer…'
                : status === 'cancelled'
                ? 'Cancelled before execution.'
                : 'Running…'}
            </p>
          )}
          {run?.pushStatus === 'failed' && run.pushError && (
            <div className="mt-2 rounded border border-red-900/60 bg-red-950/30 px-2 py-1.5">
              <div className="text-[10px] uppercase tracking-wide text-red-400 mb-0.5">
                push failed (work completed)
              </div>
              <pre className="text-red-300 whitespace-pre-wrap break-words font-mono text-[11px]">
                {run.pushError}
              </pre>
            </div>
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
})

// Markdown renderer that collapses long content behind a Show full / Show less
// toggle. Used inside dispatch badges where a multi-paragraph task description
// would otherwise dominate the chat scroll.
function ExpandableMarkdown({
  source,
  maxChars = 280,
}: {
  source: string
  maxChars?: number
}) {
  const [expanded, setExpanded] = useState(false)
  const className =
    'text-zinc-300 prose prose-sm prose-invert max-w-none prose-p:my-1 prose-pre:bg-zinc-800 prose-code:text-emerald-400'
  const isLong = source.length > maxChars || source.split('\n').length > 4
  if (!isLong) {
    return (
      <div className={className}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>
      </div>
    )
  }
  return (
    <div>
      <div
        className={`${className} ${expanded ? '' : 'relative max-h-24 overflow-hidden'}`}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>
        {!expanded && (
          <div className="absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-zinc-900 to-transparent pointer-events-none" />
        )}
      </div>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setExpanded((v) => !v)
        }}
        className="mt-1 text-[11px] text-zinc-400 hover:text-zinc-200 underline-offset-2 hover:underline"
      >
        {expanded ? 'Show less' : 'Show full'}
      </button>
    </div>
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

// Click-to-copy chip showing a shortened runId. Surfaces the UUID so the user
// can copy it for the [read, run-id] coordinator command.
function RunIdChip({ runId }: { runId: string }) {
  const [copied, setCopied] = useState(false)
  const onClick = async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(runId)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch { /* clipboard unavailable */ }
  }
  const short = runId.length >= 8 ? runId.slice(0, 8) : runId
  return (
    <button
      type="button"
      onClick={onClick}
      title={`runId: ${runId} (click to copy)`}
      className="px-1 py-0.5 rounded bg-zinc-800 text-zinc-500 hover:text-zinc-200 font-mono text-[10px]"
    >
      {copied ? 'copied' : short}
    </button>
  )
}

function PushStatusBadge({
  pushStatus,
  pushError,
}: {
  pushStatus: 'pushed' | 'failed' | 'not_attempted'
  pushError: string | null
}) {
  if (pushStatus === 'pushed') {
    return (
      <span className="px-1 py-0.5 rounded bg-green-950/50 text-green-400 text-[10px] font-mono border border-green-900/50">
        pushed
      </span>
    )
  }
  if (pushStatus === 'failed') {
    return (
      <span
        className="px-1 py-0.5 rounded bg-red-950/50 text-red-400 text-[10px] font-mono border border-red-900/50"
        title={pushError || 'push failed'}
      >
        push failed
      </span>
    )
  }
  return null
}
