'use client'

import { useState, useRef, useEffect } from 'react'
import { Workflow, Plus, MoreVertical, Pencil, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export interface WorkflowItem {
  id: string
  name: string
  isDefault?: boolean
}

interface WorkflowListProps {
  workflows: WorkflowItem[]
  currentWorkflowId: string | null
  onSelect: (workflow: WorkflowItem) => void
  onCreate: (name: string) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
}

interface ContextMenuProps {
  workflow: WorkflowItem
  position: { x: number; y: number }
  onClose: () => void
  onRename: () => void
  onDelete: () => void
}

function ContextMenu({ workflow, position, onClose, onRename, onDelete }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [onClose])

  return (
    <div
      ref={menuRef}
      className="fixed min-w-[120px] bg-popover border rounded-md shadow-lg p-1 z-50"
      style={{ left: position.x, top: position.y }}
    >
      <button
        className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer hover:bg-accent"
        onClick={() => {
          onRename()
          onClose()
        }}
      >
        <Pencil className="w-3 h-3" />
        Rename
      </button>
      {!workflow.isDefault && (
        <button
          className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded cursor-pointer hover:bg-destructive hover:text-destructive-foreground"
          onClick={() => {
            onDelete()
            onClose()
          }}
        >
          <Trash2 className="w-3 h-3" />
          Delete
        </button>
      )}
    </div>
  )
}

export function WorkflowList({
  workflows,
  currentWorkflowId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: WorkflowListProps) {
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [contextMenu, setContextMenu] = useState<{
    workflow: WorkflowItem
    position: { x: number; y: number }
  } | null>(null)

  const handleCreate = () => {
    if (newName.trim()) {
      onCreate(newName.trim())
      setNewName('')
      setShowCreate(false)
    }
  }

  const handleRename = (id: string) => {
    if (editName.trim()) {
      onRename(id, editName.trim())
      setEditingId(null)
      setEditName('')
    }
  }

  const startEdit = (workflow: WorkflowItem) => {
    setEditingId(workflow.id)
    setEditName(workflow.name)
  }

  const handleContextMenu = (event: React.MouseEvent, workflow: WorkflowItem) => {
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({
      workflow,
      position: { x: event.clientX, y: event.clientY },
    })
  }

  return (
    <div className="w-48 border-r bg-card flex flex-col h-full">
      <div className="p-3 border-b">
        <h3 className="text-sm font-medium text-muted-foreground">Workflows</h3>
      </div>

      <div className="flex-1 overflow-y-auto">
        {workflows.map((workflow) => (
          <div
            key={workflow.id}
            className={`group flex items-center px-3 py-2 cursor-pointer hover:bg-accent ${
              currentWorkflowId === workflow.id ? 'bg-accent border-l-2 border-primary' : ''
            }`}
            onContextMenu={(e) => handleContextMenu(e, workflow)}
          >
            {editingId === workflow.id ? (
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="h-7 text-sm"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleRename(workflow.id)
                  if (e.key === 'Escape') setEditingId(null)
                }}
                onBlur={() => handleRename(workflow.id)}
              />
            ) : (
              <>
                <button
                  className="flex-1 flex items-center gap-2 text-left"
                  onClick={() => onSelect(workflow)}
                >
                  <Workflow className="w-4 h-4 text-muted-foreground" />
                  <span className="text-sm truncate">{workflow.name}</span>
                </button>

                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 opacity-0 group-hover:opacity-100"
                  onClick={(e) => handleContextMenu(e, workflow)}
                >
                  <MoreVertical className="w-3 h-3" />
                </Button>
              </>
            )}
          </div>
        ))}
      </div>

      <div className="p-3 border-t">
        {showCreate ? (
          <div className="flex gap-2">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Name..."
              className="h-8 text-sm"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate()
                if (e.key === 'Escape') setShowCreate(false)
              }}
            />
            <Button size="sm" className="h-8 px-2" onClick={handleCreate}>
              <Plus className="w-4 h-4" />
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="w-full gap-2"
            onClick={() => setShowCreate(true)}
          >
            <Plus className="w-4 h-4" />
            New
          </Button>
        )}
      </div>

      {contextMenu && (
        <ContextMenu
          workflow={contextMenu.workflow}
          position={contextMenu.position}
          onClose={() => setContextMenu(null)}
          onRename={() => startEdit(contextMenu.workflow)}
          onDelete={() => onDelete(contextMenu.workflow.id)}
        />
      )}
    </div>
  )
}
