# AgentForge Anatomy — splitter handoff

Generated: 2026-04-28T17:13Z. Single-doc snapshot of every primitive,
subsystem, contract, and known gap in the repo at commit `45b745a`. Cite
this when carving per-agent scopes; mark anything still labelled
`UNGROUNDED — needs author input` as a question for the author before
splitting.

Source-of-truth priority used throughout:

1. Repo code → cited as `path:line-range`.
2. The coordinator's runtime system prompt assembled in
   `platform/backend/src/services/coordinator.ts:131-253` →
   `(per coordinator system prompt)`.
3. Anything else → `UNGROUNDED — needs author input`.

---

## 1. System overview + why it exists

AgentForge is a coordinator-driven control plane that turns natural-language
chat into provisional, user-approved work units executed by remote
Claude-Code-shaped agents. Three actor classes are first-class today:

- **Coordinator** — single Claude-API instance inside the backend. Reads
  user messages, queries oracles, drafts dispatches, drafts spawns, and
  pulls run reports. Does not write code itself.
- **Developer** — long-running Claude-Code WebSocket worker that executes
  one approved dispatch at a time inside its own workspace, commits, and
  pushes.
- **Oracle** — read-on-demand knowledge base. Answers a single question
  per query, sourced exclusively from markdown files inside its
  `state_dir`. Not part of the run lifecycle.

A fourth class — **researcher** — is reserved in the spawn-spec enum
(`platform/backend/src/schemas/spawner.ts:7`,
`platform/backend/src/services/coordinator.ts:198`) but has no runtime
image, no worker code, no WS protocol. Listed everywhere as planned.

Two horizontal services support the actors:

- **Spawner host** — per-host HTTP service (one per physical host) that
  manages docker containers for primitives via a single shared
  `compose.yml`. The backend talks to it over plaintext HTTP and ingests
  push-only lifecycle events from it.
- **Coordinator chat substrate** — `coordinator_chats` /
  `coordinator_messages` tables, SSE stream, sentinel-based history
  rewriting, plus the ReactFlow-free chat UI at
  `platform/frontend/app/coordinator/page.tsx`. This is the only
  user-facing entry point.

Why the system exists, in the order the README/docs reveal it:

- **Single-actor LLM coordination is unreliable past 5+ unrelated
  changes.** The coordinator prompt enforces "split large tasks" and
  "execution ordering is the dispatch order"
  (`platform/backend/src/services/coordinator.ts:231-243`).
- **Reports are pull-only.** Auto-injecting prior `[read, ...]` outputs
  into context recreates the bug they explicitly avoided
  (`platform/backend/src/routes/coordinator-routes.ts:32-71`).
- **Provisional dispatches.** Coordinator-emitted dispatches land in
  status `pending` and require user approval via the chat badge
  (`platform/backend/src/routes/developers-routes.ts:166-213`,
  `platform/backend/src/services/coordinator.ts:629-657`). Spawn intents
  follow the same pattern
  (`platform/backend/src/routes/spawners-routes.ts:197-296`).
- **Multi-host topology** is supported by design — each host runs its own
  spawner, the backend keeps a registry, and lifecycle events flow
  spawner → backend (`docs/spawner/architecture.md:1-15`).
- The legacy DAG/build/services system from
  `platform/backend/src/db/migrations/001_initial.ts` (`projects`,
  `services`, `actions`, `edges`, `builds`, `action_runs`,
  `agent_logs`, `file_changes`, `tasks`, `task_logs`) is still present
  but is **not** part of the coordinator/developer/oracle/spawner
  primitive set — it's the older AgentForge visual-builder and is
  out of scope for the splitter.

---

## 2. Primitive catalogue

### 2.1 coordinator

| Field | Value |
| --- | --- |
| name | coordinator |
| status | implemented (`platform/backend/src/services/coordinator.ts:1-803`, route mounted at `platform/backend/src/index.ts:21,52`) |
| role | Two-pass router-and-synthesizer. First pass parses `[query|dispatch|read|spawn]…[end]` blocks; second pass narrates results to the user. |
| why-it-exists | One LLM brain per chat that arbitrates between oracle reads, dispatch creation, and spawn proposals — never writes code, never auto-injects prior reports `(per coordinator system prompt)`. |
| inputs | User chat message + persisted `coordinator_messages` history (sentinels rewritten via `rewriteSentinelsForHistory` in `platform/backend/src/routes/coordinator-routes.ts:49-71`); live oracle/developer/spawner-host lists pulled fresh per turn (`coordinator.ts:546-555`). |
| outputs | SSE event stream of `status | oracle | dispatch | read | spawn | text | done` (`coordinator.ts:40-77`); persisted assistant message with HTML-comment sentinels for badges (`coordinator-routes.ts:256-285`). |
| lifecycle | Per-message: load context → first-pass non-streaming completion → parse commands → fan-out (oracle queries + dispatch row inserts + read DB lookups + spawn intent inserts in parallel, `coordinator.ts:607-785`) → second-pass streaming synthesis. No long-lived state between messages. |
| read scope | Reads `oracles`, `developers`, `spawner_hosts` rows; reads `developer_runs` for `[read, run-id]`; reads `coordinator_messages` for history; reads `${ORACLE_STATE_DIR}/user_profile.md` if present (`coordinator.ts:114-120`). |
| write scope | Inserts `coordinator_messages`, `developer_runs` (status=`pending`), `spawn_intents` (status=`pending`), `oracle_queries`. Does NOT insert `developers`, `oracles`, `spawner_hosts`. Bumps `coordinator_chats` cost/duration aggregates (`coordinator-routes.ts:282-285`). |
| transport | HTTP `POST /api/coordinator/chats/:id/message` returns `text/event-stream`; CRUD on `/api/coordinator/chats[/:id[/messages/:messageId]]` (`coordinator-routes.ts:75-114`). Outbound to Anthropic via `chatCompletion` / `chatCompletionStream` from `platform/backend/src/lib/anthropic-oauth.ts`. |
| where it runs | In-process inside the backend Express app — no separate container. |
| cost model | Per-turn `MessageTrailer` from each pass aggregated into a `TurnTrailer` (`coordinator.ts:30-33`); cost/duration written per-message and rolled up onto the chat (`coordinator-routes.ts:271-285`, migration `008_coordinator_message_trailer.ts`). Model defaults to `claude-opus-4-7` (`config.ts:41`); max tokens 64,000 (`coordinator.ts:28`). |
| file refs | `services/coordinator.ts`; `routes/coordinator-routes.ts`; `db/queries/coordinator-chats.ts`; `db/migrations/004_coordinator_chats.ts`; `db/migrations/008_coordinator_message_trailer.ts`; `lib/anthropic-oauth.ts`. |

### 2.2 developer

| Field | Value |
| --- | --- |
| name | developer |
| status | implemented (`platform/backend/src/services/developer-registry.ts:1-325`, `developer/src/index.ts:1-533`) |
| role | Stateless Claude-Code WS worker. Accepts one dispatch at a time, runs `claude --print --output-format stream-json` against `workspacePath`, optionally commits and pushes, reports back via WS. |
| why-it-exists | Decouples LLM execution from the backend process so workers can live on different hosts, can be replaced/restarted, and can be scaled per scope. The reverse-WS connection lets developers sit behind NAT / on private hosts. |
| inputs | `dispatch` WS message: `{ runId, instructions, mode: 'implement'|'clarify', resumeContext? }` (`developer-registry.ts:43-51`, `developer/src/index.ts:156-162`). Env: `COORDINATOR_URL`, `DEVELOPER_ID`, `DEVELOPER_SECRET`, `WORKSPACE_PATH`, `GIT_BRANCH`, `MAX_TURNS` (`developer/src/index.ts:23-37`). |
| outputs | WS messages: `event` (each Claude stream-JSON event verbatim), `run_update` (terminal status + git SHAs + push outcome + final assistant text), `heartbeat` every 30s (`developer/src/index.ts:243-261`). On implement-mode success with changes: a single `agentforge: <first instruction line>` commit pushed to `gitBranch` (`developer/src/index.ts:397-419`). |
| lifecycle | (offline → register → idle → busy → idle | error | destroyed). Per run: `pending` (only via coordinator) → `queued` → `running` → `success | failure | cancelled | no_changes`. Only one run per developer at any time; second dispatch is rejected with `failure` (`developer/src/index.ts:275-284`). |
| read scope | Full repo at `workspacePath`. The `claude` subprocess runs with `--dangerously-skip-permissions` (`developer/src/index.ts:436`) so it can read anything in the workspace and use shell tools. |
| write scope | The same workspace; commits attribute to whichever git identity the container has. Writes nothing in the AgentForge DB directly — every state change is mediated by the backend through `run_update` / `event` messages (`developer-registry.ts:230-298`). |
| transport | Reverse WebSocket: developer dials `ws://backend/api/developers/connect/:id?secret=…` (`developers-routes.ts:25-62`, `developer/src/index.ts:193-232`). Close codes `4001 superseded`, `4003 bad secret`, `4004 not found`, `1011 server error`. |
| where it runs | One container per developer. Locally: dev process via `npm run dev` from `developer/`. Production: container produced from `developer/Dockerfile` (referenced in spawner local-build for `kind=developer`) and started by a spawner host (`docs/spawner/architecture.md:17-22`). |
| cost model | Per-run `total_cost_usd`, `duration_ms`, `duration_api_ms`, `stop_reason`, full `trailer` JSON captured from the Claude `result` event (`developer-registry.ts:180-225`, migration `005_developer_runs_trailer_queue.ts`). Surfaced in the dispatch badge (`coordinator/page.tsx:1024-1058`). |
| file refs | `services/developer-registry.ts`; `routes/developers-routes.ts`; `db/queries/developers.ts`; `db/migrations/004_developers.ts` + `005`/`006`/`007`/`009`; `schemas/developer.ts`; `developer/src/index.ts`; `developer/README.md`; `developer/Dockerfile`; `docker/agent/Dockerfile`. |

### 2.3 researcher (planned)

| Field | Value |
| --- | --- |
| name | researcher |
| status | scaffolded only — name reserved in `PRIMITIVE_KINDS` enum (`schemas/spawner.ts:7`) and accepted by the coordinator's `[spawn, ...]` grammar (`services/coordinator.ts:198`). No worker code, no Dockerfile under `developer/` or anywhere else, no WS handler, no runtime image, no DB table. The spawner schema comment confirms: "researcher support is scaffolded but the spawner doesn't yet have a runtime image for it" (`schemas/spawner.ts:4-6`). |
| role | UNGROUNDED — needs author input. Intent appears to be a long-running read/research agent distinct from a code-writing developer, but the contract is undefined. |
| why-it-exists | UNGROUNDED — needs author input. |
| inputs | UNGROUNDED — needs author input. The spawn YAML body in `[spawn, host, name]` accepts `kind: researcher` today, but post-spawn nothing wires the resulting container into the backend (no analog of the `developers` row creation that happens for `kind=developer` in `routes/spawners-routes.ts:222-236`). |
| outputs | UNGROUNDED — needs author input. |
| lifecycle | UNGROUNDED — needs author input. The container itself would inherit the spawner lifecycle (`creating | running | crashed | destroyed | orphaned`), but there is no application-level "research run" concept. |
| read scope | UNGROUNDED — needs author input. |
| write scope | UNGROUNDED — needs author input. |
| transport | UNGROUNDED — needs author input. |
| where it runs | Intended: a primitive container on a spawner host. Image source: UNGROUNDED — needs author input. |
| cost model | UNGROUNDED — needs author input. The dispatch hints at "per-researcher pricing trailers" but no code captures researcher costs. |
| file refs | `schemas/spawner.ts:7,54`; `services/coordinator.ts:185-198`; `frontend/lib/api.ts:473`. |

### 2.4 oracle

| Field | Value |
| --- | --- |
| name | oracle |
| status | implemented (`platform/backend/src/services/oracle-engine.ts:1-153`, `routes/oracles-routes.ts`, migration `003_oracle_builder_coordinator.ts:26-48`) |
| role | Per-domain knowledge base. A `[query, domain]` triggers a `claude --print` subprocess in the oracle's `state_dir` with a system prompt forcing it to answer only from local files. |
| why-it-exists | Keep durable knowledge out of the coordinator's prompt. Each turn the coordinator queries fresh, so updating an oracle's state propagates immediately without context-window pressure `(per coordinator system prompt)`. |
| inputs | `[query, domain]\n<question>\n[end]` parsed in `services/coordinator.ts:325-338`. Direct HTTP: `POST /api/oracles/:id/query` (`routes/oracles-routes.ts`). `[save, domain]\n<data>\n[end]` triggers `mergeIntoState` — handled outside the streaming chat endpoint (`routes/coordinator-routes.ts:117-163`). |
| outputs | Plain text answer; `oracle_queries` row with status `completed | error`, `duration_ms`, response body (`db/queries/oracles.ts:96-114`, migration `003`). The coordinator emits a `{ type: 'oracle', domain, question, response }` SSE event (`coordinator.ts:617-628`). |
| lifecycle | Stateless per query. Subprocess spawned, Claude stream-JSON consumed line-by-line (`oracle-engine.ts:46-69`), `assistant.text` blocks concatenated, `result.result` used as fallback. Hard cap `--max-turns 30` (`oracle-engine.ts:36`). On non-zero exit, the response is null and `status='error'`. |
| read scope | The oracle's `state_dir` only — system prompt: "Answer ONLY from what is in your state files. Read them first." (`oracle-engine.ts:101-110`). The Claude CLI runs with `--dangerously-skip-permissions` (`oracle-engine.ts:32`) and `cwd: stateDir`, so technically it can read any path the backend can; the prompt is the constraint, not the sandbox. |
| write scope | `mergeIntoState` re-spawns the same agent with an Edit/Write-allowed prompt to merge new info into existing files (`oracle-engine.ts:127-152`). Authoritative storage is the markdown files under `state_dir`; `getOracleState` concatenates every `*.md` in there for inspection (`db/queries/oracles.ts:81-94`). |
| transport | Subprocess via `child_process.spawn('claude', […])` (`oracle-engine.ts:23-44`). The output is `stream-json`. The coordinator never streams oracle text token-by-token — it waits for the full result before passing it to the second-pass prompt. |
| where it runs | In the same backend process, on the host's filesystem. `ORACLE_STATE_DIR` defaults to `~/agentforge/data/oracles` (`config.ts:38`); production compose mounts `/ntfr/data:/ntfr/data` and sets `ORACLE_STATE_DIR=/ntfr/data/oracles` (`docker-compose.yml:40,46`). Each oracle has its own subdir referenced by `oracles.state_dir`. |
| cost model | UNGROUNDED — needs author input. The dispatch flags "per-oracle pricing trailers" as planned, but the subprocess does NOT capture or persist `total_cost_usd` / `duration_api_ms` / `stop_reason` — only wall-clock `duration_ms` is recorded (`oracle-engine.ts:112-118`). The Claude `result` event carries cost fields but `oracle-engine.ts` doesn't extract them. |
| file refs | `services/oracle-engine.ts`; `routes/oracles-routes.ts`; `db/queries/oracles.ts`; `db/migrations/003_oracle_builder_coordinator.ts`; `schemas/oracle.ts`. |

### 2.5 spawner host

| Field | Value |
| --- | --- |
| name | spawner host |
| status | implemented (registry + client + ingest landed in commit `376d539`; spawn-intent flow landed in `65a0b87`). Code: `services/spawner-client.ts`, `services/spawner-registry.ts`, `routes/spawners-routes.ts`, `db/queries/spawners.ts`, migrations `010` + `011`. Spawner package itself: `spawner/` with its own `package.json` + Dockerfile + deploy/. |
| role | Per-host docker manager. The backend speaks HTTP to it; it owns the host's `compose.yml`, mutex-serializes spawn/destroy, archives destroyed primitives, and pushes lifecycle events back to the backend. |
| why-it-exists | Multi-host topology — one spawner per host, hosts don't talk to each other (`docs/spawner/architecture.md:11-15`). Decouples docker orchestration from the central backend so a host can be added by registering a row + pointing `NTFR_SERVER_URL` at the backend. |
| inputs | Backend → spawner: `GET /health`, `GET /info`, `GET /spawns`, `GET /spawns/{name}`, `POST /spawns`, `POST /spawns/{name}/destroy`, `GET /spawns/{name}/logs`, `POST /update` (501) — full contract `docs/spawner/api-contract.md:1-209`, client class `services/spawner-client.ts:104-239`. Spawner → backend: `POST /api/spawners/:hostId/events` (`routes/spawners-routes.ts:350-385`). |
| outputs | The HTTP API above; lifecycle events shaped per `lifecycleEventSchema` (`schemas/spawner.ts:79-92`); on disk: `${NTFR_WORKDIR}/<name>/{state.json,workspace,.meta}`, `${NTFR_WORKDIR}/.archive/`, sqlite outbox at `.spawner/state.db` (`docs/spawner/architecture.md:23-46`). |
| lifecycle (host) | `unknown | online | offline | error` — set by `POST /api/spawners/:id/probe` (`spawners-routes.ts:94-128`) and bumped on every ingested event (`db/queries/spawners.ts:222-228`). |
| lifecycle (primitive) | `creating → running ↔ crashed`, `running → orphaned` (recovery exhausted), `* → destroyed` (`docs/spawner/architecture.md:48-77`, `schemas/spawner.ts:8`). |
| read scope | Reads `spawner_hosts` row (for `baseUrl`); reads `spawn_intents` (approval flow); reads `spawns` and `spawn_events` (admin/UI). |
| write scope | Inserts `spawner_hosts` (CRUD), `spawn_intents` (approval flow + coordinator-emit), `spawn_events` (lifecycle ingest, dedupe by `event_id`), `spawns` (latest-state-wins upsert). Side effect: when a `kind=developer` primitive transitions to `destroyed`, `developers.status` for the matching `name` is flipped to `'destroyed'` (`db/queries/spawners.ts:230-239`). When approving a `kind=developer` intent, a `developers` row is created up-front and its `id`/`secret` injected as env into the spawn (`routes/spawners-routes.ts:218-236`). |
| transport | Outbound HTTP from backend with retry/backoff/timeout (`services/spawner-client.ts:104-239`). Inbound HTTP from spawner with no auth in v1 (TODO ed25519 — `routes/spawners-routes.ts:337-349`, `docs/spawner/architecture.md:125-143`). |
| where it runs | One process per host. Backend connects via the registered `base_url`. Frontend admin pages: `app/spawners/page.tsx` + `app/spawners/[id]/page.tsx` (referenced in clarify doc — see §7). |
| cost model | None — spawner activity is infrastructure, not LLM. No cost field on `spawner_hosts`, `spawns`, or `spawn_events`. |
| file refs | `services/spawner-client.ts`; `services/spawner-registry.ts`; `routes/spawners-routes.ts`; `db/queries/spawners.ts`; `db/migrations/010_spawner_hosts.ts`; `db/migrations/011_spawn_intents.ts`; `schemas/spawner.ts`; `docs/spawner/{architecture.md,api-contract.md,deploy.md}`; `spawner/` package. |

### 2.6 spawn intent (data primitive)

| Field | Value |
| --- | --- |
| name | spawn intent |
| status | implemented (migration `011_spawn_intents.ts`, `db/queries/spawners.ts:262-356`, approve/cancel routes `routes/spawners-routes.ts:174-335`). |
| role | Pending-approval row created when the coordinator emits `[spawn, host, name]…[end]`. Holds the parsed `SpawnSpec` until the user approves or cancels via the chat badge. |
| why-it-exists | Mirrors the dispatch approval gate. Without it, an LLM-emitted spawn would mutate host state without user consent. Approval is what triggers the actual `SpawnerClient.spawn()` HTTP call. |
| inputs | YAML body inside `[spawn, host, name]…[end]` parsed with `yaml.parse` and validated against `spawnSpecSchema` (`coordinator.ts:383-424`). `kind` is required; `image` is optional (when omitted, spawner builds locally from `/ntfr/agentforge/<kind>`). |
| outputs | A `spawn_intents` row with `status='pending'`. On approve: synchronous `SpawnerClient.spawn()`, `status='approved'`, `approvedAt` set; on cancel: `status='cancelled'`, `cancelledAt` set; on spawner failure: `status='failed'`, `errorMessage` set (`routes/spawners-routes.ts:197-321`). The frontend SpawnBadge polls `getIntent` until terminal (`coordinator/page.tsx:1104-1124`). |
| lifecycle | `pending → approved | cancelled | failed` (`schemas/spawner.ts:9,SPAWN_INTENT_STATUSES`). Append-only after terminal — a re-spawn requires a fresh `[spawn, ...]` invocation and a new intent row. |
| read scope | Read by `routes/spawners-routes.ts` (list/get/approve/cancel) and the frontend SpawnBadge poll (`spawnersApi.getIntent`, `lib/api.ts:576-577`). |
| write scope | Inserted by `coordinator.ts:743` (status=`pending`) and updated only by approve/cancel handlers. The spec is stored as JSON; image label falls back to `local-build:<kind>` when unset (`db/queries/spawners.ts:298-317`). |
| transport | HTTP only (`/api/spawners/:id/spawn-intents/[…]`). No SSE or WS. |
| where it runs | DB-only. Lives in `spawn_intents` table on the AgentForge backend's Postgres/SQLite. |
| cost model | None — intents are control-plane bookkeeping, not LLM artifacts. |
| file refs | `db/migrations/011_spawn_intents.ts`; `db/queries/spawners.ts:262-356`; `routes/spawners-routes.ts:174-335`; `schemas/spawner.ts:97-110`; `frontend/app/coordinator/page.tsx:1083-1304`. |

### 2.7 spawn event (data primitive)

| Field | Value |
| --- | --- |
| name | spawn event |
| status | implemented (migration `010_spawner_hosts.ts:49-66`, `db/queries/spawners.ts:155-243`, ingest route `routes/spawners-routes.ts:350-385`). |
| role | Append-only audit log of every spawner-pushed lifecycle transition. Source-of-truth for primitive-state evolution; the `spawns` row is a derived "latest" projection. |
| why-it-exists | Out-of-order delivery and at-least-once retries from the spawner outbox mean we cannot trust a single event to determine current state. Storing every event lets the latest-timestamp-wins upsert in `spawns` survive replay/late-arrival without losing history. |
| inputs | `POST /api/spawners/:hostId/events` body validated against `lifecycleEventSchema` (`schemas/spawner.ts:79-92`): `event_id`, `primitive_name`, `primitive_kind`, `state`, `prev_state`, `timestamp`, `host_id`, `payload`. `primitive_kind` on this path is permissive (string) because spawner code still includes `oracle` in its enum — comment in `schemas/spawner.ts:74-78`. |
| outputs | One `spawn_events` row per unique `event_id` (UNIQUE constraint dedupes replay — `migrations/010_spawner_hosts.ts:56`); a (possibly) updated `spawns` row when the new event's timestamp beats the stored one (`db/queries/spawners.ts:189-220`); `spawner_hosts.last_seen_at` and `last_event_at` bumped (`db/queries/spawners.ts:222-228`); `spawnerRegistry.events.emit('event:<host>')` and `event:<host>:<primitive>` for future SSE consumers (`routes/spawners-routes.ts:369-370`). |
| lifecycle | Append-only. Never updated, never deleted (CASCADE on `spawner_hosts` removal). |
| read scope | Read by `getSpawn` / `listSpawnsForHost` (only via the `spawns` projection today). No direct `spawn_events` query is exposed via HTTP — surfaced as a known gap in the frontend clarify doc §A11. |
| write scope | Single inserter: `ingestLifecycleEvent` transaction in `db/queries/spawners.ts:164-243`. Side effect on `developers` table: when a `kind=developer` primitive transitions to `destroyed`, the matching developer row is flagged `destroyed` (`db/queries/spawners.ts:230-239`). |
| transport | Inbound HTTP only. The spawner outbox retries up to `NTFR_LIFECYCLE_RETRY_MAX` (default 5) on non-2xx (`docs/spawner/architecture.md:96-106`). |
| where it runs | DB only. |
| cost model | None. |
| file refs | `db/migrations/010_spawner_hosts.ts:49-66`; `db/queries/spawners.ts:155-243`; `routes/spawners-routes.ts:337-385`; `schemas/spawner.ts:79-92`; `docs/spawner/api-contract.md:213-256`. |

### 2.8 dispatch (data primitive)

| Field | Value |
| --- | --- |
| name | dispatch |
| status | implemented as a developer_runs row in status `pending`. Code: `coordinator.ts:629-657`, `developers-routes.ts:166-213`, migration `007_developer_runs_approval.ts` split `pending` from `queued`. |
| role | Coordinator-emitted intent to dispatch. Stored as a `developer_runs` row before the user has approved it. The same row IS the run once approved — see 2.9. |
| why-it-exists | `(per coordinator system prompt)` — "Dispatches are PROVISIONAL. They land in a 'pending' state and wait for the user to approve, cancel, or edit them via the chat badge" (`coordinator.ts:247-253`). Required four-section structure (STOP / Out of scope / Commit-report contract / Read-before-write) is enforced as prose contract, not schema (`coordinator.ts:220-229`). |
| inputs | Parsed from the assistant's first-pass output: `[dispatch, developer-name, mode]\n<instructions>\n[end]` (`coordinator.ts:340-354`). Mode ∈ `implement | clarify` (`schemas/developer.ts:4`). |
| outputs | A `developer_runs` row inserted with `status='pending'`, no `started_at` (`db/queries/developers.ts:163-184`). The coordinator emits `{ type: 'dispatch', developer, developerId, mode, runId, instructions, queued, pending }` SSE (`coordinator.ts:640-650`). On chat persistence, an `<!--DISPATCHES:[…]:DISPATCHES-->` JSON sentinel is appended to the assistant message (`coordinator-routes.ts:262-264`). |
| lifecycle | `pending` → user approves (`/runs/:id/approve`, `developers-routes.ts:230-249`) → `queued`. Or user cancels → `cancelled`. Or user edits instructions while still `pending` → row updated, status unchanged (`developers-routes.ts:362-380`). FIFO per developer once approved — execution order is the dispatch order `(per coordinator system prompt)` (`coordinator.ts:235-243`); enforced by `getNextQueuedRun` ordering on `created_at ASC` (`db/queries/developers.ts:295-305`). |
| read scope | Read via `[read, run-id]` (`coordinator.ts:360-368`, `coordinator.ts:658-711`); read by the DispatchBadge poll (`coordinator/page.tsx:720-740`). |
| write scope | Inserted by coordinator (`autoApprove=false` path) and by direct HTTP `POST /api/developers/:id/dispatch` (`autoApprove=true` skips pending entirely — `developers-routes.ts:166-213`). Mutated only by approve/cancel/edit/retry/continue endpoints. `developer_runs.parent_run_id` chains retries/continues (migration `009_developer_runs_resume_context.ts`). |
| transport | Created via SSE-streamed coordinator turn; mutated via HTTP. The runId UUID is the only durable cross-turn carrier — preserved in the assistant message via `rewriteSentinelsForHistory` (`coordinator-routes.ts:32-71`, behaviour confirmed in commit `45b745a`). |
| where it runs | DB-only until approved. |
| cost model | None at intent stage — cost is recorded against the run (2.9). |
| file refs | `services/coordinator.ts:340-354,629-657`; `routes/developers-routes.ts:166-213,230-380`; `routes/coordinator-routes.ts:32-71,256-285` (sentinel rewrite); `db/queries/developers.ts:163-198,222-232`; `db/migrations/004_developers.ts`; `db/migrations/007_developer_runs_approval.ts`; `db/migrations/009_developer_runs_resume_context.ts`; `schemas/developer.ts:5-13,85-96`. |

### 2.9 run (data primitive)

| Field | Value |
| --- | --- |
| name | run |
| status | implemented — same `developer_runs` row as 2.8 once it leaves `pending`. |
| role | Execution lifecycle of an approved (or auto-approved) dispatch. Captures git SHAs, push outcome, Claude trailer, final response. |
| why-it-exists | Decouples worker outcome from push outcome — work success and git-push success are orthogonal (migration `006_developer_runs_push_status.ts` splits them; `developer/src/index.ts:404-419` records `push_status='failed'` while keeping `status='success'`). Also enables retry/continue recovery (`migration 009`, `routes/developers-routes.ts:281-359`). |
| inputs | `dispatch` WS message from the registry (`developer-registry.ts:141-173`); `event` and `run_update` messages flowing back from the developer container. |
| outputs | Updated `developer_runs` row (status, git_sha_start, git_sha_end, response, error_message, provider, model, session_id, total_cost_usd, duration_ms, duration_api_ms, stop_reason, trailer JSON, push_status, push_error — full surface in `schemas/developer.ts:49-75`). `developer_logs` rows for every Claude stream event (`developer-registry.ts:248-264`). Registry event-bus emissions: `log:<runId>`, `update:<runId>`, `complete:<runId>` for SSE consumers (`developer-registry.ts:54-58`). |
| lifecycle | `queued → running → success | failure | cancelled | no_changes`. `success` covers both "made and pushed changes" and "push failed but work succeeded" — the dispatch badge surfaces push status orthogonally (`coordinator/page.tsx:1014-1023`). `no_changes` is reported when implement-mode finishes without modifying the working tree (`developer/src/index.ts:383-395`). |
| read scope | Read by the registry (queue drain), by `[read, run-id]`, by SSE log stream (`routes/developers-routes.ts:425-483`), by the DispatchBadge polling loop, by retry/continue (`db/queries/developers.ts:189-220` finds active children to reject duplicate retries). |
| write scope | Updated only by the registry's `handleMessage` switch (`developer-registry.ts:230-298`) and the cancel/retry/continue routes. `developer_logs` are append-only (`db/queries/developers.ts:317-341`). |
| transport | Receives via the developer WS; exposes via `GET /api/developers/:id/runs[/:runId[/logs|/stream]]` (HTTP + SSE). |
| where it runs | DB-only; the actual execution happens inside the developer container, which writes its results back through the WS. |
| cost model | Full Claude trailer captured at the `result` event (`developer-registry.ts:197-225`): `total_cost_usd`, `duration_ms`, `duration_api_ms`, `stop_reason`, `session_id`, `num_turns`, `usage`, `fast_mode_state`, `terminal_reason`, `permission_denials`, `api_error_status`, `is_error`. Persisted as columns + JSON `trailer` blob (migration `005_developer_runs_trailer_queue.ts`). Surfaced in DispatchBadge (`coordinator/page.tsx:1024-1058`). |
| file refs | `services/developer-registry.ts`; `routes/developers-routes.ts`; `db/queries/developers.ts`; `db/migrations/004_developers.ts` + `005`/`006`/`007`/`009`; `schemas/developer.ts:49-75`; `developer/src/index.ts:262-431`. |

---

## 3. Oracle subsystem

### 3.1 Current oracle implementation

A `[query, oracle-domain]` block is regex-parsed in
`services/coordinator.ts:325-338` into `{ domain, question }` and
dispatched through `queryOracle(oracleId, message)` from
`services/oracle-engine.ts:94-125`. That function:

1. Looks up the oracle row (`db/queries/oracles.ts:51-54`) — the
   `state_dir` column is the on-disk path.
2. Builds a fixed instruction prompt:
   ```
   You are the {domain} oracle. Your working directory contains your state files — read them to answer.
   Rules:
   - Answer ONLY from what is in your state files. Read them first.
   - Cite the relevant section/heading when possible.
   - If your state does not contain the answer, say "Not in my state."
   - Do not speculate or use general knowledge.
   - Be dense. No filler.
   Question: {message}
   ```
   (`oracle-engine.ts:101-110`)
3. Spawns `claude --dangerously-skip-permissions --verbose --print
   --output-format stream-json --max-turns 30 --system-prompt … -p <prompt>`
   with `cwd: stateDir` (`oracle-engine.ts:23-44`).
4. Streams stdout line-by-line (`readline`), accumulating
   `assistant.message.content[].text` blocks; falls back to
   `result.result` if no assistant blocks were captured
   (`oracle-engine.ts:51-69`). Non-JSON lines are silently dropped.
5. On non-zero exit: persists `oracle_queries` with `status='error'`
   and rejects with the stderr (or extracted non-JSON stdout lines as
   fallback). On clean exit: persists `status='completed'` with
   `duration_ms` (`oracle-engine.ts:70-92,114-125`).

State on disk:

- Default `${ORACLE_STATE_DIR}` = `~/agentforge/data/oracles`
  (`config.ts:38`).
- Production compose mounts `/ntfr/data:/ntfr/data` and sets
  `ORACLE_STATE_DIR=/ntfr/data/oracles` (`docker-compose.yml:40,46`).
- `oracles.state_dir` is stored absolute and used as the subprocess
  `cwd`. The directory contents are `*.md` files, concatenated via
  `getOracleState` for the inspect API (`db/queries/oracles.ts:81-94`).

Merge / streaming:

- `mergeIntoState` (`oracle-engine.ts:127-152`) re-spawns the same
  agent with a different prompt that allows Edit/Write tools and tells
  the model to integrate new info. Triggered by
  `[save, domain]\n<data>\n[end]` blocks parsed in
  `routes/coordinator-routes.ts:117-163`.
- There is **no streaming of oracle output** to the user. The
  coordinator awaits the full response, then includes it in the
  second-pass prompt (`coordinator.ts:296-298,607-628`).

### 3.2 Per-oracle inventory

The dispatch names eight oracles "per coordinator system prompt":
`personal`, `agentforge`, `trading`, `career`, `infrastructure`,
`ai-industry`, `hearth`, `hardware`.

**Important caveat — these names are not hardcoded in the repo.** The
coordinator system prompt builds the oracle list dynamically from
`oracleQueries.listOracles()` (`coordinator.ts:95-98,139-141`); whatever
rows are in the `oracles` table at runtime become the available
domains. There is no seed migration, no fixture, no static fallback,
and `grep` for any of those names across `platform/backend/src` returns
zero hits beyond unrelated occurrences of the word "agentforge" and
one mention of `@hearth/core` in `lib/anthropic-oauth.ts:4`. The
`/workspace/data/oracles` directory does not exist on this checkout.

Per the dispatch's own ground rule, the names themselves are flagged
`(per coordinator system prompt)` — the user states they exist at
runtime. State path / content scope / curation status for each are
**all UNGROUNDED — needs author input**:

| Domain | name (per coordinator system prompt) | state path | content scope | curation status |
| --- | --- | --- | --- | --- |
| personal | UNGROUNDED — needs author input (claimed by author) | UNGROUNDED — needs author input | UNGROUNDED — needs author input | UNGROUNDED — needs author input |
| agentforge | UNGROUNDED — needs author input (claimed by author) | UNGROUNDED — needs author input | UNGROUNDED — needs author input | UNGROUNDED — needs author input |
| trading | UNGROUNDED — needs author input (claimed by author) | UNGROUNDED — needs author input | UNGROUNDED — needs author input | UNGROUNDED — needs author input |
| career | UNGROUNDED — needs author input (claimed by author) | UNGROUNDED — needs author input | UNGROUNDED — needs author input | UNGROUNDED — needs author input |
| infrastructure | UNGROUNDED — needs author input (claimed by author) | UNGROUNDED — needs author input | UNGROUNDED — needs author input | UNGROUNDED — needs author input |
| ai-industry | UNGROUNDED — needs author input (claimed by author) | UNGROUNDED — needs author input | UNGROUNDED — needs author input | UNGROUNDED — needs author input |
| hearth | UNGROUNDED — needs author input (claimed by author) | UNGROUNDED — needs author input | UNGROUNDED — needs author input | UNGROUNDED — needs author input |
| hardware | UNGROUNDED — needs author input (claimed by author) | UNGROUNDED — needs author input | UNGROUNDED — needs author input | UNGROUNDED — needs author input |

Splitter implication: the splitter cannot rely on the names existing
post-deploy. Confirm with the author whether they're seeded by a
manual `POST /api/oracles` step or by a fixture not checked in.

### 3.3 Planned migration to Claude-native memory (@import model)

UNGROUNDED — needs author input. No design doc, code comment, or
migration in the repo references @import-style oracle memory, the
Claude-native memory feature, or a migration plan from the current
`claude --print` subprocess to it. The author's intent — that oracles
will eventually be replaced by memory primitives the model imports
directly — is not represented anywhere a splitter can read.

What's missing: target memory representation, ownership of section
authoring, granularity (per-oracle vs. per-section), how queries map
to imports, whether merge/save semantics persist, fallback for
non-Claude-native deployments.

### 3.4 Effort parameter (low/normal/deep) on oracle queries

UNGROUNDED — needs author input. No `effort` field exists on
`oracleQuerySchema` (`schemas/oracle.ts:37-46`); no parser branch in
`coordinator.ts:325-338`; the subprocess hardcodes `--max-turns 30`
(`oracle-engine.ts:36`) with no per-call override. The `[query, …]`
grammar accepts only `domain` after the comma.

What's missing: parameter shape (`[query, domain, effort]`?), what
each level changes (max-turns? sub-queries? fan-out?), default level,
how it surfaces to the user in the chat badge.

### 3.5 Pilot oracle split plan (hardware → second → agentforge-last)

UNGROUNDED — needs author input. No reference in the repo to a phased
oracle migration order, no migration tagging individual oracles, no
feature flag.

What's missing: which split (oracle-name → @import?), why hardware
goes first, why agentforge goes last, success criteria for promoting
the next oracle.

### 3.6 Author-controlled section boundaries + curation/compaction protocol

UNGROUNDED — needs author input. The merge-into-state prompt
(`oracle-engine.ts:127-152`) tells the model to "Maintain the
document's existing structure and style" but section boundaries are
implicit in whatever markdown structure the author writes. There is
no schema, frontmatter convention, or compaction job in the repo.
`oracle_queries.duration_ms` is the only signal of growth; no
size-budget enforcement, no automated summarisation, no
human-in-the-loop curation queue.

What's missing: section boundary schema (headings? frontmatter
blocks? files-as-sections?), who edits (the merge agent? the author?
both with conflict rules?), compaction triggers (size? age? token
budget?), how compaction is reviewed before commit.

---

## 4. Scope matrix (primitive × resource)

Vertical = primitives that read/write each resource. Horizontal =
resources. `R` = read scope, `W` = write scope, `—` = no scope.
Citations follow each cell where a single function is the gate.

| Resource | coordinator | developer | researcher | oracle | spawner host | spawn intent | spawn event | dispatch | run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `coordinator_chats`, `coordinator_messages` | R+W (`coordinator-routes.ts:75-285`) | — | — | — | — | — | — | — | — |
| `oracles`, `oracle_queries` | R (list/query) `coordinator.ts:95-98` | — | — | R+W (state files via subprocess; `oracle_queries` row written by `oracle-engine.ts:114-125`) | — | — | — | — | — |
| Oracle `state_dir` filesystem | — (only via oracle subprocess result) | — | UNGROUNDED — needs author input | R+W (subprocess `cwd`, `oracle-engine.ts:23-44,127-152`) | — | — | — | — | — |
| `developers` | R (list to feed prompt, `coordinator.ts:100-107`) | — (developer never queries the table; identifies via WS secret) | UNGROUNDED — needs author input | — | W on intent approve (`spawners-routes.ts:222-236`); W on `destroyed` ingest (`db/queries/spawners.ts:230-239`) | — | — | — | — |
| `developer_runs` | R via `[read, run-id]` (`coordinator.ts:658-711`); W on `[dispatch, …]` insert (`coordinator.ts:639`, status=pending) | — (worker never touches DB; updates flow through WS) | UNGROUNDED — needs author input | — | — | — | — | W via approve/cancel/edit/retry/continue routes (`developers-routes.ts:230-380`) | W via `developer-registry.handleMessage` (`developer-registry.ts:230-298`) |
| `developer_logs` | — | — (events flow via WS, not DB) | UNGROUNDED — needs author input | — | — | — | — | — | W (append-only) `db/queries/developers.ts:317-341` |
| Workspace filesystem at `developers.workspace_path` | — | R+W (via `claude --dangerously-skip-permissions` subprocess, `developer/src/index.ts:436-518`) | UNGROUNDED — needs author input | — | — | — | — | — | — |
| Git remote at `developers.git_repo`/`git_branch` | — | W (`gitCommitAndPush`, `developer/src/index.ts:84-88,397-419`) | UNGROUNDED — needs author input | — | — | — | — | — | — |
| `spawner_hosts` | R (list to feed prompt, `coordinator.ts:109-112`) | — | — | — | R+W (probe writeback `spawners-routes.ts:94-128`; CRUD `spawners-routes.ts:24-89`); W on event ingest (`db/queries/spawners.ts:222-228`) | — | — | — | — |
| `spawn_intents` | W on insert (`coordinator.ts:743`, status=pending) | — | — | — | R+W via approve/cancel routes (`spawners-routes.ts:174-335`) | (the data primitive itself) | — | — | — |
| `spawn_events` | — | — | — | — | W (single inserter `db/queries/spawners.ts:155-243`) | — | (the data primitive itself) | — | — |
| `spawns` | — | — | — | — | W (latest-state-wins upsert in same transaction `db/queries/spawners.ts:189-220`) | — | (derived projection — see 2.7) | — | — |
| Anthropic API | W (per-turn first+second pass, `coordinator.ts:511-539`) | W (subprocess `claude` CLI, `developer/src/index.ts:433-518`) | UNGROUNDED — needs author input | W (subprocess `claude` CLI, `oracle-engine.ts:23-44`) | — | — | — | — | — |
| Spawner HTTP API | — (coordinator never calls spawner directly) | — | — | — | W (`SpawnerClient` calls — health/info/spawn/destroy/logs/inspect, `services/spawner-client.ts:104-239`) | — | — | — | — |
| Container docker daemon | — | — | UNGROUNDED — needs author input | — | W (via `docker compose` invocation inside spawner process) | — | — | — | — |
| Legacy DAG tables (`projects`, `services`, `actions`, `edges`, `builds`, `action_runs`, `agent_logs`, `file_changes`, `tasks`, `task_logs`, `action_chats`) | — | — | — | — | — | — | — | — | — |

The legacy DAG row is intentionally all `—`: those tables exist (`db/migrations/001_initial.ts`, `002_action_chats.ts`) but no current primitive in this catalogue interacts with them. They are out of scope for the splitter unless the author says otherwise.

---

## 5. Data substrate

### 5.1 Database

Single Knex-backed RDBMS, Postgres in production
(`docker-compose.yml:8-26`), SQLite for local dev
(`config.ts:10`, `db/connection.ts:4-19`). Selection driven by
`DATABASE_URL` prefix.

Migration files (in `platform/backend/src/db/migrations/`, ordered
deterministically by filename — Knex sorts lexically, so two `004_`
prefixes are intentional):

| # | File | Adds |
| --- | --- | --- |
| 001 | `001_initial.ts` | Legacy DAG: `projects`, `services`, `actions`, `edges`, `builds`, `action_runs`, `agent_logs`, `file_changes`, `tasks`, `task_logs` |
| 002 | `002_action_chats.ts` | `action_chats` (legacy DAG per-action chat) |
| 003 | `003_oracle_builder_coordinator.ts` | `scopes`, `oracles`, `oracle_queries` |
| 004a | `004_coordinator_chats.ts` | `coordinator_chats`, `coordinator_messages` (UUID id, `role` enum, content text) |
| 004b | `004_developers.ts` | `developers`, `developer_runs`, `developer_logs` |
| 005 | `005_developer_runs_trailer_queue.ts` | `developer_runs`: `provider`, `model`, `session_id`, `total_cost_usd`, `duration_ms`, `duration_api_ms`, `stop_reason`, `trailer`; index `developer_runs_queue_idx` on `(developer_id, status, created_at)` |
| 006 | `006_developer_runs_push_status.ts` | `developer_runs`: `push_status`, `push_error` |
| 007 | `007_developer_runs_approval.ts` | Data migration: every existing `developer_runs.status='pending'` row promoted to `'queued'`. Splits `pending` (awaiting approval) from `queued` (approved, awaiting idle) |
| 008 | `008_coordinator_message_trailer.ts` | `coordinator_messages`: `provider`, `model`, `total_cost_usd`, `duration_ms`, `stop_reason`, `trailer`. `coordinator_chats`: `total_cost_usd`, `total_duration_ms`, `billed_message_count` |
| 009 | `009_developer_runs_resume_context.ts` | `developer_runs`: `resume_context`, `parent_run_id` (self-FK ON DELETE SET NULL); index on `parent_run_id` |
| 010 | `010_spawner_hosts.ts` | `spawner_hosts`, `spawns`, `spawn_events`. UNIQUE on `spawn_events.event_id` (dedupe key); UNIQUE on `(spawner_host_id, primitive_name)` for `spawns` |
| 011 | `011_spawn_intents.ts` | `spawn_intents` (status enum `pending|approved|cancelled|failed`; `image` NOT NULL with synthetic `local-build:<kind>` fallback) |

Active tables grouped by primitive:

- **Coordinator**: `coordinator_chats`, `coordinator_messages` (with
  trailer/cost columns from 008).
- **Oracle**: `oracles`, `oracle_queries`. State lives outside the DB
  (filesystem at `oracles.state_dir`).
- **Developer**: `developers`, `developer_runs`, `developer_logs`.
- **Scope**: `scopes` — referenced by both `oracles.scope_id` and
  `developers.scope_id` (FK ON DELETE SET NULL) but no scope-aware
  authorization is implemented.
- **Spawner**: `spawner_hosts`, `spawns` (latest projection),
  `spawn_events` (audit log), `spawn_intents` (approval gate).
- **Legacy DAG** (out of catalogue scope): see 001–002 above.

### 5.2 Sentinels (in chat substrate)

Persisted assistant messages embed structured payloads as HTML-comment
sentinels so the frontend can re-hydrate badges on chat reload:

- `<!--ORACLES:[…]:ORACLES-->` — array of `{ domain, question, response }`.
- `<!--DISPATCHES:[…]:DISPATCHES-->` — array of dispatch info incl. `runId`.
- `<!--READS:[…]:READS-->` — array of `{ runId, found, status, developerName, report }`.
- `<!--SPAWNS:[…]:SPAWNS-->` — array of `{ spawnerHostId, hostId, primitiveName, primitiveKind, image, spawnIntentId, pending, queued }`.

Format and emit: `routes/coordinator-routes.ts:259-269`.
History rewrite (what the coordinator sees on the next turn):
`routes/coordinator-routes.ts:32-71`. ORACLES, READS, and SPAWNS are
stripped (oracles must be re-queried each turn; reads are pull-only;
SPAWNS sentinel survives but no command consumes `spawnIntentId`).
DISPATCHES are not stripped — instead the JSON is rewritten to a
human-readable line per dispatch so the model can recover the
`runId` for a later `[read, run-id]`. This is the freshest behaviour
pin (commit `45b745a`, "agentforge: SCOPE", 2026-04-28). Frontend
parsing of the sentinels on chat-load: `coordinator/page.tsx:113-138`.

### 5.3 Filesystem state

- `${ORACLE_STATE_DIR}` (default `~/agentforge/data/oracles`,
  production `/ntfr/data/oracles` per `docker-compose.yml:40`) — one
  subdirectory per oracle, holding `*.md` files. Optional
  `${ORACLE_STATE_DIR}/user_profile.md` is read by the coordinator
  every turn (`coordinator.ts:114-120`).
- `${DATA_DIR}` (default `~/agentforge/data`) — generic backend data
  dir; legacy DAG runs use it for working directories.
- Spawner-side (per host, NOT on the AgentForge backend):
  `${NTFR_WORKDIR}/<name>/{state.json,workspace,.meta}`,
  `${NTFR_WORKDIR}/.archive/`, `${NTFR_WORKDIR}/.spawner/state.db`
  (`docs/spawner/architecture.md:23-46`). The backend never reads
  these — it only sees lifecycle events.

### 5.4 Authentication credentials

- **Developer secret** — random 32-byte hex (`db/queries/developers.ts:89`),
  returned exactly once at create time, validated on WS handshake
  (`developers-routes.ts:25-38`). Regeneratable via
  `GET /api/developers/:id/secret`.
- **Spawn approval → developer creation** — when a `kind=developer`
  intent is approved, a fresh developer row + secret is generated
  before the spawner spawns the container, so `DEVELOPER_ID`/
  `DEVELOPER_SECRET` can be injected as env (`spawners-routes.ts:218-236`).
- **Spawner-host auth** — none in v1. Lifecycle-event ingest is
  open; outbound spawner calls go over plaintext HTTP. Documented as
  TODO in `routes/spawners-routes.ts:337-349` and
  `docs/spawner/architecture.md:125-143`. The deferred ed25519 pass
  is UNGROUNDED — needs author input on signing scope.
- **Anthropic OAuth credential** — host-managed at
  `/var/lib/claude-creds/credentials.json`, mounted into the backend
  read-only (`docker-compose.yml:48-54`) and into developer
  containers via the spawner's per-kind volumes injection (commit
  `375d2cc`, `spawner/src/lib/compose-file.ts:60-79`).

---

## 6. Transport map

### 6.1 HTTP routes (mounted in `platform/backend/src/index.ts:39-55`)

| Path prefix | Router | Purpose |
| --- | --- | --- |
| `/api/projects` + `/services|/actions|/edges|/dag|/build|/task|/editor|/chat` | `routes/projects.ts` and friends | Legacy DAG (out of catalogue scope) |
| `/api/integrations/plane` | `routes/plane.ts` | Plane integration (legacy) |
| `/api/scopes` | `routes/scopes.ts` | `scopes` CRUD |
| `/api/oracles` | `routes/oracles-routes.ts` | Oracle CRUD + query + state inspect |
| `/api/coordinator` | `routes/coordinator-routes.ts` | Chat CRUD; `POST /chats/:id/message` SSE; `POST /chats/:id/save` for `[save, …]` blocks; rewind via `DELETE /chats/:id/messages/:messageId` |
| `/api/developers` | `routes/developers-routes.ts` | Developer CRUD; `POST /:id/dispatch`; `GET /:id/queue`; per-run approve/cancel/edit/retry/continue + logs/stream |
| `/api/spawners` | `routes/spawners-routes.ts` | Host CRUD + probe; `GET /:id/spawns[/:primitiveName]` (latest state read); `GET|POST /:id/spawn-intents[/:intentId/{approve|cancel}]`; `POST /:hostId/events` (lifecycle ingest, host_id-keyed) |

Frontend client wraps these typed in `platform/frontend/lib/api.ts`:
`oraclesApi` (407-414), `developersApi` (591-614), `spawnersApi`
(560-588). Chat endpoints are called directly with `fetch` from
`coordinator/page.tsx`. The frontend → backend proxy handles
`/api/[...path]` (`platform/frontend/app/api/[...path]/route.ts`).

### 6.2 WebSocket — developer dispatch protocol

Endpoint: `ws://backend/api/developers/connect/:id?secret=<hex>`
registered in `routes/developers-routes.ts:21-62`.

Message shapes:

- **Outbound (server → worker)**:
  ```ts
  type DispatchMessage = {
    type: 'dispatch'
    runId: string
    instructions: string
    mode: 'implement' | 'clarify'
    resumeContext?: string | null
  }
  ```
  (`services/developer-registry.ts:43-51`, `developer/src/index.ts:156-162`)

- **Inbound (worker → server)**: `heartbeat`, `event`, `run_update`
  (`developer-registry.ts:20-39`):
  ```ts
  | { type: 'heartbeat' }
  | { type: 'event'; runId; event_type: string; data?: object }
  | { type: 'run_update'; runId; status: RunStatus;
      git_sha_start?; git_sha_end?; response?; error?;
      push_status?: 'pushed'|'failed'|'not_attempted'; push_error? }
  ```

WS close codes: `4001 superseded`, `4003 bad secret`, `4004 not found`,
`1011 server error`. Heartbeat interval 30s
(`developer/src/index.ts:243-247`); reconnect with exponential backoff
+ jitter, capped 60s (`developer/src/index.ts:234-241`).

### 6.3 Spawner HTTP — outbound from backend

`SpawnerClient` (`services/spawner-client.ts:104-239`) wraps the eight
endpoints documented in `docs/spawner/api-contract.md`:
`GET /health`, `GET /info`, `POST /spawns`, `GET /spawns`,
`GET /spawns/{name}`, `POST /spawns/{name}/destroy`,
`GET /spawns/{name}/logs`. `POST /update` is not exposed — spawner
returns 501. Defaults: timeout 5000 ms (health 2000 ms), 2 retries
(transport / 5xx / 408 / 429 only) with exponential backoff +
±20% jitter. Errors are typed `SpawnerHttpError` /
`SpawnerTransportError`.

`probe()` returns `{ status: 'online'|'offline'|'error', … }` and is
the only place `GET /info` is paired with `GET /health`. The probe
route writes the result back onto the host row (status, version,
capabilities, last_seen_at, last_error) — `spawners-routes.ts:94-128`.

### 6.4 Spawner HTTP — inbound to backend

Single endpoint: `POST /api/spawners/:hostId/events`. `:hostId` is the
spawner-supplied identifier (e.g. `host-eu-1`), NOT the internal UUID
(`spawners-routes.ts:350-385`). Body is the
`lifecycleEventSchema`-validated event. Server returns 200
`{ ok, deduped }` on accept/replay, 404 on unknown host, 409 on body
`host_id` mismatching URL, 400 on validation failure.

Spawner-side retry/backoff is owned by the spawner and is durable
(persisted in the spawner sqlite outbox); the backend is allowed to
return non-2xx — the spawner will retry up to
`NTFR_LIFECYCLE_RETRY_MAX` (default 5) before dropping with a
warning (`docs/spawner/architecture.md:96-105`).

### 6.5 Oracle subprocess

Not a network transport — it's a child process:
`spawn('claude', […], { cwd: stateDir })`
(`services/oracle-engine.ts:40-44`). Stdout is line-delimited
`stream-json`. Authentication piggybacks on whatever Claude OAuth
creds the host process has (the same mounted
`/var/lib/claude-creds/credentials.json`).

### 6.6 SSE streams

- Coordinator turn: `POST /api/coordinator/chats/:id/message` →
  `data: <json>\n\n` events of type
  `status | oracle | dispatch | read | spawn | text | done`
  (`routes/coordinator-routes.ts:165-297`, frontend consumer
  `coordinator/page.tsx:262-408`). `status` is human-readable
  ("Querying 2 oracle(s)…") and is not persisted.
- Developer run logs:
  `GET /api/developers/:id/runs/:runId/stream` → replays existing
  logs, then streams `log:<runId>` / `update:<runId>` /
  `complete:<runId>` events from the registry's EventEmitter
  (`routes/developers-routes.ts:425-483`). Used by the developer
  detail page (referenced in clarify doc; not directly inspected
  here).
- Spawner: no SSE today. `spawnerRegistry` holds an `EventEmitter`
  (`services/spawner-registry.ts`) but no route subscribes —
  reserved for a future feed (Ambiguity A8 in the backend clarify).

### 6.7 Compose / network

`docker-compose.yml` (root) wires postgres (5432), backend (3001 +
code-server range 8900-8910), frontend (host port 80 → container
3000), and a one-shot `agent-builder` that builds
`agentforge/claude-agent:latest`. Single bridge network
`agentforge-net`. Frontend talks to the backend at `http://backend:3001`
inside the network and the proxy rewrites client requests at
`/api/[...path]`. Per-project user compose for legacy projects is
generated at runtime by `services/compose-generator.ts` (legacy DAG —
out of scope).

Spawner deploy compose is shipped separately under `spawner/deploy/` —
not part of the AgentForge root compose.

---

## 7. Known gaps / parked work

Each item below is real (cited from repo) but **out of scope for
splitting** — the splitter should record them and move on.

- **Researcher runtime image.** `kind=researcher` is in the spawn-spec
  enum (`schemas/spawner.ts:7`) and accepted by `[spawn, …]` grammar
  (`coordinator.ts:185-198`), but no Dockerfile, no worker code, no
  developer-row analog created on approval, no WS protocol. Schema
  comment confirms: "the spawner doesn't yet have a runtime image
  for it" (`schemas/spawner.ts:4-6`). UNGROUNDED — needs author input
  on intended runtime + connection model.
- **Ed25519 auth pass.** Lifecycle-event ingest is open
  (`routes/spawners-routes.ts:337-349`); spawner outbound calls are
  plaintext HTTP. Documented in `docs/spawner/architecture.md:125-143`
  as deferred until "all ntfr primitives at once". UNGROUNDED on
  signing scope — needs author input on which surfaces sign and how
  keys are issued at host registration.
- **`SpawnInfo.queued` cleanup.** Frontend type carries an optional
  `queued` field that mirrors `DispatchInfo.queued`, but the spawn
  approval flow has no equivalent of "approved-but-host-busy" because
  `SpawnerClient.spawn()` is synchronous and the spawner's mutex
  serializes at the host level (`routes/spawners-routes.ts:170-173`).
  Field is dead except as a pass-through. Out of scope per dispatch.
- **No SSE feed for spawner events.** `spawnerRegistry` emits
  `event:<host>` / `event:<host>:<primitive>` but no consumer route
  is wired (`services/spawner-registry.ts:6-15`,
  `routes/spawners-routes.ts:369-370`). Frontend SpawnBadge polls
  instead (`coordinator/page.tsx:1104-1153`).
- **Direct spawn from admin UI.** Frontend admin page reads-only on
  spawns; "spawn primitive" form not built (Ambiguity A6 in frontend
  clarify).
- **Spawn event-history endpoint.** `spawn_events` is append-only and
  has no exposed `GET /api/spawners/:id/spawns/:name/events` route
  (Ambiguity A11 in frontend clarify, also called out here).
- **`POST /update` (spawner).** Returns 501. Reserved for in-place
  primitive reconfiguration without losing `workspace/` (`docs/spawner/api-contract.md:197-209`).
- **Oracle pricing trailers.** `oracle-engine.ts` records only
  `duration_ms`; the Claude `result` event carries `total_cost_usd`,
  `duration_api_ms`, `stop_reason`, etc. but they are not extracted.
  Per-oracle cost dashboards therefore can't exist without a code
  change. UNGROUNDED — needs author input on whether to mirror the
  developer-run trailer capture.
- **Oracle effort parameter (low/normal/deep).** Not present.
  UNGROUNDED — see §3.4.
- **Pilot oracle split (hardware → second → agentforge-last).**
  Not represented. UNGROUNDED — see §3.5.
- **Author-controlled section boundaries and curation/compaction.**
  Not represented. UNGROUNDED — see §3.6.
- **Claude-native `@import` migration.** Not represented. UNGROUNDED
  — see §3.3.
- **Per-message / per-oracle / per-researcher pricing trailers.**
  Per-message cost is captured for coordinator (migration 008) and
  developer runs (migration 005) but not oracles or researchers.
  UNGROUNDED on aggregation/dashboard plans — needs author input.
- **Hearth tiered structured load.** No reference in the repo
  (one mention of `@hearth/core` provider in
  `lib/anthropic-oauth.ts:4` is unrelated). UNGROUNDED — needs
  author input on what "Hearth" is and how its load-tiering relates
  to AgentForge.
- **Per-primitive UID splitting.** Spawner currently uses a shared
  `10001` (`docs/spawner/architecture.md:160`). Future work, listed.
- **`/start`, `/stop`, `/restart` spawner endpoints.** Not implemented;
  destroy + re-spawn is the only pause path
  (`docs/spawner/architecture.md:163-165`).
- **Cross-host migration / rebalancing.** Not implemented
  (`docs/spawner/architecture.md:167`).
- **Legacy DAG / projects / services / actions / builds.** Tables
  exist (`db/migrations/001_initial.ts`, `002_action_chats.ts`),
  routes mounted (`platform/backend/src/index.ts:40-48`), but no
  primitive in the active catalogue interacts with them. Whether
  they are deprecated, kept-for-migration, or still developed in
  parallel is UNGROUNDED — needs author input.
- **Scope-based authorization.** `scopes.id` is FK'd from
  `oracles.scope_id` and `developers.scope_id` but no enforcement
  exists — any developer can be dispatched against any workspace,
  any oracle answers any chat. The dispatch's "scope matrix"
  reflects de-facto access, not enforced access.
- **Frontend dark-mode-only assumption.** `<html className="dark">`
  is hardcoded (`platform/frontend/app/layout.tsx`). Not a gap for
  splitting, just noted.
- **Side-finding — coordinator deletes children of `developers.name` collisions.** The lifecycle ingest flips ALL `developers` rows whose `name` matches the destroyed primitive (`db/queries/spawners.ts:230-239`). Combined with the spawn-approve path that creates a developer row keyed on the same `name` (`spawners-routes.ts:222-236`), a name reuse means historical developer rows survive but in `status='destroyed'`. Not a bug but worth surfacing — splitter should note name-uniqueness invariants.
- **Side-finding — `[spawn, …]` vs. `[query, …]` regex symmetry.** Both parsers tolerate optional whitespace before `[end]` differently — `parseReadCommands` is the only one explicitly tolerant of an optional blank/comment line (`coordinator.ts:360-368`); the others require strict `\n[end]` (`coordinator.ts:329, 344, 385`). Behaviour, not a bug.
- **Side-finding — dispatch claim mismatch with commits.** The dispatch attributes "sentinel rewrite for runId visibility across turns" to `375d2cc` and "SpawnBadge useEffect reconciliation" to `45b745a`. The actual commits are inverse: `375d2cc` is `spawner compose update` (volumes injection in `spawner/src/lib/compose-file.ts`); both the sentinel rewrite (`coordinator-routes.ts`) AND SpawnBadge reconciliation (`coordinator/page.tsx`) landed together in `45b745a` (`agentforge: SCOPE`). The repo wins per dispatch STOP rule — both behaviour pins are at `45b745a`, and `375d2cc` is the freshest commit covering the per-kind container volume injection.

---

## 8. Glossary

- **Coordinator** — In-process backend service that runs the
  two-pass chat loop. One per chat session (lifetime = HTTP request).
- **Coordinator chat** — A `coordinator_chats` row plus all its
  `coordinator_messages`. UI surface is `/coordinator` in the
  frontend.
- **Developer** — Long-running Claude-Code WebSocket worker
  identified by a `developers` row + `secret`. One workspace per
  developer.
- **Researcher** — Reserved primitive kind. No runtime today.
  Treated by the splitter as planned, not active.
- **Oracle** — Per-domain knowledge store. Read-on-demand via
  `[query, domain]`; write-via-merge via `[save, domain]`.
- **Spawner host** — Per-host docker manager. One spawner process
  per physical host; the backend keeps a `spawner_hosts` registry
  and talks to each over HTTP.
- **Primitive** — In spawner-speak, any single-container ntfr
  workload (`developer | researcher | oracle`). Not the same as
  "primitive" in this anatomy doc (which catalogues all first-class
  AgentForge concepts).
- **Dispatch** — A coordinator-emitted `[dispatch, dev, mode]`
  intent. Persisted as a `developer_runs` row in status `pending`.
  Provisional until user approves.
- **Run** — The execution lifecycle of an approved dispatch. Same
  `developer_runs` row; status flows
  `queued → running → success | failure | cancelled | no_changes`.
- **Spawn intent** — A coordinator-emitted `[spawn, host, name]`
  intent. Persisted as a `spawn_intents` row in status `pending`.
  Provisional until user approves.
- **Spawn event** — A spawner-pushed lifecycle transition. Append-only
  audit row in `spawn_events`; the latest one drives the `spawns`
  projection.
- **Mode** (developer) — `implement` (worker may modify files,
  commit, push) or `clarify` (worker reads only, returns
  questions). Mode is per-run, immutable post-creation.
- **Status** (run) — `pending | queued | running | success | failure
  | cancelled | no_changes`.
- **Push status** — Orthogonal to run status:
  `pushed | failed | not_attempted | null`. Lets a `success` run
  carry a push-failure annotation without flipping to `failure`.
- **State** (primitive lifecycle) —
  `creating | running | crashed | destroyed | orphaned`.
  Spawner-defined; both backend and spawner share the enum.
- **`[query, domain]…[end]`** — Coordinator command to read from an
  oracle. Parsed in `coordinator.ts:325-338`.
- **`[dispatch, developer, mode]…[end]`** — Coordinator command to
  create a pending dispatch. Parsed in `coordinator.ts:340-354`.
- **`[read, run-id]…[end]`** — Coordinator command to fetch a prior
  run's report on demand. Pull-only; never auto-injected. Parsed in
  `coordinator.ts:360-368`.
- **`[spawn, host-id, primitive-name]…<YAML>…[end]`** —
  Coordinator command to propose a spawn. Body is YAML; required
  field `kind` ∈ `developer | researcher`. Parsed in
  `coordinator.ts:383-424`.
- **`[save, domain]…[end]`** — User-issued (NOT coordinator-issued)
  command to merge new info into an oracle's state. Routed to a
  separate endpoint `POST /api/coordinator/chats/:id/save`
  (`routes/coordinator-routes.ts:117-163`).
- **Sentinel** — HTML-comment block embedded in a persisted
  assistant message that stores structured payload data so the
  frontend can rehydrate badges on chat reload, and the coordinator
  can recover dispatch runIds across turns. Four kinds: ORACLES,
  DISPATCHES, READS, SPAWNS.
- **Trailer** — Final `result` event from a Claude turn carrying
  `total_cost_usd`, `duration_ms`, `duration_api_ms`, `stop_reason`,
  `session_id`, etc. Captured per-developer-run (migration 005),
  per-coordinator-message (migration 008). Not captured for oracles.
- **Approval gate** — User clicks Approve in a chat badge to flip
  `pending → queued` (dispatch) or `pending → approved` (spawn
  intent). Coordinator never auto-approves.
- **FIFO per developer** — Approved (`queued`) runs are picked oldest
  first by `created_at ASC` (`db/queries/developers.ts:295-305`).
  `(per coordinator system prompt)` — "Developers process dispatches
  FIFO per developer — the order you emit the
  `[dispatch, ...][end]` blocks IS the order they will run."
- **Required dispatch structure** — Every `[dispatch, …]` body must
  contain four labeled markdown sections: STOP criteria, Out of
  scope, Commit/report contract, Read-before-write requirements
  `(per coordinator system prompt)`, also enforced as prose by the
  developer worker prompt (`developer/src/index.ts:106-127`).
- **Resume context** — Stitched failure context (stop_reason, error,
  last assistant text) from a parent run, prepended to a child
  run's prompt by `/continue` (not `/retry`). Stored on the child's
  `developer_runs.resume_context` column (migration 009).

---

End of doc.
