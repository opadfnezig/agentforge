import { z } from 'zod'

export const researcherStatusSchema = z.enum(['offline', 'idle', 'busy', 'error', 'destroyed'])
export const researcherRunStatusSchema = z.enum([
  'pending',
  'queued',
  'running',
  'success',
  'failure',
  'cancelled',
])

export const researcherSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  scopeId: z.string().uuid().nullable(),
  secret: z.string().max(64),
  status: researcherStatusSchema,
  lastHeartbeat: z.date().nullable(),
  config: z.record(z.unknown()),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export const createResearcherSchema = z.object({
  name: z.string().min(1).max(100),
  scopeId: z.string().uuid().optional(),
  config: z.record(z.unknown()).optional(),
})

export const updateResearcherSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  scopeId: z.string().uuid().nullable().optional(),
  status: researcherStatusSchema.optional(),
  config: z.record(z.unknown()).optional(),
})

export const researcherRunSchema = z.object({
  id: z.string().uuid(),
  researcherId: z.string().uuid(),
  instructions: z.string(),
  status: researcherRunStatusSchema,
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
  resumeContext: z.string().nullable(),
  parentRunId: z.string().uuid().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export const researcherLogSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  timestamp: z.date(),
  eventType: z.string(),
  data: z.record(z.unknown()),
})

export const researcherDispatchSchema = z.object({
  instructions: z.string().min(1),
  autoApprove: z.boolean().optional(),
})

export const editResearcherRunInstructionsSchema = z.object({
  instructions: z.string().min(1),
})

export type Researcher = z.infer<typeof researcherSchema>
export type CreateResearcher = z.infer<typeof createResearcherSchema>
export type UpdateResearcher = z.infer<typeof updateResearcherSchema>
export type ResearcherStatus = z.infer<typeof researcherStatusSchema>
export type ResearcherRun = z.infer<typeof researcherRunSchema>
export type ResearcherRunStatus = z.infer<typeof researcherRunStatusSchema>
export type ResearcherLog = z.infer<typeof researcherLogSchema>
