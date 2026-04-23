import { z } from 'zod'

// Pagination
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
})

// Task execution
export const createTaskSchema = z.object({
  prompt: z.string().min(1),
  scope: z.enum(['project', 'service']),
  serviceId: z.string().uuid().optional(),
  readAccess: z.array(z.string().uuid()).optional(),
  writeAccess: z.array(z.string().uuid()).optional(),
})

// Chat
export const chatMessageSchema = z.object({
  message: z.string().min(1),
  context: z.enum(['project', 'service']).optional(),
  serviceId: z.string().uuid().optional(),
})

// Editor
export const startEditorSchema = z.object({
  serviceId: z.string().uuid().optional(),
})

// DAG validation result
export const dagValidationSchema = z.object({
  valid: z.boolean(),
  errors: z.array(z.object({
    type: z.enum(['cycle', 'orphan', 'missing_start', 'missing_end', 'invalid_edge']),
    message: z.string(),
    nodeIds: z.array(z.string().uuid()).optional(),
  })),
})

export type Pagination = z.infer<typeof paginationSchema>
export type CreateTask = z.infer<typeof createTaskSchema>
export type ChatMessage = z.infer<typeof chatMessageSchema>
export type StartEditor = z.infer<typeof startEditorSchema>
export type DagValidation = z.infer<typeof dagValidationSchema>
