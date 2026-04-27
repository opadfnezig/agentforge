# Spawner backend integration — CLARIFY

Generated: 2026-04-27T18:15:50Z
Mode: clarify only — no code, no migrations, no schema changes.

---

## Important up-front note: the commit `c923d94f` does not exist

The brief asked me to summarize "what landed in commit c923d94f". That hash
is not in the repo. I checked:

- `git rev-parse --verify c923d94` → `fatal: Needed a single revision`.
- `git log --all --oneline | grep c923` → no match.
- `git for-each-ref` → no ref points at it.
- All sibling `.git` dirs under `/ntfr` (the only nested one is
  `/ntfr/agentforge/.git` — `/ntfr/ntfr/` is just config, not a repo;
  `core/` is mentioned in CLAUDE.md as a separate repo but is not present
  on disk).

The closest spawner-introduction commit is **`8559755`** —
`agentforge: # Task 1: ntfr-spawner — standalone spawn-node service`,
2026-04-25, which added everything under `spawner/` and `docs/spawner/`.
Nothing backend-side has landed yet. I treat that as the de-facto target
for question 1.9 and surface this as Ambiguity #1 below.

The brief's other STOP condition — "if the spawner API contract is not
discoverable from the repo, STOP" — is **not triggered**. The contract IS
discoverable: `docs/spawner/api-contract.md` (256 lines), plus a typed
ground truth in `spawner/src/lib/types.ts` and `spawner/src/services/lifecycle-events.ts`.

---

## Section 1 — Repo state findings

### 1.1 HTTP framework + entry file

- **Framework:** Express 4 (`express@^4.18.2`) with `express-ws@^5.0.2` for
  WebSockets. `helmet`, `cors`, `morgan`, `pino` middleware.
- **Entry file:** `platform/backend/src/index.ts` (78 lines). Bootstraps
  the app, applies middleware, mounts routers, calls `registerDeveloperWs(app)`,
  starts `app.listen(config.PORT)`, and wires `SIGTERM`/`SIGINT` shutdown.
- Confirmed by `package.json` (`platform/backend/package.json:26-27`) and
  the README (`platform/backend/README.md:14-18`).

### 1.2 Auth middleware

- **There is none.** No `app.use(authMiddleware)` anywhere in
  `platform/backend/src/index.ts`. No file under `platform/backend/src/`
  named `auth*`, `middleware/auth*`, or similar.
- The only authentication-like check in the backend is **per-route secret
  comparison** on the developer WebSocket handshake:
  `platform/backend/src/routes/developers-routes.ts:25-38` — reads
  `?secret=<hex>` from the query string and rejects with WS close code
  `4003` if it doesn't match `developers.secret`.
- HTTP routes are otherwise open. Helmet sets headers; CORS is restricted
  to `config.FRONTEND_URL`. That's it.
- **Implication for this task:** there is no opt-in/opt-out auth pattern
  to follow for the lifecycle ingest. Whatever we do, we'll be inventing
  it. The brief says auth is deferred — so the route will be open for
  now, with a `TODO` documenting the future ed25519 pass per
  `docs/spawner/architecture.md:120-138`.

### 1.3 Route registration pattern

- **Explicit `app.use(mount, router)` calls in `index.ts`.** No file-based
  routing, no decorators.
- Each `routes/<name>.ts` exports a `Router()`-backed const:

  ```ts
  // platform/backend/src/routes/developers-routes.ts:14
  export const developersRouter = Router()
  ```

- Mounted in `platform/backend/src/index.ts:39-53` like:

  ```ts
  app.use('/api/developers', developersRouter)
  registerDeveloperWs(app as any)
  ```

- WS endpoints are registered separately because `express-ws` patches
  `app.ws()`, not `router.ws()`, so a router-only export isn't enough —
  see `platform/backend/src/routes/developers-routes.ts:21-62` and
  `index.ts:53`.

### 1.4 DB layer

- **Driver:** `pg@^8.11.3` (Postgres) for prod; `sqlite3@^5.1.7` (with
  `sql.js@^1.13.0` available) for local dev. Selection driven by
  `DATABASE_URL` prefix in `platform/backend/src/db/connection.ts:4-19`.
- **Query builder:** `knex@^3.1.0`. No ORM. Hand-written queries per
  resource under `platform/backend/src/db/queries/*.ts`.
- **Migration tool:** Knex CLI via npm scripts
  (`platform/backend/package.json:14-17`):
  - `db:migrate` → `knex migrate:latest`
  - `db:rollback` → `knex migrate:rollback`
  - Config in `platform/backend/knexfile.cjs` (and `.ts` mirror) — note
    that the migrations directory points at **`./dist/db/migrations`**
    with `extension: 'js'`, i.e. migrations run against compiled output,
    not source.
- **Migrations directory (source of truth):**
  `platform/backend/src/db/migrations/` — 9 files numbered 001–009 (with
  a duplicate `004_` prefix on `004_coordinator_chats.ts` and
  `004_developers.ts`; Knex orders by filename so it's deterministic).

### 1.5 Existing tables — `dispatches`, `runs`, `workers`

There is **no table named `dispatches`, `runs`, or `workers`**. The
brief's terminology doesn't match the schema. The closest analogs:

| Brief's name | Actual table       | Migration                                              |
| ------------ | ------------------ | ------------------------------------------------------ |
| `workers`    | `developers`       | `004_developers.ts:17-29`                              |
| `dispatches` | `developer_runs`   | `004_developers.ts:32-46` + 005/006/007/009 alter cols |
| (run logs)   | `developer_logs`   | `004_developers.ts:49-56`                              |

This is an important call-out — see Ambiguity #2 below. I'm pasting these
because the brief asked for them; they will not be modified by this task.

#### `developers` (file: `platform/backend/src/db/migrations/004_developers.ts:17-29`)

| Column           | Type                                     | Notes                              |
| ---------------- | ---------------------------------------- | ---------------------------------- |
| `id`             | string(36) PRIMARY KEY                   | UUID                               |
| `name`           | string(100) NOT NULL                     |                                    |
| `scope_id`       | string(36) FK → `scopes.id` ON DELETE SET NULL | nullable                     |
| `workspace_path` | string(500) NOT NULL                     |                                    |
| `git_repo`       | string(500)                              | nullable                           |
| `git_branch`     | string(100)                              | default `'main'`                   |
| `secret`         | string(64) NOT NULL                      | random hex, never returned in list |
| `status`         | string(20)                               | default `'offline'`                |
| `last_heartbeat` | timestamp                                | nullable                           |
| `config`         | jsonb (PG) / text (SQLite)               | default `'{}'`                     |
| `created_at`     | timestamp                                | knex `timestamps(true,true)`       |
| `updated_at`     | timestamp                                | knex `timestamps(true,true)`       |

#### `developer_runs` (file: `platform/backend/src/db/migrations/004_developers.ts:32-46`, plus 005/006/007/009)

Original cols (004): `id`, `developer_id` FK→`developers.id` CASCADE,
`mode`, `instructions`, `status`, `git_sha_start`, `git_sha_end`,
`response`, `started_at`, `finished_at`, `error_message`, `created_at`,
`updated_at`. Indexes: `(developer_id, created_at)`.

Added by 005 (`005_developer_runs_trailer_queue.ts`): `provider`,
`model`, `session_id`, `total_cost_usd`, `duration_ms`, `duration_api_ms`,
`stop_reason`, `trailer` (json). Index `developer_runs_queue_idx` on
`(developer_id, status, created_at)`.

Added by 006 (`006_developer_runs_push_status.ts`): `push_status`,
`push_error`.

Added by 007 (`007_developer_runs_approval.ts`): no new columns —
data migration that promotes existing `pending` rows to `queued`.

Added by 009 (`009_developer_runs_resume_context.ts`): `resume_context`
(text), `parent_run_id` FK→`developer_runs.id` ON DELETE SET NULL.
Index `developer_runs_parent_idx` on `(parent_run_id)`.

Status enum (from `platform/backend/src/schemas/developer.ts:5-13`):
`pending | queued | running | success | failure | cancelled | no_changes`.

#### `developer_logs` (file: `platform/backend/src/db/migrations/004_developers.ts:49-56`)

`id`, `run_id` FK→`developer_runs.id` CASCADE, `timestamp`, `event_type`,
`data` (json). Index on `(run_id, timestamp)`.

### 1.6 Existing dispatch flow — HTTP receive → DB → worker WS push

Trace for the closest existing analog (a developer-run dispatch):

1. **HTTP receive** —
   `platform/backend/src/routes/developers-routes.ts:168-213`:
   `POST /api/developers/:id/dispatch` parses `dispatchSchema`
   (instructions, mode, autoApprove), looks up the developer, derives
   `initialStatus = autoApprove ? 'queued' : 'pending'`.
2. **DB insert** — same handler, line 179, calls
   `developerQueries.createRun(developer.id, instructions, finalMode, initialStatus)`
   (`platform/backend/src/db/queries/developers.ts:152-171`).
3. **Worker dispatch decision** — registry checks online + idle status
   (`developers-routes.ts:181-201`). If both, fire-and-forget
   `developerRegistry.dispatch(...)`; otherwise log "queued (developer
   not idle)" or "awaiting approval" and return 202 immediately with the
   run id.
4. **WS push** —
   `platform/backend/src/services/developer-registry.ts:141-173`:
   builds `{ type: 'dispatch', runId, instructions, mode, resumeContext? }`,
   `ws.send(JSON.stringify(...))`, then UPDATEs developer to busy and
   run to running, and awaits a `complete:<runId>` event.
5. **Queue drain on idle** — when a run reaches a terminal status
   (`developer-registry.ts:266-289`), the registry emits `complete:<runId>`,
   sets developer back to `idle`, and calls `assignNextQueued(developerId)`
   (`developer-registry.ts:96-115`) which pulls the next `'queued'` run
   FIFO via `getNextQueuedRun` (`db/queries/developers.ts:284-292`).

### 1.7 Worker WS infra — closest analog to spawner ingest

The single best analog is the **WS message handler**, not the dispatch
direction. Spawner ingest is the *inverse* of dispatch: the spawner pushes
state-change events to us, just like the developer worker pushes `event`
and `run_update` messages.

- **Connection accept:**
  `platform/backend/src/routes/developers-routes.ts:21-62`. Endpoint
  `ws://.../api/developers/connect/:id?secret=<hex>`. The handler looks
  up the developer by id, compares the query-string secret, registers the
  socket with `developerRegistry.register()`, attaches `message`/`close`/
  `error` listeners. WS close codes: 4003 (bad secret), 4004 (not found),
  1011 (server error), 4001 (superseded by new connection).
- **Routing per developer:** `DeveloperRegistry.sockets`
  (`platform/backend/src/services/developer-registry.ts:60`) — a
  `Map<developerId, DevWebSocket>`. Outbound dispatch picks the socket by
  developerId.
- **Inbound message handling:**
  `platform/backend/src/services/developer-registry.ts:230-298` — switches
  on `msg.type`:
  - `heartbeat` → bump `developers.last_heartbeat`.
  - `event` → `createLog(runId, event_type, data)`, emit
    `log:<runId>`, optionally extract trailer/model metadata via
    `captureRunMetadataFromEvent` (lines 180-225) and persist to the run
    row.
  - `run_update` → write `developer_runs` (status, push_status, shas, …),
    emit `update:<runId>`, on terminal status emit `complete:<runId>`,
    flip developer back to `idle`, drain next queued run.
  - Unknown → warn, no-op.
- The `EventEmitter` on the registry (`developer-registry.ts:61`) is the
  fan-out mechanism — SSE consumers (e.g., the run progress page)
  subscribe to `log:<runId>` / `update:<runId>` / `complete:<runId>`.

### 1.8 Spawner API contract source

**Discoverable. Two grounded sources, plus the spawner README index:**

- **`docs/spawner/api-contract.md`** (256 lines, sections per endpoint with
  request/response JSON examples, error codes, and the inbound lifecycle
  POST shape at lines 213-256).
- **Typed ground truth in spawner code:**
  - `spawner/src/lib/types.ts:1-70` — Zod schemas + `LifecycleEvent`
    interface.
  - `spawner/src/services/lifecycle-events.ts:88-110` — actual delivery
    function. The HTTP target is built as
    `${NTFR_SERVER_URL}/spawners/{NTFR_HOST_ID}/events` (line 102-104),
    `Content-Type: application/json`, body matches `LifecycleEvent`.
- **`docs/spawner/architecture.md`** — the topology, retry policy
  (lines 96-105), and the deferred-auth notes (lines 120-138).
- **Spawner README endpoint table:** `spawner/README.md:50-62`.
- **Env defaults:** `spawner/deploy/.env.example`.

Concrete invariants pulled from those files (will be cited in Section 2):

- **Inbound ingest URL** the spawner expects on this backend:
  `POST /spawners/{host_id}/events` (relative to `NTFR_SERVER_URL`).
  Note: this is a **bare path**, not `/api/spawners/...`. The spawner
  config's `NTFR_SERVER_URL` example is `https://ntfr.example.com/api`,
  so when concatenated, the actual hit is
  `<NTFR_SERVER_URL>/spawners/{host_id}/events` →
  `https://ntfr.example.com/api/spawners/{host_id}/events`. Effectively
  the route lives under `/api/spawners` on our side. See Ambiguity #3.
- **Body fields (stable):** `event_id` (uuid), `primitive_name`,
  `primitive_kind` ∈ {`developer`,`researcher`,`oracle`}, `state` ∈
  {`creating`,`running`,`crashed`,`destroyed`,`orphaned`}, `prev_state`
  (same enum or null), `timestamp` (ISO), `host_id`, `payload` (object,
  see contract for per-state shape).
- **Ack contract:** 2xx → spawner marks delivered; non-2xx → exponential
  backoff retry up to `NTFR_LIFECYCLE_RETRY_MAX` (default 5); after cap →
  drop with warning. Server **SHOULD dedupe by `event_id`** (api-contract
  line 255-256) — re-delivery and in-flight retries are both possible.
- **Outbound API the backend talks to (this client wraps):** all 7
  endpoints in `docs/spawner/api-contract.md` — `GET /health`, `GET /info`,
  `POST /spawns`, `GET /spawns`, `GET /spawns/{name}`,
  `POST /spawns/{name}/destroy`, `GET /spawns/{name}/logs`,
  `POST /update` (501).

### 1.9 What landed in commit `c923d94f`

**`c923d94f` does not exist in this repo.** Reported up top.

The most likely intended target — `8559755` (2026-04-25, "Task 1: ntfr-spawner
— standalone spawn-node service") — touches **only** spawner-side code and
docs. Nothing in `platform/backend/`. File list (27 files, 4276 +/0):

- Docs: `docs/spawner/api-contract.md`, `architecture.md`, `deploy.md`.
- Spawner package root: `spawner/.gitignore`, `README.md`, `package.json`,
  `package-lock.json`, `tsconfig.json`.
- Deploy: `spawner/deploy/{.env.example,Dockerfile,deploy.sh,docker-compose.yml}`.
- Source: `spawner/src/{index.ts,config.ts}`,
  `spawner/src/lib/{compose-file,db,docker,error-handler,logger,mutex,types}.ts`,
  `spawner/src/routes/{spawns,system}.ts`,
  `spawner/src/services/{archive,lifecycle,lifecycle-events,primitive-state}.ts`.

Exported types relevant to the backend integration
(`spawner/src/lib/types.ts`):

- `PRIMITIVE_KINDS` = `['developer','researcher','oracle']` and
  `PrimitiveKind`.
- `PRIMITIVE_STATES` = `['creating','running','crashed','destroyed','orphaned']`
  and `PrimitiveState`.
- `primitiveNameSchema` (Zod): `[a-z0-9][a-z0-9_-]*`, ≤63 chars.
- `spawnRequestSchema` (Zod) — body of POST /spawns.
- `LifecycleEvent` interface — body of POST /spawners/:host/events.

TODOs left in spawner code that affect the backend integration:

- `POST /update` is 501 (`docs/spawner/api-contract.md:197-209`,
  `spawner/README.md:61`). The backend client should still expose a stub
  but not call it.
- `docs/spawner/architecture.md:139-160` — auth pass deferred. The ingest
  route on our side mirrors that.

---

## Section 2 — Build plan proposal

Naming convention: I follow the rest of the schema (snake_case columns,
`string(36)` UUID PKs, `timestamps(true,true)`). Migration #N is the next
free number, **`010`**.

### 2.1 `spawner_hosts` migration — column list

Migration file: `platform/backend/src/db/migrations/010_spawner_hosts.ts`.

| Column          | Type                                | Notes                                                  |
| --------------- | ----------------------------------- | ------------------------------------------------------ |
| `id`            | `string(36)` PRIMARY KEY            | UUID — internal id                                     |
| `host_id`       | `string(64)` NOT NULL UNIQUE        | spawner-supplied identifier (e.g. `host-eu-1`); used in URL `/spawners/:host_id/events` and as event `host_id` |
| `name`          | `string(100)` NOT NULL              | human label                                            |
| `base_url`      | `string(500)` NOT NULL              | how the backend reaches this spawner; e.g. `http://10.0.5.7:9898` |
| `status`        | `string(20)` NOT NULL DEFAULT `'unknown'` | one of `unknown|online|offline|error`            |
| `version`       | `string(40)`                        | from `GET /info`, nullable                             |
| `capabilities`  | `jsonb` / `text` JSON DEFAULT `'[]'`| from `GET /info`                                       |
| `last_seen_at`  | `timestamp`                         | last successful health probe or event ingest           |
| `last_event_at` | `timestamp`                         | last lifecycle event received                          |
| `last_error`    | `text`                              | most recent probe/ingest error                         |
| `config`        | `jsonb` / `text` JSON DEFAULT `'{}'`| escape hatch (e.g. dial timeout overrides)             |
| `created_at`    | `timestamp` (auto)                  |                                                        |
| `updated_at`    | `timestamp` (auto)                  |                                                        |

Indexes:
- `unique(host_id)` (from the column definition).
- `index(status)` — for "list all online hosts" lookups.

No FK to anything else (deferred — researcher/oracle primitives are not
yet modeled; see Ambiguity #4).

### 2.2 CRUD route shapes

Mount: `app.use('/api/spawners', spawnersRouter)` in
`platform/backend/src/index.ts`.

Router file: `platform/backend/src/routes/spawners-routes.ts`.

| Method  | Path                          | Body / Query                                 | Response                              | Status     |
| ------- | ----------------------------- | -------------------------------------------- | ------------------------------------- | ---------- |
| `GET`   | `/api/spawners`               | —                                            | `SpawnerHost[]`                       | 200        |
| `POST`  | `/api/spawners`               | `{ hostId, name, baseUrl, config? }`         | `SpawnerHost` (newly created)         | 201        |
| `GET`   | `/api/spawners/:id`           | —                                            | `SpawnerHost`                         | 200 / 404  |
| `PATCH` | `/api/spawners/:id`           | `{ name?, baseUrl?, config? }`               | `SpawnerHost`                         | 200 / 404  |
| `DELETE`| `/api/spawners/:id`           | —                                            | `(empty)`                             | 204 / 404  |
| `POST`  | `/api/spawners/:id/probe`     | —                                            | `{ status, version, capabilities, latencyMs }` | 200 / 502 (host unreachable) |

Notes:
- `:id` is the internal UUID, not the spawner-supplied `host_id`. Lookup
  by `host_id` is only for the ingest route in §2.4.
- `POST /api/spawners` is idempotent on `host_id` (UNIQUE) — duplicate →
  409 `SPAWNER_EXISTS`.
- All bodies validated with new Zod schemas in
  `platform/backend/src/schemas/spawner.ts`. Error envelope follows the
  existing `AppError` / `errorHandler` shape
  (`platform/backend/src/utils/error-handler.ts:5-49`):
  `{ error: { message, code, details? } }`.
- `POST /:id/probe` is deliberately a CRUD-adjacent action: it triggers
  the HTTP client's `getInfo()` and updates `status`/`version`/`capabilities`
  in-band. Returns 502 on transport failure with `code: SPAWNER_UNREACHABLE`.
- **No frontend dispatch endpoints here.** Spawning a primitive (calling
  the spawner's `POST /spawns`) is a separate dispatch — the brief says
  out of scope. We expose the registry + ingest only.

### 2.3 Spawner HTTP client module

File: `platform/backend/src/services/spawner-client.ts`.

Exported surface (function signatures, no implementation):

```ts
import type { LifecycleEvent } from '../schemas/spawner.js'

export interface SpawnerClientOptions {
  baseUrl: string                // e.g. http://10.0.5.7:9898
  timeoutMs?: number             // default 5000
  retries?: number               // default 2 (i.e. 3 attempts total)
  retryBackoffMs?: number        // default 250 (×2^attempt)
  fetchImpl?: typeof fetch       // for tests
}

export interface SpawnerHealth { status: 'ok'; timestamp: string }

export interface SpawnerInfo {
  host_id: string
  version: string
  capabilities: string[]
  primitive_count: number
  uptime_ms: number
  server_url_configured: boolean
}

export interface SpawnSpec {                 // mirrors spawnRequestSchema
  name: string
  kind: 'developer' | 'researcher' | 'oracle'
  image: string
  workdir?: string
  env?: Record<string, string>
  mounts?: Array<{ source: string; target: string; readOnly?: boolean }>
  command?: string | string[]
  args?: string[]
}

export interface PrimitiveStateRecord { /* shape from api-contract POST /spawns 201 */ }

export interface InspectResult { state: PrimitiveStateRecord; folder: string; history: …; last_event: … }

export interface LogsResult { service: string; tail: number; since: string|null; exit_code: number; stdout: string; stderr: string }

export class SpawnerClient {
  constructor(opts: SpawnerClientOptions)
  health(): Promise<SpawnerHealth>
  info(): Promise<SpawnerInfo>
  listSpawns(): Promise<PrimitiveStateRecord[]>
  inspectSpawn(name: string): Promise<InspectResult>
  spawn(spec: SpawnSpec): Promise<PrimitiveStateRecord>
  destroySpawn(name: string): Promise<{ ok: boolean; archive_path: string; archive_bytes: number; compose_rm_code: number }>
  logs(name: string, opts?: { tail?: number | 'all'; since?: string }): Promise<LogsResult>
  // POST /update intentionally omitted: spawner returns 501.
}

// Convenience factory used by routes/services so we look up the host row,
// build a client, and call it in one place:
export const clientForHost = async (hostInternalId: string): Promise<SpawnerClient>
```

Retry policy:
- **Transport-level retries only** (network error, 5xx, 408, 429). 4xx
  except 408/429 → no retry, surface as a typed `SpawnerHttpError`.
- Default 2 retries (3 attempts total), `retryBackoffMs * 2^attempt` with
  ±20% jitter. Defaults chosen to be much shorter than the spawner's own
  outbox retries — we're a synchronous user-facing call, the spawner's
  delivery loop is the durable layer.

Timeouts:
- Default per-request timeout 5000 ms (generous enough for `POST /spawns`
  which can take >1s for `compose up`, but capped so a hung host fails
  fast). Caller can override.
- Health probe uses `timeoutMs: 2000`.

Health probe shape returned to callers:

```ts
type ProbeResult =
  | { status: 'online'; version: string; capabilities: string[]; primitiveCount: number; latencyMs: number }
  | { status: 'offline'; reason: string }
  | { status: 'error'; httpStatus: number; reason: string }
```

`probe()` calls `GET /health` first (cheap), then `GET /info` (richer),
combines into the above. `POST /api/spawners/:id/probe` invokes this and
also writes the result back onto the row (`status`, `version`,
`capabilities`, `last_seen_at`, `last_error`).

### 2.4 Lifecycle ingest route

Route file: `platform/backend/src/routes/spawners-routes.ts` (same router
as 2.2; lifecycle handler co-located).

**Path:** `POST /api/spawners/:hostId/events`.

`:hostId` is the spawner-supplied `host_id` (string), looked up via
`spawner_hosts.host_id`, NOT the internal UUID. This matches the URL the
spawner builds in `spawner/src/services/lifecycle-events.ts:102-104`:

```
${NTFR_SERVER_URL}/spawners/${encodeURIComponent(NTFR_HOST_ID)}/events
```

If `NTFR_SERVER_URL` is set to `https://ntfr.example.com/api`, the actual
hit is `/api/spawners/<host>/events` — perfectly aligned with our `/api`
mount prefix.

**Auth posture: NONE — explicit TODO.**

- No middleware. No signature check. No allowlist beyond
  `host_id`-must-exist-in-DB.
- File-level comment block at the top of the route documents the deferred
  ed25519 pass per `docs/spawner/architecture.md:120-138`.
- Same posture as the `developers-routes.ts` WS endpoint, which only
  validates a shared secret (and even that is not on inbound HTTP). The
  brief explicitly defers auth.
- **Recommendation:** until auth lands, deploy must keep the backend's
  `/api/spawners/*` path on a private network only. Worth noting in the
  TODO comment + the migration doc.

**Request body schema** (Zod, in
`platform/backend/src/schemas/spawner.ts`):

```ts
export const lifecycleEventSchema = z.object({
  event_id: z.string().uuid(),
  primitive_name: z.string().min(1).max(63),
  primitive_kind: z.enum(['developer', 'researcher', 'oracle']),
  state: z.enum(['creating', 'running', 'crashed', 'destroyed', 'orphaned']),
  prev_state: z.enum(['creating', 'running', 'crashed', 'destroyed', 'orphaned']).nullable(),
  timestamp: z.string().datetime(),
  host_id: z.string().min(1).max(64),
  payload: z.record(z.unknown()).default({}),
})
```

**Response contract:**
- `200 { ok: true, deduped: boolean }` — accepted (or already accepted).
- `404 { error: { code: 'SPAWNER_HOST_NOT_FOUND' } }` — `:hostId` not
  registered. The spawner will retry; operator must register the host.
- `400` — Zod validation failure (`VALIDATION_ERROR`). Spawner won't
  retry helpful errors here.
- `409 { error: { code: 'HOST_ID_MISMATCH' } }` — `body.host_id !== :hostId`
  in URL. Defensive; spawner sets both consistently but worth catching.
- `500` — DB write failed. Spawner will retry per its outbox policy.

**Insert shape** (writes into `spawn_events` from §2.5):

```ts
INSERT INTO spawn_events (
  id /* uuid */,
  spawner_host_id /* FK */,
  event_id /* from body, UNIQUE */,
  primitive_name,
  primitive_kind,
  state,
  prev_state,
  event_timestamp /* from body.timestamp */,
  payload /* json */,
  received_at /* now() */
) ON CONFLICT (event_id) DO NOTHING -- dedupe per api-contract.md:255-256
```

In SQLite-land (no `ON CONFLICT … DO NOTHING` in older sqlite3 driver
configurations of knex), dedupe is implemented as a SELECT-then-INSERT
inside a transaction. Either way, dedupe is by `event_id` (UUID). If the
INSERT actually wrote a row → response `deduped: false`; if it was a
no-op → `deduped: true`.

**State-update logic** (writes to `spawns` from §2.5):

After the `spawn_events` insert (regardless of dedupe), upsert the
`spawns` row keyed on `(spawner_host_id, primitive_name)` with the
*latest-timestamp-wins* rule:

- If the existing row's `last_event_at` is `>=` this event's `timestamp`
  → no update (out-of-order event arriving late from a retry).
- Otherwise → set `state`, `prev_state`, `last_event_id`,
  `last_event_at`, `payload` to the incoming values.
- Bump `spawner_hosts.last_event_at` and `last_seen_at` to `now()`.

Out-of-order handling matters because spawner retries can deliver an old
event after a newer one (rare, but the outbox is FIFO-by-`next_attempt_at`,
not by transition time).

Emit a registry-style event for SSE consumers:
`spawnRegistry.events.emit('event:<host_id>:<primitive_name>', record)` —
keeps the door open for a future SSE feed without locking it in now.

### 2.5 `spawn_events` migration — column list (greenfield)

Same migration file as §2.1 (`010_spawner_hosts.ts`) creates two more
tables. Splitting into a separate migration is fine too; either way 010
is the slot.

#### `spawns` (current state per primitive)

| Column            | Type                                       | Notes                                          |
| ----------------- | ------------------------------------------ | ---------------------------------------------- |
| `id`              | `string(36)` PRIMARY KEY                   |                                                |
| `spawner_host_id` | `string(36)` FK → `spawner_hosts.id` ON DELETE CASCADE | NOT NULL                          |
| `primitive_name`  | `string(63)` NOT NULL                      |                                                |
| `primitive_kind`  | `string(20)` NOT NULL                      | `developer | researcher | oracle`              |
| `state`           | `string(20)` NOT NULL                      | latest state                                   |
| `prev_state`      | `string(20)`                               | nullable                                       |
| `last_event_id`   | `string(36)`                               | UUID of the event that produced current state |
| `last_event_at`   | `timestamp` NOT NULL                       | event timestamp (NOT received_at)              |
| `payload`         | `jsonb` / `text` JSON                      | last event's payload                           |
| `created_at`      | `timestamp`                                |                                                |
| `updated_at`      | `timestamp`                                |                                                |

Indexes:
- `unique(spawner_host_id, primitive_name)`.
- `index(spawner_host_id, state)`.

#### `spawn_events` (append-only audit log)

| Column            | Type                                                | Notes                                                |
| ----------------- | --------------------------------------------------- | ---------------------------------------------------- |
| `id`              | `string(36)` PRIMARY KEY                            | internal                                             |
| `spawner_host_id` | `string(36)` FK → `spawner_hosts.id` ON DELETE CASCADE | NOT NULL                                          |
| `event_id`        | `string(36)` UNIQUE NOT NULL                        | spawner-supplied, the dedupe key                     |
| `primitive_name`  | `string(63)` NOT NULL                               |                                                      |
| `primitive_kind`  | `string(20)` NOT NULL                               |                                                      |
| `state`           | `string(20)` NOT NULL                               |                                                      |
| `prev_state`      | `string(20)`                                        | nullable                                             |
| `event_timestamp` | `timestamp` NOT NULL                                | from body, ISO-parsed                                |
| `payload`         | `jsonb` / `text` JSON DEFAULT `'{}'`                |                                                      |
| `received_at`     | `timestamp` NOT NULL DEFAULT `now()`                |                                                      |

Indexes:
- `unique(event_id)` — dedupe.
- `index(spawner_host_id, primitive_name, event_timestamp)` — history queries.
- `index(received_at)` — retention queries (future).

### 2.6 File tree diff

**New files (created by this task — but NOT in this clarify run):**

```
platform/backend/src/
  routes/spawners-routes.ts          ← CRUD + probe + lifecycle ingest
  services/spawner-client.ts         ← HTTP client (SpawnerClient class + factory)
  services/spawner-registry.ts       ← optional: thin EventEmitter wrapper, like developer-registry
  schemas/spawner.ts                 ← Zod schemas + inferred TS types
  db/queries/spawners.ts             ← spawner_hosts / spawns / spawn_events queries
  db/migrations/010_spawner_hosts.ts ← creates all three tables

platform/backend/tests/
  spawners.test.ts                   ← supertest unit tests
  spawner-client.test.ts             ← unit tests against a stub fetch
  spawner-ingest.integration.test.ts ← optional, hits a sqlite db
```

**Modified files:**

```
platform/backend/src/index.ts        ← +1 import (spawnersRouter), +1 app.use(...)
platform/backend/src/db/connection.ts ← +3 DbSpawnerHost / DbSpawn / DbSpawnEvent interfaces
platform/backend/README.md            ← +1 row in HTTP API table, +1 schema bullet, +1 migration bullet
```

That's the full diff. No changes to anything under `platform/frontend/`,
`developer/`, `spawner/`, `docker/`, `docker-compose.yml`, or any
existing route/migration/module.

### 2.7 Test plan

**Unit — `spawner-client.test.ts`** (mocks `fetch`):

- `health()` happy path returns `{ status: 'ok', timestamp }`.
- `info()` returns the typed `SpawnerInfo`.
- `spawn(spec)` posts the right body shape; 201 returns the
  PrimitiveStateRecord; 400/409/500 throw typed `SpawnerHttpError` with
  status + code.
- Retry: 5xx → retry up to N, then throw. 4xx (not 408/429) → no retry.
- Timeout: AbortController fires at `timeoutMs`.
- Backoff respects `retryBackoffMs * 2^attempt`.

**Unit — `spawners.test.ts`** (supertest, mocks `db/queries/spawners.ts`
and `services/spawner-client.ts`, à la `tests/api.test.ts`):

- `POST /api/spawners` valid → 201 with body.
- `POST /api/spawners` duplicate `host_id` → 409.
- `GET /api/spawners` → list.
- `GET /api/spawners/:id` not found → 404.
- `PATCH /api/spawners/:id` partial update → 200.
- `DELETE /api/spawners/:id` → 204; 404 for missing.
- `POST /api/spawners/:id/probe` → 200 with probe shape;
  client throws → 502 with `SPAWNER_UNREACHABLE`.

**Unit — lifecycle ingest** (in same `spawners.test.ts`):

- `POST /api/spawners/:hostId/events` valid body → 200 `{ ok: true, deduped: false }`.
- Replay (same `event_id`) → 200 `{ ok: true, deduped: true }`, no
  duplicate row.
- Unknown `:hostId` → 404 `SPAWNER_HOST_NOT_FOUND`.
- Body `host_id` mismatches URL → 409.
- Validation failures (bad `event_id`, bad enum) → 400.
- Out-of-order event (timestamp older than `spawns.last_event_at`) →
  inserted into `spawn_events` but `spawns` row unchanged.

**Integration — `spawner-ingest.integration.test.ts`** (real SQLite,
runs `010_spawner_hosts.ts` against an in-memory db, à la the spawner
project's smoke approach since the backend has no integration harness yet):

- Insert host → POST 5 events → assert `spawn_events` has 5 rows,
  `spawns` reflects latest, `spawner_hosts.last_event_at` bumped.
- 5 in-order events + 1 replay (3rd event) + 1 out-of-order event
  (timestamp older than current) → `spawn_events` has 6 rows (replay
  dropped), `spawns` reflects the truly latest.

What gets mocked vs. real:
- **Mocked:** `dockerode` (already in `tests/setup.ts`); `fetch` (for
  `spawner-client.test.ts`); `db/queries/spawners` (for the supertest
  unit suite).
- **Real:** SQLite on disk for the integration test (the existing
  `connection.ts` already supports `sqlite://` URLs).

Existing test layout to mirror: `platform/backend/tests/api.test.ts`
(supertest + vi.mock for queries) and `tests/setup.ts` for env defaults.

---

## Section 3 — Ambiguities + questions

### A1. The commit hash `c923d94f`

- (a) The hash named in the brief doesn't exist in this repo. I cannot
  verify what was meant by "what landed" there.
- (b) Options: (i) the brief means `8559755` (Task 1, only spawner-side
  code/docs landed); (ii) it refers to a separate repo we don't have
  access to (e.g., a backend-side prep commit on a feature branch
  somewhere); (iii) typo for some other hash in this repo's history.
- (c) **Recommendation:** assume (i) for §1.9 and proceed. If the user
  expected backend-side scaffolding to already exist, they should
  confirm — none does.

### A2. Naming mismatch between brief and schema

- (a) The brief says "existing tables: `dispatches`, `runs`, `workers`".
  None exist with those names. The closest analogs are `developer_runs`
  (per-dispatch row) and `developers` (per-worker row).
- (b) Options: (i) the brief is using generic terms and `developers` /
  `developer_runs` are what was meant; (ii) the brief expects future
  generalization (a dispatch table that points at `worker_kind` =
  developer | researcher | oracle); (iii) the brief is from a project
  with a different schema and was misapplied.
- (c) **Recommendation:** assume (i). I'm proposing `spawn_events` /
  `spawns` / `spawner_hosts` as **new** tables that do NOT touch
  `developer_runs` or `developers`. Spawner-managed primitives are a
  separate concept from the existing per-developer dispatch flow, even
  when the primitive's `kind` is `developer` (a "developer primitive"
  on the spawner is the *container*, the AgentForge `developers` row is
  the *worker identity inside it*). They can be linked later via a
  nullable FK if needed (deferred).

### A3. Ingest path — `/api/spawners/...` vs. `/spawners/...`

- (a) The spawner builds the URL as `${NTFR_SERVER_URL}/spawners/{host}/events`.
  If `NTFR_SERVER_URL=https://ntfr.example.com/api`, the hit is
  `/api/spawners/...`. If operators set `NTFR_SERVER_URL=https://ntfr.example.com`,
  the hit is `/spawners/...` — outside our `/api` mount.
- (b) Options: (i) require `NTFR_SERVER_URL` to include `/api` and only
  expose at `/api/spawners/*`; (ii) expose at both `/api/spawners/*`
  and `/spawners/*` to be tolerant; (iii) expose only at `/spawners/*`
  (drop `/api` prefix on this one route); (iv) document the requirement
  in a README and trust operators.
- (c) **Recommendation:** (i). The example in `spawner/deploy/.env.example`
  already has `/api` in `NTFR_SERVER_URL`, and every other backend
  endpoint is under `/api`. Documenting this requirement in the spawner
  README + a 404 with a hint message ("did you forget `/api` in
  `NTFR_SERVER_URL`?") is enough.

### A4. Should `spawn_events` / `spawns` link to `developers` / `oracles`?

- (a) When `primitive_kind === 'developer'`, the spawned container *is*
  the runtime for an AgentForge `developers` row. Worth correlating?
- (b) Options: (i) leave them disjoint for now (no FK); (ii) add a
  nullable `developer_id` / `oracle_id` / `researcher_id` to `spawns`;
  (iii) introduce a polymorphic `primitive_id` plus `primitive_kind` and
  resolve at query time.
- (c) **Recommendation:** (i). The brief explicitly carves out frontend
  + researcher + retry/continue, and we'd be inventing the cross-link
  semantics on no concrete need. Add later when the dispatch path that
  *creates* a developer-on-a-spawner exists.

### A5. Status enum on `spawner_hosts`

- (a) What values? "online" / "offline" is obvious, but is "error" a
  separate state from "offline"? Is "unknown" needed for never-probed?
- (b) Options: (i) `unknown | online | offline | error`; (ii)
  `unknown | online | offline` and use `last_error` to disambiguate;
  (iii) just `online | offline`, default `offline`.
- (c) **Recommendation:** (i) — symmetric with how `developers.status`
  carries `error` separately from `offline`
  (`platform/backend/src/schemas/developer.ts:3`). Consistent with the
  rest of the codebase.

### A6. Probe cadence — manual only or background?

- (a) Brief says "health probe" but doesn't specify cadence. Manual via
  `POST /api/spawners/:id/probe`, or a background loop?
- (b) Options: (i) manual only for v1; (ii) background interval (every
  60s, like `developers.last_heartbeat`); (iii) on-demand + last-result
  caching with a TTL.
- (c) **Recommendation:** (i). The lifecycle ingest already updates
  `last_seen_at` whenever the spawner is alive enough to push events,
  which is the better signal anyway. Add a background loop in a future
  pass if "host has been silent for X minutes" alerts become a thing.

### A7. Dedupe semantics — `(event_id)` vs. `(spawner_host_id, event_id)`

- (a) UUIDs collide with vanishingly small probability, but
  `event_id` is generated by `uuidv4()` per-spawner, so a malicious or
  buggy spawner could theoretically reuse one. Is global uniqueness
  enough?
- (b) Options: (i) `unique(event_id)` — global; (ii)
  `unique(spawner_host_id, event_id)` — per-host.
- (c) **Recommendation:** (i). UUIDv4 collision is not worth defending
  against; if a spawner reuses an event_id that's a bug in the spawner.
  Simpler index, simpler dedupe SQL.

### A8. SSE/WS feed for ingested events?

- (a) The developer flow exposes lifecycle events to the frontend via
  the existing `EventEmitter` on the registry + the SSE consumer in
  `coordinator-routes.ts` / the run progress page. Should ingest do the
  same?
- (b) Options: (i) emit on a registry-style EventEmitter but don't add
  any consumer route in this dispatch; (ii) add an SSE feed at
  `GET /api/spawners/:hostId/events/stream`; (iii) skip entirely.
- (c) **Recommendation:** (i). Cheap to add the emitter; expensive to
  remove an SSE route once it ships. Frontend dispatch is out of scope,
  and the frontend can poll `GET /api/spawners/:hostId/spawns` (a future
  read endpoint) until SSE is justified.

### A9. Health probe response status when host is dead

- (a) `POST /api/spawners/:id/probe` against an unreachable host: 200
  with `status: 'offline'`, or 502?
- (b) Options: (i) always 200 — probing succeeded, the answer is that
  the host is offline; (ii) 502 — the operation failed.
- (c) **Recommendation:** (ii). Matches §2.2's table. The operator-facing
  intent of probe is "tell me if this thing works"; non-2xx is the
  honest answer when it doesn't, and the body still carries the reason.
  Trade-off: makes the frontend treat probe specially.

### A10. Where does the spawner's `host_id` come from?

- (a) Spawner generates none — operator sets `NTFR_HOST_ID` env on the
  spawner. The backend's `spawner_hosts.host_id` must agree, but nothing
  prevents drift.
- (b) Options: (i) require operator to register the host via
  `POST /api/spawners` BEFORE pointing the spawner at the backend
  (manual, error-prone); (ii) auto-create a `spawner_hosts` row on first
  unknown-host event (security risk: any reachable spawner can register
  itself); (iii) require both: manual register + first event also calls
  `GET /info` to verify `host_id` in the registered row matches what
  the spawner self-reports.
- (c) **Recommendation:** (i) for now, with a 404 from the ingest route
  if the host is unknown and a clear log line. (ii) is on-by-default
  registration which is the wrong default for a no-auth ingest. When
  signing lands, (ii) becomes safe.

### A11. Should `spawnRequestSchema` be fully imported from spawner code?

- (a) The spawner exports `spawnRequestSchema` in
  `spawner/src/lib/types.ts:17-34`. The backend client needs the same
  shape for its `spawn(spec)` method.
- (b) Options: (i) duplicate the Zod schema in
  `platform/backend/src/schemas/spawner.ts` (same approach as
  `platform/frontend/lib/api.ts` mirrors backend types); (ii) move the
  schema to a new shared package; (iii) `import` directly from
  `../../../spawner/src/lib/types.js`.
- (c) **Recommendation:** (i). The repo's existing convention is to
  duplicate (frontend mirrors backend; spawner is its own package with
  its own `package.json` + `tsconfig`). A shared package is good
  hygiene but adds a third workspace and the surface area is small.
  Add a contract-comparison test later if drift becomes a real problem.

### A12. Migration #N collision

- (a) Two migrations are already prefixed `004_`
  (`004_coordinator_chats.ts` + `004_developers.ts`). Knex orders by
  filename, so it works, but it's noise. The next free prefix is `010`.
- (b) Options: (i) use `010` and move on; (ii) renumber `004_developers.ts`
  → `004a_developers.ts` for cleanliness.
- (c) **Recommendation:** (i). Don't touch existing migrations — they're
  already deployed somewhere.

---

## Section 4 — Files I read while answering

(For the user to verify nothing was cited from memory.)

- `CLAUDE.md`
- `platform/backend/README.md`
- `platform/backend/package.json`
- `platform/backend/knexfile.cjs`
- `platform/backend/vitest.config.ts`
- `platform/backend/tests/setup.ts`
- `platform/backend/tests/api.test.ts` (top of file only)
- `platform/backend/src/index.ts`
- `platform/backend/src/db/connection.ts`
- `platform/backend/src/db/migrations/001_initial.ts` (top portion)
- `platform/backend/src/db/migrations/004_developers.ts`
- `platform/backend/src/db/migrations/005_developer_runs_trailer_queue.ts`
- `platform/backend/src/db/migrations/006_developer_runs_push_status.ts`
- `platform/backend/src/db/migrations/007_developer_runs_approval.ts`
- `platform/backend/src/db/migrations/009_developer_runs_resume_context.ts`
- `platform/backend/src/db/queries/developers.ts`
- `platform/backend/src/routes/developers-routes.ts`
- `platform/backend/src/services/developer-registry.ts`
- `platform/backend/src/schemas/developer.ts`
- `platform/backend/src/utils/error-handler.ts`
- `spawner/README.md`
- `spawner/deploy/.env.example`
- `spawner/src/lib/types.ts`
- `spawner/src/services/lifecycle-events.ts`
- `docs/spawner/api-contract.md`
- `docs/spawner/architecture.md`
- `git log --all --oneline` and `git show 8559755 --stat`
