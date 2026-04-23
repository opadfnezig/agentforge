import knex from 'knex'
import { config, usingSqlite } from '../config.js'

const getDbConfig = () => {
  if (usingSqlite()) {
    // Extract path from sqlite:// URL
    const dbPath = config.DATABASE_URL.replace('sqlite://', '')
    return {
      client: 'sqlite3',
      connection: { filename: dbPath },
      useNullAsDefault: true,
    }
  }
  return {
    client: 'pg',
    connection: config.DATABASE_URL,
    pool: { min: 2, max: 10 },
  }
}

export const db = knex(getDbConfig())

// Helper types for database rows (snake_case)
export interface DbProject {
  id: string
  name: string
  slug: string
  description: string | null
  status: string
  compose_config: string | null
  created_at: Date
  updated_at: Date
}

export interface DbService {
  id: string
  project_id: string
  name: string
  template: string
  mdspec: string | null
  openapi_spec: string | null
  directory: string
  status: string
  created_at: Date
  updated_at: Date
}

export interface DbAction {
  id: string
  project_id: string
  name: string
  type: string
  service_id: string | null
  config: Record<string, unknown>
  position: { x: number; y: number }
  created_at: Date
}

export interface DbEdge {
  id: string
  project_id: string
  source_action_id: string
  target_action_id: string
  type: string
  created_at: Date
}

export interface DbBuild {
  id: string
  project_id: string
  status: string
  started_at: Date | null
  finished_at: Date | null
  created_at: Date
  updated_at: Date
}

export interface DbActionRun {
  id: string
  action_id: string
  build_id: string
  status: string
  started_at: Date | null
  finished_at: Date | null
  error_message: string | null
  retry_count: number
  created_at: Date
  updated_at: Date
}

export interface DbAgentLog {
  id: string
  action_run_id: string
  timestamp: Date
  event_type: string
  data: Record<string, unknown>
}

export interface DbFileChange {
  id: string
  action_run_id: string
  timestamp: Date
  file_path: string
  change_type: string
  diff: string | null
  content_snapshot: string | null
}

export interface DbActionChat {
  id: string
  action_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: Date
}

export interface DbScope {
  id: string
  name: string
  description: string | null
  path: string
  created_at: Date
  updated_at: Date
}

export interface DbOracle {
  id: string
  scope_id: string | null
  name: string
  domain: string
  description: string | null
  state_dir: string
  status: string
  config: Record<string, unknown> | string
  created_at: Date
  updated_at: Date
}

export interface DbOracleQuery {
  id: string
  oracle_id: string
  message: string
  response: string | null
  duration_ms: number | null
  status: string
  created_at: Date
  updated_at: Date
}

export interface DbCoordinatorChat {
  id: string
  title: string
  created_at: Date
  updated_at: Date
}

export interface DbCoordinatorMessage {
  id: string
  chat_id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  created_at: Date
}

export interface DbDeveloper {
  id: string
  name: string
  scope_id: string | null
  workspace_path: string
  git_repo: string | null
  git_branch: string
  secret: string
  status: string
  last_heartbeat: Date | null
  config: Record<string, unknown> | string
  created_at: Date
  updated_at: Date
}

export interface DbDeveloperRun {
  id: string
  developer_id: string
  mode: string
  instructions: string
  status: string
  git_sha_start: string | null
  git_sha_end: string | null
  response: string | null
  started_at: Date | null
  finished_at: Date | null
  error_message: string | null
  provider: string | null
  model: string | null
  session_id: string | null
  total_cost_usd: number | null
  duration_ms: number | null
  duration_api_ms: number | null
  stop_reason: string | null
  trailer: Record<string, unknown> | string | null
  push_status: string | null
  push_error: string | null
  created_at: Date
  updated_at: Date
}

export interface DbDeveloperLog {
  id: string
  run_id: string
  timestamp: Date
  event_type: string
  data: Record<string, unknown> | string
}
