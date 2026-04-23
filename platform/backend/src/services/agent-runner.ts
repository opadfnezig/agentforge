import { spawn } from 'child_process'
import { createInterface } from 'readline'
import { EventEmitter } from 'events'
import { join } from 'path'
import { writeFile, mkdir } from 'fs/promises'
import { config } from '../config.js'
import { Action } from '../schemas/action.js'
import { Project } from '../schemas/project.js'
import { Service } from '../schemas/service.js'
import { AgentLog } from '../schemas/build.js'
import * as buildQueries from '../db/queries/builds.js'
import { logger } from '../utils/logger.js'

interface AgentRunConfig {
  project: Project
  service: Service | null
  action: Action
  runId: string
  promptContent: string
  emitter: EventEmitter
}

interface ClaudeStreamEvent {
  type: string
  subtype?: string
  content?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  result?: unknown
  error?: string
}

const getProjectDir = (project: Project) =>
  join(config.DATA_DIR, 'projects', project.slug)

const mapEventType = (claudeType: string): AgentLog['eventType'] => {
  const typeMap: Record<string, AgentLog['eventType']> = {
    'assistant': 'message',
    'thinking': 'thinking',
    'tool_use': 'tool_use',
    'tool_result': 'tool_result',
    'error': 'error',
    'result': 'complete',
  }
  return typeMap[claudeType] || 'message'
}

export const runAgent = async (
  agentConfig: AgentRunConfig
): Promise<{ success: boolean; errorMessage?: string }> => {
  const { project, service, action, runId, promptContent, emitter } = agentConfig
  const projectDir = getProjectDir(project)

  // Determine workspace: service dir or project root
  const workdir = service
    ? join(projectDir, 'services', service.name)
    : projectDir

  // Ensure .agentforge directory exists for specs
  await mkdir(join(workdir, '.agentforge', 'specs'), { recursive: true })
  await mkdir(join(workdir, '.agentforge', 'openapi'), { recursive: true })

  // Write service mdspec to .agentforge/specs if available
  if (service?.mdspec) {
    await writeFile(join(workdir, '.agentforge', 'specs', 'service.md'), service.mdspec)
  }
  if (service?.openapiSpec) {
    await writeFile(join(workdir, '.agentforge', 'openapi', 'api.yaml'), service.openapiSpec)
  }

  const containerName = `agent-${runId}`

  // Simplified mounts: just workspace and credentials
  const mounts: string[] = [
    `-v ${workdir}:/workspace:rw`,
  ]

  // Mount Claude credentials for session auth
  const claudeCredentialsDir = join(config.CLAUDE_CREDENTIALS_PATH, '..')
  mounts.push(`-v ${claudeCredentialsDir}:/root/.claude:ro`)

  // Build environment variables
  const envVars: string[] = [
    '-e', `SERVICE_NAME=${service?.name || 'project'}`,
  ]

  // Only add API key if explicitly provided (prefer session auth)
  if (config.ANTHROPIC_API_KEY) {
    envVars.push('-e', `ANTHROPIC_API_KEY=${config.ANTHROPIC_API_KEY}`)
  }

  // Docker command
  const dockerArgs = [
    'run', '--rm',
    '--name', containerName,
    '--network', `${project.slug}_net`,
    ...mounts.flatMap(m => m.split(' ')),
    ...envVars,
    '-w', '/workspace',
    config.AGENT_IMAGE,
    'claude',
    '--dangerously-skip-permissions',
    '--verbose',
    '--print',
    '--output-format', 'stream-json',
    '--max-turns', String(action.config.maxRetries ? 100 : 50),
    promptContent,
  ]

  logger.info({ containerName, runId }, 'Starting agent container')

  const proc = spawn('docker', dockerArgs)
  let errorMessage: string | undefined

  // Parse streaming JSON output
  const rl = createInterface({ input: proc.stdout })

  for await (const line of rl) {
    try {
      const event = JSON.parse(line) as ClaudeStreamEvent

      const logEntry = await buildQueries.createAgentLog(
        runId,
        mapEventType(event.type),
        { ...event }
      )

      emitter.emit('event', {
        type: 'action:log',
        runId,
        event: logEntry,
      })

      // Track file changes from tool use
      if (event.type === 'tool_result' && isFileOperation(event)) {
        const fileChange = extractFileChange(event)
        if (fileChange) {
          await buildQueries.createFileChange(runId, fileChange)
          emitter.emit('event', {
            type: 'file:change',
            runId,
            change: fileChange,
          })
        }
      }

      if (event.type === 'error') {
        errorMessage = event.error || 'Unknown error'
      }
    } catch {
      // Non-JSON output, log as raw message
      if (line.trim()) {
        await buildQueries.createAgentLog(runId, 'message', { raw: line })
      }
    }
  }

  // Capture stderr
  let stderrOutput = ''
  proc.stderr.on('data', (data) => {
    stderrOutput += data.toString()
  })

  const exitCode = await new Promise<number>((resolve) => {
    proc.on('close', resolve)
  })

  if (stderrOutput && exitCode !== 0) {
    logger.error({ stderr: stderrOutput, exitCode }, 'Agent container error')
    errorMessage = errorMessage || stderrOutput
  }

  // Check for completion file
  const completionSuccess = exitCode === 0

  logger.info({ runId, exitCode, success: completionSuccess }, 'Agent container finished')

  return {
    success: completionSuccess,
    errorMessage,
  }
}

const isFileOperation = (event: ClaudeStreamEvent): boolean => {
  const fileTools = ['write', 'edit', 'create', 'delete', 'Write', 'Edit']
  return fileTools.some(tool =>
    event.tool_name?.toLowerCase().includes(tool.toLowerCase())
  )
}

const extractFileChange = (event: ClaudeStreamEvent): {
  filePath: string
  changeType: 'create' | 'modify' | 'delete'
  diff?: string
  contentSnapshot?: string
} | null => {
  if (!event.tool_input) return null

  const input = event.tool_input as Record<string, unknown>
  const filePath = (input.file_path || input.path || input.filename) as string
  if (!filePath) return null

  let changeType: 'create' | 'modify' | 'delete' = 'modify'
  if (event.tool_name?.toLowerCase().includes('create') ||
      event.tool_name?.toLowerCase().includes('write')) {
    changeType = 'create'
  } else if (event.tool_name?.toLowerCase().includes('delete')) {
    changeType = 'delete'
  }

  return {
    filePath,
    changeType,
    diff: input.diff as string | undefined,
    contentSnapshot: input.content as string | undefined,
  }
}

// Kill a running agent container
export const killAgent = async (runId: string): Promise<void> => {
  const containerName = `agent-${runId}`
  try {
    const proc = spawn('docker', ['kill', containerName])
    await new Promise<void>((resolve) => {
      proc.on('close', () => resolve())
    })
    logger.info({ containerName }, 'Agent container killed')
  } catch (error) {
    logger.warn({ error, containerName }, 'Failed to kill agent container')
  }
}
