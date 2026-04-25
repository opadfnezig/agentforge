import { readFile, writeFile, mkdir, readdir, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { paths } from '../config.js'
import { logger } from '../lib/logger.js'
import { PrimitiveState_t, PrimitiveState, SpawnRequest, PrimitiveKind } from '../lib/types.js'

const stateFile = (name: string) => paths.primitiveStateFile(name)

export const ensurePrimitiveDirs = async (name: string): Promise<void> => {
  await mkdir(paths.primitiveDir(name), { recursive: true, mode: 0o755 })
  await mkdir(paths.primitiveWorkspace(name), { recursive: true, mode: 0o755 })
  await mkdir(paths.primitiveMeta(name), { recursive: true, mode: 0o755 })
}

export const writeState = async (state: PrimitiveState_t): Promise<void> => {
  await mkdir(paths.primitiveDir(state.name), { recursive: true, mode: 0o755 })
  state.updated_at = new Date().toISOString()
  const tmp = stateFile(state.name) + '.tmp'
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
  // atomic rename via fs.promises.rename equivalent; writeFile then move
  await (await import('fs/promises')).rename(tmp, stateFile(state.name))
}

export const readState = async (name: string): Promise<PrimitiveState_t | null> => {
  const f = stateFile(name)
  if (!existsSync(f)) return null
  try {
    const txt = await readFile(f, 'utf8')
    return JSON.parse(txt) as PrimitiveState_t
  } catch (err) {
    logger.warn('Failed to read primitive state.json', { name, err: String(err) })
    return null
  }
}

export const listStates = async (): Promise<PrimitiveState_t[]> => {
  if (!existsSync(paths.root)) return []
  const out: PrimitiveState_t[] = []
  const entries = await readdir(paths.root, { withFileTypes: true })
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (e.name.startsWith('.')) continue // skip .archive, .spawner
    const s = await readState(e.name)
    if (s) out.push(s)
  }
  return out
}

export const initialState = (req: SpawnRequest): PrimitiveState_t => {
  const now = new Date().toISOString()
  return {
    name: req.name,
    kind: req.kind as PrimitiveKind,
    state: 'creating',
    image: req.image,
    container_id: null,
    created_at: now,
    updated_at: now,
    last_event_at: null,
    last_event_id: null,
    spec: req,
  }
}

export const transition = async (
  name: string,
  next: PrimitiveState,
  patch: Partial<PrimitiveState_t> = {}
): Promise<{ from: PrimitiveState; to: PrimitiveState; state: PrimitiveState_t } | null> => {
  const cur = await readState(name)
  if (!cur) return null
  const from = cur.state
  const merged: PrimitiveState_t = { ...cur, ...patch, state: next }
  await writeState(merged)
  return { from, to: next, state: merged }
}

export const primitiveExists = async (name: string): Promise<boolean> => {
  return existsSync(paths.primitiveDir(name)) && existsSync(stateFile(name))
}

export const dirSize = async (path: string): Promise<number> => {
  if (!existsSync(path)) return 0
  let total = 0
  const stack: string[] = [path]
  while (stack.length > 0) {
    const cur = stack.pop()!
    let st
    try {
      st = await stat(cur)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      const entries = await readdir(cur, { withFileTypes: true }).catch(() => [])
      for (const e of entries) stack.push(join(cur, e.name))
    } else {
      total += st.size
    }
  }
  return total
}
