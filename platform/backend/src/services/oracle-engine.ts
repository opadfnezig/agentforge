import { spawn } from 'child_process'
import { createInterface } from 'readline'
import { config } from '../config.js'
import { logger } from '../utils/logger.js'
import * as oracleQueries from '../db/queries/oracles.js'

interface ClaudeStreamEvent {
  type: string
  subtype?: string
  message?: {
    content?: Array<{ type: string; text?: string }>
  }
  result?: string
  error?: string
}

export const readState = async (stateDir: string): Promise<string> => {
  return oracleQueries.getOracleState(stateDir)
}

// Oracle = full Claude Code agent with tools, cwd = state dir.
// It can read/write its own files.
const spawnOracleAgent = (
  stateDir: string,
  prompt: string,
  model?: string
): Promise<string> => {
  return new Promise((resolve, reject) => {
    const args = [
      '--dangerously-skip-permissions',
      '--verbose',
      '--print',
      '--output-format', 'stream-json',
      '--max-turns', '30',
      '--system-prompt', 'You are a knowledge oracle. Your working directory contains your state files. Use Read tool to read them. Follow the instructions in the user message exactly.',
      ...(model ? ['--model', model] : []),
      '-p', prompt,
    ]

    const proc = spawn('claude', args, {
      env: { ...process.env },
      cwd: stateDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let result = ''
    let stderr = ''
    let rawStdout = ''
    const rl = createInterface({ input: proc.stdout })

    rl.on('line', (line) => {
      if (!line.trim()) return
      rawStdout += line + '\n'
      try {
        const event = JSON.parse(line) as ClaudeStreamEvent

        if (event.type === 'assistant' && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'text' && block.text) {
              result += block.text
            }
          }
        } else if (event.type === 'result' && event.result) {
          if (!result) result = event.result
        }
      } catch {
        // non-JSON — e.g. "Error: Reached max turns (10)"
      }
    })

    proc.stderr.on('data', (data) => {
      stderr += data.toString()
    })

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(result.trim())
      } else {
        // Extract non-JSON lines (real errors) from stdout as fallback
        const errLines = rawStdout.split('\n').filter((l) => {
          if (!l.trim()) return false
          try { JSON.parse(l); return false } catch { return true }
        })
        const errMsg = stderr.trim() || errLines.join(' ').slice(0, 500) || 'unknown'
        logger.error({ code, stderr: stderr.slice(0, 300), stdoutErr: errLines.slice(0, 3) }, 'Oracle agent failed')
        reject(new Error(`Oracle agent failed (${code}): ${errMsg}`))
      }
    })

    proc.on('error', reject)
  })
}

export const queryOracle = async (
  oracleId: string,
  message: string
): Promise<string> => {
  const oracle = await oracleQueries.getOracle(oracleId)
  if (!oracle) throw new Error(`Oracle not found: ${oracleId}`)

  const prompt = `You are the ${oracle.domain} oracle. Your working directory contains your state files — read them to answer.

Rules:
- Answer ONLY from what is in your state files. Read them first.
- Cite the relevant section/heading when possible.
- If your state does not contain the answer, say "Not in my state."
- Do not speculate or use general knowledge.
- Be dense. No filler.

Question: ${message}`

  const startTime = Date.now()

  try {
    const response = await spawnOracleAgent(oracle.stateDir, prompt, config.ORACLE_MODEL)
    const durationMs = Date.now() - startTime
    await oracleQueries.createOracleQuery(oracleId, message, response, durationMs, 'completed')
    logger.info({ oracleId, domain: oracle.domain, durationMs }, 'Oracle query completed')
    return response
  } catch (error) {
    const durationMs = Date.now() - startTime
    await oracleQueries.createOracleQuery(oracleId, message, null, durationMs, 'error')
    throw error
  }
}

export const mergeIntoState = async (
  oracleId: string,
  newData: string
): Promise<string> => {
  const oracle = await oracleQueries.getOracle(oracleId)
  if (!oracle) throw new Error(`Oracle not found: ${oracleId}`)

  const prompt = `You are the ${oracle.domain} oracle maintaining your state files. Your working directory contains your state — read it, then merge new information in.

Rules:
- Read your current state files first
- Merge the new information into the appropriate place — DO NOT just append
- Update existing sections if the new info refines/contradicts them
- Add new sections if the info covers a new topic
- Maintain the document's existing structure and style
- Do NOT remove existing information unless the new info explicitly supersedes it
- Write the updated file back using Edit or Write tools

New information to integrate:
${newData}`

  logger.info({ oracleId, domain: oracle.domain }, 'Oracle merging new data')
  const response = await spawnOracleAgent(oracle.stateDir, prompt, config.ORACLE_MODEL)
  logger.info({ oracleId, domain: oracle.domain }, 'Oracle state updated')
  return response
}
