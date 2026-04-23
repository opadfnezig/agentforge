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

export const oracleQuerySchema = z.object({
  id: z.string().uuid(),
  oracleId: z.string().uuid(),
  message: z.string(),
  response: z.string().nullable(),
  durationMs: z.number().nullable(),
  status: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export type Oracle = z.infer<typeof oracleSchema>
export type CreateOracle = z.infer<typeof createOracleSchema>
export type UpdateOracle = z.infer<typeof updateOracleSchema>
export type OracleQuery = z.infer<typeof oracleQuerySchema>
export type OracleStatus = z.infer<typeof oracleStatusSchema>
