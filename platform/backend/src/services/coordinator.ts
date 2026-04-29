import { readFile } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
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

// Multi-stage first pass: how many command iterations the model gets before we
// pause for explicit user approval. Each stage = one runFirstPassDirect call
// followed by parallel execution of any commands it emitted. Resumption gets
// another full window. No hard cap — the user can approve as many windows as
// they want.
const STAGE_BUDGET = 4

// In-memory store of paused multi-stage turns keyed by continuation id. Held
// for CONTINUATION_TTL_MS so an unattended approval window doesn't leak
// indefinitely. Lost on process restart — frontend handles 404 by surfacing
// the error so the user can retry from scratch.
const CONTINUATION_TTL_MS = 30 * 60 * 1000

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
  | { type: 'stage_start'; stage: number; window: number }
  | {
      type: 'stages_paused'
      continuationId: string
      stagesUsedThisWindow: number
      stagesUsedTotal: number
      pendingHint: string
    }
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
  message: string,
  priorStages: StageAccumulator | null = null,
  currentStage = 1,
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

Oracles are containerized primitives that serve three modes:
- read: query memories, returns synthesis. (This is what [query, ...] uses.)
- write: merge incoming notes into memories. (Driven by [save, oracle-domain] in user-edited assistant messages.)
- migrate: agent-driven — read files staged in /data, fold into memories, delete originals.

If an oracle is offline (its container hasn't been spawned), [query, ...] returns "[Oracle query failed: …offline…]". Spawn the oracle's container via [spawn, host-id, oracle-name] with \`kind: oracle\` to bring it back online.

To dispatch a developer to execute work:
[dispatch, developer-name, mode]
clear detailed instructions for the developer
[end]

Modes:
- implement: developer will make changes, commit and push if git repo (use for actual work)
- clarify: developer reads the code and asks clarifying questions, never commits (use when instructions would be ambiguous)

To spawn a new primitive (developer / researcher / oracle container) on one of the registered hosts:
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

The body is YAML. Required field: \`kind\` (developer | researcher | oracle). \`image\` is optional — when omitted, the spawner builds the primitive from the host's local source tree based on \`kind\`. Only set \`image\` if you have a real registry tag in mind; otherwise leave it out. All other fields are optional. \`primitive-name\` must match \`[a-z0-9][a-z0-9_-]*\` and is unique per host. Spawning a primitive does NOT register a developer in this app — that's a separate manual step (or a future automation). Use [spawn, ...] when the user explicitly asks for a new container; do not spawn opportunistically.

**Naming convention by kind** — primitive name = container name on the host, so prefix it by kind for grep-ability:
- \`kind: oracle\` → \`primitive-name\` MUST be \`oracle-<name>\` (e.g. \`oracle-hearth\`, \`oracle-trading\`). The \`oracle-\` prefix is stripped server-side to derive the underlying oracle name / domain / state_dir; only the container is prefixed.
- \`kind: developer\` / \`kind: researcher\` → no prefix required.

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

## Multi-stage shape (IMPORTANT)

A single user turn runs in iterative stages. Each stage you may emit any combination of [query], [read], [dispatch], [spawn] commands. After each stage executes, the results are appended to your context AND YOU ARE INVOKED AGAIN as another first-pass — same prompt, same affordances. You keep going until you emit no commands; then a synthesis pass writes the user-facing reply.

**This means:** when you need oracle/read results to decide what to dispatch, you do NOT have to commit to the dispatch upfront. The right pattern:
- Stage 1 — emit only the [query, ...] / [read, ...] commands you need data from.
- Stage 2 — see the results, then emit the [dispatch, ...] using them.
- Stage 3+ — keep going if needed (more queries based on prior responses, dependent dispatches, etc.).
- Final stage — emit no commands. Synthesis runs and writes the user-facing reply.

You get ${STAGE_BUDGET} stages before the user is asked to approve continuing. They can approve as many windows as they want, so don't artificially compress — split work across stages whenever splitting makes the dispatch instructions sharper. But also don't pad: emit no commands the moment you have what you need.

Synthesis is text-only — it is NEVER scanned for commands. Anything that needs to "do" something MUST be a command, in some stage, before synthesis runs. Describing a dispatch in synthesis prose ("I will dispatch X" / "Dispatched X — pending approval") does not dispatch anything; it produces a fake-looking message with no badge.

## Rules
- You can mix [query] / [read] / [dispatch] / [spawn] in any single stage. Output ALL commands for the current stage, then stop. Do NOT write any prose before or after the commands.
- CRITICAL: If you intend to dispatch, you MUST use the [dispatch, ...][end] syntax in some stage. Describing a dispatch in prose does NOT actually dispatch anything.
- Dispatches are PROVISIONAL. They land in a 'pending' state and wait for the user to approve, cancel, or edit them via the chat badge. Do NOT ask the user "do you approve?" in prose — the badge buttons are the approval surface. Write instructions confidently as if they will run.
- Dispatches are fire-and-report — they return a runId the user can track. Don't wait for completion in your response.
- Do NOT re-emit a command across stages. Each prior stage's results are visible in your context — treat them as already executed.
- Prefer 'clarify' mode when the request is high-level or ambiguous. Prefer 'implement' when the user has been specific or confirmed the approach.
- If the question is purely conversational AND needs no oracle data or dispatch, respond directly in plain prose (no fake command formatting). This counts as "no commands" and skips synthesis — the prose IS the reply.
- Never assume. If the request is ambiguous, ask the user a clarifying question directly — do not dispatch blindly.
- NEVER tell the user you can't access oracles/developers — you can, every turn.
- Only dispatch to online developers.`

  if (profile) {
    prompt += `\n\n--- USER PROFILE ---\n${profile}\n--- END PROFILE ---`
  }

  prompt += formatHistory(history)
  prompt += `\n\nUser: ${message}`

  // Inject prior-stage results so the model can decide what (if anything) to
  // emit next based on what it already pulled. Format matches synthesis-pass
  // result blocks so the shape stays consistent across passes.
  if (priorStages && !accumulatorEmpty(priorStages)) {
    prompt += `\n\n--- RESULTS FROM PRIOR STAGES IN THIS TURN ---${formatStageResults(priorStages)}\n--- END PRIOR STAGES ---`
    prompt += `\n\nThis is stage ${currentStage}. Emit any further commands you need (treating the above as already executed — do NOT re-emit), or emit no commands to proceed to the synthesis pass.`
  }

  return prompt
}

interface DispatchResult {
  developer: string
  developerId: string | null
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
  const dispatched = dispatchResults.filter((d) => !d.error)
  const dispatchFailed = dispatchResults.filter((d) => d.error)
  const spawned = spawnResults.filter((s) => !s.error)
  const reads = readResults
  const oraclesUsed = oracleResponses

  // CRITICAL framing: enumerate what ACTUALLY happened so the model can't
  // narrate something different. The previous prompt opened with "you just
  // dispatched developers" unconditionally — that primed past-tense
  // narration even when no dispatch was emitted. The model would then write
  // "Dispatched X — pending approval" with no command behind it. The lists
  // below are the ground truth.
  const truthLines: string[] = []
  truthLines.push(`Oracles consulted: ${oraclesUsed.length}`)
  truthLines.push(`Dispatches emitted: ${dispatched.length}${dispatchFailed.length > 0 ? ` (plus ${dispatchFailed.length} failed)` : ''}`)
  truthLines.push(`Reads pulled: ${reads.length}`)
  truthLines.push(`Spawns proposed: ${spawned.length}`)
  const truth = truthLines.join('\n')

  let prompt = `You are a coordinator. The user's turn ran across one or more stages of [query]/[read]/[dispatch]/[spawn] commands. The actual results from those stages are below. Synthesize the user-facing reply.

GROUND TRUTH FOR THIS TURN — narrate ONLY this:
${truth}

CRITICAL — do not narrate actions that did not happen:
- If "Dispatches emitted" is 0, you MUST NOT write "Dispatched X" / "I dispatched X" / "X is pending approval in a badge" anywhere. There is no badge. Saying so produces a fake message and the user loses trust.
- If "Spawns proposed" is 0, you MUST NOT claim a spawn happened.
- If "Reads pulled" is 0, do not claim you read a run report.
- If you wanted to dispatch but didn't, just say so plainly: "I have the data; want me to dispatch X to do Y?" — let the user trigger the next turn.
- The result blocks below are exhaustive. Anything not listed there did not happen this turn.

Style:
- Answer the user's question directly, using oracle data and run reports as source of truth.
- For each real dispatch (one that appears in a DISPATCHED block below), tell the user briefly: which developer, mode, and that it's awaiting approval in the chat badge.
- Do NOT repeat the full dispatch instructions in your user message. The user can expand the dispatch badge to see them (and can edit them before approving).
- When you dispatched, ALWAYS include a "## Decisions I Made" section listing assumptions/ambiguities you resolved (e.g. "picked implement over clarify because X", "scoped to module Y, skipped Z"). This is the user's chance to catch you before they approve.
- If you spawned, same "Decisions I Made" rule applies for image tags, env vars, mount paths.
- If you pulled a run report, summarize the takeaway — the user can expand the read badge for raw text.
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
    const rawPrimitiveName = match[2].trim()
    const body = match[3]
    let spec: SpawnSpec | null = null
    let parseError: string | null = null
    let primitiveName = rawPrimitiveName
    try {
      const parsed = parseYaml(body)
      if (!parsed || typeof parsed !== 'object') {
        parseError = 'spawn body must be a YAML object with kind + image fields'
      } else {
        const kind = (parsed as Record<string, unknown>).kind
        if (!kind || !PRIMITIVE_KINDS.includes(kind as PrimitiveKind)) {
          parseError = `kind must be one of ${PRIMITIVE_KINDS.join(' | ')} (got ${JSON.stringify(kind)})`
        } else {
          // Naming convention: oracle primitives are container-prefixed
          // `oracle-<name>` so they're greppable on the host (and the
          // approve handler strips the prefix to derive the underlying
          // oracle.name / domain / state_dir). If the model forgot the
          // prefix, we add it defensively rather than failing — log so we
          // notice if the prompt drifts.
          if (kind === 'oracle' && !primitiveName.startsWith('oracle-')) {
            logger.warn({ primitiveName }, 'Oracle spawn missing oracle- prefix; auto-prefixing')
            primitiveName = `oracle-${primitiveName}`
          }
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

// --- Multi-stage state -------------------------------------------------------

export interface StageAccumulator {
  oracleResponses: { domain: string; question: string; response: string }[]
  dispatchResults: DispatchResult[]
  readResults: ReadResult[]
  spawnResults: SpawnResult[]
}

const newAccumulator = (): StageAccumulator => ({
  oracleResponses: [],
  dispatchResults: [],
  readResults: [],
  spawnResults: [],
})

const accumulatorEmpty = (a: StageAccumulator): boolean =>
  a.oracleResponses.length === 0 &&
  a.dispatchResults.length === 0 &&
  a.readResults.length === 0 &&
  a.spawnResults.length === 0

// Same block format used by both pass-1 (priors) and pass-2 (synthesis input)
// so the model sees a consistent shape across stages.
const formatStageResults = (a: StageAccumulator): string => {
  const out: string[] = []
  for (const r of a.oracleResponses) {
    out.push(`\n\n--- ORACLE: ${r.domain} (Q: ${r.question}) ---\n${r.response}\n--- END ORACLE ---`)
  }
  for (const d of a.dispatchResults) {
    if (d.error) {
      out.push(`\n\n--- DISPATCH FAILED: ${d.developer} ---\nError: ${d.error}\nInstructions attempted: ${d.instructions}\n--- END DISPATCH ---`)
    } else {
      out.push(`\n\n--- DISPATCHED (pending approval): ${d.developer} (mode: ${d.mode}, runId: ${d.runId}) ---\nInstructions: ${d.instructions}\n--- END DISPATCH ---`)
    }
  }
  for (const r of a.readResults) {
    out.push(`\n\n--- READ RUN: ${r.runId} ---\n${r.report}\n--- END READ ---`)
  }
  for (const s of a.spawnResults) {
    if (s.error) {
      out.push(`\n\n--- SPAWN FAILED: ${s.primitiveName} on ${s.hostId} ---\nError: ${s.error}\n--- END SPAWN ---`)
    } else {
      out.push(`\n\n--- SPAWN PROPOSED (pending approval): ${s.primitiveName} (${s.primitiveKind}) on ${s.hostId} ---\nImage: ${s.image}\nIntent: ${s.intentId}\n--- END SPAWN ---`)
    }
  }
  return out.join('')
}

// Snapshot of everything `run()` needs to keep going across a pause/resume.
// We snapshot once at the start of a new turn (oracleList, developerList,
// hosts, profile) so registry updates mid-window don't change the shape the
// model has been reasoning against.
interface RuntimeState {
  message: string
  history: ChatMessage[]
  profile: string
  oracleList: OracleSummary[]
  developerList: DeveloperSummary[]
  spawnerHostList: SpawnerHostSummary[]
}

interface ContinuationState {
  runtime: RuntimeState
  accumulator: StageAccumulator
  // Sum-trailer for all first-pass calls executed so far across windows.
  firstPassTrailer: MessageTrailer
  stagesUsedTotal: number
  createdAt: number
}

const pendingContinuations = new Map<string, ContinuationState>()

// Sum two trailers field-wise so the chat-message-level rollup reflects the
// real cost across an arbitrary number of stages.
const zeroTrailer = (): MessageTrailer => ({
  model: null,
  message_id: null,
  stop_reason: null,
  stop_sequence: null,
  duration_ms: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cost_usd: 0,
})

const addTrailer = (a: MessageTrailer, b: MessageTrailer): MessageTrailer => ({
  model: b.model ?? a.model,
  message_id: b.message_id ?? a.message_id,
  stop_reason: b.stop_reason ?? a.stop_reason,
  stop_sequence: b.stop_sequence ?? a.stop_sequence,
  duration_ms: a.duration_ms + b.duration_ms,
  input_tokens: a.input_tokens + b.input_tokens,
  output_tokens: a.output_tokens + b.output_tokens,
  cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
  cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
  cost_usd: a.cost_usd + b.cost_usd,
})

// Run all of one stage's commands in parallel and emit per-result SSE events.
// Pure data in / events out — no state mutation. The caller appends results
// onto the long-lived accumulator.
const executeStage = async (
  cmds: {
    queries: { domain: string; question: string }[]
    dispatches: { developer: string; mode: RunMode; instructions: string }[]
    reads: { runId: string }[]
    spawns: ParsedSpawnCommand[]
  },
  emit: (event: CoordinatorEvent) => void,
): Promise<{
  oracleResponses: { domain: string; question: string; response: string }[]
  dispatchResults: DispatchResult[]
  readResults: ReadResult[]
  spawnResults: SpawnResult[]
}> => {
  const [allOracles, allDevelopers, allHosts] = await Promise.all([
    oracleQueries.listOracles(),
    developerQueries.listDevelopers(),
    spawnerQueries.listSpawnerHosts(),
  ])
  const oraclesByDomain = new Map(allOracles.map((o) => [o.domain, o]))
  const developersByName = new Map(allDevelopers.map((d) => [d.name, d]))
  const developersById = new Map(allDevelopers.map((d) => [d.id, d]))
  const hostsByHostId = new Map(allHosts.map((h) => [h.hostId, h]))

  const [oracleResponses, dispatchResults, readResults, spawnResults] = await Promise.all([
    Promise.all(
      cmds.queries.map(async (q) => {
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
      cmds.dispatches.map(async (d): Promise<DispatchResult> => {
        const dev = developersByName.get(d.developer)
        if (!dev) {
          // Surface lookup failures to the user via SSE — silent failure
          // here was the prior bug class (badge never appeared, model later
          // claimed dispatch happened in synthesis prose).
          const result: DispatchResult = {
            developer: d.developer,
            developerId: null,
            mode: d.mode,
            runId: null,
            instructions: d.instructions,
            error: `Developer "${d.developer}" not found`,
          }
          logger.warn({ developer: d.developer }, 'Dispatch failed: developer not found')
          return result
        }
        try {
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
          return { developer: d.developer, developerId: dev.id, mode: d.mode, runId: run.id, instructions: d.instructions, error: null }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.error({ developer: d.developer, error: msg }, 'Dispatch failed: createRun threw')
          return { developer: d.developer, developerId: dev.id, mode: d.mode, runId: null, instructions: d.instructions, error: msg }
        }
      })
    ),
    Promise.all(
      cmds.reads.map(async (r): Promise<ReadResult> => {
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
      cmds.spawns.map(async (s): Promise<SpawnResult> => {
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
            error: imageLabel ? msg : msg,
          }
        }
      })
    ),
  ])

  return { oracleResponses, dispatchResults, readResults, spawnResults }
}

// Single hot-path used by both `run()` (fresh turn) and `resumeRun()` (after
// an approval window). Loops through stages until the model emits no commands
// or we hit STAGE_BUDGET stages this window. On budget exhaustion we save a
// continuation and emit `stages_paused`. On no-commands we either return the
// stage-1 prose directly (zero-command turn) or run the synthesis pass.
const runMultiStage = async (
  state: RuntimeState,
  emit: (event: CoordinatorEvent) => void,
  resumeFrom: ContinuationState | null,
): Promise<{ text: string; trailer: TurnTrailer; paused: boolean; accumulator: StageAccumulator }> => {
  const accumulator = resumeFrom?.accumulator ?? newAccumulator()
  let firstPassTrailerSum = resumeFrom?.firstPassTrailer ?? zeroTrailer()
  const stagesUsedTotalAtStart = resumeFrom?.stagesUsedTotal ?? 0
  let stagesUsedThisWindow = 0

  while (true) {
    stagesUsedThisWindow++
    const stage = stagesUsedTotalAtStart + stagesUsedThisWindow
    emit({ type: 'stage_start', stage, window: stagesUsedThisWindow })

    const firstPassPrompt = buildFirstPassPrompt(
      state.profile,
      state.oracleList,
      state.developerList,
      state.spawnerHostList,
      state.history,
      state.message,
      accumulatorEmpty(accumulator) ? null : accumulator,
      stage,
    )
    const { text, trailer } = await runFirstPassDirect(firstPassPrompt)
    firstPassTrailerSum = addTrailer(firstPassTrailerSum, trailer)

    const queries = parseQueryCommands(text)
    const dispatches = parseDispatchCommands(text)
    const reads = parseReadCommands(text)
    const spawns = parseSpawnCommands(text)
    const totalCommands = queries.length + dispatches.length + reads.length + spawns.length

    logger.info({
      stage,
      stagesUsedThisWindow,
      queriesFound: queries.length,
      dispatchesFound: dispatches.length,
      readsFound: reads.length,
      spawnsFound: spawns.length,
      outputPreview: text.slice(0, 800),
      stageCostUsd: trailer.cost_usd,
      stageTokens: { input: trailer.input_tokens, output: trailer.output_tokens },
    }, 'Coordinator stage decision')

    if (totalCommands === 0) {
      // Stage 1 with no commands: the prose IS the answer (chat-style turn,
      // no oracle/dispatch needed). Skip synthesis; emit the text directly.
      if (stage === 1) {
        logger.info('Coordinator answered directly')
        emit({ type: 'text', text })
        emit({ type: 'done' })
        return {
          text,
          trailer: { first_pass: firstPassTrailerSum, second_pass: null },
          paused: false,
          accumulator,
        }
      }
      // Stage 2+ with no commands: model is signalling "I have what I need" —
      // discard this stage's output and run synthesis with everything
      // accumulated.
      break
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

    const stageResults = await executeStage({ queries, dispatches, reads, spawns }, emit)
    accumulator.oracleResponses.push(...stageResults.oracleResponses)
    accumulator.dispatchResults.push(...stageResults.dispatchResults)
    accumulator.readResults.push(...stageResults.readResults)
    accumulator.spawnResults.push(...stageResults.spawnResults)

    // Budget exhausted — save state, emit pause, return without synthesis.
    // The frontend renders an "approve next stages" button; clicking it
    // POSTs to /continue, which calls resumeRun() with another window.
    if (stagesUsedThisWindow >= STAGE_BUDGET) {
      const continuationId = randomUUID()
      pendingContinuations.set(continuationId, {
        runtime: state,
        accumulator,
        firstPassTrailer: firstPassTrailerSum,
        stagesUsedTotal: stage,
        createdAt: Date.now(),
      })
      const timer = setTimeout(() => pendingContinuations.delete(continuationId), CONTINUATION_TTL_MS)
      timer.unref?.()

      const hintParts: string[] = []
      if (stageResults.oracleResponses.length) hintParts.push(`${stageResults.oracleResponses.length} oracle(s)`)
      if (stageResults.dispatchResults.length) hintParts.push(`${stageResults.dispatchResults.length} dispatch(es)`)
      if (stageResults.readResults.length) hintParts.push(`${stageResults.readResults.length} read(s)`)
      if (stageResults.spawnResults.length) hintParts.push(`${stageResults.spawnResults.length} spawn(s)`)
      const pendingHint = hintParts.length
        ? `Last stage ran ${hintParts.join(', ')}. Coordinator may want more — approve to continue.`
        : 'Coordinator may want more stages — approve to continue.'

      logger.info({ continuationId, stage, accumulator: {
        oracles: accumulator.oracleResponses.length,
        dispatches: accumulator.dispatchResults.length,
        reads: accumulator.readResults.length,
        spawns: accumulator.spawnResults.length,
      } }, 'Coordinator paused for approval')

      emit({
        type: 'stages_paused',
        continuationId,
        stagesUsedThisWindow,
        stagesUsedTotal: stage,
        pendingHint,
      })
      emit({ type: 'done' })
      return {
        text: '',
        trailer: { first_pass: firstPassTrailerSum, second_pass: null },
        paused: true,
        accumulator,
      }
    }
  }

  // Synthesis
  emit({ type: 'status', message: 'Synthesizing...' })
  const secondPrompt = buildSecondPassPrompt(
    state.profile,
    accumulator.oracleResponses,
    accumulator.dispatchResults,
    accumulator.readResults,
    accumulator.spawnResults,
    state.history,
    state.message,
  )
  const { text: fullText, trailer: secondPassTrailer } = await runSecondPassDirect(secondPrompt, (text) => {
    emit({ type: 'text', text })
  })

  logger.info({
    secondPassCostUsd: secondPassTrailer.cost_usd,
    secondPassTokens: { input: secondPassTrailer.input_tokens, output: secondPassTrailer.output_tokens },
    stopReason: secondPassTrailer.stop_reason,
  }, 'Coordinator second pass complete')

  emit({ type: 'done' })
  return {
    text: fullText,
    trailer: { first_pass: firstPassTrailerSum, second_pass: secondPassTrailer },
    paused: false,
    accumulator,
  }
}

const buildRuntimeState = async (message: string, history: ChatMessage[]): Promise<RuntimeState> => {
  const [profile, oracleList, developerList, spawnerHostList] = await Promise.all([
    loadUserProfile(),
    loadOracleList(),
    loadDeveloperList(),
    loadSpawnerHostList(),
  ])
  return { message, history, profile, oracleList, developerList, spawnerHostList }
}

export const run = async (
  message: string,
  history: ChatMessage[],
  emit: (event: CoordinatorEvent) => void,
): Promise<{ text: string; trailer: TurnTrailer; paused: boolean; accumulator: StageAccumulator }> => {
  const state = await buildRuntimeState(message, history)
  emit({ type: 'status', message: `Deciding (${state.oracleList.length} oracles, ${state.developerList.length} devs, ${state.spawnerHostList.length} hosts available)...` })
  return runMultiStage(state, emit, null)
}

// Resume a paused multi-stage turn. Consumes the continuation from the
// in-memory store (one-shot) so a stale tab can't replay it. Throws if the
// id is unknown — typically a process restart or TTL expiry.
export const resumeRun = async (
  continuationId: string,
  emit: (event: CoordinatorEvent) => void,
): Promise<{ text: string; trailer: TurnTrailer; paused: boolean; accumulator: StageAccumulator }> => {
  const cont = pendingContinuations.get(continuationId)
  if (!cont) {
    throw new Error(`Continuation "${continuationId}" not found (expired or process restarted)`)
  }
  pendingContinuations.delete(continuationId)
  emit({ type: 'status', message: `Resuming (stage ${cont.stagesUsedTotal + 1}+)...` })
  return runMultiStage(cont.runtime, emit, cont)
}
