'use client'

import { useState, useEffect, useRef } from 'react'
import { useParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { oraclesApi, type Oracle, type OracleStateFile } from '@/lib/api'

interface ChatMsg {
  role: 'user' | 'assistant'
  content: string
}

export default function OracleDetailPage() {
  const params = useParams()
  const id = params.id as string

  const [oracle, setOracle] = useState<Oracle | null>(null)
  const [stateFiles, setStateFiles] = useState<OracleStateFile[]>([])
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    oraclesApi.get(id).then(setOracle).catch(err => setError(err.message))
    oraclesApi.getState(id).then(res => setStateFiles(res.files)).catch(() => {})
    oraclesApi.getQueries(id).then(queries => {
      setMessages(queries.map(q => ({ role: q.role as 'user' | 'assistant', content: q.content })))
    }).catch(() => {})
  }, [id])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  const handleQuery = async (e: React.FormEvent) => {
    e.preventDefault()
    const text = input.trim()
    if (!text || loading) return

    setMessages(prev => [...prev, { role: 'user', content: text }])
    setInput('')
    setLoading(true)

    try {
      const res = await oraclesApi.query(id, text)
      setMessages(prev => [...prev, { role: 'assistant', content: res.response }])
      // Refresh state after query (oracle may have updated it)
      oraclesApi.getState(id).then(r => setStateFiles(r.files)).catch(() => {})
    } catch (err) {
      setMessages(prev => [
        ...prev,
        { role: 'assistant', content: `Error: ${err instanceof Error ? err.message : 'Query failed'}` },
      ])
    } finally {
      setLoading(false)
    }
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

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)] bg-zinc-950">
      {/* Header */}
      <div className="border-b border-zinc-800 px-6 py-4 flex items-center gap-4">
        <div className="flex-1">
          <h1 className="text-xl font-bold">{oracle.name}</h1>
          <p className="text-sm text-zinc-500">{oracle.domain}</p>
        </div>
        <span className={`px-2 py-0.5 text-xs font-medium text-white rounded ${
          oracle.status === 'active' ? 'bg-green-600' : 'bg-zinc-600'
        }`}>
          {oracle.status}
        </span>
        <span className="px-2 py-0.5 text-xs rounded bg-zinc-800 text-zinc-400">
          {oracle.variant || 'domain'}
        </span>
      </div>

      {/* Two-column layout */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: State viewer */}
        <div className="w-1/2 border-r border-zinc-800 overflow-y-auto p-4 space-y-4">
          <h2 className="text-sm font-semibold text-zinc-400 uppercase tracking-wide">State Files</h2>
          {stateFiles.length === 0 ? (
            <p className="text-sm text-zinc-600">No state files</p>
          ) : (
            stateFiles.map(file => (
              <div key={file.name} className="rounded border border-zinc-800">
                <div className="px-3 py-2 bg-zinc-900 border-b border-zinc-800 text-xs font-mono text-zinc-400">
                  {file.name}
                </div>
                <pre className="p-3 text-sm text-zinc-300 overflow-x-auto font-mono leading-relaxed whitespace-pre-wrap">
                  <code>{file.content}</code>
                </pre>
              </div>
            ))
          )}
        </div>

        {/* Right: Query interface */}
        <div className="w-1/2 flex flex-col">
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
            {messages.length === 0 && (
              <p className="text-center text-zinc-600 py-10 text-sm">
                Query this oracle directly
              </p>
            )}
            {messages.map((msg, i) => (
              <div key={i} className={`max-w-md ${msg.role === 'user' ? 'ml-auto' : 'mr-auto'}`}>
                <div className="text-xs text-zinc-500 mb-1">
                  {msg.role === 'user' ? 'You' : oracle.name}
                </div>
                <div className={`rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                  msg.role === 'user'
                    ? 'bg-zinc-800 text-zinc-100'
                    : 'bg-zinc-900 border border-zinc-800 text-zinc-300'
                }`}>
                  {msg.content}
                </div>
              </div>
            ))}
            {loading && (
              <div className="text-sm text-zinc-500">Thinking...</div>
            )}
          </div>

          <form onSubmit={handleQuery} className="border-t border-zinc-800 p-4 flex gap-3">
            <Input
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="Query this oracle..."
              className="flex-1 bg-zinc-900 border-zinc-700"
              disabled={loading}
            />
            <Button type="submit" disabled={loading || !input.trim()}>
              Send
            </Button>
          </form>
        </div>
      </div>
    </div>
  )
}
