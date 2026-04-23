'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Plus, Code, Database, Globe, Cog, ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import { servicesApi, type Service, type CreateService } from '@/lib/api'
import * as Dialog from '@radix-ui/react-dialog'

type TemplateType = 'node' | 'next' | 'python' | 'go' | 'static' | 'database' | 'custom'

const templates: { value: TemplateType; label: string; icon: React.ElementType }[] = [
  { value: 'node', label: 'Node.js', icon: Code },
  { value: 'next', label: 'Next.js', icon: Globe },
  { value: 'python', label: 'Python', icon: Code },
  { value: 'go', label: 'Go', icon: Code },
  { value: 'database', label: 'Database', icon: Database },
  { value: 'custom', label: 'Custom', icon: Cog },
]

export default function ServicesPage() {
  const params = useParams()
  const projectId = params.id as string
  const router = useRouter()
  const { toast } = useToast()

  const [services, setServices] = useState<Service[]>([])
  const [loading, setLoading] = useState(true)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingService, setEditingService] = useState<Service | null>(null)

  useEffect(() => {
    servicesApi.list(projectId).then(setServices).catch(console.error).finally(() => setLoading(false))
  }, [projectId])

  const handleCreate = async (data: CreateService) => {
    try {
      const service = await servicesApi.create(projectId, data)
      setServices((prev) => [...prev, service])
      setDialogOpen(false)
      toast({ title: 'Service created' })
    } catch (error) {
      toast({
        title: 'Error creating service',
        description: error instanceof Error ? error.message : 'Failed',
        variant: 'destructive',
      })
    }
  }

  const handleUpdate = async (serviceId: string, data: Partial<Service>) => {
    try {
      const updated = await servicesApi.update(projectId, serviceId, data)
      setServices((prev) => prev.map((s) => (s.id === serviceId ? updated : s)))
      setEditingService(null)
      toast({ title: 'Service updated' })
    } catch (error) {
      toast({
        title: 'Error updating service',
        description: error instanceof Error ? error.message : 'Failed',
        variant: 'destructive',
      })
    }
  }

  const handleDelete = async (serviceId: string) => {
    if (!confirm('Delete this service?')) return

    try {
      await servicesApi.delete(projectId, serviceId)
      setServices((prev) => prev.filter((s) => s.id !== serviceId))
      toast({ title: 'Service deleted' })
    } catch (error) {
      toast({
        title: 'Error deleting service',
        description: error instanceof Error ? error.message : 'Failed',
        variant: 'destructive',
      })
    }
  }

  if (loading) {
    return <div className="p-8 text-muted-foreground">Loading services...</div>
  }

  return (
    <div className="container mx-auto py-8 px-4">
      <div className="flex justify-between items-center mb-6">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push(`/projects/${projectId}`)}
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Project
          </Button>
          <h1 className="text-2xl font-bold">Services</h1>
        </div>
        <Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
          <Dialog.Trigger asChild>
            <Button>
              <Plus className="w-4 h-4 mr-2" />
              Add Service
            </Button>
          </Dialog.Trigger>
          <ServiceDialog onSubmit={handleCreate} />
        </Dialog.Root>
      </div>

      {services.length === 0 ? (
        <div className="text-center py-16 border border-dashed rounded-lg">
          <Code className="w-12 h-12 mx-auto text-muted-foreground mb-4" />
          <h2 className="text-xl font-semibold mb-2">No services yet</h2>
          <p className="text-muted-foreground mb-4">
            Add services to define your microservices architecture
          </p>
          <Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
            <Dialog.Trigger asChild>
              <Button>
                <Plus className="w-4 h-4 mr-2" />
                Add Service
              </Button>
            </Dialog.Trigger>
            <ServiceDialog onSubmit={handleCreate} />
          </Dialog.Root>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {services.map((service) => (
            <ServiceCard
              key={service.id}
              service={service}
              onEdit={() => setEditingService(service)}
              onDelete={() => handleDelete(service.id)}
            />
          ))}
        </div>
      )}

      {/* Edit dialog */}
      <Dialog.Root open={!!editingService} onOpenChange={(open) => !open && setEditingService(null)}>
        {editingService && (
          <ServiceDialog
            service={editingService}
            onSubmit={(data) => handleUpdate(editingService.id, data)}
          />
        )}
      </Dialog.Root>
    </div>
  )
}

function ServiceCard({
  service,
  onEdit,
  onDelete,
}: {
  service: Service
  onEdit: () => void
  onDelete: () => void
}) {
  const template = templates.find((t) => t.value === service.template)
  const Icon = template?.icon || Code

  return (
    <div className="p-6 border rounded-lg bg-card">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-muted rounded">
            <Icon className="w-5 h-5" />
          </div>
          <div>
            <h3 className="font-semibold">{service.name}</h3>
            <p className="text-sm text-muted-foreground">{template?.label}</p>
          </div>
        </div>
        <StatusBadge status={service.status} />
      </div>

      <div className="mt-4 text-sm text-muted-foreground">
        <p className="truncate">{service.directory}</p>
      </div>

      <div className="mt-4 flex gap-2">
        <Button variant="outline" size="sm" onClick={onEdit}>
          Edit
        </Button>
        <Button variant="outline" size="sm" onClick={onDelete}>
          Delete
        </Button>
      </div>
    </div>
  )
}

function ServiceDialog({
  service,
  onSubmit,
}: {
  service?: Service
  onSubmit: (data: CreateService) => void
}) {
  const [name, setName] = useState(service?.name || '')
  const [template, setTemplate] = useState<TemplateType>(service?.template || 'node')
  const [mdspec, setMdspec] = useState(service?.mdspec || '')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSubmit({ name, template: template as CreateService['template'], mdspec })
  }

  return (
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 bg-black/50" />
      <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-lg bg-card border rounded-lg p-6 max-h-[85vh] overflow-y-auto">
        <Dialog.Title className="text-lg font-semibold mb-4">
          {service ? 'Edit Service' : 'Add Service'}
        </Dialog.Title>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="backend"
              pattern="[a-z0-9-]+"
              required
            />
          </div>

          <div>
            <Label htmlFor="template">Template</Label>
            <select
              id="template"
              value={template}
              onChange={(e) => setTemplate(e.target.value as TemplateType)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              {templates.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <Label htmlFor="mdspec">Specification (mdspec)</Label>
            <Textarea
              id="mdspec"
              value={mdspec}
              onChange={(e) => setMdspec(e.target.value)}
              placeholder="# Service Specification&#10;&#10;Describe what this service should do..."
              rows={10}
              className="font-mono text-sm"
            />
          </div>

          <div className="flex gap-2 justify-end">
            <Dialog.Close asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </Dialog.Close>
            <Button type="submit">{service ? 'Update' : 'Create'}</Button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  )
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: 'bg-zinc-500',
    building: 'bg-yellow-500',
    ready: 'bg-green-500',
    error: 'bg-red-500',
  }

  return (
    <span className={`px-2 py-1 text-xs font-medium text-white rounded ${colors[status] || 'bg-zinc-500'}`}>
      {status}
    </span>
  )
}
