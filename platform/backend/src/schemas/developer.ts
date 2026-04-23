import { z } from 'zod'

export const developerStatusSchema = z.enum(['offline', 'idle', 'busy', 'error'])
export const runModeSchema = z.enum(['implement', 'clarify'])
export const runStatusSchema = z.enum([
  'pending',
  'running',
  'success',
  'failure',
  'cancelled',
  'no_changes',
])

export const developerSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  scopeId: z.string().uuid().nullable(),
  workspacePath: z.string().min(1).max(500),
  gitRepo: z.string().max(500).nullable(),
  gitBranch: z.string().max(100),
  secret: z.string().max(64),
  status: developerStatusSchema,
  lastHeartbeat: z.date().nullable(),
  config: z.record(z.unknown()),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export const createDeveloperSchema = z.object({
  name: z.string().min(1).max(100),
  scopeId: z.string().uuid().optional(),
  workspacePath: z.string().min(1).max(500),
  gitRepo: z.string().max(500).optional(),
  gitBranch: z.string().max(100).optional(),
  config: z.record(z.unknown()).optional(),
})

export const updateDeveloperSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  scopeId: z.string().uuid().nullable().optional(),
  workspacePath: z.string().min(1).max(500).optional(),
  gitRepo: z.string().max(500).nullable().optional(),
  gitBranch: z.string().max(100).optional(),
  status: developerStatusSchema.optional(),
  config: z.record(z.unknown()).optional(),
})

export const developerRunSchema = z.object({
  id: z.string().uuid(),
  developerId: z.string().uuid(),
  mode: runModeSchema,
  instructions: z.string(),
  status: runStatusSchema,
  gitShaStart: z.string().nullable(),
  gitShaEnd: z.string().nullable(),
  response: z.string().nullable(),
  startedAt: z.date().nullable(),
  finishedAt: z.date().nullable(),
  errorMessage: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  sessionId: z.string().nullable(),
  totalCostUsd: z.number().nullable(),
  durationMs: z.number().nullable(),
  durationApiMs: z.number().nullable(),
  stopReason: z.string().nullable(),
  trailer: z.record(z.unknown()).nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export const developerLogSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  timestamp: z.date(),
  eventType: z.string(),
  data: z.record(z.unknown()),
})

export const dispatchSchema = z.object({
  instructions: z.string().min(1),
  mode: runModeSchema.optional(),
})

export type Developer = z.infer<typeof developerSchema>
export type CreateDeveloper = z.infer<typeof createDeveloperSchema>
export type UpdateDeveloper = z.infer<typeof updateDeveloperSchema>
export type DeveloperStatus = z.infer<typeof developerStatusSchema>
export type DeveloperRun = z.infer<typeof developerRunSchema>
export type DeveloperLog = z.infer<typeof developerLogSchema>
export type RunMode = z.infer<typeof runModeSchema>
export type RunStatus = z.infer<typeof runStatusSchema>
export type Dispatch = z.infer<typeof dispatchSchema>
