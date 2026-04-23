import { spawn, ChildProcess } from 'child_process'
import { join } from 'path'
import { config } from '../config.js'
import { logger } from '../utils/logger.js'

interface CodeServerInstance {
  process: ChildProcess
  port: number
  url: string
}

// Store active code-server instances by project ID
const instances = new Map<string, CodeServerInstance>()

// Track used ports
const usedPorts = new Set<number>()

const getNextPort = (): number => {
  let port = config.CODE_SERVER_PORT_START
  while (usedPorts.has(port)) {
    port++
    if (port > config.CODE_SERVER_PORT_START + 100) {
      throw new Error('No available ports for code-server')
    }
  }
  usedPorts.add(port)
  return port
}

export const startCodeServer = async (
  projectId: string,
  workdir: string
): Promise<string> => {
  // Check if already running
  const existing = instances.get(projectId)
  if (existing) {
    return existing.url
  }

  const port = getNextPort()
  const fullWorkdir = join(config.DATA_DIR, 'projects', workdir)

  const args = [
    '--bind-addr', `0.0.0.0:${port}`,
    '--auth', config.CODE_SERVER_PASSWORD ? 'password' : 'none',
    '--disable-telemetry',
    fullWorkdir,
  ]

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
  }

  if (config.CODE_SERVER_PASSWORD) {
    env.PASSWORD = config.CODE_SERVER_PASSWORD
  }

  const proc = spawn('code-server', args, {
    env,
    detached: true,
    stdio: 'ignore',
  })

  proc.unref()

  proc.on('error', (error) => {
    logger.error({ error, projectId }, 'code-server failed to start')
    instances.delete(projectId)
    usedPorts.delete(port)
  })

  proc.on('exit', (code) => {
    logger.info({ projectId, code }, 'code-server exited')
    instances.delete(projectId)
    usedPorts.delete(port)
  })

  const url = `http://localhost:${port}`

  instances.set(projectId, {
    process: proc,
    port,
    url,
  })

  // Wait a bit for code-server to start
  await new Promise((r) => setTimeout(r, 2000))

  logger.info({ projectId, port, url }, 'code-server started')

  return url
}

export const stopCodeServer = async (projectId: string): Promise<void> => {
  const instance = instances.get(projectId)
  if (!instance) {
    return
  }

  try {
    instance.process.kill('SIGTERM')
    // Give it time to shut down gracefully
    await new Promise((r) => setTimeout(r, 1000))
    if (!instance.process.killed) {
      instance.process.kill('SIGKILL')
    }
  } catch (error) {
    logger.warn({ error, projectId }, 'Failed to stop code-server')
  }

  usedPorts.delete(instance.port)
  instances.delete(projectId)

  logger.info({ projectId }, 'code-server stopped')
}

export const getCodeServerUrl = async (
  projectId: string
): Promise<string | null> => {
  const instance = instances.get(projectId)
  return instance?.url || null
}

// Cleanup on process exit
process.on('exit', () => {
  instances.forEach((instance, _projectId) => {
    try {
      instance.process.kill('SIGKILL')
    } catch {
      // Ignore errors during cleanup
    }
  })
})
