'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Loader2, Play, Square, RefreshCw, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { editorApi, projectsApi } from '@/lib/api'
import { useToast } from '@/components/ui/use-toast'

export default function EditorPage() {
  const params = useParams()
  const router = useRouter()
  const { toast } = useToast()
  const projectId = params.id as string

  const [projectName, setProjectName] = useState<string>('')
  const [editorUrl, setEditorUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [starting, setStarting] = useState(false)
  const [stopping, setStopping] = useState(false)

  // Load project and check if code-server is running
  useEffect(() => {
    const load = async () => {
      try {
        const project = await projectsApi.get(projectId)
        setProjectName(project.name)

        // Check if code-server is already running
        try {
          const { url } = await editorApi.getUrl(projectId)
          setEditorUrl(url)
        } catch {
          // Not running, that's fine
          setEditorUrl(null)
        }
      } catch (err) {
        console.error('Failed to load project:', err)
        toast({
          title: 'Failed to load project',
          description: err instanceof Error ? err.message : 'Unknown error',
          variant: 'destructive',
        })
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [projectId, toast])

  const handleStart = useCallback(async () => {
    setStarting(true)
    try {
      const { url } = await editorApi.start(projectId)
      setEditorUrl(url)
      toast({ title: 'Code editor started' })
    } catch (err) {
      toast({
        title: 'Failed to start editor',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      })
    } finally {
      setStarting(false)
    }
  }, [projectId, toast])

  const handleStop = useCallback(async () => {
    setStopping(true)
    try {
      await editorApi.stop(projectId)
      setEditorUrl(null)
      toast({ title: 'Code editor stopped' })
    } catch (err) {
      toast({
        title: 'Failed to stop editor',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      })
    } finally {
      setStopping(false)
    }
  }, [projectId, toast])

  const handleRefresh = useCallback(() => {
    const iframe = document.getElementById('code-server-iframe') as HTMLIFrameElement
    if (iframe && editorUrl) {
      iframe.src = editorUrl
    }
  }, [editorUrl])

  const handleOpenExternal = useCallback(() => {
    if (editorUrl) {
      window.open(editorUrl, '_blank')
    }
  }, [editorUrl])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="border-b bg-card flex-shrink-0">
        <div className="px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link
              href={`/projects/${projectId}`}
              className="text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="w-5 h-5" />
            </Link>
            <div>
              <h1 className="text-lg font-semibold">Code Editor</h1>
              <p className="text-xs text-muted-foreground">{projectName}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {editorUrl && (
              <>
                <Button variant="outline" size="sm" onClick={handleRefresh}>
                  <RefreshCw className="w-4 h-4 mr-1" />
                  Refresh
                </Button>
                <Button variant="outline" size="sm" onClick={handleOpenExternal}>
                  <ExternalLink className="w-4 h-4 mr-1" />
                  Open External
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={handleStop}
                  disabled={stopping}
                >
                  {stopping ? (
                    <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                  ) : (
                    <Square className="w-4 h-4 mr-1" />
                  )}
                  Stop
                </Button>
              </>
            )}
            {!editorUrl && (
              <Button onClick={handleStart} disabled={starting}>
                {starting ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Play className="w-4 h-4 mr-2" />
                )}
                Start Editor
              </Button>
            )}
          </div>
        </div>
      </header>

      {/* Editor Content */}
      <main className="flex-1 relative">
        {editorUrl ? (
          <iframe
            id="code-server-iframe"
            src={editorUrl}
            className="absolute inset-0 w-full h-full border-0"
            title="VS Code Editor"
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center p-8">
            <div className="w-24 h-24 rounded-full bg-muted flex items-center justify-center mb-6">
              <Play className="w-12 h-12 text-muted-foreground" />
            </div>
            <h2 className="text-xl font-semibold mb-2">Code Editor Not Running</h2>
            <p className="text-muted-foreground mb-6 max-w-md">
              Start the code editor to edit project files directly in VS Code.
              The editor includes Claude Code extension for AI-assisted development.
            </p>
            <Button onClick={handleStart} disabled={starting} size="lg">
              {starting ? (
                <Loader2 className="w-5 h-5 mr-2 animate-spin" />
              ) : (
                <Play className="w-5 h-5 mr-2" />
              )}
              Start Code Editor
            </Button>
          </div>
        )}
      </main>
    </div>
  )
}
