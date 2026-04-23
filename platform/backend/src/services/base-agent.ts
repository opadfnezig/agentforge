import { spawn } from 'child_process'
import { config } from '../config.js'
import { logger } from '../utils/logger.js'

interface ChatContext {
  projectId: string
  projectSlug: string
  serviceId?: string
  serviceName?: string
}

export const sendChatMessage = async (
  message: string,
  context: ChatContext
): Promise<string> => {
  const systemPrompt = buildSystemPrompt(context)
  const fullPrompt = `${systemPrompt}\n\nUser: ${message}`

  return new Promise((resolve, reject) => {
    const args = [
      '--dangerously-skip-permissions',
      '--print',
      fullPrompt,
    ]

    const proc = spawn('claude', args, {
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: config.ANTHROPIC_API_KEY,
      },
    })

    let output = ''
    let errorOutput = ''

    proc.stdout.on('data', (data) => {
      output += data.toString()
    })

    proc.stderr.on('data', (data) => {
      errorOutput += data.toString()
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(output.trim())
      } else {
        logger.error({ code, stderr: errorOutput }, 'Chat command failed')
        reject(new Error(`Chat failed: ${errorOutput}`))
      }
    })

    proc.on('error', reject)
  })
}

export const streamChatResponse = async (
  message: string,
  context: ChatContext,
  onChunk: (chunk: string) => void
): Promise<void> => {
  const systemPrompt = buildSystemPrompt(context)
  const fullPrompt = `${systemPrompt}\n\nUser: ${message}`

  return new Promise((resolve, reject) => {
    const args = [
      '--dangerously-skip-permissions',
      '--print',
      '--output-format', 'stream-json',
      fullPrompt,
    ]

    const proc = spawn('claude', args, {
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: config.ANTHROPIC_API_KEY,
      },
    })

    proc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean)
      for (const line of lines) {
        try {
          const event = JSON.parse(line)
          if (event.type === 'assistant' && event.content) {
            onChunk(event.content)
          } else if (event.type === 'text' && event.text) {
            onChunk(event.text)
          }
        } catch {
          // Non-JSON output
          onChunk(line)
        }
      }
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Chat stream failed with code ${code}`))
      }
    })

    proc.on('error', reject)
  })
}

const buildSystemPrompt = (context: ChatContext): string => {
  let prompt = `You are a helpful AI assistant for the AgentForge project "${context.projectSlug}".`

  if (context.serviceName) {
    prompt += `\n\nYou are specifically helping with the "${context.serviceName}" service.`
  }

  prompt += `\n\nYou can help with:
- Explaining code and architecture
- Suggesting improvements
- Debugging issues
- Answering questions about the project

Be concise and helpful. If you need to write code, use markdown code blocks.`

  return prompt
}
