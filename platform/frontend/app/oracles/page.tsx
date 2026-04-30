'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { oraclesApi, type Oracle } from '@/lib/api'

export default function OraclesPage() {
  const [oracles, setOracles] = useState<Oracle[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    oraclesApi.list()
      .then(setOracles)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="container mx-auto py-16 text-center text-zinc-500">
        Loading oracles...
      </div>
    )
  }

  if (error) {
    return (
      <div className="container mx-auto py-16 text-center text-red-400">
        Failed to load oracles: {error}
      </div>
    )
  }

  return (
    <div className="container mx-auto py-8 px-4">
      <div className="mb-8">
        <h1 className="text-3xl font-bold">Oracles</h1>
        <p className="text-zinc-500 mt-1">Domain experts that maintain structured knowledge</p>
      </div>

      {oracles.length === 0 ? (
        <div className="text-center py-16 border border-dashed border-zinc-700 rounded-lg">
          <p className="text-zinc-500">No oracles configured yet</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {oracles.map(oracle => (
            <Link
              key={oracle.id}
              href={`/oracles/${oracle.id}`}
              className="block p-6 rounded-lg border border-zinc-800 bg-zinc-900/50 hover:border-zinc-600 transition-colors"
            >
              <div className="flex items-start justify-between mb-3">
                <h3 className="font-semibold text-lg">{oracle.name}</h3>
                <StatusBadge status={oracle.status} />
              </div>
              <p className="text-sm text-zinc-400 mb-4">{oracle.domain}</p>
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${oracle.online ? 'bg-green-500' : 'bg-zinc-600'}`} />
                <span className="text-xs text-zinc-500">{oracle.online ? 'online' : 'offline'}</span>
                {oracle.scopeId && (
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
    active: 'bg-green-600',
    inactive: 'bg-zinc-600',
    error: 'bg-red-600',
    initializing: 'bg-yellow-600',
  }
  return (
    <span className={`px-2 py-0.5 text-xs font-medium text-white rounded ${colors[status] || 'bg-zinc-600'}`}>
      {status}
    </span>
  )
}
