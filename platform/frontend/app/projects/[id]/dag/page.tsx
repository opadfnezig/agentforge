'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import ReactFlow, {
  Node,
  Edge,
  useNodesState,
  useEdgesState,
  addEdge,
  Connection,
  MarkerType,
  Controls,
  Background,
  MiniMap,
  Panel,
  NodeDragHandler,
} from 'reactflow'
import 'reactflow/dist/style.css'
import { Plus, Play, CheckCircle, ArrowLeft, Square } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { actionsApi, edgesApi, buildsApi } from '@/lib/api'
import { ActionNode } from '@/components/dag/ActionNode'
import { ActionPanel } from '@/components/dag/ActionPanel'
import { StartNode } from '@/components/dag/StartNode'
import { EndNode } from '@/components/dag/EndNode'
import { WorkflowSelector, type WorkflowItem } from '@/components/dag/WorkflowSelector'

const nodeTypes = {
  action: ActionNode,
  start: StartNode,
  end: EndNode,
}

export default function DagEditorPage() {
  const params = useParams()
  const projectId = params.id as string
  const router = useRouter()
  const { toast } = useToast()

  const [nodes, setNodes, onNodesChange] = useNodesState([])
  const [edges, setEdges, onEdgesChange] = useEdgesState([])
  const [selectedNode, setSelectedNode] = useState<Node | null>(null)
  const [loading, setLoading] = useState(true)

  // Edge deletion handler
  const handleDeleteEdge = useCallback(
    async (edgeId: string) => {
      try {
        await edgesApi.delete(projectId, edgeId)
        setEdges((eds) => eds.filter((e) => e.id !== edgeId))
        toast({ title: 'Edge deleted' })
      } catch (error) {
        toast({
          title: 'Error deleting edge',
          description: error instanceof Error ? error.message : 'Failed',
          variant: 'destructive',
        })
      }
    },
    [projectId, setEdges, toast]
  )

  // Node deletion handler
  const handleDeleteNode = useCallback(
    async (nodeId: string) => {
      try {
        await actionsApi.delete(projectId, nodeId)
        setNodes((nds) => nds.filter((n) => n.id !== nodeId))
        setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId))
        setSelectedNode(null)
        toast({ title: 'Node deleted' })
      } catch (error) {
        toast({
          title: 'Error deleting node',
          description: error instanceof Error ? error.message : 'Failed',
          variant: 'destructive',
        })
      }
    },
    [projectId, setNodes, setEdges, toast]
  )

  // Right-click on edge to delete
  const onEdgeContextMenu = useCallback(
    (event: React.MouseEvent, edge: Edge) => {
      event.preventDefault()
      handleDeleteEdge(edge.id)
    },
    [handleDeleteEdge]
  )

  // Right-click on node to delete
  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
      event.preventDefault()
      handleDeleteNode(node.id)
    },
    [handleDeleteNode]
  )

  // Auto-save position when node is dragged
  const onNodeDragStop: NodeDragHandler = useCallback(
    async (_event, node) => {
      try {
        await actionsApi.update(projectId, node.id, {
          position: node.position,
        })
      } catch (error) {
        console.error('Failed to save node position:', error)
      }
    },
    [projectId]
  )

  // Workflow state (UI-only for now, backend support coming later)
  const [workflows, setWorkflows] = useState<WorkflowItem[]>([
    { id: 'default', name: 'Main Workflow', isDefault: true },
  ])
  const [currentWorkflow, setCurrentWorkflow] = useState<WorkflowItem | null>(
    { id: 'default', name: 'Main Workflow', isDefault: true }
  )

  const handleSelectWorkflow = (workflow: WorkflowItem) => {
    setCurrentWorkflow(workflow)
    // TODO: Load workflow-specific nodes/edges when backend supports it
    toast({ title: `Switched to ${workflow.name}` })
  }

  const handleCreateWorkflow = (name: string) => {
    const newWorkflow: WorkflowItem = {
      id: `workflow-${Date.now()}`,
      name,
    }
    setWorkflows((prev) => [...prev, newWorkflow])
    setCurrentWorkflow(newWorkflow)
    // Clear canvas for new workflow
    setNodes([])
    setEdges([])
    toast({ title: `Created workflow: ${name}` })
  }

  // Load DAG
  useEffect(() => {
    const loadDag = async () => {
      try {
        const dag = await actionsApi.getDag(projectId)

        const flowNodes: Node[] = dag.actions.map((action) => {
          // Use special node types for start/end
          const nodeType = action.type === 'start' || action.type === 'end'
            ? action.type
            : 'action'

          return {
            id: action.id,
            type: nodeType,
            position: action.position,
            data: {
              ...action,
              label: action.type === 'start' ? 'Start' : action.type === 'end' ? 'End' : undefined,
              onEdit: () => setSelectedNode(nodes.find((n) => n.id === action.id) || null),
            },
          }
        })

        const flowEdges: Edge[] = dag.edges.map((edge) => ({
          id: edge.id,
          source: edge.sourceActionId,
          target: edge.targetActionId,
          sourceHandle: edge.type,
          targetHandle: 'input',
          type: 'smoothstep',
          markerEnd: { type: MarkerType.ArrowClosed },
          style: { stroke: edge.type === 'failure' ? '#ef4444' : '#22c55e', strokeWidth: 2 },
          label: edge.type,
        }))

        setNodes(flowNodes)
        setEdges(flowEdges)
      } catch (error) {
        toast({
          title: 'Error loading DAG',
          description: error instanceof Error ? error.message : 'Failed to load',
          variant: 'destructive',
        })
      } finally {
        setLoading(false)
      }
    }

    loadDag()
  }, [projectId, toast])

  const onConnect = useCallback(
    async (params: Connection) => {
      if (!params.source || !params.target) return

      // Determine edge type based on which handle was used (success or failure)
      const edgeType = params.sourceHandle === 'failure' ? 'failure' : 'success'
      const edgeColor = edgeType === 'failure' ? '#ef4444' : '#22c55e'

      try {
        const edge = await edgesApi.create(projectId, {
          sourceActionId: params.source,
          targetActionId: params.target,
          type: edgeType,
        })

        setEdges((eds) =>
          addEdge(
            {
              ...params,
              targetHandle: 'input',
              id: edge.id,
              type: 'smoothstep',
              markerEnd: { type: MarkerType.ArrowClosed },
              style: { stroke: edgeColor, strokeWidth: 2 },
              label: edgeType,
            },
            eds
          )
        )
      } catch (error) {
        toast({
          title: 'Error creating edge',
          description: error instanceof Error ? error.message : 'Failed',
          variant: 'destructive',
        })
      }
    },
    [projectId, setEdges, toast]
  )

  const handleAddAction = async (type: string) => {
    try {
      const action = await actionsApi.create(projectId, {
        name: `New ${type} action`,
        type: type as any,
        position: { x: 250, y: 100 + nodes.length * 100 },
      })

      setNodes((nds) => [
        ...nds,
        {
          id: action.id,
          type: 'action',
          position: action.position,
          data: action,
        },
      ])

      toast({ title: 'Action added' })
    } catch (error) {
      toast({
        title: 'Error adding action',
        description: error instanceof Error ? error.message : 'Failed',
        variant: 'destructive',
      })
    }
  }

  const handleAddSpecialNode = async (nodeType: 'start' | 'end') => {
    // Check if node of this type already exists
    const exists = nodes.some((n) => n.type === nodeType)
    if (exists) {
      toast({
        title: `${nodeType === 'start' ? 'Start' : 'End'} node already exists`,
        description: 'Only one start/end node is allowed per workflow',
        variant: 'destructive',
      })
      return
    }

    const position = nodeType === 'start'
      ? { x: 250, y: 50 }
      : { x: 250, y: 100 + nodes.length * 100 }

    try {
      const action = await actionsApi.create(projectId, {
        name: nodeType === 'start' ? 'Start' : 'End',
        type: nodeType,
        position,
      })

      setNodes((nds) => [
        ...nds,
        {
          id: action.id,
          type: nodeType,
          position: action.position,
          data: { ...action, label: nodeType === 'start' ? 'Start' : 'End' },
        },
      ])

      toast({ title: `${nodeType === 'start' ? 'Start' : 'End'} node added` })
    } catch (error) {
      toast({
        title: 'Error adding node',
        description: error instanceof Error ? error.message : 'Failed',
        variant: 'destructive',
      })
    }
  }

  const handleValidate = async () => {
    try {
      const result = await actionsApi.validateDag(projectId)
      if (result.valid) {
        toast({
          title: 'DAG is valid',
          description: 'Ready to execute',
        })
      } else {
        toast({
          title: 'DAG has errors',
          description: result.errors.map((e) => e.message).join(', '),
          variant: 'destructive',
        })
      }
    } catch (error) {
      toast({
        title: 'Validation failed',
        description: error instanceof Error ? error.message : 'Failed',
        variant: 'destructive',
      })
    }
  }

  const handleStartBuild = async () => {
    try {
      const build = await buildsApi.start(projectId)
      toast({
        title: 'Build started',
        description: `Build ${build.id.slice(0, 8)} is running`,
      })
    } catch (error) {
      toast({
        title: 'Error starting build',
        description: error instanceof Error ? error.message : 'Failed',
        variant: 'destructive',
      })
    }
  }

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <div className="text-muted-foreground">Loading DAG...</div>
      </div>
    )
  }

  return (
    <div className="h-screen flex">
      <div className="flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          nodeTypes={nodeTypes}
          onNodeClick={(_, node) => setSelectedNode(node)}
          onNodeContextMenu={onNodeContextMenu}
          onEdgeContextMenu={onEdgeContextMenu}
          onNodeDragStop={onNodeDragStop}
          fitView
        >
          <Background />
          <Controls />
          <MiniMap />

          <Panel position="top-left" className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => router.push(`/projects/${projectId}`)}
              >
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back
              </Button>
              <WorkflowSelector
                workflows={workflows}
                currentWorkflow={currentWorkflow}
                onSelect={handleSelectWorkflow}
                onCreate={handleCreateWorkflow}
              />
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => handleAddSpecialNode('start')}>
                <Play className="w-4 h-4 mr-1 text-green-500" />
                Start
              </Button>
              <Button size="sm" variant="outline" onClick={() => handleAddAction('build')}>
                <Plus className="w-4 h-4 mr-1" />
                Build
              </Button>
              <Button size="sm" variant="outline" onClick={() => handleAddAction('unit-test')}>
                <Plus className="w-4 h-4 mr-1" />
                Test
              </Button>
              <Button size="sm" variant="outline" onClick={() => handleAddAction('fixer')}>
                <Plus className="w-4 h-4 mr-1" />
                Fixer
              </Button>
              <Button size="sm" variant="outline" onClick={() => handleAddAction('router')}>
                <Plus className="w-4 h-4 mr-1" />
                Router
              </Button>
              <Button size="sm" variant="outline" onClick={() => handleAddSpecialNode('end')}>
                <Square className="w-4 h-4 mr-1 text-red-500" />
                End
              </Button>
            </div>
          </Panel>

          <Panel position="top-right" className="flex gap-2">
            <Button size="sm" variant="outline" onClick={handleValidate}>
              <CheckCircle className="w-4 h-4 mr-1" />
              Validate
            </Button>
            <Button size="sm" onClick={handleStartBuild}>
              <Play className="w-4 h-4 mr-1" />
              Run Build
            </Button>
          </Panel>
        </ReactFlow>
      </div>

      {selectedNode && (
        <ActionPanel
          node={selectedNode}
          projectId={projectId}
          onClose={() => setSelectedNode(null)}
          onUpdate={(updated) => {
            setNodes((nds) =>
              nds.map((n) =>
                n.id === updated.id ? { ...n, data: { ...n.data, ...updated } } : n
              )
            )
          }}
          onDelete={(nodeId) => {
            setNodes((nds) => nds.filter((n) => n.id !== nodeId))
            setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId))
            setSelectedNode(null)
          }}
        />
      )}
    </div>
  )
}
