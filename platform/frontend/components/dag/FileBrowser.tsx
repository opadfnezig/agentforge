'use client'

import { useState, useEffect } from 'react'
import {
  ChevronRight,
  ChevronDown,
  File,
  Folder,
  FolderOpen,
  FileCode,
  FileText,
  Plus,
  Trash2,
  RefreshCw,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
}

interface FileBrowserProps {
  rootPath: string
  files: FileNode[]
  selectedFile: string | null
  onSelectFile: (path: string) => void
  onCreateFile?: (path: string) => void
  onDeleteFile?: (path: string) => void
  onRefresh?: () => void
  loading?: boolean
}

const getFileIcon = (name: string) => {
  if (name.endsWith('.md')) return FileText
  if (name.endsWith('.yaml') || name.endsWith('.yml')) return FileCode
  if (name.endsWith('.json')) return FileCode
  if (name.endsWith('.ts') || name.endsWith('.tsx')) return FileCode
  if (name.endsWith('.js') || name.endsWith('.jsx')) return FileCode
  return File
}

interface TreeNodeProps {
  node: FileNode
  depth: number
  selectedFile: string | null
  onSelect: (path: string) => void
  onDelete?: (path: string) => void
}

function TreeNode({ node, depth, selectedFile, onSelect, onDelete }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(depth < 2)
  const isSelected = selectedFile === node.path
  const isDirectory = node.type === 'directory'
  const Icon = isDirectory
    ? expanded
      ? FolderOpen
      : Folder
    : getFileIcon(node.name)

  const handleClick = () => {
    if (isDirectory) {
      setExpanded(!expanded)
    } else {
      onSelect(node.path)
    }
  }

  return (
    <div>
      <div
        className={`group flex items-center py-1 px-2 cursor-pointer hover:bg-accent rounded ${
          isSelected ? 'bg-accent' : ''
        }`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={handleClick}
      >
        {isDirectory && (
          <span className="mr-1">
            {expanded ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
          </span>
        )}
        {!isDirectory && <span className="w-4 mr-1" />}
        <Icon
          className={`w-4 h-4 mr-2 ${
            isDirectory ? 'text-blue-400' : 'text-muted-foreground'
          }`}
        />
        <span className="text-sm flex-1 truncate">{node.name}</span>
        {onDelete && !isDirectory && (
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 opacity-0 group-hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation()
              onDelete(node.path)
            }}
          >
            <Trash2 className="w-3 h-3 text-muted-foreground hover:text-destructive" />
          </Button>
        )}
      </div>
      {isDirectory && expanded && node.children && (
        <div>
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedFile={selectedFile}
              onSelect={onSelect}
              onDelete={onDelete}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function FileBrowser({
  rootPath,
  files,
  selectedFile,
  onSelectFile,
  onCreateFile,
  onDeleteFile,
  onRefresh,
  loading,
}: FileBrowserProps) {
  const [showCreate, setShowCreate] = useState(false)
  const [newFileName, setNewFileName] = useState('')

  const handleCreate = () => {
    if (newFileName.trim() && onCreateFile) {
      onCreateFile(`${rootPath}/${newFileName.trim()}`)
      setNewFileName('')
      setShowCreate(false)
    }
  }

  return (
    <div className="h-full flex flex-col bg-card border-l">
      {/* Header */}
      <div className="flex items-center justify-between p-2 border-b">
        <span className="text-xs font-medium text-muted-foreground truncate px-2">
          {rootPath}
        </span>
        <div className="flex gap-1">
          {onRefresh && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={onRefresh}
              disabled={loading}
            >
              <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          )}
          {onCreateFile && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => setShowCreate(!showCreate)}
            >
              <Plus className="w-3 h-3" />
            </Button>
          )}
        </div>
      </div>

      {/* Create file input */}
      {showCreate && (
        <div className="p-2 border-b">
          <div className="flex gap-2">
            <Input
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              placeholder="filename.md"
              className="h-7 text-sm"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate()
                if (e.key === 'Escape') setShowCreate(false)
              }}
            />
            <Button size="sm" className="h-7 px-2" onClick={handleCreate}>
              Add
            </Button>
          </div>
        </div>
      )}

      {/* File tree */}
      <div className="flex-1 overflow-y-auto py-2">
        {files.length === 0 ? (
          <div className="text-center py-8 text-sm text-muted-foreground">
            No files yet
          </div>
        ) : (
          files.map((node) => (
            <TreeNode
              key={node.path}
              node={node}
              depth={0}
              selectedFile={selectedFile}
              onSelect={onSelectFile}
              onDelete={onDeleteFile}
            />
          ))
        )}
      </div>
    </div>
  )
}

// Demo/example data for development
export const exampleFiles: FileNode[] = [
  {
    name: 'mdspec.md',
    path: '/actions/build/mdspec.md',
    type: 'file',
  },
  {
    name: 'prompts',
    path: '/actions/build/prompts',
    type: 'directory',
    children: [
      {
        name: 'system.md',
        path: '/actions/build/prompts/system.md',
        type: 'file',
      },
      {
        name: 'custom.md',
        path: '/actions/build/prompts/custom.md',
        type: 'file',
      },
    ],
  },
  {
    name: 'config.yaml',
    path: '/actions/build/config.yaml',
    type: 'file',
  },
]
