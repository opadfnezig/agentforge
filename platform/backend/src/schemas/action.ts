import { z } from 'zod'

export const actionTypeSchema = z.enum([
  'start',
  'end',
  'build',
  'unit-test',
  'api-test',
  'integration-test',
  'e2e-test',
  'fixer',
  'router',
  'custom',
])

export const actionConfigSchema = z.object({
  // For build/fixer actions
  promptTemplate: z.string().optional(),
  maxRetries: z.number().int().min(0).max(10).optional(),
  timeoutMinutes: z.number().int().min(1).max(120).optional(),

  // For test actions
  testCommand: z.string().optional(),
  testPattern: z.string().optional(),

  // For router actions
  routerPrompt: z.string().optional(),

  // Access control
  readAccess: z.array(z.string().uuid()).optional(),
  writeAccess: z.array(z.string().uuid()).optional(),
  canReadOpenapi: z.boolean().optional(),
  canReadWholeProject: z.boolean().optional(),

  // Internal - set by orchestrator
  _errorContext: z.object({
    fromAction: z.string().uuid(),
    errorMessage: z.string().nullable(),
    logs: z.array(z.unknown()),
  }).optional(),
})

export const positionSchema = z.object({
  x: z.number(),
  y: z.number(),
})

export const actionSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  name: z.string().min(1).max(100),
  type: actionTypeSchema,
  serviceId: z.string().uuid().nullable(),
  config: actionConfigSchema,
  position: positionSchema,
  createdAt: z.date(),
})

export const createActionSchema = z.object({
  name: z.string().min(1).max(100),
  type: actionTypeSchema,
  serviceId: z.string().uuid().nullable().optional(),
  config: actionConfigSchema.optional(),
  position: positionSchema.optional(),
})

export const updateActionSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  type: actionTypeSchema.optional(),
  serviceId: z.string().uuid().nullable().optional(),
  config: actionConfigSchema.optional(),
  position: positionSchema.optional(),
})

export type Action = z.infer<typeof actionSchema>
export type CreateAction = z.infer<typeof createActionSchema>
export type UpdateAction = z.infer<typeof updateActionSchema>
export type ActionType = z.infer<typeof actionTypeSchema>
export type ActionConfig = z.infer<typeof actionConfigSchema>
export type Position = z.infer<typeof positionSchema>
