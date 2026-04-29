import { randomBytes } from 'crypto'
import { db, DbOracle, DbOracleQuery } from '../connection.js'
import { Oracle, CreateOracle, UpdateOracle, OracleQuery } from '../../schemas/oracle.js'
import { v4 as uuid } from 'uuid'
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'

const toOracle = (row: DbOracle): Oracle => ({
  id: row.id,
  scopeId: row.scope_id,
  name: row.name,
  domain: row.domain,
  description: row.description,
  stateDir: row.state_dir,
  status: row.status as Oracle['status'],
  secret: row.secret ?? null,
  config: typeof row.config === 'string' ? JSON.parse(row.config) : row.config,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export const generateSecret = (): string => randomBytes(32).toString('hex')

const toOracleQuery = (row: DbOracleQuery): OracleQuery => ({
  id: row.id,
  oracleId: row.oracle_id,
  message: row.message,
  response: row.response,
  durationMs: row.duration_ms,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export const createOracle = async (data: CreateOracle): Promise<Oracle> => {
  const [row] = await db<DbOracle>('oracles')
    .insert({
      id: uuid(),
      scope_id: data.scopeId || null,
      name: data.name,
      domain: data.domain,
      description: data.description || null,
      state_dir: data.stateDir,
      secret: generateSecret(),
      config: JSON.stringify(data.config || {}),
    })
    .returning('*')
  return toOracle(row)
}

export const getOracleByName = async (name: string): Promise<Oracle | null> => {
  const row = await db<DbOracle>('oracles').where({ name }).first()
  return row ? toOracle(row) : null
}

export const getOracleByDomain = async (domain: string): Promise<Oracle | null> => {
  const row = await db<DbOracle>('oracles').where({ domain }).first()
  return row ? toOracle(row) : null
}

// Lazily generate + persist a secret for legacy rows that pre-date the
// secret column. Returns the up-to-date secret (existing or newly minted).
export const ensureOracleSecret = async (id: string): Promise<string | null> => {
  const oracle = await getOracle(id)
  if (!oracle) return null
  if (oracle.secret) return oracle.secret
  const secret = generateSecret()
  await db<DbOracle>('oracles')
    .where({ id })
    .update({ secret, updated_at: new Date() })
  return secret
}

export const listOracles = async (): Promise<Oracle[]> => {
  const rows = await db<DbOracle>('oracles').orderBy('created_at', 'desc')
  return rows.map(toOracle)
}

export const getOracle = async (id: string): Promise<Oracle | null> => {
  const row = await db<DbOracle>('oracles').where({ id }).first()
  return row ? toOracle(row) : null
}

export const updateOracle = async (
  id: string,
  data: UpdateOracle
): Promise<Oracle | null> => {
  const updateData: Partial<DbOracle> = {}
  if (data.scopeId !== undefined) updateData.scope_id = data.scopeId
  if (data.name !== undefined) updateData.name = data.name
  if (data.domain !== undefined) updateData.domain = data.domain
  if (data.description !== undefined) updateData.description = data.description
  if (data.stateDir !== undefined) updateData.state_dir = data.stateDir
  if (data.status !== undefined) updateData.status = data.status
  if (data.config !== undefined) updateData.config = JSON.stringify(data.config) as any

  const [row] = await db<DbOracle>('oracles')
    .where({ id })
    .update({ ...updateData, updated_at: new Date() })
    .returning('*')
  return row ? toOracle(row) : null
}

export const deleteOracle = async (id: string): Promise<boolean> => {
  const count = await db<DbOracle>('oracles').where({ id }).delete()
  return count > 0
}

export const getOracleState = async (stateDir: string): Promise<string> => {
  try {
    const files = await readdir(stateDir)
    const mdFiles = files.filter((f) => f.endsWith('.md')).sort()
    const contents: string[] = []
    for (const file of mdFiles) {
      const content = await readFile(join(stateDir, file), 'utf-8')
      contents.push(`# ${file}\n\n${content}`)
    }
    return contents.join('\n\n---\n\n')
  } catch {
    return ''
  }
}

export const createOracleQuery = async (
  oracleId: string,
  message: string,
  response: string | null,
  durationMs: number | null,
  status: string
): Promise<OracleQuery> => {
  const [row] = await db<DbOracleQuery>('oracle_queries')
    .insert({
      id: uuid(),
      oracle_id: oracleId,
      message,
      response,
      duration_ms: durationMs,
      status,
    })
    .returning('*')
  return toOracleQuery(row)
}

export const listOracleQueries = async (oracleId: string): Promise<OracleQuery[]> => {
  const rows = await db<DbOracleQuery>('oracle_queries')
    .where({ oracle_id: oracleId })
    .orderBy('created_at', 'desc')
  return rows.map(toOracleQuery)
}
