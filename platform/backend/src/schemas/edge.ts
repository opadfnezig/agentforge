import { z } from 'zod'

export const edgeTypeSchema = z.enum(['success', 'failure'])

export const edgeSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  sourceActionId: z.string().uuid(),
  targetActionId: z.string().uuid(),
  type: edgeTypeSchema,
  createdAt: z.date(),
})

export const createEdgeSchema = z.object({
  sourceActionId: z.string().uuid(),
  targetActionId: z.string().uuid(),
  type: edgeTypeSchema.optional().default('success'),
})

export type Edge = z.infer<typeof edgeSchema>
export type CreateEdge = z.infer<typeof createEdgeSchema>
export type EdgeType = z.infer<typeof edgeTypeSchema>
