import { db, DbScope } from '../connection.js'
import { Scope, CreateScope, UpdateScope } from '../../schemas/scope.js'
import { v4 as uuid } from 'uuid'

const toScope = (row: DbScope): Scope => ({
  id: row.id,
  name: row.name,
  description: row.description,
  path: row.path,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export const createScope = async (data: CreateScope): Promise<Scope> => {
  const [row] = await db<DbScope>('scopes')
    .insert({
      id: uuid(),
      name: data.name,
      description: data.description || null,
      path: data.path,
    })
    .returning('*')
  return toScope(row)
}

export const listScopes = async (): Promise<Scope[]> => {
  const rows = await db<DbScope>('scopes').orderBy('created_at', 'desc')
  return rows.map(toScope)
}

export const getScope = async (id: string): Promise<Scope | null> => {
  const row = await db<DbScope>('scopes').where({ id }).first()
  return row ? toScope(row) : null
}

export const updateScope = async (
  id: string,
  data: UpdateScope
): Promise<Scope | null> => {
  const updateData: Partial<DbScope> = {}
  if (data.name !== undefined) updateData.name = data.name
  if (data.description !== undefined) updateData.description = data.description
  if (data.path !== undefined) updateData.path = data.path

  const [row] = await db<DbScope>('scopes')
    .where({ id })
    .update({ ...updateData, updated_at: new Date() })
    .returning('*')
  return row ? toScope(row) : null
}

export const deleteScope = async (id: string): Promise<boolean> => {
  const count = await db<DbScope>('scopes').where({ id }).delete()
  return count > 0
}
