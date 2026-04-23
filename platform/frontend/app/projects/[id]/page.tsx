import Link from 'next/link'
import { ArrowLeft, Play, Square, RotateCcw, GitBranch, Code, Layers, Settings, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ProjectActions } from './project-actions'

async function getProject(id: string) {
  const res = await fetch(`http://backend:3001/api/projects/${id}`, {
    cache: 'no-store',
  })
  if (!res.ok) return null
  return res.json()
}

async function getServices(projectId: string) {
  const res = await fetch(`http://backend:3001/api/projects/${projectId}/services`, {
    cache: 'no-store',
  })
  if (!res.ok) return []
  return res.json()
}

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [project, services] = await Promise.all([
    getProject(id),
    getServices(id),
  ])

  if (!project) {
    return (
      <div className="container mx-auto py-8 px-4">
        <h1 className="text-2xl font-bold">Project not found</h1>
      </div>
    )
  }

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="border-b bg-card">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Link href="/" className="text-muted-foreground hover:text-foreground">
                <ArrowLeft className="w-5 h-5" />
              </Link>
              <div>
                <h1 className="text-xl font-semibold">{project.name}</h1>
                <p className="text-sm text-muted-foreground">{project.slug}</p>
              </div>
              <StatusBadge status={project.status} />
            </div>
            <ProjectActions projectId={project.id} status={project.status} />
          </div>
        </div>
      </header>

      {/* Navigation */}
      <nav className="border-b bg-card/50">
        <div className="container mx-auto px-4">
          <div className="flex gap-1">
            <NavLink href={`/projects/${project.id}`} active>
              <Layers className="w-4 h-4" />
              Overview
            </NavLink>
            <NavLink href={`/projects/${project.id}/dag`}>
              <GitBranch className="w-4 h-4" />
              DAG Editor
            </NavLink>
            <NavLink href={`/projects/${project.id}/services`}>
              <Code className="w-4 h-4" />
              Services
            </NavLink>
            <NavLink href={`/projects/${project.id}/build`}>
              <Play className="w-4 h-4" />
              Builds
            </NavLink>
            <NavLink href={`/projects/${project.id}/editor`}>
              <Terminal className="w-4 h-4" />
              Editor
            </NavLink>
            <NavLink href={`/projects/${project.id}/settings`}>
              <Settings className="w-4 h-4" />
              Settings
            </NavLink>
          </div>
        </div>
      </nav>

      {/* Content */}
      <main className="container mx-auto px-4 py-8">
        <div className="grid gap-6 md:grid-cols-2">
          {/* Project Info */}
          <div className="p-6 border rounded-lg bg-card">
            <h2 className="font-semibold mb-4">Project Details</h2>
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Status</dt>
                <dd><StatusBadge status={project.status} /></dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Slug</dt>
                <dd className="font-mono">{project.slug}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Services</dt>
                <dd>{services.length}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Created</dt>
                <dd>{new Date(project.createdAt).toLocaleDateString()}</dd>
              </div>
            </dl>
          </div>

          {/* Services */}
          <div className="p-6 border rounded-lg bg-card">
            <div className="flex justify-between items-center mb-4">
              <h2 className="font-semibold">Services</h2>
              <Link href={`/projects/${project.id}/services`}>
                <Button variant="outline" size="sm">Manage</Button>
              </Link>
            </div>
            {services.length === 0 ? (
              <p className="text-sm text-muted-foreground">No services yet</p>
            ) : (
              <ul className="space-y-2">
                {services.slice(0, 5).map((service: any) => (
                  <li key={service.id} className="flex items-center justify-between text-sm">
                    <span className="font-medium">{service.name}</span>
                    <span className="text-muted-foreground">{service.template}</span>
                  </li>
                ))}
                {services.length > 5 && (
                  <li className="text-sm text-muted-foreground">
                    +{services.length - 5} more
                  </li>
                )}
              </ul>
            )}
          </div>

          {/* Quick Actions */}
          <div className="p-6 border rounded-lg bg-card md:col-span-2">
            <h2 className="font-semibold mb-4">Quick Actions</h2>
            <div className="flex flex-wrap gap-3">
              <Link href={`/projects/${project.id}/dag`}>
                <Button variant="outline">
                  <GitBranch className="w-4 h-4 mr-2" />
                  Edit DAG
                </Button>
              </Link>
              <Link href={`/projects/${project.id}/build`}>
                <Button variant="outline">
                  <Play className="w-4 h-4 mr-2" />
                  Start Build
                </Button>
              </Link>
              <Link href={`/projects/${project.id}/services`}>
                <Button variant="outline">
                  <Code className="w-4 h-4 mr-2" />
                  Add Service
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    draft: 'bg-zinc-500',
    building: 'bg-yellow-500',
    ready: 'bg-green-500',
    error: 'bg-red-500',
    stopped: 'bg-zinc-600',
  }

  return (
    <span className={`px-2 py-1 text-xs font-medium text-white rounded ${colors[status] || 'bg-zinc-500'}`}>
      {status}
    </span>
  )
}

function NavLink({ href, children, active = false }: { href: string; children: React.ReactNode; active?: boolean }) {
  return (
    <Link
      href={href}
      className={`inline-flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
        active
          ? 'border-primary text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted'
      }`}
    >
      {children}
    </Link>
  )
}
