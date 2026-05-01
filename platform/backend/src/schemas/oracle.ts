import { z } from 'zod'

export const oracleStatusSchema = z.enum(['active', 'inactive', 'error'])

export const oracleSchema = z.object({
  id: z.string().uuid(),
  scopeId: z.string().uuid().nullable(),
  name: z.string().min(1).max(100),
  domain: z.string().min(1).max(100),
  description: z.string().nullable(),
  stateDir: z.string().min(1),
  status: oracleStatusSchema,
  secret: z.string().nullable(),
  config: z.record(z.unknown()),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export const createOracleSchema = z.object({
  scopeId: z.string().uuid().optional(),
  name: z.string().min(1).max(100),
  domain: z.string().min(1).max(100),
  description: z.string().optional(),
  stateDir: z.string().min(1),
  config: z.record(z.unknown()).optional(),
})

export const updateOracleSchema = z.object({
  scopeId: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(100).optional(),
  domain: z.string().min(1).max(100).optional(),
  description: z.string().nullable().optional(),
  stateDir: z.string().min(1).optional(),
  status: oracleStatusSchema.optional(),
  config: z.record(z.unknown()).optional(),
})

export const oracleModeSchema = z.enum(['read', 'write', 'migrate', 'chat'])

export const oracleChatSchema = z.object({
  id: z.string().uuid(),
  oracleId: z.string().uuid(),
  title: z.string().nullable(),
  claudeSessionId: z.string().nullable(),
  lastMessageAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export type OracleChat = z.infer<typeof oracleChatSchema>
export const oracleQueryStatusSchema = z.enum([
  'pending',
  'queued',
  'running',
  'success',
  'failure',
  'cancelled',
])

export const oracleQuerySchema = z.object({
  id: z.string().uuid(),
  oracleId: z.string().uuid(),
  mode: oracleModeSchema,
  message: z.string(),
  response: z.string().nullable(),
  status: oracleQueryStatusSchema,
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
  parentQueryId: z.string().uuid().nullable(),
  chatId: z.string().uuid().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export const oracleLogSchema = z.object({
  id: z.string().uuid(),
  queryId: z.string().uuid(),
  timestamp: z.date(),
  eventType: z.string(),
  data: z.record(z.unknown()),
})

export const oracleDispatchSchema = z.object({
  message: z.string().min(1),
  mode: oracleModeSchema.optional(),
  autoApprove: z.boolean().optional(),
  chatId: z.string().uuid().optional(),
})

export const createOracleChatSchema = z.object({
  oracleId: z.string().uuid(),
  title: z.string().max(200).optional(),
})

export const updateOracleChatSchema = z.object({
  title: z.string().max(200).nullable().optional(),
})

export type CreateOracleChat = z.infer<typeof createOracleChatSchema>
export type UpdateOracleChat = z.infer<typeof updateOracleChatSchema>

export const editOracleQueryMessageSchema = z.object({
  message: z.string().min(1),
})

export type Oracle = z.infer<typeof oracleSchema>
export type CreateOracle = z.infer<typeof createOracleSchema>
export type UpdateOracle = z.infer<typeof updateOracleSchema>
export type OracleQuery = z.infer<typeof oracleQuerySchema>
export type OracleQueryStatus = z.infer<typeof oracleQueryStatusSchema>
export type OracleMode = z.infer<typeof oracleModeSchema>
export type OracleLog = z.infer<typeof oracleLogSchema>
export type OracleStatus = z.infer<typeof oracleStatusSchema>
