import { spawn } from 'child_process'
import { mkdir, rm, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { paths } from '../config.js'
import { logger } from '../lib/logger.js'

const tarToFile = (cwd: string, target: string, archive: string): Promise<{ code: number; stderr: string }> => {
  return new Promise((resolve) => {
    const proc = spawn('tar', ['-czf', archive, target], { cwd })
    let stderr = ''
    proc.stderr.on('data', (d) => { stderr += d.toString() })
    proc.on('close', (code) => resolve({ code: code ?? -1, stderr }))
    proc.on('error', (err) => resolve({ code: -1, stderr: stderr + String(err) }))
  })
}

/**
 * Tar `~/ntfr/<name>/` into `~/ntfr/.archive/<name>-<ts>.tar.gz`.
 * Returns the absolute path + size in bytes. Throws on failure — the caller
 * MUST NOT proceed to delete the source folder if archiving failed.
 */
export const archivePrimitive = async (
  name: string
): Promise<{ archivePath: string; bytes: number }> => {
  const dir = paths.primitiveDir(name)
  if (!existsSync(dir)) {
    throw new Error(`primitive folder missing: ${dir}`)
  }
  await mkdir(paths.archiveDir, { recursive: true, mode: 0o755 })

  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const archive = join(paths.archiveDir, `${name}-${ts}.tar.gz`)

  const r = await tarToFile(paths.root, name, archive)
  if (r.code !== 0) {
    throw new Error(`tar failed (code=${r.code}): ${r.stderr.slice(0, 500)}`)
  }
  const st = await stat(archive)
  logger.info('Archive created', { name, archive, bytes: st.size })
  return { archivePath: archive, bytes: st.size }
}

export const removePrimitiveDir = async (name: string): Promise<void> => {
  const dir = paths.primitiveDir(name)
  if (!existsSync(dir)) return
  await rm(dir, { recursive: true, force: true })
  logger.info('Primitive folder removed', { name, dir })
}
