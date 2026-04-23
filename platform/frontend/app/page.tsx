import Link from 'next/link'

async function getOracles() {
  try {
    const res = await fetch('http://backend:3001/api/oracles', { cache: 'no-store' })
    if (!res.ok) return []
    return res.json()
  } catch {
    return []
  }
}

async function getDevelopers() {
  try {
    const res = await fetch('http://backend:3001/api/developers', { cache: 'no-store' })
    if (!res.ok) return []
    return res.json()
  } catch {
    return []
  }
}

export default async function DashboardPage() {
  const [oracles, developers] = await Promise.all([getOracles(), getDevelopers()])

  return (
    <div className="container mx-auto py-12 px-4 max-w-4xl">
      <div className="mb-12">
        <h1 className="text-4xl font-bold tracking-tight">AgentForge</h1>
        <p className="text-zinc-500 mt-2">Oracle / Coordinator system for structured AI knowledge</p>
      </div>

      {/* Coordinator */}
      <Link
        href="/coordinator"
        className="block p-8 rounded-lg border border-zinc-800 bg-zinc-900/50 hover:border-zinc-600 transition-colors mb-8"
      >
        <h2 className="text-2xl font-semibold mb-2">Coordinator Chat</h2>
        <p className="text-zinc-400">
          Ask questions that get routed to the right oracles. The coordinator synthesizes responses across domains.
        </p>
      </Link>

      {/* Oracles summary */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Oracles</h2>
          <Link href="/oracles" className="text-sm text-zinc-400 hover:text-white transition-colors">
            View all
          </Link>
        </div>

        {oracles.length === 0 ? (
          <div className="text-center py-10 border border-dashed border-zinc-700 rounded-lg">
            <p className="text-zinc-500">No oracles configured</p>
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {oracles.slice(0, 6).map((oracle: any) => (
              <Link
                key={oracle.id}
                href={`/oracles/${oracle.id}`}
                className="flex items-center justify-between p-4 rounded-lg border border-zinc-800 hover:border-zinc-600 transition-colors"
              >
                <div>
                  <p className="font-medium">{oracle.name}</p>
                  <p className="text-xs text-zinc-500">{oracle.domain}</p>
                </div>
                <span className={`px-2 py-0.5 text-xs font-medium text-white rounded ${
                  oracle.status === 'active' ? 'bg-green-600' : 'bg-zinc-600'
                }`}>
                  {oracle.status}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Developers summary */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Developers</h2>
          <Link href="/developers" className="text-sm text-zinc-400 hover:text-white transition-colors">
            View all
          </Link>
        </div>

        {developers.length === 0 ? (
          <div className="text-center py-10 border border-dashed border-zinc-700 rounded-lg">
            <p className="text-zinc-500">No developers registered</p>
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {developers.slice(0, 6).map((dev: any) => (
              <Link
                key={dev.id}
                href={`/developers/${dev.id}`}
                className="flex items-center justify-between p-4 rounded-lg border border-zinc-800 hover:border-zinc-600 transition-colors"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${dev.online ? 'bg-green-500' : 'bg-zinc-600'}`} />
                  <div className="min-w-0">
                    <p className="font-medium truncate">{dev.name}</p>
                    <p className="text-xs text-zinc-500 font-mono truncate">{dev.workspacePath}</p>
                  </div>
                </div>
                <span className={`px-2 py-0.5 text-xs font-medium text-white rounded shrink-0 ml-2 ${
                  dev.status === 'idle' ? 'bg-green-600'
                    : dev.status === 'busy' ? 'bg-yellow-600'
                    : dev.status === 'error' ? 'bg-red-600'
                    : 'bg-zinc-600'
                }`}>
                  {dev.status}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* System status */}
      <div className="p-6 rounded-lg border border-zinc-800 bg-zinc-900/30">
        <h2 className="text-lg font-semibold mb-3">System Status</h2>
        <div className="grid grid-cols-4 gap-4 text-center">
          <div>
            <p className="text-2xl font-bold">{oracles.length}</p>
            <p className="text-xs text-zinc-500">Oracles</p>
          </div>
          <div>
            <p className="text-2xl font-bold">{oracles.filter((o: any) => o.status === 'active').length}</p>
            <p className="text-xs text-zinc-500">Active</p>
          </div>
          <div>
            <p className="text-2xl font-bold">{developers.length}</p>
            <p className="text-xs text-zinc-500">Developers</p>
          </div>
          <div>
            <p className="text-2xl font-bold text-green-500">
              {developers.filter((d: any) => d.online).length}
            </p>
            <p className="text-xs text-zinc-500">Online</p>
          </div>
        </div>
      </div>
    </div>
  )
}
