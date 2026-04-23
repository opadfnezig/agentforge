'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { Node } from 'reactflow'
import { X, Trash2, Maximize2, Minimize2, ChevronsLeft, GripHorizontal } from 'lucide-react'
import dynamic from 'next/dynamic'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { actionsApi, servicesApi, actionChatApi, actionFilesApi, type Service, type Action, type ChatMessage as ApiChatMessage, type ActionFile } from '@/lib/api'
import { Chat, type ChatMessage } from './Chat'
import { FileBrowser, type FileNode } from './FileBrowser'

// Dynamic import Monaco to avoid SSR issues
const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false })

interface ActionPanelProps {
  node: Node
  projectId: string
  onClose: () => void
  onUpdate: (action: Partial<Action>) => void
  onDelete: (nodeId: string) => void
}

type TabType = 'config' | 'spec' | 'prompt'

// Convert API ActionFile to FileNode for FileBrowser
const toFileNodes = (files: ActionFile[]): FileNode[] => {
  return files.map(f => ({
    name: f.name,
    path: f.name,
    type: f.isDirectory ? 'directory' as const : 'file' as const,
  }))
}

// Convert API ChatMessage to component ChatMessage
const toComponentMessage = (msg: ApiChatMessage): ChatMessage => ({
  id: msg.id,
  role: msg.role,
  content: msg.content,
  timestamp: new Date(msg.createdAt),
  status: 'complete',
})

export function ActionPanel({ node, projectId, onClose, onUpdate, onDelete }: ActionPanelProps) {
  const { toast } = useToast()
  const [name, setName] = useState(node.data.name)
  const [serviceId, setServiceId] = useState<string | null>(node.data.serviceId)
  const [maxRetries, setMaxRetries] = useState(node.data.config?.maxRetries ?? 0)
  const [mdspec, setMdspec] = useState(node.data.mdspec ?? '')
  const [promptTemplate, setPromptTemplate] = useState(node.data.config?.promptTemplate ?? '')
  const [services, setServices] = useState<Service[]>([])
  const [saving, setSaving] = useState(false)
  const [activeTab, setActiveTab] = useState<TabType>('config')

  // Resize state
  const [manualWidth, setManualWidth] = useState(400) // pos1 - drag-set width
  const [isFullExpanded, setIsFullExpanded] = useState(false) // pos2 - 80vw
  const [isDragging, setIsDragging] = useState(false)
  const dragStartX = useRef(0)
  const dragStartWidth = useRef(0)

  // Specification tab split state
  const [editorHeight, setEditorHeight] = useState(200)
  const [isResizingEditor, setIsResizingEditor] = useState(false)
  const editorDragStartY = useRef(0)
  const editorDragStartHeight = useRef(0)

  // Chat state
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])
  const [chatLoading, setChatLoading] = useState(false)

  // Files state
  const [actionFiles, setActionFiles] = useState<FileNode[]>([])
  const [filesLoading, setFilesLoading] = useState(false)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)

  useEffect(() => {
    servicesApi.list(projectId).then(setServices).catch(console.error)
  }, [projectId])

  // Reset state when node changes
  useEffect(() => {
    setName(node.data.name)
    setServiceId(node.data.serviceId)
    setMaxRetries(node.data.config?.maxRetries ?? 0)
    setMdspec(node.data.mdspec ?? '')
    setPromptTemplate(node.data.config?.promptTemplate ?? '')
  }, [node.id, node.data])

  // Load chat messages for this action
  useEffect(() => {
    const loadChat = async () => {
      try {
        const messages = await actionChatApi.list(projectId, node.id)
        setChatMessages(messages.map(toComponentMessage))
      } catch (err) {
        console.error('Failed to load chat:', err)
      }
    }
    loadChat()
  }, [projectId, node.id])

  // Load files for this action
  const loadFiles = useCallback(async () => {
    setFilesLoading(true)
    try {
      const files = await actionFilesApi.list(projectId, node.id)
      setActionFiles(toFileNodes(files))
    } catch (err) {
      console.error('Failed to load files:', err)
    } finally {
      setFilesLoading(false)
    }
  }, [projectId, node.id])

  useEffect(() => {
    loadFiles()
  }, [loadFiles])

  // Chat send handler
  const handleSendMessage = async (content: string) => {
    // Add user message immediately
    const userMessage: ChatMessage = {
      id: `temp-${Date.now()}`,
      role: 'user',
      content,
      timestamp: new Date(),
      status: 'complete',
    }
    setChatMessages(prev => [...prev, userMessage])
    setChatLoading(true)

    try {
      // Save to backend
      const savedUser = await actionChatApi.send(projectId, node.id, { role: 'user', content })

      // Update with real ID
      setChatMessages(prev => prev.map(m =>
        m.id === userMessage.id ? toComponentMessage(savedUser) : m
      ))

      // For now, add a placeholder response
      // TODO: Connect to actual Claude API for responses
      const assistantMessage: ChatMessage = {
        id: `temp-assist-${Date.now()}`,
        role: 'assistant',
        content: 'Chat response feature coming soon. This will connect to Claude to help with your action specification.',
        timestamp: new Date(),
        status: 'complete',
      }
      setChatMessages(prev => [...prev, assistantMessage])

      // Save assistant message
      await actionChatApi.send(projectId, node.id, { role: 'assistant', content: assistantMessage.content })
    } catch (err) {
      toast({
        title: 'Failed to send message',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      })
    } finally {
      setChatLoading(false)
    }
  }

  // File operations
  const handleCreateFile = async (path: string) => {
    try {
      const name = path.split('/').pop() || path
      await actionFilesApi.create(projectId, node.id, { name, content: '' })
      await loadFiles()
      toast({ title: 'File created' })
    } catch (err) {
      toast({
        title: 'Failed to create file',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      })
    }
  }

  const handleDeleteFile = async (path: string) => {
    try {
      await actionFilesApi.delete(projectId, node.id, path)
      await loadFiles()
      toast({ title: 'File deleted' })
    } catch (err) {
      toast({
        title: 'Failed to delete file',
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      })
    }
  }

  // Editor vertical resize handlers
  const handleEditorResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizingEditor(true)
    editorDragStartY.current = e.clientY
    editorDragStartHeight.current = editorHeight
  }, [editorHeight])

  const handleEditorResizeMove = useCallback((e: MouseEvent) => {
    if (!isResizingEditor) return
    const delta = e.clientY - editorDragStartY.current
    const newHeight = Math.min(500, Math.max(100, editorDragStartHeight.current + delta))
    setEditorHeight(newHeight)
  }, [isResizingEditor])

  const handleEditorResizeEnd = useCallback(() => {
    setIsResizingEditor(false)
  }, [])

  useEffect(() => {
    if (isResizingEditor) {
      document.addEventListener('mousemove', handleEditorResizeMove)
      document.addEventListener('mouseup', handleEditorResizeEnd)
      document.body.style.cursor = 'row-resize'
      document.body.style.userSelect = 'none'
    } else {
      document.removeEventListener('mousemove', handleEditorResizeMove)
      document.removeEventListener('mouseup', handleEditorResizeEnd)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    return () => {
      document.removeEventListener('mousemove', handleEditorResizeMove)
      document.removeEventListener('mouseup', handleEditorResizeEnd)
    }
  }, [isResizingEditor, handleEditorResizeMove, handleEditorResizeEnd])

  // Drag handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsDragging(true)
    dragStartX.current = e.clientX
    dragStartWidth.current = manualWidth
  }, [manualWidth])

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging) return
    // Calculate new width (dragging left edge, so subtract delta)
    const delta = dragStartX.current - e.clientX
    const newWidth = Math.min(800, Math.max(350, dragStartWidth.current + delta))
    setManualWidth(newWidth)
  }, [isDragging])

  const handleMouseUp = useCallback(() => {
    setIsDragging(false)
  }, [])

  // Attach global mouse events when dragging
  useEffect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    } else {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isDragging, handleMouseMove, handleMouseUp])

  const handleExpandToggle = () => {
    setIsFullExpanded(!isFullExpanded)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const updated = await actionsApi.update(projectId, node.id, {
        name,
        serviceId,
        mdspec,
        config: {
          maxRetries: Number(maxRetries),
          promptTemplate: promptTemplate || undefined,
        },
      })
      onUpdate(updated)
      toast({ title: 'Action updated' })
    } catch (error) {
      toast({
        title: 'Error updating action',
        description: error instanceof Error ? error.message : 'Failed',
        variant: 'destructive',
      })
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!confirm('Delete this action?')) return

    try {
      await actionsApi.delete(projectId, node.id)
      onDelete(node.id)
      toast({ title: 'Action deleted' })
    } catch (error) {
      toast({
        title: 'Error deleting action',
        description: error instanceof Error ? error.message : 'Failed',
        variant: 'destructive',
      })
    }
  }

  // Calculate actual width
  const panelWidth = isFullExpanded ? '80vw' : `${manualWidth}px`

  return (
    <div
      className="flex h-full transition-all duration-200"
      style={{ width: panelWidth }}
    >
      {/* Drag handle */}
      <div
        className="w-4 bg-muted hover:bg-primary/30 cursor-col-resize flex items-center justify-center transition-colors group border-l"
        onMouseDown={handleMouseDown}
      >
        <ChevronsLeft className="w-4 h-4 text-muted-foreground group-hover:text-primary" />
      </div>

      {/* Panel content */}
      <div
        className="flex-1 border-l bg-card flex flex-col h-full overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b">
          <h3 className="font-semibold">Edit Action</h3>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" onClick={handleExpandToggle}>
              {isFullExpanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </Button>
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b">
          <button
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'config'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setActiveTab('config')}
          >
            Config
          </button>
          <button
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'spec'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setActiveTab('spec')}
          >
            Specification
          </button>
          <button
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'prompt'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setActiveTab('prompt')}
          >
            Prompt
          </button>
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {activeTab === 'config' && (
            <div className="space-y-4">
              <div>
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div>
                <Label htmlFor="type">Type</Label>
                <Input id="type" value={node.data.type} disabled />
              </div>

              <div>
                <Label htmlFor="service">Service</Label>
                <select
                  id="service"
                  value={serviceId || ''}
                  onChange={(e) => setServiceId(e.target.value || null)}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="">None (project-level)</option>
                  {services.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <Label htmlFor="retries">Max Retries</Label>
                <Input
                  id="retries"
                  type="number"
                  min="0"
                  max="10"
                  value={maxRetries}
                  onChange={(e) => setMaxRetries(Number(e.target.value))}
                />
              </div>
            </div>
          )}

          {activeTab === 'spec' && (
            <div className="h-full flex flex-col">
              {/* Monaco Editor - Top Section */}
              <div className="mb-1">
                <Label className="mb-1 block">Specification (mdspec)</Label>
                <p className="text-xs text-muted-foreground">
                  Define what this action should accomplish.
                </p>
              </div>
              <div className="border rounded-md overflow-hidden" style={{ height: editorHeight }}>
                <MonacoEditor
                  height="100%"
                  language="markdown"
                  theme="vs-dark"
                  value={mdspec}
                  onChange={(value) => setMdspec(value || '')}
                  options={{
                    minimap: { enabled: false },
                    fontSize: 13,
                    lineNumbers: 'on',
                    wordWrap: 'on',
                    scrollBeyondLastLine: false,
                    padding: { top: 8, bottom: 8 },
                  }}
                />
              </div>

              {/* Resize Handle */}
              <div
                className="h-3 flex items-center justify-center cursor-row-resize hover:bg-accent transition-colors"
                onMouseDown={handleEditorResizeStart}
              >
                <GripHorizontal className="w-4 h-4 text-muted-foreground" />
              </div>

              {/* Bottom Section - Files and Chat */}
              <div className="flex-1 flex gap-2 min-h-[200px]">
                {/* Files Browser - Left */}
                <div className="w-1/2 border rounded-md overflow-hidden">
                  <FileBrowser
                    rootPath={`actions/${node.id}`}
                    files={actionFiles}
                    selectedFile={selectedFile}
                    onSelectFile={setSelectedFile}
                    onCreateFile={handleCreateFile}
                    onDeleteFile={handleDeleteFile}
                    onRefresh={loadFiles}
                    loading={filesLoading}
                  />
                </div>

                {/* Chat - Right */}
                <div className="w-1/2 border rounded-md overflow-hidden">
                  <Chat
                    messages={chatMessages}
                    onSendMessage={handleSendMessage}
                    loading={chatLoading}
                    title="Action Chat"
                    placeholder="Ask about this action..."
                  />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'prompt' && (
            <div className="h-full flex flex-col">
              <Label className="mb-2">Additional Prompt</Label>
              <p className="text-xs text-muted-foreground mb-2">
                Extra instructions passed to the agent for this action.
              </p>
              <div className="flex-1 min-h-[300px] border rounded-md overflow-hidden">
                <MonacoEditor
                  height="100%"
                  language="markdown"
                  theme="vs-dark"
                  value={promptTemplate}
                  onChange={(value) => setPromptTemplate(value || '')}
                  options={{
                    minimap: { enabled: false },
                    fontSize: 13,
                    lineNumbers: 'off',
                    wordWrap: 'on',
                    scrollBeyondLastLine: false,
                    padding: { top: 8, bottom: 8 },
                  }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="p-4 border-t flex gap-2">
          <Button onClick={handleSave} disabled={saving} className="flex-1">
            {saving ? 'Saving...' : 'Save'}
          </Button>
          <Button variant="destructive" size="icon" onClick={handleDelete}>
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}
