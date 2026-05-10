'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { researchersApi, type Researcher } from '@/lib/api'

export default function ResearchersPage() {
  const [researchers, setResearchers] = useState<Researcher[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    researchersApi.list()
      .then(setResearchers)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="container mx-auto py-16 text-center text-zinc-500">
        Loading researchers...
      </div>
    )
  }

  if (error) {
    return (
      <div className="container mx-auto py-16 text-center text-red-400">
        Failed to load researchers: {error}
      </div>
    )
  }

  return (
    <div className="container mx-auto py-8 px-4">
      <div className="mb-8">
        <h1 className="text-3xl font-bold">Researchers</h1>
        <p className="text-zinc-500 mt-1">Web search + analysis agents that produce structured markdown articles</p>
      </div>

      {researchers.length === 0 ? (
        <div className="text-center py-16 border border-dashed border-zinc-700 rounded-lg">
          <p className="text-zinc-500">No researchers configured yet</p>
          <p className="text-zinc-600 text-sm mt-2">Spawn one via the coordinator with{' '}
            <code className="bg-zinc-800 px-1.5 py-0.5 rounded">[spawn, host, &lt;name&gt;-researcher]</code>
          </p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {researchers.map(r => (
            <Link
              key={r.id}
              href={`/researchers/${r.id}`}
              className="block p-6 rounded-lg border border-zinc-800 bg-zinc-900/50 hover:border-zinc-600 transition-colors"
            >
              <div className="flex items-start justify-between mb-3">
                <h3 className="font-semibold text-lg">{r.name}</h3>
                <StatusBadge status={r.status} />
              </div>
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${r.online ? 'bg-green-500' : 'bg-zinc-600'}`} />
                <span className="text-xs text-zinc-500">{r.online ? 'online' : 'offline'}</span>
                {r.scopeId && (
                  <span className="px-2 py-0.5 text-xs rounded bg-zinc-800 text-zinc-500">
                    scoped
                  </span>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    idle: 'bg-green-600',
    busy: 'bg-violet-600',
    offline: 'bg-zinc-600',
    error: 'bg-red-600',
    destroyed: 'bg-zinc-700',
  }
  return (
    <span className={`px-2 py-0.5 text-xs font-medium text-white rounded ${colors[status] || 'bg-zinc-600'}`}>
      {status}
    </span>
  )
}
