import dotenv from 'dotenv'
import { z } from 'zod'
import { join } from 'path'
import { homedir } from 'os'

dotenv.config({ path: '../../.env' })

const envSchema = z.object({
  // Database - support SQLite for development
  DATABASE_URL: z.string().default('sqlite://./agentforge.db'),

  // Anthropic - optional if using session auth
  ANTHROPIC_API_KEY: z.string().optional(),

  // Claude session auth path
  CLAUDE_CREDENTIALS_PATH: z.string().default(join(homedir(), '.claude', '.credentials.json')),

  // Platform
  PORT: z.coerce.number().default(3001),
  FRONTEND_URL: z.string().url().default('http://localhost:3000'),
  DATA_DIR: z.string().default(join(homedir(), 'agentforge', 'data')),

  // Docker
  DOCKER_SOCKET: z.string().default('/var/run/docker.sock'),
  AGENT_IMAGE: z.string().default('agentforge/claude-agent:latest'),

  // Plane (optional)
  PLANE_API_URL: z.string().url().optional(),
  PLANE_API_KEY: z.string().optional(),
  PLANE_WORKSPACE: z.string().optional(),
  PLANE_PROJECT_ID: z.string().optional(),

  // code-server
  CODE_SERVER_PORT_START: z.coerce.number().default(8900),
  CODE_SERVER_PASSWORD: z.string().optional(),

  // Oracle
  ORACLE_STATE_DIR: z.string().default(join(homedir(), 'agentforge', 'data', 'oracles')),

  // Model selection
  COORDINATOR_MODEL: z.string().default('claude-opus-4-7'),
  ORACLE_MODEL: z.string().default('sonnet'),

  // Environment
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
})

const parseEnv = () => {
  const result = envSchema.safeParse(process.env)
  if (!result.success) {
    console.error('Invalid environment variables:')
    console.error(result.error.format())
    process.exit(1)
  }
  return result.data
}

export const config = parseEnv()

// Helper to check if using SQLite
export const usingSqlite = () => config.DATABASE_URL.startsWith('sqlite://')

export type Config = typeof config
