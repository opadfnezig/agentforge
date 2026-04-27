'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter, useParams } from 'next/navigation'
import Link from 'next/link'
import { formatDistanceToNow } from 'date-fns'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useToast } from '@/components/ui/toaster'
import {
  spawnersApi,
  type SpawnerHost,
  type Spawn,
  type ProbeResult,
} from '@/lib/api'

export default function SpawnerHostDetailPage() {
  const router = useRouter()
  const params = useParams<{ id: string }>()
  const id = params.id
  const { toast } = useToast()

  const [host, setHost] = useState<SpawnerHost | null>(null)
  const [spawns, setSpawns] = useState<Spawn[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const [editBaseUrl, setEditBaseUrl] = useState('')
  const [editError, setEditError] = useState<string | null>(null)
  const [savingEdit, setSavingEdit] = useState(false)
  const [probing, setProbing] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [h, s] = await Promise.all([
        spawnersApi.get(id),
        spawnersApi.listSpawns(id).catch(() => [] as Spawn[]),
      ])
      setHost(h)
      setSpawns(s)
      if (!editing) {
        setEditName(h.name)
        setEditBaseUrl(h.baseUrl)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [id, editing])

  useEffect(() => {
    refresh()
  }, [refresh])

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!editName.trim() || !editBaseUrl.trim()) return
    try {
      new URL(editBaseUrl.trim())
    } catch {
      setEditError('baseUrl must be a valid URL')
      return
    }
    setSavingEdit(true)
    setEditError(null)
    try {
      const updated = await spawnersApi.update(id, {
        name: editName.trim(),
        baseUrl: editBaseUrl.trim(),
      })
      setHost(updated)
      setEditing(false)
      toast({ title: 'Saved', description: 'Spawner host updated' })
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSavingEdit(false)
    }
  }

  const handleProbe = async () => {
    setProbing(true)
    try {
      const result = await spawnersApi.probe(id)
      toast({
        title: 'Probe: online',
        description: `v${result.status === 'online' ? result.version : ''} · ${result.status === 'online' ? `${result.latencyMs}ms` : ''}`,
      })
      refresh()
    } catch (err) {
      const e = err as Error & { status?: number; code?: string }
      toast({
        title: 'Probe failed',
        description: e.message,
        variant: 'destructive',
      })
      refresh()
    } finally {
      setProbing(false)
    }
  }

  const handleDelete = async () => {
    if (!host) return
    const okMsg = `Delete spawner host "${host.name}"? This also removes ${spawns.length} tracked spawn${spawns.length === 1 ? '' : 's'} and their event history.`
    if (!confirm(okMsg)) return
    setDeleting(true)
    try {
      await spawnersApi.delete(id)
      toast({ title: 'Deleted', description: host.name })
      router.push('/spawners')
    } catch (err) {
      toast({
        title: 'Delete failed',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      })
      setDeleting(false)
    }
  }

  if (loading) {
    return (
      <div className="container mx-auto py-16 text-center text-zinc-500">
        Loading spawner host…
      </div>
    )
  }

  if (error || !host) {
    return (
      <div className="container mx-auto py-16 text-center text-red-400">
        Spawner host not found: {error}
        <div className="mt-4">
          <Link href="/spawners" className="text-zinc-400 hover:text-white underline">
            ← back to spawners
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="container mx-auto py-8 px-4 max-w-4xl">
      <div className="mb-6">
        <Link href="/spawners" className="text-sm text-zinc-500 hover:text-zinc-300">
          ← Spawners
        </Link>
      </div>

      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-3xl font-bold flex items-center gap-3">
            {host.name}
            <SpawnerStatusBadge status={host.status} />
          </h1>
          <p className="font-mono text-violet-400 text-sm mt-1">{host.hostId}</p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button
            onClick={handleProbe}
            disabled={probing}
            variant="secondary"
            size="sm"
          >
            {probing ? 'Probing…' : 'Probe'}
          </Button>
          <Button
            onClick={() => setEditing((v) => !v)}
            variant="secondary"
            size="sm"
          >
            {editing ? 'Cancel edit' : 'Edit'}
          </Button>
        </div>
      </div>

      {editing ? (
        <form
          onSubmit={handleSaveEdit}
          className="mb-8 p-6 rounded-lg border border-zinc-800 bg-zinc-900/50 space-y-4"
        >
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1">Display Name</label>
            <Input
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              className="bg-zinc-900 border-zinc-700"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1">Base URL</label>
            <Input
              value={editBaseUrl}
              onChange={(e) => setEditBaseUrl(e.target.value)}
              className="bg-zinc-900 border-zinc-700 font-mono"
              required
            />
          </div>
          <p className="text-xs text-zinc-500">
            Host ID is immutable — changing it would break the running spawner pushing events here.
          </p>
          {editError && <p className="text-sm text-red-400">{editError}</p>}
          <div className="flex gap-2">
            <Button type="submit" disabled={savingEdit}>
              {savingEdit ? 'Saving…' : 'Save'}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                setEditing(false)
                setEditName(host.name)
                setEditBaseUrl(host.baseUrl)
                setEditError(null)
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="mb-8 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <Field label="Internal ID" value={<code className="text-zinc-500 font-mono text-xs">{host.id}</code>} />
          <Field label="Base URL" value={<code className="font-mono text-zinc-300 break-all">{host.baseUrl}</code>} />
          <Field label="Version" value={host.version ? <code className="font-mono text-zinc-300">{host.version}</code> : <span className="text-zinc-500">unknown</span>} />
          <Field
            label="Capabilities"
            value={
              host.capabilities.length === 0 ? (
                <span className="text-zinc-500">unknown — probe to populate</span>
              ) : (
                <div className="flex gap-1.5 flex-wrap">
                  {host.capabilities.map((c) => (
                    <span key={c} className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 font-mono text-xs">
                      {c}
                    </span>
                  ))}
                </div>
              )
            }
          />
          <Field label="Last seen" value={<TimeAgo iso={host.lastSeenAt} />} />
          <Field label="Last event" value={<TimeAgo iso={host.lastEventAt} />} />
          {host.lastError && (
            <Field
              label="Last error"
              value={<pre className="text-red-400 text-xs whitespace-pre-wrap break-words font-mono">{host.lastError}</pre>}
            />
          )}
        </div>
      )}

      <h2 className="text-xl font-semibold mb-3">
        Spawns <span className="text-zinc-500 text-base">({spawns.length})</span>
      </h2>
      {spawns.length === 0 ? (
        <div className="text-center py-12 border border-dashed border-zinc-700 rounded-lg text-zinc-500">
          No primitives reported yet on this host.
        </div>
      ) : (
        <div className="space-y-2">
          {spawns.map((spawn) => (
            <SpawnRow key={spawn.id} spawn={spawn} />
          ))}
        </div>
      )}

      <div className="mt-12 pt-6 border-t border-zinc-800">
        <h2 className="text-base font-semibold text-red-400 mb-2">Danger zone</h2>
        <Button
          onClick={handleDelete}
          disabled={deleting}
          variant="destructive"
          size="sm"
        >
          {deleting ? 'Deleting…' : 'Delete spawner host'}
        </Button>
        <p className="text-xs text-zinc-500 mt-2">
          Removes the registry entry and all tracked spawns/events. The actual spawner process keeps running — re-register it to resume tracking.
        </p>
      </div>
    </div>
  )
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <span className="text-zinc-500 text-xs uppercase tracking-wide self-center">{label}</span>
      <div>{value}</div>
    </>
  )
}

function TimeAgo({ iso }: { iso: string | null }) {
  if (!iso) return <span className="text-zinc-500">never</span>
  const diff = Date.now() - new Date(iso).getTime()
  const stale = diff > 5 * 60 * 1000
  return (
    <span className={stale ? 'text-amber-400' : 'text-zinc-300'} title={new Date(iso).toISOString()}>
      {formatDistanceToNow(new Date(iso), { addSuffix: true })}
    </span>
  )
}

function SpawnRow({ spawn }: { spawn: Spawn }) {
  const stateColors: Record<Spawn['state'], string> = {
    creating: 'text-yellow-400',
    running: 'text-blue-400',
    crashed: 'text-red-400',
    orphaned: 'text-red-400',
    destroyed: 'text-zinc-500',
  }
  return (
    <div className="px-3 py-2 rounded border border-zinc-800 bg-zinc-900/40 flex items-center gap-3 flex-wrap">
      <span className="font-medium text-violet-400">{spawn.primitiveName}</span>
      <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 font-mono text-xs">
        {spawn.primitiveKind}
      </span>
      <span className={`text-sm font-medium ${stateColors[spawn.state] || 'text-zinc-400'}`}>
        {spawn.state}
      </span>
      {spawn.prevState && (
        <span className="text-zinc-500 text-xs font-mono">
          (was {spawn.prevState})
        </span>
      )}
      <span className="text-zinc-500 text-xs ml-auto">
        <TimeAgo iso={spawn.lastEventAt} />
      </span>
    </div>
  )
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
