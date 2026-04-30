import 'dotenv/config'
import { z } from 'zod'
import { join } from 'path'
import { homedir } from 'os'

const envSchema = z.object({
  NTFR_HOST_ID: z.string().min(1),
  NTFR_PORT: z.coerce.number().int().positive().default(9898),
  NTFR_WORKDIR: z.string().default(join(homedir(), 'ntfr')),
  NTFR_SERVER_URL: z.string().url().optional(),
  // WS base URL for primitives that need to dial back to the coordinator
  // (developer kind today). When unset we derive it from NTFR_SERVER_URL by
  // swapping http→ws and stripping any trailing /api segment.
  NTFR_COORDINATOR_URL: z.string().url().optional(),
  // Existing docker network that primitives must join so they can reach
  // the backend by service name. Same default as the spawner's own deploy
  // compose so the two stay aligned out of the box.
  NTFR_PRIMITIVE_NETWORK: z.string().min(1).default('agentforge_agentforge-net'),
  NTFR_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  DOCKER_SOCKET: z.string().default('/var/run/docker.sock'),
  NTFR_LIFECYCLE_RETRY_MAX: z.coerce.number().int().nonnegative().default(5),
  NTFR_LIFECYCLE_RETRY_BACKOFF_MS: z.coerce.number().int().nonnegative().default(1000),
  NTFR_ORPHAN_RETRY_MAX: z.coerce.number().int().nonnegative().default(3),
  NTFR_ORPHAN_RETRY_BACKOFF_MS: z.coerce.number().int().nonnegative().default(10000),
  NTFR_VERSION: z.string().default('0.1.0'),
})

const parseEnv = () => {
  const result = envSchema.safeParse(process.env)
  if (!result.success) {
    console.error('[spawner] invalid environment:', result.error.format())
    process.exit(1)
  }
  return result.data
}

export const config = parseEnv()

export const paths = {
  root: config.NTFR_WORKDIR,
  composeFile: join(config.NTFR_WORKDIR, 'compose.yml'),
  archiveDir: join(config.NTFR_WORKDIR, '.archive'),
  spawnerDir: join(config.NTFR_WORKDIR, '.spawner'),
  spawnerDb: join(config.NTFR_WORKDIR, '.spawner', 'state.db'),
  spawnerLog: join(config.NTFR_WORKDIR, '.spawner', 'spawner.log'),
  primitiveDir: (name: string) => join(config.NTFR_WORKDIR, name),
  primitiveStateFile: (name: string) => join(config.NTFR_WORKDIR, name, 'state.json'),
}

export type Config = typeof config
