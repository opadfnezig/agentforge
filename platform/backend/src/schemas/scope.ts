import { z } from 'zod'

export const scopeSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  description: z.string().nullable(),
  path: z.string().min(1),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export const createScopeSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
  path: z.string().min(1),
})

export const updateScopeSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().nullable().optional(),
  path: z.string().min(1).optional(),
})

export type Scope = z.infer<typeof scopeSchema>
export type CreateScope = z.infer<typeof createScopeSchema>
export type UpdateScope = z.infer<typeof updateScopeSchema>
