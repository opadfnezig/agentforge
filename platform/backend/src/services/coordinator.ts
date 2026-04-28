import { readFile } from 'fs/promises'
import { join } from 'path'
import { parse as parseYaml } from 'yaml'
import { config } from '../config.js'
import { logger } from '../utils/logger.js'
import * as oracleQueries from '../db/queries/oracles.js'
import * as developerQueries from '../db/queries/developers.js'
import * as spawnerQueries from '../db/queries/spawners.js'
import { queryOracle } from './oracle-engine.js'
import { developerRegistry } from './developer-registry.js'
import type { RunMode, DeveloperRun } from '../schemas/developer.js'
import { spawnSpecSchema, PRIMITIVE_KINDS, type PrimitiveKind, type SpawnSpec } from '../schemas/spawner.js'
import {
  chatCompletion,
  chatCompletionStream,
  type MessageTrailer,
} from '../lib/anthropic-oauth.js'

const FIRST_PASS_SYSTEM_PROMPT =
  'You are a coordinator routing queries to oracle knowledge bases. Follow the instructions in the user message exactly.'
const SECOND_PASS_SYSTEM_PROMPT =
  'You are a coordinator synthesizing oracle knowledge base responses. Follow the instructions in the user message exactly.'

// Matches the implicit Claude Code default for Opus (verified via mitm-poc:
// `max_tokens: 64000` per request body capture). The replaced subprocess
// (`claude --print --tools ''`) didn't pass --max-tokens, so it used this same
// internal default. Preserving it keeps response budgets identical post-swap.
const COORDINATOR_MAX_TOKENS = 64_000

export interface TurnTrailer {
  first_pass: MessageTrailer
  second_pass: MessageTrailer | null
}

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
  | {
      type: 'read'
      runId: string
      found: boolean
      status: string | null
      developerName: string | null
      report: string
    }
  | {
      type: 'spawn'
      spawnerHostId: string
      hostId: string
      primitiveName: string
      primitiveKind: PrimitiveKind
      image: string
      spawnIntentId: string
      pending: boolean
      queued: boolean
    }
  | { type: 'text'; text: string }
  | { type: 'done' }

interface OracleSummary {
  domain: string
  description: string | null
}

interface DeveloperSummary {
  name: string
  workspacePath: string
  online: boolean
}

interface SpawnerHostSummary {
  hostId: string
  name: string
  status: string
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

const loadSpawnerHostList = async (): Promise<SpawnerHostSummary[]> => {
  const hosts = await spawnerQueries.listSpawnerHosts()
  return hosts.map((h) => ({ hostId: h.hostId, name: h.name, status: h.status }))
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
  spawnerHostList: SpawnerHostSummary[],
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

  const hostListStr = spawnerHostList.length
    ? spawnerHostList
        .map((h) => `- ${h.hostId} (${h.name}) [${h.status}]`)
        .join('\n')
    : '(none configured)'

  let prompt = `You are a coordinator with LIVE access to:
1. Oracle knowledge bases — you can query any oracle fresh every turn.
2. Developer workers — code-executing agents that run Claude Code in a repo on dispatch.
3. Spawner hosts — physical hosts that can spin up new developer/researcher containers via [spawn, ...].

Available oracles:
${oracleListStr}

Available developers:
${developerListStr}

Available spawner hosts:
${hostListStr}

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

To spawn a new primitive (developer or researcher container) on one of the registered hosts:
[spawn, host-id, primitive-name]
kind: developer
env:
  FOO: bar
mounts:
  - source: /host/path
    target: /in/container
    readOnly: false
command: ["node", "x.js"]
args: ["--flag"]
[end]

The body is YAML. Required field: \`kind\` (developer | researcher). \`image\` is optional — when omitted, the spawner builds the primitive from the host's local source tree based on \`kind\` (e.g. developer → /ntfr/agentforge/developer). Only set \`image\` if you have a real registry tag in mind; otherwise leave it out. All other fields are optional. \`primitive-name\` must match \`[a-z0-9][a-z0-9_-]*\` and is unique per host. Spawning a primitive does NOT register a developer in this app — that's a separate manual step (or a future automation). Use [spawn, ...] when the user explicitly asks for a new container; do not spawn opportunistically.

To pull the report for a previously dispatched run by its UUID:
[read, run-id]
[end]

Reports are PULL-ONLY — they are NEVER auto-injected into your context. You must explicitly issue [read, run-id] for each report you want to see. Use this when:
- The user asks "what did run X say?" / "did the dispatch finish?" / "show me the result".
- You need a prior run's outcome to inform the next dispatch (e.g. follow-up work that depends on what was changed).
- You want to verify a dispatch landed before queueing dependent work.

The runId is the UUID shown in the dispatch badge (e.g. \`c5278321-9a83-4a01-b3ca-b2659cd24948\`). It's also returned in your previous synthesis turn whenever you emit a [dispatch, ...].

Behavior by run state:
- completed (success / no_changes): returns final report text + git SHAs + push status + cost/duration trailer.
- failed: returns error message + whatever final text was captured.
- still running / queued / pending: returns current status + elapsed time. No partial output is streamed — re-issue [read, ...] later to check again.
- cancelled: returns cancelled marker.
- unknown id: returns "run not found".

Reads are cheap (DB lookup, no LLM call). Read multiple in one turn if useful. Do NOT read every dispatch reflexively — only when the report content actually informs your next decision.

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
  readResults: ReadResult[],
  spawnResults: SpawnResult[],
  history: ChatMessage[],
  message: string
): string => {
  let prompt = `You are a coordinator. You just queried oracles, dispatched developers, spawned primitives, and/or pulled run reports — results are below. Synthesize a response for the user.

- Answer the user's question directly, using oracle data and run reports as source of truth.
- If you dispatched, tell the user briefly: which developer, mode, and that the dispatch is awaiting their approval in the chat badge. Dispatches do NOT execute until the user approves — treat them as provisional.
- Do NOT repeat the full dispatch instructions in your user message. The user can expand the dispatch badge to see them (and can edit them before approving).
- When you dispatched, ALWAYS include a "## Decisions I Made" section in your user-facing message. List the assumptions you made and ambiguities you resolved on the user's behalf (e.g. "picked implement over clarify because X", "scoped to module Y, skipped Z", "chose name/path W because V"). This is the user's chance to catch you before they approve the dispatch.
- If you spawned, the same "Decisions I Made" rule applies: list assumed image tags, env vars, mount paths. Spawn intents are also pending approval — the user clicks Approve in the spawn badge to actually create the container on the spawner host.
- If you pulled a run report, summarize what the run accomplished (or failed at) — the user wants the takeaway, not a dump of the full report. They can expand the read badge to see the raw text.
- Be dense. No filler, no meta-commentary about oracles or your process.
- You have live oracle/developer/spawner access every turn — never say otherwise.`

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

  for (const r of readResults) {
    prompt += `\n\n--- READ RUN: ${r.runId} ---\n${r.report}\n--- END READ ---`
  }

  for (const s of spawnResults) {
    if (s.error) {
      prompt += `\n\n--- SPAWN FAILED: ${s.primitiveName} on ${s.hostId} ---\nError: ${s.error}\n--- END SPAWN ---`
    } else {
      prompt += `\n\n--- SPAWN PROPOSED (pending approval): ${s.primitiveName} (${s.primitiveKind}) on ${s.hostId} ---\nImage: ${s.image}\nIntent: ${s.intentId}\n--- END SPAWN ---`
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

// Pull-on-demand: [read, run-id] [end]. Body is intentionally empty (the
// runId fully identifies the report to fetch). Tolerant of an optional
// blank/comment line between the header and [end] so model output that drifts
// from the strict shape still parses.
const parseReadCommands = (output: string): { runId: string }[] => {
  const reads: { runId: string }[] = []
  const regex = /\[read,\s*([^\]]+)\]\s*(?:\n[\s\S]*?)?\n?\[end\]/gi
  let match
  while ((match = regex.exec(output)) !== null) {
    reads.push({ runId: match[1].trim() })
  }
  return reads
}

interface ParsedSpawnCommand {
  hostId: string
  primitiveName: string
  body: string
  spec: SpawnSpec | null
  parseError: string | null
}

// [spawn, host-id, primitive-name]\n<YAML body>\n[end]. Body is parsed as
// YAML; required fields are `kind` (developer|researcher) and `image`.
// Errors are not thrown — they're returned in `parseError` so the caller
// can surface them in the SSE stream as a failure event without aborting
// other commands in the same turn.
const parseSpawnCommands = (output: string): ParsedSpawnCommand[] => {
  const commands: ParsedSpawnCommand[] = []
  const regex = /\[spawn,\s*([^,\]]+),\s*([^\]]+)\]\s*\n([\s\S]*?)\n\[end\]/gi
  let match
  while ((match = regex.exec(output)) !== null) {
    const hostId = match[1].trim()
    const primitiveName = match[2].trim()
    const body = match[3]
    let spec: SpawnSpec | null = null
    let parseError: string | null = null
    try {
      const parsed = parseYaml(body)
      if (!parsed || typeof parsed !== 'object') {
        parseError = 'spawn body must be a YAML object with kind + image fields'
      } else {
        const kind = (parsed as Record<string, unknown>).kind
        if (!kind || !PRIMITIVE_KINDS.includes(kind as PrimitiveKind)) {
          parseError = `kind must be one of ${PRIMITIVE_KINDS.join(' | ')} (got ${JSON.stringify(kind)})`
        } else {
          // Build a candidate spec and validate via Zod for the rest of the shape.
          const candidate = {
            ...(parsed as Record<string, unknown>),
            name: primitiveName,
            kind,
          }
          const result = spawnSpecSchema.safeParse(candidate)
          if (!result.success) {
            parseError = result.error.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join('; ')
          } else {
            spec = result.data
          }
        }
      }
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err)
    }
    commands.push({ hostId, primitiveName, body, spec, parseError })
  }
  return commands
}

interface SpawnResult {
  hostId: string
  primitiveName: string
  intentId: string | null
  primitiveKind: PrimitiveKind | null
  image: string | null
  error: string | null
}

interface ReadResult {
  runId: string
  found: boolean
  status: string | null
  developerName: string | null
  report: string
}

const formatTimestamp = (d: Date | string | null): string | null => {
  if (!d) return null
  const dt = typeof d === 'string' ? new Date(d) : d
  if (Number.isNaN(dt.getTime())) return null
  return dt.toISOString()
}

const formatRunReport = (run: DeveloperRun, developerName: string | null): string => {
  const lines: string[] = []
  lines.push(`runId: ${run.id}`)
  lines.push(`developer: ${developerName ?? run.developerId}`)
  lines.push(`mode: ${run.mode}`)
  lines.push(`status: ${run.status}`)

  const created = formatTimestamp(run.createdAt)
  const started = formatTimestamp(run.startedAt)
  const finished = formatTimestamp(run.finishedAt)
  if (created) lines.push(`created: ${created}`)
  if (started) lines.push(`started: ${started}`)
  if (finished) lines.push(`finished: ${finished}`)

  // Elapsed for in-flight runs so the coordinator can decide whether to wait.
  if (started && !finished) {
    const elapsedMs = Date.now() - new Date(started).getTime()
    if (Number.isFinite(elapsedMs) && elapsedMs >= 0) {
      lines.push(`elapsed_ms: ${elapsedMs}`)
    }
  }

  if (run.gitShaStart) lines.push(`git_sha_start: ${run.gitShaStart}`)
  if (run.gitShaEnd) lines.push(`git_sha_end: ${run.gitShaEnd}`)
  if (run.pushStatus) lines.push(`push_status: ${run.pushStatus}`)
  if (run.pushError) lines.push(`push_error: ${run.pushError}`)
  if (run.model) lines.push(`model: ${run.model}`)
  if (typeof run.totalCostUsd === 'number') lines.push(`total_cost_usd: ${run.totalCostUsd}`)
  if (typeof run.durationMs === 'number') lines.push(`duration_ms: ${run.durationMs}`)
  if (run.stopReason) lines.push(`stop_reason: ${run.stopReason}`)

  // Report body. For terminal runs this is the developer's final message.
  // For in-flight runs response is null — surface that explicitly so the
  // coordinator doesn't think the run finished silently.
  if (run.response) {
    lines.push('')
    lines.push('--- Final report ---')
    lines.push(run.response)
  } else if (run.status === 'pending') {
    lines.push('')
    lines.push('(Awaiting user approval in the chat badge — no work has started.)')
  } else if (run.status === 'queued') {
    lines.push('')
    lines.push('(Approved and queued — waiting for an idle developer.)')
  } else if (run.status === 'running') {
    lines.push('')
    lines.push('(Still running — no final report yet. Re-read later for the result.)')
  } else if (run.status === 'cancelled') {
    lines.push('')
    lines.push('(Cancelled before completion — no report.)')
  }

  if (run.errorMessage) {
    lines.push('')
    lines.push('--- Error ---')
    lines.push(run.errorMessage)
  }

  return lines.join('\n')
}

// First pass: routing decision. Non-streaming — we want the full output before
// parsing for [query]/[dispatch]/[read] commands.
const runFirstPassDirect = async (prompt: string): Promise<{ text: string; trailer: MessageTrailer }> => {
  const result = await chatCompletion({
    model: config.COORDINATOR_MODEL,
    systemPrompt: FIRST_PASS_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: COORDINATOR_MAX_TOKENS,
  })
  return { text: result.content.trim(), trailer: result.trailer }
}

// Second pass: streaming synthesis. Each text token is emitted via onText so
// the SSE channel can forward it as the existing { type: 'text' } event.
const runSecondPassDirect = async (
  prompt: string,
  onText: (text: string) => void,
): Promise<{ text: string; trailer: MessageTrailer }> => {
  const result = await chatCompletionStream(
    {
      model: config.COORDINATOR_MODEL,
      systemPrompt: SECOND_PASS_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: COORDINATOR_MAX_TOKENS,
    },
    onText,
  )
  return { text: result.content.trim(), trailer: result.trailer }
}

export const run = async (
  message: string,
  history: ChatMessage[],
  emit: (event: CoordinatorEvent) => void
): Promise<{ text: string; trailer: TurnTrailer }> => {
  const [profile, oracleList, developerList, spawnerHostList] = await Promise.all([
    loadUserProfile(),
    loadOracleList(),
    loadDeveloperList(),
    loadSpawnerHostList(),
  ])

  emit({ type: 'status', message: `Deciding (${oracleList.length} oracles, ${developerList.length} devs, ${spawnerHostList.length} hosts available)...` })

  const firstPassPrompt = buildFirstPassPrompt(profile, oracleList, developerList, spawnerHostList, history, message)
  const { text: firstPassOutput, trailer: firstPassTrailer } = await runFirstPassDirect(firstPassPrompt)
  const queries = parseQueryCommands(firstPassOutput)
  const dispatches = parseDispatchCommands(firstPassOutput)
  const reads = parseReadCommands(firstPassOutput)
  const spawns = parseSpawnCommands(firstPassOutput)

  // Log every first-pass for debugging command parsing
  logger.info({
    queriesFound: queries.length,
    dispatchesFound: dispatches.length,
    readsFound: reads.length,
    spawnsFound: spawns.length,
    outputPreview: firstPassOutput.slice(0, 800),
    firstPassCostUsd: firstPassTrailer.cost_usd,
    firstPassTokens: { input: firstPassTrailer.input_tokens, output: firstPassTrailer.output_tokens },
  }, 'Coordinator first pass decision')

  // No commands — direct answer
  if (
    queries.length === 0 &&
    dispatches.length === 0 &&
    reads.length === 0 &&
    spawns.length === 0
  ) {
    logger.info('Coordinator answered directly')
    emit({ type: 'text', text: firstPassOutput })
    emit({ type: 'done' })
    return { text: firstPassOutput, trailer: { first_pass: firstPassTrailer, second_pass: null } }
  }

  if (queries.length > 0) {
    emit({ type: 'status', message: `Querying ${queries.length} oracle(s): ${queries.map((q) => q.domain).join(', ')}` })
  }
  if (reads.length > 0) {
    emit({ type: 'status', message: `Reading ${reads.length} run report(s)` })
  }
  if (spawns.length > 0) {
    emit({ type: 'status', message: `Proposing ${spawns.length} spawn(s)` })
  }

  const [allOracles, allDevelopers, allHosts] = await Promise.all([
    oracleQueries.listOracles(),
    developerQueries.listDevelopers(),
    spawnerQueries.listSpawnerHosts(),
  ])
  const oraclesByDomain = new Map(allOracles.map((o) => [o.domain, o]))
  const developersByName = new Map(allDevelopers.map((d) => [d.name, d]))
  const developersById = new Map(allDevelopers.map((d) => [d.id, d]))
  const hostsByHostId = new Map(allHosts.map((h) => [h.hostId, h]))

  // Oracle queries + dispatches + reads + spawns in parallel
  const [oracleResponses, dispatchResults, readResults, spawnResults] = await Promise.all([
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
    Promise.all(
      reads.map(async (r): Promise<ReadResult> => {
        // UUID format check up front — anything else is almost certainly a
        // typo, and getRun would round-trip to the DB just to return null.
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(r.runId)
        if (!isUuid) {
          const result: ReadResult = {
            runId: r.runId,
            found: false,
            status: null,
            developerName: null,
            report: `Run id "${r.runId}" is not a valid UUID. Run ids look like c5278321-9a83-4a01-b3ca-b2659cd24948 — copy them from a dispatch badge in this chat.`,
          }
          emit({ type: 'read', ...result })
          return result
        }
        try {
          const run = await developerQueries.getRun(r.runId)
          if (!run) {
            const result: ReadResult = {
              runId: r.runId,
              found: false,
              status: null,
              developerName: null,
              report: `Run "${r.runId}" not found.`,
            }
            emit({ type: 'read', ...result })
            return result
          }
          const dev = developersById.get(run.developerId)
          const developerName = dev?.name ?? null
          const result: ReadResult = {
            runId: run.id,
            found: true,
            status: run.status,
            developerName,
            report: formatRunReport(run, developerName),
          }
          emit({ type: 'read', ...result })
          return result
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          const result: ReadResult = {
            runId: r.runId,
            found: false,
            status: null,
            developerName: null,
            report: `[Read failed: ${msg}]`,
          }
          emit({ type: 'read', ...result })
          return result
        }
      })
    ),
    Promise.all(
      spawns.map(async (s): Promise<SpawnResult> => {
        // Surface parser errors as failed spawn results without aborting the
        // turn — same shape as a Dispatch error so the second pass can mention
        // them in the synthesized response.
        if (s.parseError || !s.spec) {
          return {
            hostId: s.hostId,
            primitiveName: s.primitiveName,
            intentId: null,
            primitiveKind: null,
            image: null,
            error: s.parseError ?? 'spawn body did not parse',
          }
        }
        const host = hostsByHostId.get(s.hostId)
        // Fall back to a synthetic label when no image was provided —
        // matches what createSpawnIntent persists, so the same string is
        // shown in coordinator events, spawn results, and DB rows.
        const imageLabel = s.spec.image ?? `local-build:${s.spec.kind}`
        if (!host) {
          return {
            hostId: s.hostId,
            primitiveName: s.primitiveName,
            intentId: null,
            primitiveKind: s.spec.kind,
            image: imageLabel,
            error: `Spawner host "${s.hostId}" not registered`,
          }
        }
        try {
          const intent = await spawnerQueries.createSpawnIntent(host.id, s.spec)
          logger.info(
            {
              intentId: intent.id,
              hostId: host.hostId,
              primitive: s.primitiveName,
              kind: s.spec.kind,
            },
            'Spawn intent pending approval'
          )
          emit({
            type: 'spawn',
            spawnerHostId: host.id,
            hostId: host.hostId,
            primitiveName: s.spec.name,
            primitiveKind: s.spec.kind,
            image: imageLabel,
            spawnIntentId: intent.id,
            pending: true,
            queued: false,
          })
          return {
            hostId: s.hostId,
            primitiveName: s.primitiveName,
            intentId: intent.id,
            primitiveKind: s.spec.kind,
            image: imageLabel,
            error: null,
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return {
            hostId: s.hostId,
            primitiveName: s.primitiveName,
            intentId: null,
            primitiveKind: s.spec.kind,
            image: imageLabel,
            error: msg,
          }
        }
      })
    ),
  ])

  emit({ type: 'status', message: 'Synthesizing...' })

  const secondPrompt = buildSecondPassPrompt(profile, oracleResponses, dispatchResults, readResults, spawnResults, history, message)
  const { text: fullText, trailer: secondPassTrailer } = await runSecondPassDirect(secondPrompt, (text) => {
    emit({ type: 'text', text })
  })

  logger.info({
    secondPassCostUsd: secondPassTrailer.cost_usd,
    secondPassTokens: { input: secondPassTrailer.input_tokens, output: secondPassTrailer.output_tokens },
    stopReason: secondPassTrailer.stop_reason,
  }, 'Coordinator second pass complete')

  emit({ type: 'done' })
  return { text: fullText, trailer: { first_pass: firstPassTrailer, second_pass: secondPassTrailer } }
}
