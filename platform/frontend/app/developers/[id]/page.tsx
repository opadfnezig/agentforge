'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams } from 'next/navigation'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import {
  developersApi,
  type Developer,
  type DeveloperRun,
  type DeveloperLog,
  type DeveloperRunMode,
  type DeveloperChat,
  type DeveloperStateFile,
} from '@/lib/api'

const TERMINAL_STATUSES = new Set(['success', 'failure', 'cancelled', 'no_changes'])

const MODES: { value: DeveloperRunMode; label: string; hint: string }[] = [
  { value: 'implement', label: 'Implement', hint: 'Make code changes, commit, push.' },
  { value: 'clarify', label: 'Clarify', hint: 'Read code, ask questions. No edits.' },
  { value: 'chat', label: 'Chat', hint: 'Multi-turn — start new chat or use existing.' },
]

type Selection =
  | { kind: 'run'; id: string }
  | { kind: 'chat'; id: string }
  | null

type ListTab = 'chats' | 'runs'

export default function DeveloperDetailPage() {
  const params = useParams()
  const id = params.id as string

  // ---- top-level data ----
  const [developer, setDeveloper] = useState<Developer | null>(null)
  const [runs, setRuns] = useState<DeveloperRun[]>([])
  const [chats, setChats] = useState<DeveloperChat[]>([])
  const [stateFiles, setStateFiles] = useState<DeveloperStateFile[]>([])
  const [error, setError] = useState<string | null>(null)

  // ---- ui state ----
  const [listTab, setListTab] = useState<ListTab>('chats')
  const [selection, setSelection] = useState<Selection>(null)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)

  // ---- dispatch form ----
  const [instructions, setInstructions] = useState('')
  const [mode, setMode] = useState<DeveloperRunMode>('implement')
  const [dispatching, setDispatching] = useState(false)
  const [dispatchError, setDispatchError] = useState<string | null>(null)

  // ---- run detail ----
  const [activeRun, setActiveRun] = useState<DeveloperRun | null>(null)
  const [logs, setLogs] = useState<DeveloperLog[]>([])
  const [expandedLogIds, setExpandedLogIds] = useState<Set<string>>(new Set())

  // ---- chat thread ----
  const [activeChat, setActiveChat] = useState<DeveloperChat | null>(null)
  const [chatMessages, setChatMessages] = useState<DeveloperRun[]>([])

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const detailScrollRef = useRef<HTMLDivElement>(null)

  const now = useNow(1000)

  // ---- loaders ----
  const refreshRuns = useCallback(() => {
    developersApi.listRuns(id).then(setRuns).catch(() => {})
  }, [id])

  const refreshChats = useCallback(() => {
    developersApi.listChats(id).then(setChats).catch(() => {})
  }, [id])

  const refreshState = useCallback(() => {
    developersApi.getState(id).then(res => setStateFiles(res.files)).catch(() => {})
  }, [id])

  useEffect(() => {
    developersApi.get(id).then(setDeveloper).catch(err => setError(err.message))
    refreshRuns()
    refreshChats()
    refreshState()
  }, [id, refreshRuns, refreshChats, refreshState])

  useEffect(() => {
    if (detailScrollRef.current) {
      detailScrollRef.current.scrollTop = detailScrollRef.current.scrollHeight
    }
  }, [logs, chatMessages])

  // ---- polling ----
  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const pollRun = useCallback((runId: string) => {
    stopPolling()
    const tick = async () => {
      try {
        const [run, logList] = await Promise.all([
          developersApi.getRun(id, runId),
          developersApi.listLogs(id, runId),
        ])
        setActiveRun(run)
        setLogs(logList)
        if (TERMINAL_STATUSES.has(run.status)) {
          stopPolling()
          refreshRuns()
        }
      } catch { /* keep polling */ }
    }
    tick()
    pollRef.current = setInterval(tick, 1500)
  }, [id, refreshRuns, stopPolling])

  const pollChat = useCallback((chatId: string) => {
    stopPolling()
    const tick = async () => {
      try {
        const { chat, messages } = await developersApi.getChat(id, chatId)
        setActiveChat(chat)
        setChatMessages(messages)
        if (messages.every(m => TERMINAL_STATUSES.has(m.status))) {
          stopPolling()
          refreshChats()
          refreshRuns()
          refreshState()
        }
      } catch { /* keep polling */ }
    }
    tick()
    pollRef.current = setInterval(tick, 1500)
  }, [id, refreshChats, refreshRuns, refreshState, stopPolling])

  useEffect(() => () => stopPolling(), [stopPolling])

  // ---- selection ----
  const selectRun = useCallback((r: DeveloperRun) => {
    if (r.chatId) {
      setSelection({ kind: 'chat', id: r.chatId })
      return
    }
    setSelection({ kind: 'run', id: r.id })
    setActiveRun(r)
    setLogs([])
    if (TERMINAL_STATUSES.has(r.status)) {
      stopPolling()
      developersApi.listLogs(id, r.id).then(setLogs).catch(() => {})
    } else {
      pollRun(r.id)
    }
  }, [id, pollRun, stopPolling])

  const selectChat = useCallback((c: DeveloperChat) => {
    setSelection({ kind: 'chat', id: c.id })
    setActiveChat(c)
    setChatMessages([])
    pollChat(c.id)
  }, [pollChat])

  useEffect(() => {
    if (!selection) return
    if (selection.kind === 'run') {
      const r = runs.find(rr => rr.id === selection.id)
      if (r) selectRun(r)
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
      await developersApi.dispatch(id, text, { mode: 'chat', chatId: selection.id })
      setInstructions('')
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
      const { runId } = await developersApi.dispatch(id, text, { mode })
      setInstructions('')
      setSelection({ kind: 'run', id: runId })
      setActiveRun(null)
      setLogs([])
      pollRun(runId)
      refreshRuns()
    } catch (err) {
      setDispatchError(err instanceof Error ? err.message : 'Dispatch failed')
    } finally {
      setDispatching(false)
    }
  }

  const submitDispatch = (e: React.FormEvent) => {
    e.preventDefault()
    const text = instructions.trim()
    if (!text) return
    if (selection?.kind === 'chat') {
      handleSendInChat(text)
    } else {
      handleDispatchOneShot(text)
    }
  }

  const handleNewChat = async () => {
    try {
      const chat = await developersApi.createChat(id)
      refreshChats()
      setListTab('chats')
      setSelection({ kind: 'chat', id: chat.id })
      setActiveChat(chat)
      setChatMessages([])
    } catch (err) {
      setDispatchError(err instanceof Error ? err.message : 'New chat failed')
    }
  }

  const handlePromoteToChat = async (runId: string) => {
    try {
      const chat = await developersApi.promoteRunToChat(id, runId)
      refreshChats()
      refreshRuns()
      setListTab('chats')
      setSelection({ kind: 'chat', id: chat.id })
    } catch (err) {
      setDispatchError(err instanceof Error ? err.message : 'Promote failed')
    }
  }

  const handleApprove = async (runId: string) => {
    try { await developersApi.approveRun(id, runId); pollRun(runId); refreshRuns() }
    catch (err) { setDispatchError(err instanceof Error ? err.message : 'Approve failed') }
  }
  const handleCancel = async (runId: string) => {
    try {
      await developersApi.cancelRun(id, runId)
      refreshRuns()
      if (selection?.kind === 'run' && selection.id === runId) {
        const r = await developersApi.getRun(id, runId); setActiveRun(r)
      }
    } catch (err) { setDispatchError(err instanceof Error ? err.message : 'Cancel failed') }
  }
  const handleRetry = async (runId: string, withContext: boolean) => {
    try {
      const child = withContext
        ? await developersApi.continueRun(id, runId)
        : await developersApi.retryRun(id, runId)
      setSelection({ kind: 'run', id: child.id })
      setActiveRun(child)
      setLogs([])
      pollRun(child.id)
      refreshRuns()
    } catch (err) { setDispatchError(err instanceof Error ? err.message : 'Retry failed') }
  }
  const handleDeleteChat = async (chatId: string) => {
    if (!confirm('Delete this chat? Run history is preserved.')) return
    try {
      await developersApi.deleteChat(id, chatId)
      refreshChats()
      if (selection?.kind === 'chat' && selection.id === chatId) {
        setSelection(null)
        setActiveChat(null)
        setChatMessages([])
      }
    } catch (err) { setDispatchError(err instanceof Error ? err.message : 'Delete failed') }
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
        Failed to load developer: {error}
      </div>
    )
  }
  if (!developer) {
    return (
      <div className="container mx-auto py-16 text-center text-zinc-500">Loading developer...</div>
    )
  }

  const selectedFileObj = stateFiles.find(f => f.name === selectedFile) ?? null
  const standaloneRuns = runs.filter(r => !r.chatId)

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)] bg-zinc-950">
      {/* Header */}
      <div className="border-b border-zinc-800 px-6 py-3 flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${developer.online ? 'bg-green-500' : 'bg-zinc-600'}`} />
          <h1 className="text-lg font-bold">{developer.name}</h1>
        </div>
        <span className={`px-2 py-0.5 text-xs font-medium rounded ${
          developer.status === 'idle' ? 'bg-green-900 text-green-200' :
          developer.status === 'busy' ? 'bg-violet-900 text-violet-200' :
          developer.status === 'error' ? 'bg-red-900 text-red-200' :
          'bg-zinc-800 text-zinc-400'
        }`}>{developer.status}</span>
        <span className="text-xs text-zinc-600 font-mono truncate">{developer.workspacePath}</span>
        {developer.gitRepo && <span className="text-xs text-zinc-500 truncate">{developer.gitRepo}</span>}
        {developer.gitBranch && <span className="text-xs text-zinc-500">@{developer.gitBranch}</span>}
        {!developer.online && (
          <span className="ml-auto text-xs text-amber-400">offline — spawn the container</span>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 flex overflow-hidden">
        {/* State files */}
        <div className="w-[20rem] border-r border-zinc-800 flex flex-col">
          <div className="px-3 py-2 border-b border-zinc-800 flex items-center justify-between">
            <span className="text-xs uppercase tracking-wider text-zinc-500">Memory</span>
            <button onClick={refreshState} className="text-xs text-zinc-500 hover:text-zinc-300">refresh</button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {stateFiles.length === 0 ? (
              <p className="text-xs text-zinc-600 p-3">No memory files yet. Dev's claude memory shows up here.</p>
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

        {/* List panel */}
        <div className="w-[22rem] border-r border-zinc-800 flex flex-col">
          <div className="px-3 py-2 border-b border-zinc-800 flex items-center gap-1">
            <button
              onClick={() => setListTab('chats')}
              className={`text-xs px-2 py-1 rounded ${listTab === 'chats' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
            >Chats ({chats.length})</button>
            <button
              onClick={() => setListTab('runs')}
              className={`text-xs px-2 py-1 rounded ${listTab === 'runs' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
            >Runs ({standaloneRuns.length})</button>
            <div className="ml-auto flex items-center gap-1">
              {listTab === 'chats' && (
                <button
                  onClick={handleNewChat}
                  className="text-xs px-2 py-1 rounded bg-violet-900 hover:bg-violet-800 text-violet-100"
                >+ New</button>
              )}
              <button
                onClick={listTab === 'chats' ? refreshChats : refreshRuns}
                className="text-xs text-zinc-500 hover:text-zinc-300"
              >↻</button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto">
            {listTab === 'chats' ? (
              chats.length === 0 ? (
                <p className="text-xs text-zinc-600 p-3">No chats yet. Start a new one or promote a run.</p>
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
                        <div className="text-xs text-zinc-200 line-clamp-1 mb-1">{c.title || '(untitled)'}</div>
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
              standaloneRuns.length === 0 ? (
                <p className="text-xs text-zinc-600 p-3">No standalone runs yet.</p>
              ) : (
                <ul>
                  {standaloneRuns.map(r => (
                    <li key={r.id}>
                      <button
                        onClick={() => selectRun(r)}
                        className={`w-full text-left px-3 py-2 border-b border-zinc-900 ${
                          selection?.kind === 'run' && selection.id === r.id ? 'bg-zinc-800' : 'hover:bg-zinc-900'
                        }`}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <StatusBadge status={r.status} />
                          <span className="text-xs uppercase tracking-wider text-zinc-500">{r.mode}</span>
                          <span className="text-xs text-zinc-600 ml-auto">{relTime(r.createdAt)}</span>
                        </div>
                        <p className="text-xs text-zinc-300 line-clamp-2 mb-1">{r.instructions || '(empty)'}</p>
                        <div className="flex items-center gap-3 text-[10px] text-zinc-500 font-mono">
                          <span>{liveDuration(r, now) ?? '—'}</span>
                          <span>{r.totalCostUsd != null ? `$${r.totalCostUsd.toFixed(4)}` : '—'}</span>
                          {tokensSummary(r) && <span className="text-zinc-600">{tokensSummary(r)}</span>}
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
                await developersApi.updateChatTitle(id, activeChat.id, title)
                refreshChats()
                setActiveChat({ ...activeChat, title })
              }}
              detailScrollRef={detailScrollRef}
            />
          ) : selection?.kind === 'run' && activeRun ? (
            <ActiveRunView
              run={activeRun}
              logs={logs}
              expandedLogIds={expandedLogIds}
              onToggleExpand={toggleExpandedLog}
              onCancel={() => handleCancel(activeRun.id)}
              onApprove={() => handleApprove(activeRun.id)}
              onRetry={(withContext) => handleRetry(activeRun.id, withContext)}
              onPromoteToChat={() => handlePromoteToChat(activeRun.id)}
              detailScrollRef={detailScrollRef}
              now={now}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-zinc-600 text-sm text-center px-6">
              <div>
                <p>Pick a chat or run, start a new chat, or dispatch a one-off below.</p>
                <p className="text-xs text-zinc-700 mt-2">Chats keep claude session warm across messages — no commit per turn.</p>
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
                    onChange={e => setMode(e.target.value as DeveloperRunMode)}
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
              value={instructions}
              onChange={e => setInstructions(e.target.value)}
              placeholder={
                selection?.kind === 'chat' ? 'Send a message...' :
                mode === 'implement' ? 'Describe what to build/change. Include STOP criteria + Out of scope + Commit contract + Read-before-write.' :
                mode === 'clarify' ? 'What needs clarifying? Dev will read code and ask, not edit.' :
                'Multi-turn message. Pick "Chat" mode to use it as a fresh chat.'
              }
              disabled={dispatching}
              rows={4}
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
                disabled={dispatching || !instructions.trim() || !developer.online}
                size="sm"
              >
                {dispatching ? 'Sending...' : !developer.online ? 'Developer offline' : selection?.kind === 'chat' ? 'Send' : 'Dispatch'}
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
// Chat thread
// ---------------------------------------------------------------------------

function ChatThread({
  chat, messages, now, onDelete, onRenameTitle, detailScrollRef,
}: {
  chat: DeveloperChat
  messages: DeveloperRun[]
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

function ChatMessage({ message, now }: { message: DeveloperRun; now: number }) {
  return (
    <div className="space-y-1">
      <div className="flex">
        <div className="ml-auto max-w-[70%] bg-zinc-800 rounded-lg px-3 py-2">
          <pre className="text-sm text-zinc-100 whitespace-pre-wrap font-sans">{message.instructions}</pre>
        </div>
      </div>
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
// Run detail
// ---------------------------------------------------------------------------

function ActiveRunView({
  run, logs, expandedLogIds, onToggleExpand, onCancel, onApprove, onRetry, onPromoteToChat, detailScrollRef, now,
}: {
  run: DeveloperRun
  logs: DeveloperLog[]
  expandedLogIds: Set<string>
  onToggleExpand: (logId: string) => void
  onCancel: () => void
  onApprove: () => void
  onRetry: (withContext: boolean) => void
  onPromoteToChat: () => void
  detailScrollRef: React.RefObject<HTMLDivElement | null>
  now: number
}) {
  const isTerminal = TERMINAL_STATUSES.has(run.status)
  const [showAllLogs, setShowAllLogs] = useState(false)
  const visibleLogs = !isTerminal || showAllLogs ? logs : logs.slice(-10)
  const hiddenCount = logs.length - visibleLogs.length
  const usage = (run.trailer?.usage ?? {}) as Record<string, number | undefined>
  const tokensIn = usage.input_tokens
  const tokensOut = usage.output_tokens
  const cacheRead = usage.cache_read_input_tokens
  const cacheWrite = usage.cache_creation_input_tokens
  const canPromote = run.status === 'success' && !!run.sessionId && !run.chatId

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-800 space-y-2">
        <div className="flex items-center gap-3 flex-wrap">
          <StatusBadge status={run.status} />
          <span className="text-xs uppercase tracking-wider text-zinc-500">{run.mode}</span>
          <span className="text-xs text-zinc-600 font-mono">{run.id.slice(0, 8)}</span>
          <span className="text-xs text-zinc-600">{relTime(run.createdAt)}</span>
          {run.parentRunId && (
            <span className="text-xs text-amber-400">retry of {run.parentRunId.slice(0, 8)}</span>
          )}
          {run.pushStatus === 'pushed' && <span className="text-xs text-green-400">pushed</span>}
          {run.pushStatus === 'failed' && <span className="text-xs text-red-400" title={run.pushError ?? ''}>push failed</span>}
          <div className="ml-auto flex items-center gap-2">
            {canPromote && (
              <Button onClick={onPromoteToChat} size="sm" variant="outline">Continue as chat</Button>
            )}
            {run.status === 'pending' && <Button onClick={onApprove} size="sm">Approve</Button>}
            {(run.status === 'pending' || run.status === 'queued') && (
              <Button onClick={onCancel} size="sm" variant="outline">Cancel</Button>
            )}
            {run.status === 'failure' && (
              <>
                <Button onClick={() => onRetry(false)} size="sm" variant="outline">Retry</Button>
                <Button onClick={() => onRetry(true)} size="sm" variant="outline">Continue</Button>
              </>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-1 text-xs">
          <Meta label="model" value={run.model} />
          <Meta label="cost" value={run.totalCostUsd != null ? `$${run.totalCostUsd.toFixed(4)}` : null} />
          <Meta label="duration" value={liveDuration(run, now)} />
          <Meta label="api time" value={formatDuration(run.durationApiMs)} />
          <Meta label="tokens in" value={tokensIn != null ? tokensIn.toLocaleString() : null} />
          <Meta label="tokens out" value={tokensOut != null ? tokensOut.toLocaleString() : null} />
          <Meta label="cache read" value={cacheRead ? cacheRead.toLocaleString() : null} />
          <Meta label="cache write" value={cacheWrite ? cacheWrite.toLocaleString() : null} />
          <Meta label="stop" value={run.stopReason} />
          <Meta label="session" value={run.sessionId ? run.sessionId.slice(0, 8) : null} />
          <Meta label="git start" value={run.gitShaStart ? run.gitShaStart.slice(0, 7) : null} />
          <Meta label="git end" value={run.gitShaEnd ? run.gitShaEnd.slice(0, 7) : null} />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto" ref={detailScrollRef}>
        <Section title="Instructions">
          <pre className="text-sm text-zinc-300 whitespace-pre-wrap font-mono">{run.instructions || '(empty)'}</pre>
        </Section>
        {run.errorMessage && (
          <Section title="Error" tone="error">
            <pre className="text-sm text-red-300 whitespace-pre-wrap font-mono">{run.errorMessage}</pre>
          </Section>
        )}
        {run.pushError && (
          <Section title="Push error" tone="error">
            <pre className="text-sm text-red-300 whitespace-pre-wrap font-mono">{run.pushError}</pre>
          </Section>
        )}
        {run.response && (
          <Section title="Response">
            <div className="prose prose-invert prose-sm max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{run.response}</ReactMarkdown>
            </div>
          </Section>
        )}
        {run.resumeContext && (
          <Section title="Resume context">
            <pre className="text-xs text-zinc-400 whitespace-pre-wrap font-mono">{run.resumeContext}</pre>
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
        {run.trailer && Object.keys(run.trailer).length > 0 && (
          <Section title="Trailer">
            <pre className="text-xs text-zinc-400 whitespace-pre-wrap font-mono">{JSON.stringify(run.trailer, null, 2)}</pre>
          </Section>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Pieces (mirrors oracle page)
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: DeveloperRun['status'] }) {
  const styles: Record<DeveloperRun['status'], string> = {
    pending: 'bg-amber-900 text-amber-200',
    queued: 'bg-blue-900 text-blue-200',
    running: 'bg-violet-900 text-violet-200 animate-pulse',
    success: 'bg-green-900 text-green-200',
    failure: 'bg-red-900 text-red-200',
    cancelled: 'bg-zinc-800 text-zinc-400',
    no_changes: 'bg-zinc-700 text-zinc-300',
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
  log: DeveloperLog
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

function summariseEvent(log: DeveloperLog): string {
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

function liveDuration(run: DeveloperRun, now: number): string | null {
  if (run.durationMs != null) return formatDuration(run.durationMs)
  if (run.status === 'running' && run.startedAt) {
    return formatDuration(now - new Date(run.startedAt).getTime())
  }
  return null
}

function tokensSummary(run: DeveloperRun): string | null {
  const usage = (run.trailer?.usage ?? {}) as Record<string, number | undefined>
  const inT = usage.input_tokens
  const outT = usage.output_tokens
  if (inT == null && outT == null) return null
  const inS = inT != null ? `${(inT / 1000).toFixed(1)}k` : '?'
  const outS = outT != null ? `${(outT / 1000).toFixed(1)}k` : '?'
  return `↑${inS} ↓${outS}`
}

function cacheSummary(run: DeveloperRun): string | null {
  const usage = (run.trailer?.usage ?? {}) as Record<string, number | undefined>
  const read = usage.cache_read_input_tokens
  const write = usage.cache_creation_input_tokens
  if (!read && !write) return null
  const fmt = (n: number | undefined) => n ? (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`) : '0'
  return `cache W${fmt(write)} R${fmt(read)}`
}
