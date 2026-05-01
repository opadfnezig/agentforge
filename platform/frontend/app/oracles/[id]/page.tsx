'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams } from 'next/navigation'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import {
  oraclesApi,
  type Oracle,
  type OracleQuery,
  type OracleLog,
  type OracleMode,
  type OracleStateFile,
  type OracleChat,
} from '@/lib/api'

const TERMINAL_STATUSES = new Set(['success', 'failure', 'cancelled'])

const MODES: { value: OracleMode; label: string; hint: string }[] = [
  { value: 'read', label: 'Read', hint: 'Answer from memories. No writes.' },
  { value: 'write', label: 'Write', hint: 'Merge new data into memories.' },
  { value: 'migrate', label: 'Migrate', hint: 'Ingest /data files into memories.' },
]

type Selection =
  | { kind: 'query'; id: string }
  | { kind: 'chat'; id: string }
  | null

type ListTab = 'chats' | 'queries'

export default function OracleDetailPage() {
  const params = useParams()
  const id = params.id as string

  // ---- top-level data ----
  const [oracle, setOracle] = useState<Oracle | null>(null)
  const [queries, setQueries] = useState<OracleQuery[]>([])
  const [chats, setChats] = useState<OracleChat[]>([])
  const [stateFiles, setStateFiles] = useState<OracleStateFile[]>([])
  const [error, setError] = useState<string | null>(null)

  // ---- ui state ----
  const [listTab, setListTab] = useState<ListTab>('chats')
  const [selection, setSelection] = useState<Selection>(null)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)

  // ---- dispatch form ----
  const [message, setMessage] = useState('')
  const [mode, setMode] = useState<OracleMode>('read')
  const [dispatching, setDispatching] = useState(false)
  const [dispatchError, setDispatchError] = useState<string | null>(null)

  // ---- query detail (loaded when selection is { kind: 'query' }) ----
  const [activeQuery, setActiveQuery] = useState<OracleQuery | null>(null)
  const [logs, setLogs] = useState<OracleLog[]>([])
  const [expandedLogIds, setExpandedLogIds] = useState<Set<string>>(new Set())

  // ---- chat thread (loaded when selection is { kind: 'chat' }) ----
  const [activeChat, setActiveChat] = useState<OracleChat | null>(null)
  const [chatMessages, setChatMessages] = useState<OracleQuery[]>([])

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const detailScrollRef = useRef<HTMLDivElement>(null)

  // Wall-clock tick so in-progress durations advance independently of the poll.
  const now = useNow(1000)

  // ---- loaders ----
  const refreshQueries = useCallback(() => {
    oraclesApi.listQueries(id).then(setQueries).catch(() => {})
  }, [id])

  const refreshChats = useCallback(() => {
    oraclesApi.listChats(id).then(setChats).catch(() => {})
  }, [id])

  const refreshState = useCallback(() => {
    oraclesApi.getState(id).then(res => setStateFiles(res.files)).catch(() => {})
  }, [id])

  useEffect(() => {
    oraclesApi.get(id).then(setOracle).catch(err => setError(err.message))
    refreshQueries()
    refreshChats()
    refreshState()
  }, [id, refreshQueries, refreshChats, refreshState])

  // Auto-scroll detail panel as new content arrives.
  useEffect(() => {
    if (detailScrollRef.current) {
      detailScrollRef.current.scrollTop = detailScrollRef.current.scrollHeight
    }
  }, [logs, chatMessages])

  // ---- polling helpers ----
  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const pollQuery = useCallback((queryId: string) => {
    stopPolling()
    const tick = async () => {
      try {
        const [q, logList] = await Promise.all([
          oraclesApi.getQuery(id, queryId),
          oraclesApi.listLogs(id, queryId),
        ])
        setActiveQuery(q)
        setLogs(logList)
        if (TERMINAL_STATUSES.has(q.status)) {
          stopPolling()
          refreshQueries()
          if (q.status === 'success' && (q.mode === 'write' || q.mode === 'migrate')) {
            refreshState()
          }
        }
      } catch { /* keep polling */ }
    }
    tick()
    pollRef.current = setInterval(tick, 1500)
  }, [id, refreshQueries, refreshState, stopPolling])

  const pollChat = useCallback((chatId: string) => {
    stopPolling()
    const tick = async () => {
      try {
        const { chat, messages } = await oraclesApi.getChat(id, chatId)
        setActiveChat(chat)
        setChatMessages(messages)
        // Stop polling once all messages are terminal.
        if (messages.every(m => TERMINAL_STATUSES.has(m.status))) {
          stopPolling()
          refreshChats()
          refreshQueries()
          // Refresh state if any message was a write/migrate.
          if (messages.some(m => m.status === 'success' && (m.mode === 'write' || m.mode === 'migrate'))) {
            refreshState()
          }
        }
      } catch { /* keep polling */ }
    }
    tick()
    pollRef.current = setInterval(tick, 1500)
  }, [id, refreshChats, refreshQueries, refreshState, stopPolling])

  useEffect(() => () => stopPolling(), [stopPolling])

  // ---- selection ----
  const selectQuery = useCallback((q: OracleQuery) => {
    // If this query is part of a chat, jump to the chat instead.
    if (q.chatId) {
      setSelection({ kind: 'chat', id: q.chatId })
      return
    }
    setSelection({ kind: 'query', id: q.id })
    setActiveQuery(q)
    setLogs([])
    if (TERMINAL_STATUSES.has(q.status)) {
      stopPolling()
      oraclesApi.listLogs(id, q.id).then(setLogs).catch(() => {})
    } else {
      pollQuery(q.id)
    }
  }, [id, pollQuery, stopPolling])

  const selectChat = useCallback((chat: OracleChat) => {
    setSelection({ kind: 'chat', id: chat.id })
    setActiveChat(chat)
    setChatMessages([])
    pollChat(chat.id)
  }, [pollChat])

  // Switch detail loaders when selection changes externally (e.g. via promote).
  useEffect(() => {
    if (!selection) return
    if (selection.kind === 'query') {
      const q = queries.find(qq => qq.id === selection.id)
      if (q) selectQuery(q)
    } else if (selection.kind === 'chat') {
      const c = chats.find(cc => cc.id === selection.id)
      if (c) selectChat(c)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection?.kind, selection?.id])

  // ---- dispatch / chat actions ----
  const handleSendInChat = async (text: string) => {
    if (!selection || selection.kind !== 'chat') return
    setDispatching(true)
    setDispatchError(null)
    try {
      await oraclesApi.dispatch(id, text, { mode: 'chat', chatId: selection.id })
      setMessage('')
      pollChat(selection.id)
      refreshChats()
    } catch (err) {
      setDispatchError(err instanceof Error ? err.message : 'Send failed')
    } finally {
      setDispatching(false)
    }
  }

  const handleDispatchOneShot = async (text: string) => {
    setDispatching(true)
    setDispatchError(null)
    try {
      const { queryId } = await oraclesApi.dispatch(id, text || '(migrate)', { mode })
      setMessage('')
      setSelection({ kind: 'query', id: queryId })
      setActiveQuery(null)
      setLogs([])
      pollQuery(queryId)
      refreshQueries()
    } catch (err) {
      setDispatchError(err instanceof Error ? err.message : 'Dispatch failed')
    } finally {
      setDispatching(false)
    }
  }

  const submitDispatch = (e: React.FormEvent) => {
    e.preventDefault()
    const text = message.trim()
    if (selection?.kind === 'chat') {
      if (!text) return
      handleSendInChat(text)
    } else {
      if (!text && mode !== 'migrate') return
      handleDispatchOneShot(text)
    }
  }

  const handleNewChat = async () => {
    try {
      const chat = await oraclesApi.createChat(id)
      refreshChats()
      setListTab('chats')
      setSelection({ kind: 'chat', id: chat.id })
      setActiveChat(chat)
      setChatMessages([])
    } catch (err) {
      setDispatchError(err instanceof Error ? err.message : 'New chat failed')
    }
  }

  const handlePromoteToChat = async (queryId: string) => {
    try {
      const chat = await oraclesApi.promoteQueryToChat(id, queryId)
      refreshChats()
      refreshQueries()
      setListTab('chats')
      setSelection({ kind: 'chat', id: chat.id })
    } catch (err) {
      setDispatchError(err instanceof Error ? err.message : 'Promote failed')
    }
  }

  const handleCancel = async (queryId: string) => {
    try {
      await oraclesApi.cancelQuery(id, queryId)
      refreshQueries()
      if (selection?.kind === 'query' && selection.id === queryId) {
        const q = await oraclesApi.getQuery(id, queryId)
        setActiveQuery(q)
      }
    } catch (err) {
      setDispatchError(err instanceof Error ? err.message : 'Cancel failed')
    }
  }

  const handleApprove = async (queryId: string) => {
    try {
      await oraclesApi.approveQuery(id, queryId)
      pollQuery(queryId)
      refreshQueries()
    } catch (err) {
      setDispatchError(err instanceof Error ? err.message : 'Approve failed')
    }
  }

  const handleRetry = async (queryId: string, withContext: boolean) => {
    try {
      const child = withContext
        ? await oraclesApi.continueQuery(id, queryId)
        : await oraclesApi.retryQuery(id, queryId)
      setSelection({ kind: 'query', id: child.id })
      setActiveQuery(child)
      setLogs([])
      pollQuery(child.id)
      refreshQueries()
    } catch (err) {
      setDispatchError(err instanceof Error ? err.message : 'Retry failed')
    }
  }

  const handleDeleteChat = async (chatId: string) => {
    if (!confirm('Delete this chat? Messages stay in query history.')) return
    try {
      await oraclesApi.deleteChat(id, chatId)
      refreshChats()
      if (selection?.kind === 'chat' && selection.id === chatId) {
        setSelection(null)
        setActiveChat(null)
        setChatMessages([])
      }
    } catch (err) {
      setDispatchError(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  const toggleExpandedLog = (logId: string) => {
    setExpandedLogIds(prev => {
      const next = new Set(prev)
      if (next.has(logId)) next.delete(logId)
      else next.add(logId)
      return next
    })
  }

  if (error) {
    return (
      <div className="container mx-auto py-16 text-center text-red-400">
        Failed to load oracle: {error}
      </div>
    )
  }
  if (!oracle) {
    return (
      <div className="container mx-auto py-16 text-center text-zinc-500">
        Loading oracle...
      </div>
    )
  }

  const selectedFileObj = stateFiles.find(f => f.name === selectedFile) ?? null
  const standaloneQueries = queries.filter(q => !q.chatId)

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)] bg-zinc-950">
      {/* Header */}
      <div className="border-b border-zinc-800 px-6 py-3 flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${oracle.online ? 'bg-green-500' : 'bg-zinc-600'}`} />
          <h1 className="text-lg font-bold">{oracle.name}</h1>
        </div>
        <span className="text-sm text-zinc-500">{oracle.domain}</span>
        <span className={`px-2 py-0.5 text-xs font-medium rounded ${
          oracle.status === 'active' ? 'bg-green-900 text-green-200' :
          oracle.status === 'error' ? 'bg-red-900 text-red-200' :
          'bg-zinc-800 text-zinc-400'
        }`}>{oracle.status}</span>
        <span className="text-xs text-zinc-600 font-mono">{oracle.stateDir}</span>
        {!oracle.online && (
          <span className="ml-auto text-xs text-amber-400">offline — spawn the container</span>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* State files */}
        <div className="w-[20rem] border-r border-zinc-800 flex flex-col">
          <div className="px-3 py-2 border-b border-zinc-800 flex items-center justify-between">
            <span className="text-xs uppercase tracking-wider text-zinc-500">State files</span>
            <button onClick={refreshState} className="text-xs text-zinc-500 hover:text-zinc-300">refresh</button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {stateFiles.length === 0 ? (
              <p className="text-xs text-zinc-600 p-3">No memory files yet.</p>
            ) : (
              <ul>
                {stateFiles.map(f => (
                  <li key={f.name}>
                    <button
                      onClick={() => setSelectedFile(f.name === selectedFile ? null : f.name)}
                      className={`w-full text-left px-3 py-1.5 text-xs font-mono truncate ${
                        f.name === selectedFile ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900'
                      }`}
                    >{f.name}</button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {selectedFileObj && (
            <div className="border-t border-zinc-800 max-h-[50%] overflow-y-auto">
              <div className="px-3 py-2 border-b border-zinc-800 flex items-center justify-between">
                <span className="text-xs font-mono text-zinc-300 truncate">{selectedFileObj.name}</span>
                <button onClick={() => setSelectedFile(null)} className="text-xs text-zinc-500 hover:text-zinc-300">×</button>
              </div>
              <pre className="p-3 text-xs text-zinc-300 whitespace-pre-wrap break-words font-mono">
                {selectedFileObj.content}
              </pre>
            </div>
          )}
        </div>

        {/* List panel: tabs + list */}
        <div className="w-[22rem] border-r border-zinc-800 flex flex-col">
          <div className="px-3 py-2 border-b border-zinc-800 flex items-center gap-1">
            <button
              onClick={() => setListTab('chats')}
              className={`text-xs px-2 py-1 rounded ${listTab === 'chats' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
            >Chats ({chats.length})</button>
            <button
              onClick={() => setListTab('queries')}
              className={`text-xs px-2 py-1 rounded ${listTab === 'queries' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
            >Queries ({standaloneQueries.length})</button>
            <div className="ml-auto flex items-center gap-1">
              {listTab === 'chats' && (
                <button
                  onClick={handleNewChat}
                  className="text-xs px-2 py-1 rounded bg-violet-900 hover:bg-violet-800 text-violet-100"
                >+ New</button>
              )}
              <button
                onClick={listTab === 'chats' ? refreshChats : refreshQueries}
                className="text-xs text-zinc-500 hover:text-zinc-300"
              >↻</button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {listTab === 'chats' ? (
              chats.length === 0 ? (
                <p className="text-xs text-zinc-600 p-3">No chats yet. Start a new one or promote a query.</p>
              ) : (
                <ul>
                  {chats.map(c => (
                    <li key={c.id}>
                      <button
                        onClick={() => selectChat(c)}
                        className={`w-full text-left px-3 py-2 border-b border-zinc-900 ${
                          selection?.kind === 'chat' && selection.id === c.id ? 'bg-zinc-800' : 'hover:bg-zinc-900'
                        }`}
                      >
                        <div className="text-xs text-zinc-200 line-clamp-1 mb-1">
                          {c.title || '(untitled)'}
                        </div>
                        <div className="flex items-center gap-2 text-[10px] text-zinc-500 font-mono">
                          <span>{relTime(c.lastMessageAt ?? c.createdAt)}</span>
                          {c.claudeSessionId && <span title={c.claudeSessionId}>session {c.claudeSessionId.slice(0, 8)}</span>}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )
            ) : (
              standaloneQueries.length === 0 ? (
                <p className="text-xs text-zinc-600 p-3">No standalone queries. Try dispatching one below.</p>
              ) : (
                <ul>
                  {standaloneQueries.map(q => (
                    <li key={q.id}>
                      <button
                        onClick={() => selectQuery(q)}
                        className={`w-full text-left px-3 py-2 border-b border-zinc-900 ${
                          selection?.kind === 'query' && selection.id === q.id ? 'bg-zinc-800' : 'hover:bg-zinc-900'
                        }`}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <StatusBadge status={q.status} />
                          <span className="text-xs uppercase tracking-wider text-zinc-500">{q.mode}</span>
                          <span className="text-xs text-zinc-600 ml-auto">{relTime(q.createdAt)}</span>
                        </div>
                        <p className="text-xs text-zinc-300 line-clamp-2 mb-1">{q.message || '(empty)'}</p>
                        <div className="flex items-center gap-3 text-[10px] text-zinc-500 font-mono">
                          <span>{liveDuration(q, now) ?? '—'}</span>
                          <span>{q.totalCostUsd != null ? `$${q.totalCostUsd.toFixed(4)}` : '—'}</span>
                          {tokensSummary(q) && <span className="text-zinc-600">{tokensSummary(q)}</span>}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )
            )}
          </div>
        </div>

        {/* Detail panel */}
        <div className="flex-1 flex flex-col">
          {selection?.kind === 'chat' && activeChat ? (
            <ChatThread
              chat={activeChat}
              messages={chatMessages}
              now={now}
              onDelete={() => handleDeleteChat(activeChat.id)}
              onRenameTitle={async (title) => {
                await oraclesApi.updateChatTitle(id, activeChat.id, title)
                refreshChats()
                setActiveChat({ ...activeChat, title })
              }}
              detailScrollRef={detailScrollRef}
            />
          ) : selection?.kind === 'query' && activeQuery ? (
            <ActiveQueryView
              oracleId={id}
              query={activeQuery}
              logs={logs}
              expandedLogIds={expandedLogIds}
              onToggleExpand={toggleExpandedLog}
              onCancel={() => handleCancel(activeQuery.id)}
              onApprove={() => handleApprove(activeQuery.id)}
              onRetry={(withContext) => handleRetry(activeQuery.id, withContext)}
              onPromoteToChat={() => handlePromoteToChat(activeQuery.id)}
              detailScrollRef={detailScrollRef}
              now={now}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-zinc-600 text-sm text-center px-6">
              <div>
                <p>Pick a chat or query, start a new chat, or dispatch one-off below.</p>
                <p className="text-xs text-zinc-700 mt-2">Chats keep cache + session warm across messages — useful for follow-ups.</p>
              </div>
            </div>
          )}

          <form onSubmit={submitDispatch} className="border-t border-zinc-800 p-3 space-y-2">
            <div className="flex items-center gap-2">
              {selection?.kind === 'chat' ? (
                <span className="text-xs uppercase tracking-wider text-violet-400">chat</span>
              ) : (
                <>
                  <span className="text-xs uppercase tracking-wider text-zinc-500">mode</span>
                  <select
                    value={mode}
                    onChange={e => setMode(e.target.value as OracleMode)}
                    className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm"
                  >
                    {MODES.map(m => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                  <span className="text-xs text-zinc-500">{MODES.find(m => m.value === mode)?.hint}</span>
                </>
              )}
              {selection?.kind === 'chat' && (
                <span className="text-xs text-zinc-500 ml-auto">
                  {activeChat?.claudeSessionId ? `Resumes session ${activeChat.claudeSessionId.slice(0, 8)}` : 'New session — first message creates it'}
                </span>
              )}
            </div>
            <textarea
              value={message}
              onChange={e => setMessage(e.target.value)}
              placeholder={
                selection?.kind === 'chat' ? 'Send a message...' :
                mode === 'read' ? 'Ask the oracle...' :
                mode === 'write' ? 'New information to merge into memories...' :
                'Migrate runs without a message — files in /data drive it.'
              }
              disabled={dispatching}
              rows={3}
              className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm font-mono resize-none"
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  submitDispatch(e as unknown as React.FormEvent)
                }
              }}
            />
            {dispatchError && <p className="text-xs text-red-400">{dispatchError}</p>}
            <div className="flex items-center gap-2">
              <Button
                type="submit"
                disabled={dispatching || (!message.trim() && (selection?.kind === 'chat' || mode !== 'migrate')) || !oracle.online}
                size="sm"
              >
                {dispatching ? 'Sending...' : !oracle.online ? 'Oracle offline' : selection?.kind === 'chat' ? 'Send' : 'Dispatch'}
              </Button>
              <span className="text-xs text-zinc-600">Ctrl+Enter</span>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Chat thread view
// ---------------------------------------------------------------------------

function ChatThread({
  chat, messages, now, onDelete, onRenameTitle, detailScrollRef,
}: {
  chat: OracleChat
  messages: OracleQuery[]
  now: number
  onDelete: () => void
  onRenameTitle: (title: string) => Promise<void>
  detailScrollRef: React.RefObject<HTMLDivElement | null>
}) {
  const [editing, setEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState(chat.title || '')
  useEffect(() => { setTitleDraft(chat.title || '') }, [chat.title])

  const totalCost = messages.reduce((s, m) => s + (m.totalCostUsd ?? 0), 0)

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-800 flex items-center gap-3">
        {editing ? (
          <form
            onSubmit={async (e) => {
              e.preventDefault()
              await onRenameTitle(titleDraft.trim() || 'Chat')
              setEditing(false)
            }}
            className="flex-1 flex items-center gap-2"
          >
            <input
              value={titleDraft}
              onChange={e => setTitleDraft(e.target.value)}
              autoFocus
              className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-sm"
            />
            <Button type="submit" size="sm">Save</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing(false)}>Cancel</Button>
          </form>
        ) : (
          <>
            <h2 className="text-sm font-semibold text-zinc-200 flex-1 truncate">{chat.title || '(untitled chat)'}</h2>
            <button onClick={() => setEditing(true)} className="text-xs text-zinc-500 hover:text-zinc-300">rename</button>
            <button onClick={onDelete} className="text-xs text-red-500 hover:text-red-300">delete</button>
          </>
        )}
      </div>

      <div className="px-4 py-2 border-b border-zinc-900 flex items-center gap-4 text-xs text-zinc-500">
        <span>{messages.length} message{messages.length === 1 ? '' : 's'}</span>
        {totalCost > 0 && <span>total cost ${totalCost.toFixed(4)}</span>}
        {chat.claudeSessionId && (
          <span className="font-mono ml-auto" title={chat.claudeSessionId}>session {chat.claudeSessionId.slice(0, 8)}</span>
        )}
      </div>

      <div ref={detailScrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {messages.length === 0 && (
          <p className="text-center text-zinc-600 text-sm py-12">No messages yet. Send one below.</p>
        )}
        {messages.map(m => (
          <ChatMessage key={m.id} message={m} now={now} />
        ))}
      </div>
    </div>
  )
}

function ChatMessage({ message, now }: { message: OracleQuery; now: number }) {
  return (
    <div className="space-y-1">
      {/* User bubble */}
      <div className="flex">
        <div className="ml-auto max-w-[70%] bg-zinc-800 rounded-lg px-3 py-2">
          <pre className="text-sm text-zinc-100 whitespace-pre-wrap font-sans">{message.message}</pre>
        </div>
      </div>
      {/* Assistant bubble */}
      <div className="flex">
        <div className="mr-auto max-w-[85%] rounded-lg px-3 py-2 bg-zinc-900 border border-zinc-800">
          <div className="flex items-center gap-2 mb-1 text-[10px] text-zinc-500 flex-wrap">
            <StatusBadge status={message.status} />
            <span>{liveDuration(message, now) ?? '...'}</span>
            {message.totalCostUsd != null && <span>${message.totalCostUsd.toFixed(4)}</span>}
            {tokensSummary(message) && <span className="text-zinc-600">{tokensSummary(message)}</span>}
            {cacheSummary(message) && <span className="text-zinc-600">{cacheSummary(message)}</span>}
            {message.stopReason && <span className="text-zinc-600">{message.stopReason}</span>}
          </div>
          {message.status === 'running' && !message.response ? (
            <p className="text-sm text-zinc-500 italic">thinking...</p>
          ) : message.errorMessage ? (
            <pre className="text-sm text-red-300 whitespace-pre-wrap font-mono">{message.errorMessage}</pre>
          ) : (
            <div className="prose prose-invert prose-sm max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.response || ''}</ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// One-off query view (existing — extended with promote-to-chat)
// ---------------------------------------------------------------------------

function ActiveQueryView({
  query, logs, expandedLogIds, onToggleExpand, onCancel, onApprove, onRetry, onPromoteToChat, detailScrollRef, now,
}: {
  oracleId: string
  query: OracleQuery
  logs: OracleLog[]
  expandedLogIds: Set<string>
  onToggleExpand: (logId: string) => void
  onCancel: () => void
  onApprove: () => void
  onRetry: (withContext: boolean) => void
  onPromoteToChat: () => void
  detailScrollRef: React.RefObject<HTMLDivElement | null>
  now: number
}) {
  const isTerminal = query.status === 'success' || query.status === 'failure' || query.status === 'cancelled'
  const [showAllLogs, setShowAllLogs] = useState(false)
  const visibleLogs = !isTerminal || showAllLogs ? logs : logs.slice(-10)
  const hiddenCount = logs.length - visibleLogs.length
  const usage = (query.trailer?.usage ?? {}) as Record<string, number | undefined>
  const tokensIn = usage.input_tokens
  const tokensOut = usage.output_tokens
  const cacheRead = usage.cache_read_input_tokens
  const cacheWrite = usage.cache_creation_input_tokens
  const canPromote = query.status === 'success' && !!query.sessionId && !query.chatId

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-800 space-y-2">
        <div className="flex items-center gap-3 flex-wrap">
          <StatusBadge status={query.status} />
          <span className="text-xs uppercase tracking-wider text-zinc-500">{query.mode}</span>
          <span className="text-xs text-zinc-600 font-mono">{query.id.slice(0, 8)}</span>
          <span className="text-xs text-zinc-600">{relTime(query.createdAt)}</span>
          {query.parentQueryId && (
            <span className="text-xs text-amber-400">retry of {query.parentQueryId.slice(0, 8)}</span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {canPromote && (
              <Button onClick={onPromoteToChat} size="sm" variant="outline">Continue as chat</Button>
            )}
            {query.status === 'pending' && (
              <Button onClick={onApprove} size="sm" variant="default">Approve</Button>
            )}
            {(query.status === 'pending' || query.status === 'queued') && (
              <Button onClick={onCancel} size="sm" variant="outline">Cancel</Button>
            )}
            {query.status === 'failure' && (
              <>
                <Button onClick={() => onRetry(false)} size="sm" variant="outline">Retry</Button>
                <Button onClick={() => onRetry(true)} size="sm" variant="outline">Continue</Button>
              </>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1 text-xs">
          <Meta label="model" value={query.model} />
          <Meta label="cost" value={query.totalCostUsd != null ? `$${query.totalCostUsd.toFixed(4)}` : null} />
          <Meta label="duration" value={liveDuration(query, now)} />
          <Meta label="api time" value={formatDuration(query.durationApiMs)} />
          <Meta label="tokens in" value={tokensIn != null ? tokensIn.toLocaleString() : null} />
          <Meta label="tokens out" value={tokensOut != null ? tokensOut.toLocaleString() : null} />
          <Meta label="cache read" value={cacheRead ? cacheRead.toLocaleString() : null} />
          <Meta label="cache write" value={cacheWrite ? cacheWrite.toLocaleString() : null} />
          <Meta label="stop" value={query.stopReason} />
          <Meta label="session" value={query.sessionId ? query.sessionId.slice(0, 8) : null} />
          <Meta label="provider" value={query.provider} />
          <Meta label="started" value={query.startedAt ? relTime(query.startedAt) : null} />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto" ref={detailScrollRef}>
        <Section title="Message">
          <pre className="text-sm text-zinc-300 whitespace-pre-wrap font-mono">{query.message || '(empty)'}</pre>
        </Section>

        {query.errorMessage && (
          <Section title="Error" tone="error">
            <pre className="text-sm text-red-300 whitespace-pre-wrap font-mono">{query.errorMessage}</pre>
          </Section>
        )}

        {query.response && (
          <Section title="Response">
            <div className="prose prose-invert prose-sm max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{query.response}</ReactMarkdown>
            </div>
          </Section>
        )}

        {query.resumeContext && (
          <Section title="Resume context">
            <pre className="text-xs text-zinc-400 whitespace-pre-wrap font-mono">{query.resumeContext}</pre>
          </Section>
        )}

        <Section title={`Events (${logs.length})`}>
          {logs.length === 0 ? (
            <p className="text-xs text-zinc-600">No events yet.</p>
          ) : (
            <>
              {hiddenCount > 0 && (
                <button
                  onClick={() => setShowAllLogs(true)}
                  className="text-xs text-zinc-500 hover:text-zinc-300 mb-2"
                >▸ show {hiddenCount} earlier event{hiddenCount === 1 ? '' : 's'}</button>
              )}
              {showAllLogs && isTerminal && logs.length > 10 && (
                <button
                  onClick={() => setShowAllLogs(false)}
                  className="text-xs text-zinc-500 hover:text-zinc-300 mb-2"
                >▾ collapse to last 10</button>
              )}
              <ul className="space-y-1">
                {visibleLogs.map(log => (
                  <LogItem
                    key={log.id}
                    log={log}
                    expanded={expandedLogIds.has(log.id)}
                    onToggle={() => onToggleExpand(log.id)}
                  />
                ))}
              </ul>
            </>
          )}
        </Section>

        {query.trailer && Object.keys(query.trailer).length > 0 && (
          <Section title="Trailer">
            <pre className="text-xs text-zinc-400 whitespace-pre-wrap font-mono">{JSON.stringify(query.trailer, null, 2)}</pre>
          </Section>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: OracleQuery['status'] }) {
  const styles: Record<OracleQuery['status'], string> = {
    pending: 'bg-amber-900 text-amber-200',
    queued: 'bg-blue-900 text-blue-200',
    running: 'bg-violet-900 text-violet-200 animate-pulse',
    success: 'bg-green-900 text-green-200',
    failure: 'bg-red-900 text-red-200',
    cancelled: 'bg-zinc-800 text-zinc-400',
  }
  return (
    <span className={`px-1.5 py-0.5 text-[10px] uppercase tracking-wider rounded font-mono ${styles[status]}`}>
      {status}
    </span>
  )
}

function Meta({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <span className="text-zinc-500">{label}:</span>{' '}
      <span className="text-zinc-300 font-mono">{value ?? '—'}</span>
    </div>
  )
}

function Section({
  title, tone = 'default', children,
}: {
  title: string
  tone?: 'default' | 'error'
  children: React.ReactNode
}) {
  return (
    <div className={`px-4 py-3 border-b border-zinc-900 ${tone === 'error' ? 'bg-red-950/20' : ''}`}>
      <h3 className="text-xs uppercase tracking-wider text-zinc-500 mb-2">{title}</h3>
      {children}
    </div>
  )
}

function LogItem({
  log, expanded, onToggle,
}: {
  log: OracleLog
  expanded: boolean
  onToggle: () => void
}) {
  const summary = summariseEvent(log)
  return (
    <li className="rounded border border-zinc-800 bg-zinc-900/50">
      <button
        onClick={onToggle}
        className="w-full text-left px-2 py-1 flex items-center gap-2 text-xs hover:bg-zinc-900"
      >
        <span className="text-zinc-500 font-mono w-16 shrink-0">{log.eventType}</span>
        <span className="text-zinc-400 truncate flex-1">{summary}</span>
        <span className="text-zinc-600 shrink-0">{new Date(log.timestamp).toLocaleTimeString()}</span>
      </button>
      {expanded && (
        <pre className="px-2 py-2 text-[11px] text-zinc-400 font-mono whitespace-pre-wrap break-words border-t border-zinc-800">
          {JSON.stringify(log.data, null, 2)}
        </pre>
      )}
    </li>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summariseEvent(log: OracleLog): string {
  const data = log.data as any
  if (log.eventType === 'assistant') {
    const content = data?.message?.content
    if (Array.isArray(content)) {
      const parts = content
        .map((c: { type?: string; text?: string; name?: string }) =>
          c?.type === 'text' ? (c.text ?? '').slice(0, 80) :
          c?.type === 'tool_use' ? `→ ${c.name}` :
          c?.type
        )
        .filter(Boolean)
      return parts.join(' | ') || '(empty)'
    }
  }
  if (log.eventType === 'system' && data?.subtype) return `system/${data.subtype}`
  if (log.eventType === 'result') {
    const cost = typeof data?.total_cost_usd === 'number' ? `$${data.total_cost_usd.toFixed(4)}` : ''
    const stop = typeof data?.stop_reason === 'string' ? data.stop_reason : ''
    return [stop, cost].filter(Boolean).join(' • ')
  }
  if (log.eventType === 'stderr') return (data?.text ?? '').slice(0, 120)
  return JSON.stringify(data).slice(0, 120)
}

function relTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

function formatDuration(ms: number | null | undefined): string | null {
  if (ms == null) return null
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
}

function useNow(intervalMs: number = 1000): number {
  const [now, setNow] = useState<number>(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

function liveDuration(query: OracleQuery, now: number): string | null {
  if (query.durationMs != null) return formatDuration(query.durationMs)
  if (query.status === 'running' && query.startedAt) {
    return formatDuration(now - new Date(query.startedAt).getTime())
  }
  return null
}

function tokensSummary(query: OracleQuery): string | null {
  const usage = (query.trailer?.usage ?? {}) as Record<string, number | undefined>
  const inT = usage.input_tokens
  const outT = usage.output_tokens
  if (inT == null && outT == null) return null
  const inS = inT != null ? `${(inT / 1000).toFixed(1)}k` : '?'
  const outS = outT != null ? `${(outT / 1000).toFixed(1)}k` : '?'
  return `↑${inS} ↓${outS}`
}

function cacheSummary(query: OracleQuery): string | null {
  const usage = (query.trailer?.usage ?? {}) as Record<string, number | undefined>
  const read = usage.cache_read_input_tokens
  const write = usage.cache_creation_input_tokens
  if (!read && !write) return null
  const fmt = (n: number | undefined) => n ? (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`) : '0'
  return `cache W${fmt(write)} R${fmt(read)}`
}
