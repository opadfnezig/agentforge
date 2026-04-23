'use client'

import { useEffect, useState, useRef } from 'react'
import { format } from 'date-fns'
import { FileText, Terminal, MessageSquare, AlertCircle, CheckCircle } from 'lucide-react'
import { buildsApi, type AgentLog, type FileChange } from '@/lib/api'

interface StreamViewerProps {
  projectId: string
  buildId: string
  runId: string
}

export function StreamViewer({ projectId, buildId, runId }: StreamViewerProps) {
  const [logs, setLogs] = useState<AgentLog[]>([])
  const [fileChanges, setFileChanges] = useState<FileChange[]>([])
  const [loading, setLoading] = useState(true)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const loadData = async () => {
      try {
        const [logsData, changesData] = await Promise.all([
          buildsApi.getLogs(projectId, buildId, runId),
          buildsApi.getFileChanges(projectId, buildId, runId),
        ])
        setLogs(logsData)
        setFileChanges(changesData)
      } catch (error) {
        console.error('Failed to load logs:', error)
      } finally {
        setLoading(false)
      }
    }

    loadData()

    // Poll for updates
    const interval = setInterval(loadData, 2000)
    return () => clearInterval(interval)
  }, [projectId, buildId, runId])

  // Auto-scroll
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight
    }
  }, [logs])

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        Loading logs...
      </div>
    )
  }

  return (
    <div className="h-full flex">
      {/* Main stream view */}
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto p-4 font-mono text-sm bg-zinc-950"
      >
        {logs.length === 0 ? (
          <div className="text-muted-foreground">Waiting for logs...</div>
        ) : (
          logs.map((log) => <LogEntry key={log.id} log={log} />)
        )}
      </div>

      {/* File changes sidebar */}
      <div className="w-64 border-l bg-card overflow-y-auto">
        <div className="p-4">
          <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
            <FileText className="w-4 h-4" />
            File Changes
          </h3>
          {fileChanges.length === 0 ? (
            <p className="text-sm text-muted-foreground">No changes yet</p>
          ) : (
            <ul className="space-y-2">
              {fileChanges.map((change) => (
                <FileChangeItem key={change.id} change={change} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

function LogEntry({ log }: { log: AgentLog }) {
  const timestamp = format(new Date(log.timestamp), 'HH:mm:ss.SSS')

  const content = (() => {
    switch (log.eventType) {
      case 'thinking':
        return (
          <div className="text-zinc-500 italic">
            {(log.data as any).content || JSON.stringify(log.data)}
          </div>
        )
      case 'tool_use':
        return (
          <div className="text-blue-400">
            <span className="text-blue-600">[{(log.data as any).name || 'tool'}]</span>{' '}
            <pre className="inline whitespace-pre-wrap">
              {JSON.stringify((log.data as any).input || log.data, null, 2)}
            </pre>
          </div>
        )
      case 'tool_result':
        return (
          <div className="text-green-400">
            <Terminal className="inline w-3 h-3 mr-1" />
            <pre className="inline whitespace-pre-wrap text-xs">
              {JSON.stringify((log.data as any).result || log.data, null, 2).slice(0, 500)}
            </pre>
          </div>
        )
      case 'message':
        return (
          <div className="text-zinc-100">
            <MessageSquare className="inline w-3 h-3 mr-1" />
            {(log.data as any).content || (log.data as any).raw || JSON.stringify(log.data)}
          </div>
        )
      case 'error':
        return (
          <div className="text-red-400">
            <AlertCircle className="inline w-3 h-3 mr-1" />
            {(log.data as any).error || JSON.stringify(log.data)}
          </div>
        )
      case 'complete':
        return (
          <div className="text-green-400">
            <CheckCircle className="inline w-3 h-3 mr-1" />
            Task completed
          </div>
        )
      default:
        return (
          <pre className="text-zinc-400 whitespace-pre-wrap">
            {JSON.stringify(log.data, null, 2)}
          </pre>
        )
    }
  })()

  return (
    <div className="mb-2 leading-relaxed">
      <span className="text-zinc-600 mr-2 select-none">{timestamp}</span>
      {content}
    </div>
  )
}

function FileChangeItem({ change }: { change: FileChange }) {
  const icons: Record<string, string> = {
    create: 'text-green-500',
    modify: 'text-yellow-500',
    delete: 'text-red-500',
  }

  return (
    <li className="text-sm">
      <div className={`flex items-center gap-2 ${icons[change.changeType]}`}>
        <span className="text-xs uppercase">{change.changeType[0]}</span>
        <span className="truncate text-foreground" title={change.filePath}>
          {change.filePath.split('/').pop()}
        </span>
      </div>
      <div className="text-xs text-muted-foreground truncate pl-5">
        {change.filePath}
      </div>
    </li>
  )
}
