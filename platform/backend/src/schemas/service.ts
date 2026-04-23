import { z } from 'zod'

export const serviceTemplateSchema = z.enum([
  'node',
  'next',
  'python',
  'go',
  'static',
  'database',
  'custom',
])

export const serviceStatusSchema = z.enum([
  'pending',
  'building',
  'ready',
  'error',
])

export const serviceSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  name: z.string().min(1).max(50),
  template: serviceTemplateSchema,
  mdspec: z.string().nullable(),
  openapiSpec: z.string().nullable(),
  directory: z.string(),
  status: serviceStatusSchema,
  createdAt: z.date(),
  updatedAt: z.date(),
})

export const createServiceSchema = z.object({
  name: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/),
  template: serviceTemplateSchema,
  mdspec: z.string().optional(),
  openapiSpec: z.string().optional(),
})

export const updateServiceSchema = z.object({
  name: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/).optional(),
  template: serviceTemplateSchema.optional(),
  mdspec: z.string().optional(),
  openapiSpec: z.string().nullable().optional(),
  status: serviceStatusSchema.optional(),
})

export type Service = z.infer<typeof serviceSchema>
export type CreateService = z.infer<typeof createServiceSchema>
export type UpdateService = z.infer<typeof updateServiceSchema>
export type ServiceTemplate = z.infer<typeof serviceTemplateSchema>
export type ServiceStatus = z.infer<typeof serviceStatusSchema>
