import { z } from 'zod'

export const PRIMITIVE_KINDS = ['developer', 'researcher', 'oracle'] as const
export type PrimitiveKind = (typeof PRIMITIVE_KINDS)[number]

export const PRIMITIVE_STATES = ['creating', 'running', 'crashed', 'destroyed', 'orphaned'] as const
export type PrimitiveState = (typeof PRIMITIVE_STATES)[number]

// Service name must be a valid docker-compose service name and a safe folder
// name: [a-z0-9][a-z0-9_-]{0,62}. We disallow leading dots and slashes.
export const primitiveNameSchema = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'must match [a-z0-9][a-z0-9_-]*')

export const spawnRequestSchema = z.object({
  name: primitiveNameSchema,
  kind: z.enum(PRIMITIVE_KINDS),
  workdir: z.string().optional(), // subpath under ~/ntfr/<name>/; defaults to "workspace"
  // If omitted, the spawner builds the primitive from the hardcoded
  // per-kind context under /ntfr/agentforge (see KIND_BUILD_CONTEXT in
  // lib/compose-file.ts). Will move to a registry once we have one.
  image: z.string().min(1).optional(),
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

export type SpawnRequest = z.infer<typeof spawnRequestSchema>

export interface PrimitiveState_t {
  name: string
  kind: PrimitiveKind
  state: PrimitiveState
  image: string
  container_id: string | null
  created_at: string
  updated_at: string
  last_event_at: string | null
  last_event_id: string | null
  spec: SpawnRequest
}

export interface LifecycleEvent {
  event_id: string
  primitive_name: string
  primitive_kind: string
  state: PrimitiveState
  prev_state: PrimitiveState | null
  timestamp: string
  host_id: string
  payload: Record<string, unknown>
}

export interface LifecycleHistoryEntry {
  event_id: string
  state: PrimitiveState
  prev_state: PrimitiveState | null
  timestamp: string
  delivered: boolean
  attempts: number
  last_error: string | null
}
