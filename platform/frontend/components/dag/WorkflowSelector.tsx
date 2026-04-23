'use client'

import { useState, useRef, useEffect } from 'react'
import { ChevronDown, Plus, Workflow, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export interface WorkflowItem {
  id: string
  name: string
  isDefault?: boolean
}

interface WorkflowSelectorProps {
  workflows: WorkflowItem[]
  currentWorkflow: WorkflowItem | null
  onSelect: (workflow: WorkflowItem) => void
  onCreate: (name: string) => void
}

export function WorkflowSelector({
  workflows,
  currentWorkflow,
  onSelect,
  onCreate,
}: WorkflowSelectorProps) {
  const [open, setOpen] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setOpen(false)
        setShowCreate(false)
      }
    }

    if (open) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  const handleCreate = () => {
    if (newName.trim()) {
      onCreate(newName.trim())
      setNewName('')
      setShowCreate(false)
      setOpen(false)
    }
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <Button
        variant="outline"
        size="sm"
        className="gap-2"
        onClick={() => setOpen(!open)}
      >
        <Workflow className="w-4 h-4" />
        <span className="max-w-[120px] truncate">
          {currentWorkflow?.name || 'Select Workflow'}
        </span>
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </Button>

      {open && (
        <div className="absolute top-full left-0 mt-1 w-64 bg-popover border rounded-lg shadow-lg p-2 z-50">
          <div className="text-xs font-medium text-muted-foreground px-2 py-1 mb-1">
            Workflows
          </div>

          {workflows.length === 0 ? (
            <div className="px-2 py-4 text-sm text-muted-foreground text-center">
              No workflows yet
            </div>
          ) : (
            <div className="max-h-48 overflow-y-auto">
              {workflows.map((workflow) => (
                <button
                  key={workflow.id}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-accent ${
                    currentWorkflow?.id === workflow.id ? 'bg-accent' : ''
                  }`}
                  onClick={() => {
                    onSelect(workflow)
                    setOpen(false)
                  }}
                >
                  <Workflow className="w-4 h-4 text-muted-foreground" />
                  <span className="flex-1 text-left truncate">{workflow.name}</span>
                  {currentWorkflow?.id === workflow.id && (
                    <Check className="w-4 h-4 text-primary" />
                  )}
                </button>
              ))}
            </div>
          )}

          <div className="border-t mt-2 pt-2">
            {showCreate ? (
              <div className="flex gap-2">
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Workflow name..."
                  className="h-8 text-sm"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleCreate()
                    if (e.key === 'Escape') setShowCreate(false)
                  }}
                />
                <Button size="sm" className="h-8" onClick={handleCreate}>
                  Add
                </Button>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start gap-2"
                onClick={() => setShowCreate(true)}
              >
                <Plus className="w-4 h-4" />
                New Workflow
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
