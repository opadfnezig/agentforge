import { spawn } from 'child_process'
import { createInterface } from 'readline'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { config } from '../config.js'
import { logger } from '../utils/logger.js'
import * as oracleQueries from '../db/queries/oracles.js'
import * as developerQueries from '../db/queries/developers.js'
import { queryOracle } from './oracle-engine.js'
import { developerRegistry } from './developer-registry.js'
import type { RunMode } from '../schemas/developer.js'

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export type CoordinatorEvent =
  | { type: 'status'; message: string }
  | { type: 'oracle'; domain: string; question: string; response: string }
  | {
      type: 'dispatch'
      developer: string
      developerId: string
      mode: RunMode
      runId: string
      instructions: string
      // All coordinator-initiated dispatches start in 'pending' (awaiting
      // approval). Kept as a bool flag for UI backward-compat with stored
      // chat history; new consumers should check the run's real status.
      queued: boolean
      pending: boolean
    }
  | { type: 'text'; text: string }
  | { type: 'done' }

interface ClaudeStreamEvent {
  type: string
  subtype?: string
  message?: {
    content?: Array<{ type: string; text?: string }>
  }
  result?: string
  error?: string
}

interface OracleSummary {
  domain: string
  description: string | null
}

interface DeveloperSummary {
  name: string
  workspacePath: string
  online: boolean
}

const loadOracleList = async (): Promise<OracleSummary[]> => {
  const oracles = await oracleQueries.listOracles()
  return oracles.map((o) => ({ domain: o.domain, description: o.description }))
}

const loadDeveloperList = async (): Promise<DeveloperSummary[]> => {
  const developers = await developerQueries.listDevelopers()
  return developers.map((d) => ({
    name: d.name,
    workspacePath: d.workspacePath,
    online: developerRegistry.isOnline(d.id),
  }))
}

const loadUserProfile = async (): Promise<string> => {
  try {
    return await readFile(join(config.ORACLE_STATE_DIR, 'user_profile.md'), 'utf-8')
  } catch {
    return ''
  }
}

const formatHistory = (history: ChatMessage[]): string => {
  if (history.length === 0) return ''
  const lines = history.map((m) => {
    const label = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Coordinator' : 'System'
    return `${label}: ${m.content}`
  })
  return `\n\n--- CONVERSATION HISTORY ---\n${lines.join('\n\n')}\n--- END HISTORY ---`
}

const buildFirstPassPrompt = (
  profile: string,
  oracleList: OracleSummary[],
  developerList: DeveloperSummary[],
  history: ChatMessage[],
  message: string
): string => {
  const oracleListStr = oracleList
    .map((o) => `- ${o.domain}${o.description ? ': ' + o.description : ''}`)
    .join('\n')

  const developerListStr = developerList.length
    ? developerList
        .map((d) => `- ${d.name} (${d.workspacePath}) ${d.online ? '[online]' : '[OFFLINE]'}`)
        .join('\n')
    : '(none configured)'

  let prompt = `You are a coordinator with LIVE access to:
1. Oracle knowledge bases — you can query any oracle fresh every turn.
2. Developer workers — code-executing agents that run Claude Code in a repo on dispatch.

Available oracles:
${oracleListStr}

Available developers:
${developerListStr}

## Commands

To query an oracle for context:
[query, oracle-domain]
your specific question
[end]

To dispatch a developer to execute work:
[dispatch, developer-name, mode]
clear detailed instructions for the developer
[end]

Modes:
- implement: developer will make changes, commit and push if git repo (use for actual work)
- clarify: developer reads the code and asks clarifying questions, never commits (use when instructions would be ambiguous)

## Required dispatch structure

Every dispatch you emit MUST contain these four labeled sections. The developer will refuse the dispatch (or proceed blindly) if any are missing or contradictory. Write them confidently — the user reviews and approves the dispatch before it executes, so being precise is more valuable than being tentative.

1. **STOP criteria** — exit condition if data is missing/ambiguous. Tell the developer when to halt and re-dispatch in clarify mode instead of guessing.
2. **Out of scope** — negative space. What the developer MUST NOT touch (themes, layouts, unrelated modules, schema rewrites, etc.).
3. **Commit/report contract** — exact commit messages expected (if any), whether to push, and what the final report back to you must contain.
4. **Read-before-write requirements** — which files/components/schemas must be read (bulk) before any write.

Use the exact labels above as markdown headers inside the dispatch body. Put the rest of the instructions (task description, acceptance criteria) above them or in another clearly-labeled section.

## Reliability: split large tasks

Prefer many small, dependency-ordered dispatches over one big bundle. Smaller scope = higher reliability. If a single request would cover 5+ unrelated areas, break it into 2–4 dispatches, each with its own four required sections.

## Execution ordering is the dispatch order

Developers process dispatches FIFO per developer — the order you emit the [dispatch, ...][end] blocks IS the order they will run. Order with dependency awareness:
- resume-prior-push / cleanup / migrations FIRST
- schema/type/contract changes BEFORE code that consumes them
- tests/docs AFTER the code they cover

Do NOT retroactively split dispatches that are already queued — this rule is forward-looking.

## Rules
- You can query multiple oracles and dispatch to developers in the same turn. Output ALL commands you need, then stop. Do NOT write any prose before or after the commands — let the synthesis pass produce the user-facing response.
- CRITICAL: If you intend to dispatch, you MUST use the [dispatch, ...][end] syntax. Describing a dispatch in prose ("I will dispatch X to do Y") does NOT actually dispatch anything. The command syntax is the only way to trigger real work.
- Dispatches are PROVISIONAL. They land in a 'pending' state and wait for the user to approve, cancel, or edit them via the chat badge. Do NOT ask the user "do you approve?" in prose — the badge buttons are the approval surface. Write instructions confidently as if they will run.
- Dispatches are fire-and-report — they return a runId the user can track. Don't wait for completion in your response.
- Prefer 'clarify' mode when the request is high-level or ambiguous. Prefer 'implement' when the user has been specific or confirmed the approach.
- If the question is purely conversational AND needs no oracle data or dispatch, respond directly in plain prose (no fake command formatting).
- Never assume. If the request is ambiguous, ask the user a clarifying question directly — do not dispatch blindly.
- NEVER tell the user you can't access oracles/developers — you can, every turn.
- Only dispatch to online developers.`

  if (profile) {
    prompt += `\n\n--- USER PROFILE ---\n${profile}\n--- END PROFILE ---`
  }

  prompt += formatHistory(history)
  prompt += `\n\nUser: ${message}`
  return prompt
}

interface DispatchResult {
  developer: string
  mode: RunMode
  runId: string | null
  instructions: string
  error: string | null
}

const buildSecondPassPrompt = (
  profile: string,
  oracleResponses: { domain: string; question: string; response: string }[],
  dispatchResults: DispatchResult[],
  history: ChatMessage[],
  message: string
): string => {
  let prompt = `You are a coordinator. You just queried oracles and/or dispatched developers — results are below. Synthesize a response for the user.

- Answer the user's question directly, using oracle data as source of truth.
- If you dispatched, tell the user briefly: which developer, mode, and that the dispatch is awaiting their approval in the chat badge. Dispatches do NOT execute until the user approves — treat them as provisional.
- Do NOT repeat the full dispatch instructions in your user message. The user can expand the dispatch badge to see them (and can edit them before approving).
- When you dispatched, ALWAYS include a "## Decisions I Made" section in your user-facing message. List the assumptions you made and ambiguities you resolved on the user's behalf (e.g. "picked implement over clarify because X", "scoped to module Y, skipped Z", "chose name/path W because V"). This is the user's chance to catch you before they approve the dispatch.
- Be dense. No filler, no meta-commentary about oracles or your process.
- You have live oracle/developer access every turn — never say otherwise.`

  if (profile) {
    prompt += `\n\n--- USER PROFILE ---\n${profile}\n--- END PROFILE ---`
  }

  for (const r of oracleResponses) {
    prompt += `\n\n--- ORACLE: ${r.domain} (Q: ${r.question}) ---\n${r.response}\n--- END ORACLE ---`
  }

  for (const d of dispatchResults) {
    if (d.error) {
      prompt += `\n\n--- DISPATCH FAILED: ${d.developer} ---\nError: ${d.error}\nInstructions attempted: ${d.instructions}\n--- END DISPATCH ---`
    } else {
      prompt += `\n\n--- DISPATCHED (pending approval): ${d.developer} (mode: ${d.mode}, runId: ${d.runId}) ---\nInstructions: ${d.instructions}\n--- END DISPATCH ---`
    }
  }

  prompt += formatHistory(history)
  prompt += `\n\nUser: ${message}`
  return prompt
}

const parseQueryCommands = (
  output: string
): { domain: string; question: string }[] => {
  const queries: { domain: string; question: string }[] = []
  const regex = /\[query,\s*([^\]]+)\]\s*\n([\s\S]*?)\n\[end\]/gi
  let match
  while ((match = regex.exec(output)) !== null) {
    queries.push({
      domain: match[1].trim(),
      question: match[2].trim(),
    })
  }
  return queries
}

const parseDispatchCommands = (
  output: string
): { developer: string; mode: RunMode; instructions: string }[] => {
  const dispatches: { developer: string; mode: RunMode; instructions: string }[] = []
  const regex = /\[dispatch,\s*([^,]+),\s*(implement|clarify)\]\s*\n([\s\S]*?)\n\[end\]/gi
  let match
  while ((match = regex.exec(output)) !== null) {
    dispatches.push({
      developer: match[1].trim(),
      mode: match[2].trim() as RunMode,
      instructions: match[3].trim(),
    })
  }
  return dispatches
}

// First pass: no tools, just routing decision. Prompt goes via stdin to avoid
// argv limits and shell-quote hazards on long synthesis prompts.
const runFirstPass = (prompt: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    const args = [
      '--dangerously-skip-permissions',
      '--print',
      '--tools', '',
      '--model', config.COORDINATOR_MODEL,
      '--system-prompt', 'You are a coordinator routing queries to oracle knowledge bases. Follow the instructions in the user message exactly.',
    ]

    const proc = spawn('claude', args, {
      env: { ...process.env },
      cwd: '/tmp',
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let output = ''
    let stderr = ''

    proc.stdout.on('data', (d) => { output += d.toString() })
    proc.stderr.on('data', (d) => { stderr += d.toString() })

    proc.stdin.write(prompt)
    proc.stdin.end()

    proc.on('close', (code) => {
      if (code === 0) resolve(output.trim())
      else {
        logger.error({ code, stderr: stderr.slice(0, 500) }, 'Coordinator first pass failed')
        reject(new Error(`First pass failed (${code}): ${stderr.slice(0, 200)}`))
      }
    })

    proc.on('error', reject)
  })
}

// Second pass: stream-json, no tools. Prompt via stdin (same reason as first pass).
const runSecondPass = async (
  prompt: string,
  onText: (text: string) => void
): Promise<string> => {
  return new Promise((resolve, reject) => {
    const args = [
      '--dangerously-skip-permissions',
      '--verbose',
      '--print',
      '--output-format', 'stream-json',
      '--tools', '',
      '--model', config.COORDINATOR_MODEL,
      '--system-prompt', 'You are a coordinator synthesizing oracle knowledge base responses. Follow the instructions in the user message exactly.',
    ]

    const proc = spawn('claude', args, {
      env: { ...process.env },
      cwd: '/tmp',
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    proc.stdin.write(prompt)
    proc.stdin.end()

    let fullText = ''
    let stderr = ''
    const rl = createInterface({ input: proc.stdout })

    rl.on('line', (line) => {
      if (!line.trim()) return
      try {
        const event = JSON.parse(line) as ClaudeStreamEvent

        if (event.type === 'assistant' && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'text' && block.text) {
              onText(block.text)
              fullText += block.text
            }
          }
        } else if (event.type === 'result' && event.result) {
          if (!fullText) {
            onText(event.result)
            fullText = event.result
          }
        }
      } catch {
        // non-JSON
      }
    })

    proc.stderr.on('data', (d) => { stderr += d.toString() })

    proc.on('close', (code) => {
      if (code === 0) resolve(fullText.trim())
      else {
        logger.error({ code, stderr: stderr.slice(0, 500) }, 'Coordinator second pass failed')
        reject(new Error(`Second pass failed (${code}): ${stderr.slice(0, 200)}`))
      }
    })

    proc.on('error', reject)
  })
}

export const run = async (
  message: string,
  history: ChatMessage[],
  emit: (event: CoordinatorEvent) => void
): Promise<string> => {
  const [profile, oracleList, developerList] = await Promise.all([
    loadUserProfile(),
    loadOracleList(),
    loadDeveloperList(),
  ])

  emit({ type: 'status', message: `Deciding (${oracleList.length} oracles, ${developerList.length} devs available)...` })

  const firstPassPrompt = buildFirstPassPrompt(profile, oracleList, developerList, history, message)
  const firstPassOutput = await runFirstPass(firstPassPrompt)
  const queries = parseQueryCommands(firstPassOutput)
  const dispatches = parseDispatchCommands(firstPassOutput)

  // Log every first-pass for debugging command parsing
  logger.info({
    queriesFound: queries.length,
    dispatchesFound: dispatches.length,
    outputPreview: firstPassOutput.slice(0, 800),
  }, 'Coordinator first pass decision')

  // No commands — direct answer
  if (queries.length === 0 && dispatches.length === 0) {
    logger.info('Coordinator answered directly')
    emit({ type: 'text', text: firstPassOutput })
    emit({ type: 'done' })
    return firstPassOutput
  }

  if (queries.length > 0) {
    emit({ type: 'status', message: `Querying ${queries.length} oracle(s): ${queries.map((q) => q.domain).join(', ')}` })
  }

  const [allOracles, allDevelopers] = await Promise.all([
    oracleQueries.listOracles(),
    developerQueries.listDevelopers(),
  ])
  const oraclesByDomain = new Map(allOracles.map((o) => [o.domain, o]))
  const developersByName = new Map(allDevelopers.map((d) => [d.name, d]))

  // Oracle queries + dispatches in parallel
  const [oracleResponses, dispatchResults] = await Promise.all([
    Promise.all(
      queries.map(async (q) => {
        const oracle = oraclesByDomain.get(q.domain)
        if (!oracle) {
          const r = { domain: q.domain, question: q.question, response: `[Oracle "${q.domain}" not found]` }
          emit({ type: 'oracle', ...r })
          return r
        }
        try {
          const response = await queryOracle(oracle.id, q.question)
          const r = { domain: q.domain, question: q.question, response }
          emit({ type: 'oracle', ...r })
          return r
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          const r = { domain: q.domain, question: q.question, response: `[Oracle query failed: ${msg}]` }
          emit({ type: 'oracle', ...r })
          return r
        }
      })
    ),
    Promise.all(
      dispatches.map(async (d): Promise<DispatchResult> => {
        const dev = developersByName.get(d.developer)
        if (!dev) {
          return { developer: d.developer, mode: d.mode, runId: null, instructions: d.instructions, error: `Developer "${d.developer}" not found` }
        }
        try {
          // Coordinator-initiated dispatches land in 'pending' and wait for
          // the user to approve or cancel them from the chat badge. We do
          // NOT call developerRegistry.dispatch here — approval drives that.
          const run = await developerQueries.createRun(dev.id, d.instructions, d.mode, 'pending')
          logger.info({ runId: run.id, developer: d.developer }, 'Dispatch pending approval')
          emit({
            type: 'dispatch',
            developer: d.developer,
            developerId: dev.id,
            mode: d.mode,
            runId: run.id,
            instructions: d.instructions,
            queued: false,
            pending: true,
          })
          return { developer: d.developer, mode: d.mode, runId: run.id, instructions: d.instructions, error: null }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { developer: d.developer, mode: d.mode, runId: null, instructions: d.instructions, error: msg }
        }
      })
    ),
  ])

  emit({ type: 'status', message: 'Synthesizing...' })

  const secondPrompt = buildSecondPassPrompt(profile, oracleResponses, dispatchResults, history, message)
  const fullText = await runSecondPass(secondPrompt, (text) => {
    emit({ type: 'text', text })
  })

  emit({ type: 'done' })
  return fullText
}
