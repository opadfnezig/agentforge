import { db, DbService } from '../connection.js'
import { Service, CreateService, UpdateService } from '../../schemas/service.js'
import { v4 as uuid } from 'uuid'

const toService = (row: DbService): Service => ({
  id: row.id,
  projectId: row.project_id,
  name: row.name,
  template: row.template as Service['template'],
  mdspec: row.mdspec,
  openapiSpec: row.openapi_spec,
  directory: row.directory,
  status: row.status as Service['status'],
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export const createService = async (
  projectId: string,
  data: CreateService
): Promise<Service> => {
  const [row] = await db<DbService>('services')
    .insert({
      id: uuid(),
      project_id: projectId,
      name: data.name,
      template: data.template,
      mdspec: data.mdspec || null,
      openapi_spec: data.openapiSpec || null,
      directory: `services/${data.name}`,
    })
    .returning('*')
  return toService(row)
}

export const listServices = async (projectId: string): Promise<Service[]> => {
  const rows = await db<DbService>('services')
    .where({ project_id: projectId })
    .orderBy('created_at', 'asc')
  return rows.map(toService)
}

export const getService = async (
  projectId: string,
  serviceId: string
): Promise<Service | null> => {
  const row = await db<DbService>('services')
    .where({ id: serviceId, project_id: projectId })
    .first()
  return row ? toService(row) : null
}

export const getServiceByName = async (
  projectId: string,
  name: string
): Promise<Service | null> => {
  const row = await db<DbService>('services')
    .where({ project_id: projectId, name })
    .first()
  return row ? toService(row) : null
}

export const updateService = async (
  projectId: string,
  serviceId: string,
  data: UpdateService
): Promise<Service | null> => {
  const updateData: Partial<DbService> = {}
  if (data.name !== undefined) {
    updateData.name = data.name
    updateData.directory = `services/${data.name}`
  }
  if (data.template !== undefined) updateData.template = data.template
  if (data.mdspec !== undefined) updateData.mdspec = data.mdspec
  if (data.openapiSpec !== undefined) updateData.openapi_spec = data.openapiSpec
  if (data.status !== undefined) updateData.status = data.status

  const [row] = await db<DbService>('services')
    .where({ id: serviceId, project_id: projectId })
    .update({ ...updateData, updated_at: new Date() })
    .returning('*')
  return row ? toService(row) : null
}

export const deleteService = async (
  projectId: string,
  serviceId: string
): Promise<boolean> => {
  const count = await db<DbService>('services')
    .where({ id: serviceId, project_id: projectId })
    .delete()
  return count > 0
}
