'use client'

import { memo } from 'react'
import { Handle, Position, NodeProps } from 'reactflow'
import { Play } from 'lucide-react'

interface StartNodeData {
  label?: string
}

export const StartNode = memo(({ selected }: NodeProps<StartNodeData>) => {
  return (
    <div
      className={`
        w-16 h-16 rounded-full border-2 border-green-500 bg-green-500/20
        flex items-center justify-center shadow-sm
        ${selected ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : ''}
      `}
    >
      <Play className="w-6 h-6 text-green-500 ml-0.5" />

      {/* Single output handle */}
      <Handle
        type="source"
        position={Position.Bottom}
        id="start"
        className="!bg-green-500 !border-background !w-3 !h-3 !-bottom-1.5"
      />
    </div>
  )
})

StartNode.displayName = 'StartNode'
