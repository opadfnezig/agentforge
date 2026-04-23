'use client'

import { memo } from 'react'
import { Handle, Position, NodeProps } from 'reactflow'
import { Hammer, TestTube, Wrench, Route, Code, MoreVertical } from 'lucide-react'

const typeIcons: Record<string, React.ElementType> = {
  build: Hammer,
  'unit-test': TestTube,
  'api-test': TestTube,
  'integration-test': TestTube,
  'e2e-test': TestTube,
  fixer: Wrench,
  router: Route,
  custom: Code,
}

const typeColors: Record<string, string> = {
  build: 'border-blue-500 bg-blue-500/10',
  'unit-test': 'border-green-500 bg-green-500/10',
  'api-test': 'border-green-500 bg-green-500/10',
  'integration-test': 'border-green-500 bg-green-500/10',
  'e2e-test': 'border-green-500 bg-green-500/10',
  fixer: 'border-yellow-500 bg-yellow-500/10',
  router: 'border-purple-500 bg-purple-500/10',
  custom: 'border-zinc-500 bg-zinc-500/10',
}

interface ActionNodeData {
  id: string
  name: string
  type: string
  serviceId?: string
  config?: Record<string, unknown>
}

export const ActionNode = memo(({ data, selected }: NodeProps<ActionNodeData>) => {
  const Icon = typeIcons[data.type] || Code
  const colorClass = typeColors[data.type] || 'border-zinc-500 bg-zinc-500/10'

  return (
    <div
      className={`
        min-w-[180px] rounded-lg border-2 bg-card shadow-sm
        ${colorClass}
        ${selected ? 'ring-2 ring-primary' : ''}
      `}
    >
      {/* Input handle */}
      <Handle
        type="target"
        position={Position.Top}
        id="input"
        className="!bg-muted-foreground !border-background !w-3 !h-3"
      />

      <div className="p-3">
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4 text-muted-foreground" />
          <span className="font-medium text-sm truncate flex-1">{data.name}</span>
        </div>
        <div className="text-xs text-muted-foreground mt-1">
          {data.type}
        </div>
      </div>

      {/* Success output handle */}
      <Handle
        type="source"
        position={Position.Bottom}
        id="success"
        className="!bg-green-500 !border-background !w-3 !h-3 !-bottom-1.5"
        style={{ left: '30%' }}
      />

      {/* Failure output handle */}
      <Handle
        type="source"
        position={Position.Bottom}
        id="failure"
        className="!bg-red-500 !border-background !w-3 !h-3 !-bottom-1.5"
        style={{ left: '70%' }}
      />
    </div>
  )
})

ActionNode.displayName = 'ActionNode'
