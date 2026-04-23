'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { developersApi, type Developer } from '@/lib/api'

export default function DevelopersPage() {
  const [developers, setDevelopers] = useState<Developer[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [showForm, setShowForm] = useState(false)
  const [formName, setFormName] = useState('')
  const [formWorkspace, setFormWorkspace] = useState('')
  const [formGitRepo, setFormGitRepo] = useState('')
  const [formGitBranch, setFormGitBranch] = useState('main')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const [newSecret, setNewSecret] = useState<{name: string, secret: string} | null>(null)
  const [copied, setCopied] = useState(false)

  const refresh = () => {
    developersApi.list()
      .then(setDevelopers)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false))
  }

  useEffect(() => { refresh() }, [])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!formName.trim() || !formWorkspace.trim()) return
    setCreating(true)
    setCreateError(null)
    try {
      const created = await developersApi.create({
        name: formName.trim(),
        workspacePath: formWorkspace.trim(),
        gitRepo: formGitRepo.trim() || undefined,
        gitBranch: formGitBranch.trim() || 'main',
      })
      setNewSecret({ name: created.name, secret: created.secret })
      setFormName('')
      setFormWorkspace('')
      setFormGitRepo('')
      setFormGitBranch('main')
      setShowForm(false)
      refresh()
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create')
    } finally {
      setCreating(false)
    }
  }

  const handleCopy = async () => {
    if (!newSecret) return
    try {
      await navigator.clipboard.writeText(newSecret.secret)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {}
  }

  if (loading) {
    return (
      <div className="container mx-auto py-16 text-center text-zinc-500">
        Loading developers...
      </div>
    )
  }

  if (error) {
    return (
      <div className="container mx-auto py-16 text-center text-red-400">
        Failed to load developers: {error}
      </div>
    )
  }

  return (
    <div className="container mx-auto py-8 px-4">
      <div className="mb-8 flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-bold">Developers</h1>
          <p className="text-zinc-500 mt-1">Autonomous coding agents dispatched to workspaces</p>
        </div>
        <Button onClick={() => setShowForm(v => !v)}>
          {showForm ? 'Cancel' : 'New Developer'}
        </Button>
      </div>

      {newSecret && (
        <div className="mb-8 p-6 rounded-lg border border-yellow-600 bg-yellow-950/30">
          <div className="flex items-start justify-between mb-2">
            <div>
              <h3 className="font-semibold text-yellow-200">Developer "{newSecret.name}" created</h3>
              <p className="text-sm text-yellow-400/80 mt-1">
                Copy this secret now — it will not be shown again.
              </p>
            </div>
            <button
              onClick={() => setNewSecret(null)}
              className="text-yellow-400 hover:text-yellow-200 text-sm"
            >
              Dismiss
            </button>
          </div>
          <div className="flex gap-2 mt-3">
            <code className="flex-1 px-3 py-2 rounded bg-zinc-950 border border-zinc-800 font-mono text-sm text-zinc-200 break-all">
              {newSecret.secret}
            </code>
            <Button onClick={handleCopy} variant="secondary">
              {copied ? 'Copied!' : 'Copy'}
            </Button>
          </div>
        </div>
      )}

      {showForm && (
        <form
          onSubmit={handleCreate}
          className="mb-8 p-6 rounded-lg border border-zinc-800 bg-zinc-900/50 space-y-4"
        >
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1">Name</label>
            <Input
              value={formName}
              onChange={e => setFormName(e.target.value)}
              placeholder="e.g. worker-01"
              className="bg-zinc-900 border-zinc-700"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1">Workspace Path</label>
            <Input
              value={formWorkspace}
              onChange={e => setFormWorkspace(e.target.value)}
              placeholder="/absolute/path/to/workspace"
              className="bg-zinc-900 border-zinc-700 font-mono"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1">Git Repo (optional)</label>
            <Input
              value={formGitRepo}
              onChange={e => setFormGitRepo(e.target.value)}
              placeholder="https://github.com/owner/repo"
              className="bg-zinc-900 border-zinc-700"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-300 mb-1">Git Branch</label>
            <Input
              value={formGitBranch}
              onChange={e => setFormGitBranch(e.target.value)}
              placeholder="main"
              className="bg-zinc-900 border-zinc-700"
            />
          </div>
          {createError && (
            <p className="text-sm text-red-400">{createError}</p>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={creating}>
              {creating ? 'Creating...' : 'Create Developer'}
            </Button>
            <Button type="button" variant="secondary" onClick={() => setShowForm(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {developers.length === 0 ? (
        <div className="text-center py-16 border border-dashed border-zinc-700 rounded-lg">
          <p className="text-zinc-500">No developers registered yet</p>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {developers.map(dev => (
            <Link
              key={dev.id}
              href={`/developers/${dev.id}`}
              className="block p-6 rounded-lg border border-zinc-800 bg-zinc-900/50 hover:border-zinc-600 transition-colors"
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2 min-w-0">
                  <OnlineDot online={dev.online} />
                  <h3 className="font-semibold text-lg truncate">{dev.name}</h3>
                </div>
                <StatusBadge status={dev.status} />
              </div>
              <p className="text-xs font-mono text-zinc-400 mb-3 truncate" title={dev.workspacePath}>
                {dev.workspacePath}
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="px-2 py-0.5 text-xs rounded bg-zinc-800 text-zinc-400 font-mono">
                  {dev.gitBranch}
                </span>
                {dev.gitRepo && (
                  <span className="px-2 py-0.5 text-xs rounded bg-zinc-800 text-zinc-500 truncate max-w-[10rem]" title={dev.gitRepo}>
                    git
                  </span>
                )}
                <span className={`px-2 py-0.5 text-xs rounded ${dev.online ? 'bg-green-900/40 text-green-400' : 'bg-zinc-800 text-zinc-500'}`}>
                  {dev.online ? 'online' : 'offline'}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

function OnlineDot({ online }: { online: boolean }) {
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full shrink-0 ${online ? 'bg-green-500' : 'bg-zinc-600'}`}
      title={online ? 'Online' : 'Offline'}
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
