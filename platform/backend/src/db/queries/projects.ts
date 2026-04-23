import { db, DbProject } from '../connection.js'
import { Project, CreateProject, UpdateProject } from '../../schemas/project.js'
import { v4 as uuid } from 'uuid'

const toProject = (row: DbProject): Project => ({
  id: row.id,
  name: row.name,
  slug: row.slug,
  description: row.description,
  status: row.status as Project['status'],
  composeConfig: row.compose_config,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

export const createProject = async (data: CreateProject): Promise<Project> => {
  const slug = data.slug || slugify(data.name)
  const [row] = await db<DbProject>('projects')
    .insert({
      id: uuid(),
      name: data.name,
      slug,
      description: data.description || null,
    })
    .returning('*')
  return toProject(row)
}

export const listProjects = async (): Promise<Project[]> => {
  const rows = await db<DbProject>('projects').orderBy('created_at', 'desc')
  return rows.map(toProject)
}

export const getProject = async (id: string): Promise<Project | null> => {
  const row = await db<DbProject>('projects').where({ id }).first()
  return row ? toProject(row) : null
}

export const getProjectBySlug = async (slug: string): Promise<Project | null> => {
  const row = await db<DbProject>('projects').where({ slug }).first()
  return row ? toProject(row) : null
}

export const updateProject = async (
  id: string,
  data: UpdateProject
): Promise<Project | null> => {
  const updateData: Partial<DbProject> = {}
  if (data.name !== undefined) updateData.name = data.name
  if (data.description !== undefined) updateData.description = data.description
  if (data.status !== undefined) updateData.status = data.status
  if (data.composeConfig !== undefined) updateData.compose_config = data.composeConfig

  const [row] = await db<DbProject>('projects')
    .where({ id })
    .update({ ...updateData, updated_at: new Date() })
    .returning('*')
  return row ? toProject(row) : null
}

export const deleteProject = async (id: string): Promise<boolean> => {
  const count = await db<DbProject>('projects').where({ id }).delete()
  return count > 0
}
