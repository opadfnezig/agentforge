import { spawn } from 'child_process'
import { paths } from '../config.js'
import { logger } from './logger.js'

export interface DockerExecResult {
  code: number
  stdout: string
  stderr: string
}

const run = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string }
): Promise<DockerExecResult> => {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd: opts?.cwd, env: process.env })
    let stdout = ''
    let stderr = ''
    proc.stdout?.on('data', (d) => { stdout += d.toString() })
    proc.stderr?.on('data', (d) => { stderr += d.toString() })
    proc.on('error', (err) => {
      resolve({ code: -1, stdout, stderr: stderr + (stderr ? '\n' : '') + String(err) })
    })
    proc.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

const compose = (args: string[]) =>
  run('docker', ['compose', '-f', paths.composeFile, ...args], { cwd: paths.root })

/**
 * Bring up one or more services, building if needed. Idempotent.
 */
export const composeUp = async (services?: string[]): Promise<DockerExecResult> => {
  const args = ['up', '-d']
  if (services && services.length > 0) args.push(...services)
  const r = await compose(args)
  if (r.code !== 0) logger.warn('docker compose up failed', { stderr: r.stderr, services })
  return r
}

/**
 * Stop and remove a single service plus its anonymous volumes. We use
 * `rm -fsv` rather than `down -v` because `down` would tear down the entire
 * compose project (every primitive on the host).
 */
export const composeRmService = async (service: string): Promise<DockerExecResult> => {
  const r = await compose(['rm', '-fsv', service])
  if (r.code !== 0) logger.warn('docker compose rm failed', { stderr: r.stderr, service })
  return r
}

/**
 * Map of compose service name -> container ID for currently-known services.
 * Returns empty map if the compose file is missing/empty.
 */
export const composePsIds = async (): Promise<Map<string, string>> => {
  const r = await compose(['ps', '-q', '--all'])
  // Service ID listing without names is not directly useful; use --format
  if (r.code !== 0) {
    logger.warn('docker compose ps failed', { stderr: r.stderr })
    return new Map()
  }
  // Use a second call with --format for service+id pairs
  const fmt = await compose([
    'ps',
    '--all',
    '--format',
    '{{.Service}}\t{{.ID}}\t{{.State}}',
  ])
  const out = new Map<string, string>()
  if (fmt.code !== 0) return out
  for (const line of fmt.stdout.split('\n')) {
    const [service, id] = line.trim().split('\t')
    if (service && id) out.set(service, id)
  }
  return out
}

/**
 * Inspect a service's current container state (running/exited/etc).
 * Returns `null` if no container exists.
 */
export const composeServiceState = async (
  service: string
): Promise<{ id: string; state: string } | null> => {
  const r = await compose([
    'ps',
    '--all',
    '--format',
    '{{.Service}}\t{{.ID}}\t{{.State}}',
  ])
  if (r.code !== 0) return null
  for (const line of r.stdout.split('\n')) {
    const [s, id, state] = line.trim().split('\t')
    if (s === service && id) return { id, state: state || 'unknown' }
  }
  return null
}

/**
 * Tail logs for a service. `tail` is a count or 'all'. `since` is a duration
 * (e.g. '5m', '1h') or RFC3339 timestamp accepted by docker.
 */
export const composeLogs = async (
  service: string,
  opts: { tail?: number | 'all'; since?: string } = {}
): Promise<DockerExecResult> => {
  const args = ['logs', '--no-color']
  if (opts.tail !== undefined) args.push('--tail', String(opts.tail))
  if (opts.since) args.push('--since', opts.since)
  args.push(service)
  return compose(args)
}
