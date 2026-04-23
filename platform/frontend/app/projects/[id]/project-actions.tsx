'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Play, Square, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { projectsApi } from '@/lib/api'

interface ProjectActionsProps {
  projectId: string
  status: string
}

export function ProjectActions({ projectId, status }: ProjectActionsProps) {
  const router = useRouter()
  const { toast } = useToast()
  const [loading, setLoading] = useState<string | null>(null)

  const handleAction = async (action: 'start' | 'stop' | 'rebuild') => {
    setLoading(action)
    try {
      switch (action) {
        case 'start':
          await projectsApi.start(projectId)
          toast({ title: 'Project started', description: 'Containers are running' })
          break
        case 'stop':
          await projectsApi.stop(projectId)
          toast({ title: 'Project stopped', description: 'Containers have been stopped' })
          break
        case 'rebuild':
          await projectsApi.rebuild(projectId)
          toast({ title: 'Project rebuilt', description: 'Containers have been rebuilt' })
          break
      }
      router.refresh()
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Operation failed',
        variant: 'destructive',
      })
    } finally {
      setLoading(null)
    }
  }

  return (
    <div className="flex gap-2">
      {status === 'stopped' || status === 'draft' ? (
        <Button
          size="sm"
          onClick={() => handleAction('start')}
          disabled={loading !== null}
        >
          <Play className="w-4 h-4 mr-2" />
          {loading === 'start' ? 'Starting...' : 'Start'}
        </Button>
      ) : (
        <Button
          size="sm"
          variant="outline"
          onClick={() => handleAction('stop')}
          disabled={loading !== null}
        >
          <Square className="w-4 h-4 mr-2" />
          {loading === 'stop' ? 'Stopping...' : 'Stop'}
        </Button>
      )}
      <Button
        size="sm"
        variant="outline"
        onClick={() => handleAction('rebuild')}
        disabled={loading !== null}
      >
        <RotateCcw className="w-4 h-4 mr-2" />
        {loading === 'rebuild' ? 'Rebuilding...' : 'Rebuild'}
      </Button>
    </div>
  )
}
