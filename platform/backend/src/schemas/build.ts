import { z } from 'zod'

export const buildStatusSchema = z.enum([
  'pending',
  'running',
  'success',
  'failure',
  'cancelled',
])

export const buildSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  status: buildStatusSchema,
  startedAt: z.date().nullable(),
  finishedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export const actionRunStatusSchema = z.enum([
  'pending',
  'running',
  'success',
  'failure',
  'skipped',
])

export const actionRunSchema = z.object({
  id: z.string().uuid(),
  actionId: z.string().uuid(),
  buildId: z.string().uuid(),
  status: actionRunStatusSchema,
  startedAt: z.date().nullable(),
  finishedAt: z.date().nullable(),
  errorMessage: z.string().nullable(),
  retryCount: z.number().int().default(0),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export const agentEventTypeSchema = z.enum([
  'init',
  'thinking',
  'tool_use',
  'tool_result',
  'message',
  'error',
  'complete',
])

export const agentLogSchema = z.object({
  id: z.string().uuid(),
  actionRunId: z.string().uuid(),
  timestamp: z.date(),
  eventType: agentEventTypeSchema,
  data: z.record(z.unknown()),
})

export const fileChangeTypeSchema = z.enum(['create', 'modify', 'delete'])

export const fileChangeSchema = z.object({
  id: z.string().uuid(),
  actionRunId: z.string().uuid(),
  timestamp: z.date(),
  filePath: z.string(),
  changeType: fileChangeTypeSchema,
  diff: z.string().nullable(),
  contentSnapshot: z.string().nullable(),
})

export type Build = z.infer<typeof buildSchema>
export type BuildStatus = z.infer<typeof buildStatusSchema>
export type ActionRun = z.infer<typeof actionRunSchema>
export type ActionRunStatus = z.infer<typeof actionRunStatusSchema>
export type AgentLog = z.infer<typeof agentLogSchema>
export type AgentEventType = z.infer<typeof agentEventTypeSchema>
export type FileChange = z.infer<typeof fileChangeSchema>
export type FileChangeType = z.infer<typeof fileChangeTypeSchema>
