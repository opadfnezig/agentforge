'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams } from 'next/navigation'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '@/components/ui/button'
import {
  researchersApi,
  type Researcher,
  type ResearcherRun,
  type ResearcherLog,
} from '@/lib/api'

const TERMINAL_STATUSES = new Set(['success', 'failure', 'cancelled'])

export default function ResearcherDetailPage() {
  const params = useParams()
  const id = params.id as string

  const [researcher, setResearcher] = useState<Researcher | null>(null)
  const [runs, setRuns] = useState<ResearcherRun[]>([])
  const [error, setError] = useState<string | null>(null)

  const [instructions, setInstructions] = useState('')
  const [dispatching, setDispatching] = useState(false)
  const [dispatchError, setDispatchError] = useState<string | null>(null)

  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [activeRun, setActiveRun] = useState<ResearcherRun | null>(null)
  const [logs, setLogs] = useState<ResearcherLog[]>([])
  const [expandedLogIds, setExpandedLogIds] = useState<Set<string>>(new Set())

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const logScrollRef = useRef<HTMLDivElement>(null)

  const now = useNow(1000)

  const refreshRuns = useCallback(() => {
    researchersApi.listRuns(id).then(setRuns).catch(() => {})
  }, [id])

  useEffect(() => {
    researchersApi.get(id).then(setResearcher).catch(err => setError(err.message))
    refreshRuns()
  }, [id, refreshRuns])

  useEffect(() => {
    if (logScrollRef.current) {
      logScrollRef.current.scrollTop = logScrollRef.current.scrollHeight
    }
  }, [logs])

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
  }, [])

  const pollRun = useCallback((runId: string) => {
    stopPolling()
    const tick = async () => {
      try {
        const [run, logList] = await Promise.all([
          researchersApi.getRun(id, runId),
          researchersApi.listLogs(id, runId),
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

  useEffect(() => () => stopPolling(), [stopPolling])

  const handleDispatch = async (e: React.FormEvent) => {
    e.preventDefault()
    const text = instructions.trim()
    if (!text || dispatching) return
    setDispatching(true); setDispatchError(null)
    try {
      const { runId } = await researchersApi.dispatch(id, text)
      setActiveRunId(runId)
      setActiveRun(null)
      setLogs([])
      setInstructions('')
      pollRun(runId)
      refreshRuns()
    } catch (err) {
      setDispatchError(err instanceof Error ? err.message : 'Dispatch failed')
    } finally {
      setDispatching(false)
    }
  }

  const handleSelectRun = (r: ResearcherRun) => {
    setActiveRunId(r.id)
    setActiveRun(r)
    setLogs([])
    if (TERMINAL_STATUSES.has(r.status)) {
      stopPolling()
      researchersApi.listLogs(id, r.id).then(setLogs).catch(() => {})
    } else {
      pollRun(r.id)
    }
  }

  const handleCancel = async (runId: string) => {
    try {
      await researchersApi.cancelRun(id, runId)
      refreshRuns()
      if (activeRunId === runId) setActiveRun(await researchersApi.getRun(id, runId))
    } catch (err) { setDispatchError(err instanceof Error ? err.message : 'Cancel failed') }
  }
  const handleApprove = async (runId: string) => {
    try { await researchersApi.approveRun(id, runId); pollRun(runId); refreshRuns() }
    catch (err) { setDispatchError(err instanceof Error ? err.message : 'Approve failed') }
  }
  const handleRetry = async (runId: string, withContext: boolean) => {
    try {
      const child = withContext
        ? await researchersApi.continueRun(id, runId)
        : await researchersApi.retryRun(id, runId)
      setActiveRunId(child.id)
      setActiveRun(child)
      setLogs([])
      pollRun(child.id)
      refreshRuns()
    } catch (err) { setDispatchError(err instanceof Error ? err.message : 'Retry failed') }
  }

  const toggleExpandedLog = (logId: string) => {
    setExpandedLogIds(prev => {
      const next = new Set(prev)
      if (next.has(logId)) next.delete(logId); else next.add(logId)
      return next
    })
  }

  if (error) {
    return <div className="container mx-auto py-16 text-center text-red-400">Failed to load researcher: {error}</div>
  }
  if (!researcher) {
    return <div className="container mx-auto py-16 text-center text-zinc-500">Loading researcher...</div>
  }

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)] bg-zinc-950">
      <div className="border-b border-zinc-800 px-6 py-3 flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${researcher.online ? 'bg-green-500' : 'bg-zinc-600'}`} />
          <h1 className="text-lg font-bold">{researcher.name}</h1>
        </div>
        <span className={`px-2 py-0.5 text-xs font-medium rounded ${
          researcher.status === 'idle' ? 'bg-green-900 text-green-200' :
          researcher.status === 'busy' ? 'bg-violet-900 text-violet-200' :
          researcher.status === 'error' ? 'bg-red-900 text-red-200' :
          'bg-zinc-800 text-zinc-400'
        }`}>{researcher.status}</span>
        {!researcher.online && (
          <span className="ml-auto text-xs text-amber-400">offline — spawn the container</span>
        )}
      </div>

      <div className="flex-1 flex overflow-hidden">
        <div className="w-[22rem] border-r border-zinc-800 flex flex-col">
          <div className="px-3 py-2 border-b border-zinc-800 flex items-center justify-between">
            <span className="text-xs uppercase tracking-wider text-zinc-500">Runs ({runs.length})</span>
            <button onClick={refreshRuns} className="text-xs text-zinc-500 hover:text-zinc-300">↻</button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {runs.length === 0 ? (
              <p className="text-xs text-zinc-600 p-3">No runs yet. Dispatch one below.</p>
            ) : (
              <ul>
                {runs.map(r => (
                  <li key={r.id}>
                    <button
                      onClick={() => handleSelectRun(r)}
                      className={`w-full text-left px-3 py-2 border-b border-zinc-900 ${
                        activeRunId === r.id ? 'bg-zinc-800' : 'hover:bg-zinc-900'
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <StatusBadge status={r.status} />
                        <span className="text-xs text-zinc-600 ml-auto">{relTime(r.createdAt)}</span>
                      </div>
                      <p className="text-xs text-zinc-300 line-clamp-2 mb-1">{r.instructions || '(empty)'}</p>
                      <div className="flex items-center gap-3 text-[10px] text-zinc-500 font-mono">
                        <span>{liveDuration(r, now) ?? '—'}</span>
                        <span>{r.totalCostUsd != null ? `$${r.totalCostUsd.toFixed(4)}` : '—'}</span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="flex-1 flex flex-col">
          {activeRun ? (
            <ActiveRunView
              run={activeRun}
              logs={logs}
              expandedLogIds={expandedLogIds}
              onToggleExpand={toggleExpandedLog}
              onCancel={() => handleCancel(activeRun.id)}
              onApprove={() => handleApprove(activeRun.id)}
              onRetry={(c) => handleRetry(activeRun.id, c)}
              logScrollRef={logScrollRef}
              now={now}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-zinc-600 text-sm">
              Pick a run, or dispatch a new one below.
            </div>
          )}

          <form onSubmit={handleDispatch} className="border-t border-zinc-800 p-3 space-y-2">
            <textarea
              value={instructions}
              onChange={e => setInstructions(e.target.value)}
              placeholder="What should the researcher investigate? Be specific — they write structured articles with sources."
              disabled={dispatching}
              rows={3}
              className="w-full bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-sm font-mono resize-none"
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  handleDispatch(e as unknown as React.FormEvent)
                }
              }}
            />
            {dispatchError && <p className="text-xs text-red-400">{dispatchError}</p>}
            <div className="flex items-center gap-2">
              <Button type="submit" disabled={dispatching || !instructions.trim() || !researcher.online} size="sm">
                {dispatching ? 'Dispatching...' : researcher.online ? 'Dispatch' : 'Researcher offline'}
              </Button>
              <span className="text-xs text-zinc-600">Ctrl+Enter</span>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}

function ActiveRunView({
  run, logs, expandedLogIds, onToggleExpand, onCancel, onApprove, onRetry, logScrollRef, now,
}: {
  run: ResearcherRun
  logs: ResearcherLog[]
  expandedLogIds: Set<string>
  onToggleExpand: (id: string) => void
  onCancel: () => void
  onApprove: () => void
  onRetry: (withContext: boolean) => void
  logScrollRef: React.RefObject<HTMLDivElement | null>
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

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-800 space-y-2">
        <div className="flex items-center gap-3 flex-wrap">
          <StatusBadge status={run.status} />
          <span className="text-xs text-zinc-600 font-mono">{run.id.slice(0, 8)}</span>
          <span className="text-xs text-zinc-600">{relTime(run.createdAt)}</span>
          {run.parentRunId && (
            <span className="text-xs text-amber-400">retry of {run.parentRunId.slice(0, 8)}</span>
          )}
          <div className="ml-auto flex items-center gap-2">
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
          <Meta label="provider" value={run.provider} />
          <Meta label="started" value={run.startedAt ? relTime(run.startedAt) : null} />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto" ref={logScrollRef}>
        <Section title="Instructions">
          <pre className="text-sm text-zinc-300 whitespace-pre-wrap font-mono">{run.instructions || '(empty)'}</pre>
        </Section>
        {run.errorMessage && (
          <Section title="Error" tone="error">
            <pre className="text-sm text-red-300 whitespace-pre-wrap font-mono">{run.errorMessage}</pre>
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
                <button onClick={() => setShowAllLogs(true)}
                  className="text-xs text-zinc-500 hover:text-zinc-300 mb-2">
                  ▸ show {hiddenCount} earlier event{hiddenCount === 1 ? '' : 's'}
                </button>
              )}
              {showAllLogs && isTerminal && logs.length > 10 && (
                <button onClick={() => setShowAllLogs(false)}
                  className="text-xs text-zinc-500 hover:text-zinc-300 mb-2">
                  ▾ collapse to last 10
                </button>
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

function StatusBadge({ status }: { status: ResearcherRun['status'] }) {
  const styles: Record<ResearcherRun['status'], string> = {
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

function Section({ title, tone = 'default', children }: {
  title: string; tone?: 'default' | 'error'; children: React.ReactNode
}) {
  return (
    <div className={`px-4 py-3 border-b border-zinc-900 ${tone === 'error' ? 'bg-red-950/20' : ''}`}>
      <h3 className="text-xs uppercase tracking-wider text-zinc-500 mb-2">{title}</h3>
      {children}
    </div>
  )
}

function LogItem({ log, expanded, onToggle }: {
  log: ResearcherLog; expanded: boolean; onToggle: () => void
}) {
  const summary = summariseEvent(log)
  return (
    <li className="rounded border border-zinc-800 bg-zinc-900/50">
      <button onClick={onToggle}
        className="w-full text-left px-2 py-1 flex items-center gap-2 text-xs hover:bg-zinc-900">
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

function summariseEvent(log: ResearcherLog): string {
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

function liveDuration(run: ResearcherRun, now: number): string | null {
  if (run.durationMs != null) return formatDuration(run.durationMs)
  if (run.status === 'running' && run.startedAt) {
    return formatDuration(now - new Date(run.startedAt).getTime())
  }
  return null
}
