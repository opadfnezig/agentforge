'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { formatDistanceToNow } from 'date-fns'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { spawnersApi, type SpawnerHost } from '@/lib/api'

export default function SpawnersPage() {
  const [hosts, setHosts] = useState<SpawnerHost[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [showForm, setShowForm] = useState(false)
  const [formHostId, setFormHostId] = useState('')
  const [formName, setFormName] = useState('')
  const [formBaseUrl, setFormBaseUrl] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const refresh = () => {
    spawnersApi
      .list()
      .then(setHosts)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    refresh()
  }, [])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!formHostId.trim() || !formName.trim() || !formBaseUrl.trim()) return
    try {
      // Catch obvious URL issues client-side; backend Zod will catch the rest.
      new URL(formBaseUrl.trim())
    } catch {
      setCreateError('baseUrl must be a valid URL (e.g. http://10.0.5.7:9898)')
      return
    }
    setCreating(true)
    setCreateError(null)
    try {
      await spawnersApi.create({
        hostId: formHostId.trim(),
        name: formName.trim(),
        baseUrl: formBaseUrl.trim(),
      })
      setFormHostId('')
      setFormName('')
      setFormBaseUrl('')
      setShowForm(false)
      refresh()
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create')
    } finally {
      setCreating(false)
    }
  }

  if (loading) {
    return (
      <div className="container mx-auto py-16 text-center text-zinc-500">
        Loading spawner hosts…
      </div>
    )
  }

  if (error) {
    return (
      <div className="container mx-auto py-16 text-center text-red-400">
        Failed to load spawner hosts: {error}
      </div>
    )
  }

  return (
    <div className="container mx-auto py-8 px-4">
      <div className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold">Spawner Hosts</h1>
          <p className="text-zinc-500 mt-1">
            Hosts running the ntfr-spawner that creates developer / researcher / oracle primitives
          </p>
        </div>
        <Button onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Cancel' : 'New Spawner Host'}
        </Button>
      </div>

      {showForm && (
        <form
          onSubmit={handleCreate}
          className="mb-8 p-6 rounded-lg border border-zinc-800 bg-zinc-900/50 space-y-4"
        >
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1">Host ID</label>
            <Input
              value={formHostId}
              onChange={(e) => setFormHostId(e.target.value)}
              placeholder="e.g. host-eu-1 (must match NTFR_HOST_ID on the spawner)"
              className="bg-zinc-900 border-zinc-700 font-mono"
              required
            />
            <p className="text-xs text-zinc-500 mt-1">
              Identifier the spawner uses when pushing lifecycle events. Must match the spawner's
              <code className="mx-1 px-1 py-0.5 bg-zinc-800 rounded">NTFR_HOST_ID</code> env. Immutable after creation.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1">Display Name</label>
            <Input
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="EU 1"
              className="bg-zinc-900 border-zinc-700"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1">Base URL</label>
            <Input
              value={formBaseUrl}
              onChange={(e) => setFormBaseUrl(e.target.value)}
              placeholder="http://10.0.5.7:9898"
              className="bg-zinc-900 border-zinc-700 font-mono"
              required
            />
            <p className="text-xs text-zinc-500 mt-1">
              How the backend reaches the spawner. Default port is 9898.
            </p>
          </div>
          {createError && <p className="text-sm text-red-400">{createError}</p>}
          <div className="flex gap-2">
            <Button type="submit" disabled={creating}>
              {creating ? 'Creating…' : 'Create Spawner Host'}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {hosts.length === 0 ? (
        <div className="text-center py-16 border border-dashed border-zinc-700 rounded-lg">
          <p className="text-zinc-500">No spawner hosts registered yet</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {hosts.map((host) => (
            <Link
              key={host.id}
              href={`/spawners/${host.id}`}
              className="block p-6 rounded-lg border border-zinc-800 bg-zinc-900/50 hover:border-zinc-600 transition-colors"
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2 min-w-0">
                  <StatusDot status={host.status} />
                  <h3 className="font-semibold text-lg truncate">{host.name}</h3>
                </div>
                <SpawnerStatusBadge status={host.status} />
              </div>
              <p
                className="text-xs font-mono text-violet-400 mb-1 truncate"
                title={host.hostId}
              >
                {host.hostId}
              </p>
              <p
                className="text-xs font-mono text-zinc-400 mb-3 truncate"
                title={host.baseUrl}
              >
                {host.baseUrl}
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                {host.version && (
                  <span className="px-2 py-0.5 text-xs rounded bg-zinc-800 text-zinc-400 font-mono">
                    v{host.version}
                  </span>
                )}
                {host.capabilities.map((cap) => (
                  <span
                    key={cap}
                    className="px-2 py-0.5 text-xs rounded bg-zinc-800 text-zinc-500 font-mono"
                  >
                    {cap}
                  </span>
                ))}
                <LastSeenBadge lastSeenAt={host.lastSeenAt} />
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

function StatusDot({ status }: { status: SpawnerHost['status'] }) {
  const cls =
    status === 'online'
      ? 'bg-green-500'
      : status === 'error'
      ? 'bg-red-500'
      : status === 'offline'
      ? 'bg-zinc-600'
      : 'bg-zinc-500' // unknown
  return <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${cls}`} />
}

function SpawnerStatusBadge({ status }: { status: SpawnerHost['status'] }) {
  const colors: Record<SpawnerHost['status'], string> = {
    online: 'bg-green-600',
    offline: 'bg-zinc-600',
    error: 'bg-red-600',
    unknown: 'bg-zinc-700',
  }
  return (
    <span
      className={`px-2 py-0.5 text-xs font-medium text-white rounded ${colors[status] || 'bg-zinc-600'}`}
    >
      {status}
    </span>
  )
}

function LastSeenBadge({ lastSeenAt }: { lastSeenAt: string | null }) {
  if (!lastSeenAt) {
    return <span className="text-xs text-zinc-500">never seen</span>
  }
  const diff = Date.now() - new Date(lastSeenAt).getTime()
  const stale = diff > 5 * 60 * 1000
  const cls = stale ? 'text-amber-400' : 'text-zinc-400'
  return (
    <span className={`text-xs ${cls}`} title={new Date(lastSeenAt).toISOString()}>
      {formatDistanceToNow(new Date(lastSeenAt), { addSuffix: true })}
    </span>
  )
}
