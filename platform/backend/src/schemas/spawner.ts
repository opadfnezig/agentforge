import { z } from 'zod'

export const PRIMITIVE_KINDS = ['developer', 'researcher', 'oracle'] as const
export const PRIMITIVE_STATES = ['creating', 'running', 'crashed', 'destroyed', 'orphaned'] as const

export const primitiveKindSchema = z.enum(PRIMITIVE_KINDS)
export const primitiveStateSchema = z.enum(PRIMITIVE_STATES)
export const spawnerHostStatusSchema = z.enum(['unknown', 'online', 'offline', 'error'])

export const spawnerHostSchema = z.object({
  id: z.string().uuid(),
  hostId: z.string().min(1).max(64),
  name: z.string().min(1).max(100),
  baseUrl: z.string().url(),
  status: spawnerHostStatusSchema,
  version: z.string().nullable(),
  capabilities: z.array(z.string()),
  lastSeenAt: z.date().nullable(),
  lastEventAt: z.date().nullable(),
  lastError: z.string().nullable(),
  config: z.record(z.unknown()),
  createdAt: z.date(),
  updatedAt: z.date(),
})

export const createSpawnerHostSchema = z.object({
  hostId: z.string().min(1).max(64),
  name: z.string().min(1).max(100),
  baseUrl: z.string().url(),
  config: z.record(z.unknown()).optional(),
})

export const updateSpawnerHostSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  baseUrl: z.string().url().optional(),
  config: z.record(z.unknown()).optional(),
})

// Mirror of spawner/src/lib/types.ts:spawnRequestSchema. Duplicated by
// design (Ambiguity A11) — keep in sync with the spawner package; if the
// shapes drift, runtime validation will reject the spawn.
export const spawnSpecSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, 'must match [a-z0-9][a-z0-9_-]*'),
  kind: primitiveKindSchema,
  workdir: z.string().optional(),
  image: z.string().min(1),
  env: z.record(z.string()).optional(),
  mounts: z
    .array(
      z.object({
        source: z.string().min(1),
        target: z.string().min(1),
        readOnly: z.boolean().optional(),
      })
    )
    .optional(),
  command: z.union([z.string(), z.array(z.string())]).optional(),
  args: z.array(z.string()).optional(),
})

// Lifecycle event POST body — body shape per docs/spawner/api-contract.md
// "Lifecycle event POST" (lines 213-256).
export const lifecycleEventSchema = z.object({
  event_id: z.string().uuid(),
  primitive_name: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9_-]*$/),
  primitive_kind: primitiveKindSchema,
  state: primitiveStateSchema,
  prev_state: primitiveStateSchema.nullable(),
  timestamp: z.string().datetime({ offset: true }),
  host_id: z.string().min(1).max(64),
  payload: z.record(z.unknown()).optional().default({}),
})

export type SpawnerHost = z.infer<typeof spawnerHostSchema>
export type CreateSpawnerHost = z.infer<typeof createSpawnerHostSchema>
export type UpdateSpawnerHost = z.infer<typeof updateSpawnerHostSchema>
export type SpawnerHostStatus = z.infer<typeof spawnerHostStatusSchema>
export type PrimitiveKind = z.infer<typeof primitiveKindSchema>
export type PrimitiveState = z.infer<typeof primitiveStateSchema>
export type SpawnSpec = z.infer<typeof spawnSpecSchema>
export type LifecycleEvent = z.infer<typeof lifecycleEventSchema>
