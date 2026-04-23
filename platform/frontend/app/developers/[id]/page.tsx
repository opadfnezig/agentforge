'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { developersApi, type Developer, type DeveloperRun, type DeveloperLog } from '@/lib/api'

const TERMINAL_STATUSES = new Set(['success', 'failure', 'cancelled', 'no_changes'])

export default function DeveloperDetailPage() {
  const params = useParams()
  const id = params.id as string

  const [developer, setDeveloper] = useState<Developer | null>(null)
  const [runs, setRuns] = useState<DeveloperRun[]>([])
  const [error, setError] = useState<string | null>(null)

  const [instructions, setInstructions] = useState('')
  const [mode, setMode] = useState<'implement' | 'clarify'>('implement')
  const [dispatching, setDispatching] = useState(false)
  const [dispatchError, setDispatchError] = useState<string | null>(null)

  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [activeRun, setActiveRun] = useState<DeveloperRun | null>(null)
  const [logs, setLogs] = useState<DeveloperLog[]>([])
  const [copiedSecret, setCopiedSecret] = useState(false)
  const [regenSecret, setRegenSecret] = useState<string | null>(null)

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const logScrollRef = useRef<HTMLDivElement>(null)

  const refreshRuns = useCallback(() => {
    developersApi.listRuns(id).then(setRuns).catch(() => {})
  }, [id])

  useEffect(() => {
    developersApi.get(id).then(setDeveloper).catch(err => setError(err.message))
    refreshRuns()
  }, [id, refreshRuns])

  // Auto-scroll log viewer
  useEffect(() => {
    if (logScrollRef.current) {
      logScrollRef.current.scrollTop = logScrollRef.current.scrollHeight
    }
  }, [logs])

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
      } catch {
        // keep polling; transient errors
      }
    }
    tick()
    pollRef.current = setInterval(tick, 1500)
  }, [id, refreshRuns, stopPolling])

  useEffect(() => {
    return () => stopPolling()
  }, [stopPolling])

  const handleDispatch = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!instructions.trim() || dispatching) return
    setDispatching(true)
    setDispatchError(null)
    try {
      const { runId } = await developersApi.dispatch(id, instructions.trim(), mode)
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

  const viewRun = (runId: string) => {
    setActiveRunId(runId)
    setActiveRun(null)
    setLogs([])
    pollRun(runId)
  }

  const handleRegenSecret = async () => {
    if (!confirm('Regenerate secret? The old secret will stop working.')) return
    try {
      const res = await developersApi.regenerateSecret(id)
      setRegenSecret(res.secret)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to regenerate secret')
    }
  }

  const handleCopySecret = async () => {
    if (!regenSecret) return
    try {
      await navigator.clipboard.writeText(regenSecret)
      setCopiedSecret(true)
      setTimeout(() => setCopiedSecret(false), 2000)
    } catch {}
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
      <div className="container mx-auto py-16 text-center text-zinc-500">
        Loading developer...
      </div>
    )
  }

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)] bg-zinc-950">
      {/* Header */}
      <div className="border-b border-zinc-800 px-6 py-4 flex items-center gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <OnlineDot online={developer.online} />
            <h1 className="text-xl font-bold truncate">{developer.name}</h1>
          </div>
          <p className="text-sm text-zinc-500 font-mono truncate">{developer.workspacePath}</p>
        </div>
        <span className="px-2 py-0.5 text-xs rounded bg-zinc-800 text-zinc-400 font-mono">
          {developer.gitBranch}
        </span>
        <StatusBadge status={developer.status} />
        <Button variant="secondary" size="sm" onClick={handleRegenSecret}>
          Regenerate Secret
        </Button>
      </div>

      {regenSecret && (
        <div className="border-b border-yellow-800 bg-yellow-950/30 px-6 py-3 flex items-center gap-3">
          <p className="text-sm text-yellow-300">New secret (copy now, shown once):</p>
          <code className="flex-1 px-3 py-1 rounded bg-zinc-950 border border-zinc-800 font-mono text-sm text-zinc-200 truncate">
            {regenSecret}
          </code>
          <Button variant="secondary" size="sm" onClick={handleCopySecret}>
            {copiedSecret ? 'Copied!' : 'Copy'}
          </Button>
          <button
            onClick={() => setRegenSecret(null)}
            className="text-yellow-400 hover:text-yellow-200 text-sm"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Two-column layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Info + runs */}
        <div className="w-1/2 border-r border-zinc-800 overflow-y-auto p-4 space-y-4">
          <section>
            <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide mb-2">
              Info
            </h2>
            <dl className="rounded border border-zinc-800 bg-zinc-900/50 text-sm">
              <InfoRow label="ID" value={<code className="font-mono text-xs">{developer.id}</code>} />
              <InfoRow label="Workspace" value={<code className="font-mono text-xs">{developer.workspacePath}</code>} />
              <InfoRow label="Git Branch" value={<code className="font-mono text-xs">{developer.gitBranch}</code>} />
              {developer.gitRepo && (
                <InfoRow label="Git Repo" value={
                  <a href={developer.gitRepo} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline break-all">
                    {developer.gitRepo}
                  </a>
                } />
              )}
              <InfoRow label="Last Heartbeat" value={
                <span className="text-zinc-400">
                  {developer.lastHeartbeat ? new Date(developer.lastHeartbeat).toLocaleString() : 'never'}
                </span>
              } />
            </dl>
          </section>

          <section>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide">
                Runs ({runs.length})
              </h2>
              <button
                onClick={refreshRuns}
                className="text-xs text-zinc-500 hover:text-zinc-300"
              >
                Refresh
              </button>
            </div>
            {runs.length === 0 ? (
              <p className="text-sm text-zinc-600">No runs yet</p>
            ) : (
              <div className="space-y-2">
                {runs.map(run => (
                  <button
                    key={run.id}
                    onClick={() => viewRun(run.id)}
                    className={`w-full text-left rounded border p-3 transition-colors ${
                      activeRunId === run.id
                        ? 'border-zinc-500 bg-zinc-900'
                        : 'border-zinc-800 bg-zinc-900/30 hover:border-zinc-600'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <RunStatusBadge status={run.status} />
                        <span className="px-1.5 py-0.5 text-xs rounded bg-zinc-800 text-zinc-400">
                          {run.mode}
                        </span>
                      </div>
                      <span className="text-xs text-zinc-500">
                        {formatDuration(run.startedAt, run.finishedAt)}
                      </span>
                    </div>
                    <p className="text-sm text-zinc-300 truncate">{run.instructions}</p>
                    <div className="flex items-center gap-2 mt-1 text-xs text-zinc-500 font-mono">
                      {run.gitShaStart && <span>{run.gitShaStart.slice(0, 7)}</span>}
                      {run.gitShaStart && run.gitShaEnd && <span>→</span>}
                      {run.gitShaEnd && <span>{run.gitShaEnd.slice(0, 7)}</span>}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* Right: Dispatch + live logs */}
        <div className="w-1/2 flex flex-col">
          <form onSubmit={handleDispatch} className="border-b border-zinc-800 p-4 space-y-3">
            <div>
              <label className="block text-sm font-medium text-zinc-300 mb-1">Instructions</label>
              <textarea
                value={instructions}
                onChange={e => setInstructions(e.target.value)}
                placeholder="Describe the task for the developer agent..."
                className="w-full min-h-[120px] rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500 font-mono"
                disabled={dispatching}
              />
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-900 p-1">
                <ModeButton
                  active={mode === 'implement'}
                  onClick={() => setMode('implement')}
                  label="Implement"
                />
                <ModeButton
                  active={mode === 'clarify'}
                  onClick={() => setMode('clarify')}
                  label="Clarify"
                />
              </div>
              <Button type="submit" disabled={dispatching || !instructions.trim()}>
                {dispatching ? 'Dispatching...' : 'Dispatch'}
              </Button>
            </div>
            {dispatchError && <p className="text-sm text-red-400">{dispatchError}</p>}
          </form>

          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="px-4 py-2 border-b border-zinc-800 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide">
                {activeRunId ? 'Run Stream' : 'Latest Run'}
              </h2>
              {activeRun && (
                <div className="flex items-center gap-2">
                  <RunStatusBadge status={activeRun.status} />
                  <span className="text-xs text-zinc-500">
                    {logs.length} event{logs.length === 1 ? '' : 's'}
                  </span>
                </div>
              )}
            </div>

            <div ref={logScrollRef} className="flex-1 overflow-y-auto p-4 space-y-2">
              {!activeRunId && (
                <p className="text-sm text-zinc-600 text-center py-10">
                  Dispatch a task or select a run to view its log stream
                </p>
              )}
              {activeRunId && logs.length === 0 && (
                <p className="text-sm text-zinc-600">Waiting for events...</p>
              )}
              {logs.map(log => (
                <LogEntry key={log.id} log={log} />
              ))}
              {activeRun && TERMINAL_STATUSES.has(activeRun.status) && (
                <RunSummary run={activeRun} developer={developer} />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex border-b border-zinc-800 last:border-b-0 px-3 py-2">
      <dt className="w-32 text-zinc-500 shrink-0">{label}</dt>
      <dd className="flex-1 min-w-0 text-zinc-200 break-all">{value}</dd>
    </div>
  )
}

function ModeButton({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
        active ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'
      }`}
    >
      {label}
    </button>
  )
}

function OnlineDot({ online }: { online: boolean }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${online ? 'bg-green-500' : 'bg-zinc-600'}`}
    />
  )
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    idle: 'bg-green-600',
    busy: 'bg-yellow-600',
    error: 'bg-red-600',
    offline: 'bg-zinc-600',
  }
  return (
    <span className={`px-2 py-0.5 text-xs font-medium text-white rounded ${colors[status] || 'bg-zinc-600'}`}>
      {status}
    </span>
  )
}

function RunStatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: 'bg-zinc-600',
    running: 'bg-yellow-600',
    success: 'bg-green-600',
    failure: 'bg-red-600',
    cancelled: 'bg-zinc-600',
    no_changes: 'bg-blue-600',
  }
  return (
    <span className={`px-1.5 py-0.5 text-xs font-medium text-white rounded ${colors[status] || 'bg-zinc-600'}`}>
      {status}
    </span>
  )
}

const EVENT_ICONS: Record<string, string> = {
  thinking: '·',
  tool_use: '>',
  tool_result: '<',
  message: '=',
  error: '!',
  complete: 'o',
  init: '+',
}

const EVENT_COLORS: Record<string, string> = {
  thinking: 'text-zinc-500',
  tool_use: 'text-blue-400',
  tool_result: 'text-cyan-400',
  message: 'text-zinc-200',
  error: 'text-red-400',
  complete: 'text-green-400',
  init: 'text-zinc-400',
}

function LogEntry({ log }: { log: DeveloperLog }) {
  const icon = EVENT_ICONS[log.eventType] || '-'
  const color = EVENT_COLORS[log.eventType] || 'text-zinc-400'
  const text = extractLogText(log)
  return (
    <div className="flex gap-2 text-sm font-mono leading-relaxed">
      <span className={`${color} shrink-0 w-4 text-center`}>{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <span>{log.eventType}</span>
          <span>{new Date(log.timestamp).toLocaleTimeString()}</span>
        </div>
        {text && (
          <pre className={`whitespace-pre-wrap break-words text-sm ${color}`}>
            {text}
          </pre>
        )}
      </div>
    </div>
  )
}

function extractLogText(log: DeveloperLog): string {
  const d = log.data as Record<string, unknown>
  if (!d) return ''
  if (typeof d.text === 'string') return d.text
  if (typeof d.content === 'string') return d.content
  if (typeof d.message === 'string') return d.message
  if (typeof d.name === 'string') {
    const input = d.input ? `\n${JSON.stringify(d.input, null, 2)}` : ''
    return `${d.name}${input}`
  }
  if (typeof d.output === 'string') return d.output
  try {
    return JSON.stringify(d, null, 2)
  } catch {
    return ''
  }
}

function RunSummary({ run, developer }: { run: DeveloperRun; developer: Developer }) {
  const diffUrl = run.gitShaStart && run.gitShaEnd && developer.gitRepo
    ? buildDiffUrl(developer.gitRepo, run.gitShaStart, run.gitShaEnd)
    : null
  return (
    <div className="mt-4 p-3 rounded border border-zinc-700 bg-zinc-900">
      <div className="flex items-center gap-2 mb-2">
        <RunStatusBadge status={run.status} />
        <span className="text-xs text-zinc-500">
          {formatDuration(run.startedAt, run.finishedAt)}
        </span>
      </div>
      {run.response && (
        <pre className="text-sm text-zinc-300 whitespace-pre-wrap font-mono mb-2">
          {run.response}
        </pre>
      )}
      {run.errorMessage && (
        <pre className="text-sm text-red-400 whitespace-pre-wrap font-mono mb-2">
          {run.errorMessage}
        </pre>
      )}
      {(run.gitShaStart || run.gitShaEnd) && (
        <div className="flex items-center gap-2 text-xs font-mono text-zinc-500">
          {run.gitShaStart && <span>{run.gitShaStart.slice(0, 7)}</span>}
          {run.gitShaStart && run.gitShaEnd && <span>→</span>}
          {run.gitShaEnd && <span>{run.gitShaEnd.slice(0, 7)}</span>}
          {diffUrl && (
            <a href={diffUrl} target="_blank" rel="noreferrer" className="text-blue-400 hover:underline ml-2">
              View diff
            </a>
          )}
        </div>
      )}
    </div>
  )
}

function buildDiffUrl(gitRepo: string, start: string, end: string): string | null {
  // Convert SSH/HTTPS git URLs to github-style compare URLs when possible
  let base = gitRepo.trim().replace(/\.git$/, '')
  if (base.startsWith('git@github.com:')) {
    base = 'https://github.com/' + base.slice('git@github.com:'.length)
  }
  if (/github\.com/i.test(base)) {
    return `${base}/compare/${start}...${end}`
  }
  if (/gitlab\.com/i.test(base)) {
    return `${base}/-/compare/${start}...${end}`
  }
  if (/bitbucket\.org/i.test(base)) {
    return `${base}/branches/compare/${end}..${start}`
  }
  return null
}

function formatDuration(startedAt: string | null, finishedAt: string | null): string {
  if (!startedAt) return '—'
  const start = new Date(startedAt).getTime()
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now()
  const ms = Math.max(0, end - start)
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return `${m}m ${rem}s`
}
