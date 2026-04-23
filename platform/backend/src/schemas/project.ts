import { z } from 'zod'

export const projectStatusSchema = z.enum([
  'draft',
  'building',
  'ready',
  'error',
  'stopped',
])

export const projectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  slug: z.string().regex(/^[a-z0-9-]+$/).min(1).max(50),
  description: z.string().nullable(),
  status: projectStatusSchema,
  composeConfig: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().regex(/^[a-z0-9-]+$/).min(1).max(50).optional(),
  description: z.string().optional(),
})

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().nullable().optional(),
  status: projectStatusSchema.optional(),
  composeConfig: z.string().optional(),
})

export type Project = z.infer<typeof projectSchema>
export type CreateProject = z.infer<typeof createProjectSchema>
export type UpdateProject = z.infer<typeof updateProjectSchema>
export type ProjectStatus = z.infer<typeof projectStatusSchema>
