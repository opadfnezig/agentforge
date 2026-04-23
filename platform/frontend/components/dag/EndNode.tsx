'use client'

import { memo } from 'react'
import { Handle, Position, NodeProps } from 'reactflow'
import { Square } from 'lucide-react'

interface EndNodeData {
  label?: string
}

export const EndNode = memo(({ selected }: NodeProps<EndNodeData>) => {
  return (
    <div
      className={`
        w-16 h-16 rounded-full border-2 border-red-500 bg-red-500/20
        flex items-center justify-center shadow-sm
        ${selected ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : ''}
      `}
    >
      <Square className="w-5 h-5 text-red-500" fill="currentColor" />

      {/* Single input handle */}
      <Handle
        type="target"
        position={Position.Top}
        id="input"
        className="!bg-red-500 !border-background !w-3 !h-3 !-top-1.5"
      />
    </div>
  )
})

EndNode.displayName = 'EndNode'
