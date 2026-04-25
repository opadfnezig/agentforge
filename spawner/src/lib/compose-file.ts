import { readFile, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { parse as yamlParse, stringify as yamlStringify } from 'yaml'
import { paths } from '../config.js'
import { logger } from './logger.js'
import { SpawnRequest } from './types.js'

interface ComposeService {
  image: string
  container_name?: string
  restart?: string
  environment?: Record<string, string>
  volumes?: string[]
  command?: string | string[]
  entrypoint?: string | string[]
  // Allow extra keys for forward-compatibility
  [key: string]: unknown
}

interface ComposeFile {
  name: string
  services: Record<string, ComposeService>
  // version intentionally omitted — modern compose ignores it.
}

const empty = (): ComposeFile => ({ name: 'ntfr', services: {} })

export const readCompose = async (): Promise<ComposeFile> => {
  if (!existsSync(paths.composeFile)) return empty()
  const txt = await readFile(paths.composeFile, 'utf8')
  if (!txt.trim()) return empty()
  try {
    const parsed = yamlParse(txt) as ComposeFile | null
    if (!parsed || typeof parsed !== 'object') return empty()
    if (!parsed.services) parsed.services = {}
    if (!parsed.name) parsed.name = 'ntfr'
    return parsed
  } catch (err) {
    logger.error('Failed to parse compose.yml — refusing to overwrite', { err: String(err) })
    throw err
  }
}

export const writeCompose = async (file: ComposeFile): Promise<void> => {
  const txt = yamlStringify(file)
  await writeFile(paths.composeFile, txt, 'utf8')
}

/**
 * Build the service block for a primitive. Every primitive runs with
 * `restart: always` per locked design decision.
 *
 * Volume layout (mandatory):
 *   - <primitive>/workspace:/workspace:rw  — primitive's R/W folder
 *   - <primitive>/.meta:/meta:ro           — spawner-owned metadata, primitive RO
 * Plus any extra mounts the caller provided (passed through verbatim).
 */
export const buildServiceBlock = (req: SpawnRequest): ComposeService => {
  const baseVolumes = [
    `./${req.name}/workspace:/workspace:rw`,
    `./${req.name}/.meta:/meta:ro`,
  ]
  const extraVolumes = (req.mounts ?? []).map((m) => {
    const ro = m.readOnly ? ':ro' : ':rw'
    return `${m.source}:${m.target}${ro}`
  })

  const svc: ComposeService = {
    image: req.image,
    container_name: `ntfr-${req.name}`,
    restart: 'always',
    volumes: [...baseVolumes, ...extraVolumes],
  }

  if (req.env && Object.keys(req.env).length > 0) {
    svc.environment = { ...req.env }
  }

  if (req.command !== undefined) svc.command = req.command
  if (req.args !== undefined && !req.command) svc.command = req.args

  return svc
}
