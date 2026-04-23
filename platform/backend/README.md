# @agentforge/backend

Express + TypeScript API server for AgentForge. Hosts the REST/WebSocket surface the frontend talks to, drives Docker-based build/agent runs, and holds the Knex-managed database (Postgres in prod, SQLite for dev).

## Purpose

- Serve the AgentForge API (`/api/*`) consumed by the frontend.
- Persist projects, services, DAG actions/edges, builds, oracles, developers, runs, logs.
- Orchestrate Docker containers for project services, code-server editor sessions, and agent workers.
- Terminate the developer worker WebSocket (`/api/developers/connect/:id`) and dispatch `implement` / `clarify` runs.
- Run the coordinator (SSE chat) and oracle engines.

## Entry points

- `src/index.ts` — Express app bootstrap, middleware, route mounting, WebSocket registration, graceful shutdown.
- `src/config.ts` — Zod-validated env loader; fails fast on missing vars.
- `knexfile.ts` / `knexfile.cjs` — Knex migration/seed config.
- `docker-entrypoint.sh` — Container entrypoint (runs migrations then starts the server).

## Layout

```
src/
  index.ts              App bootstrap
  config.ts             Env schema & parsing
  routes/               Express routers (one file per resource)
  services/             Business logic (docker, coordinator, oracle engine, developer registry, …)
  schemas/              Zod schemas + inferred TS types (shared contract shape)
  db/
    connection.ts       Knex instance
    migrations/         Knex migrations (numbered)
    queries/            Query helpers per resource
    seeds/              Seed data
  utils/                logger (pino), error-handler, compose-generator, prompt-builder
tests/                  vitest unit tests (api.test.ts, dag-validation.test.ts, schemas.test.ts)
dist/                   tsc output (gitignored via top-level build outputs rule)
```

## Run

From repo root (uses pnpm workspaces):

```bash
pnpm --filter backend install
pnpm --filter backend db:migrate
pnpm --filter backend dev            # tsx watch src/index.ts
pnpm --filter backend test
pnpm --filter backend build && pnpm --filter backend start
```

Or via Docker Compose from the repo root: `pnpm docker:up` (builds the backend image from `./platform/backend/Dockerfile`, waits on `postgres` healthcheck).

Env vars (see `src/config.ts` for full schema; `.env.example` at repo root):

- `DATABASE_URL` — `postgres://…` or `sqlite://./agentforge.db`
- `ANTHROPIC_API_KEY` — optional if `~/.claude/.credentials.json` is mounted
- `PORT` (default 3001), `FRONTEND_URL`, `DATA_DIR`
- `DOCKER_SOCKET`, `AGENT_IMAGE`
- `PLANE_API_URL` / `PLANE_API_KEY` / `PLANE_WORKSPACE` / `PLANE_PROJECT_ID` (optional)
- `CODE_SERVER_PORT_START` (default 8900), `CODE_SERVER_PASSWORD`
- `ORACLE_STATE_DIR`, `COORDINATOR_MODEL`, `ORACLE_MODEL`

## Key modules

- `services/docker.ts` — dockerode client; generates and runs compose, starts/stops/rebuilds project containers.
- `services/orchestrator.ts`, `services/task-runner.ts`, `services/agent-runner.ts`, `services/base-agent.ts` — DAG execution and agent process management.
- `services/coordinator.ts` + `routes/coordinator-routes.ts` — SSE coordinator chat, parses `[save, domain] … [end]` blocks into oracle state.
- `services/oracle-engine.ts` + `routes/oracles-routes.ts` — oracle query/state merge.
- `services/developer-registry.ts` + `routes/developers-routes.ts` — developer worker registry, dispatch queue, WebSocket endpoint.
- `services/code-server.ts` — spawns per-project code-server containers on `CODE_SERVER_PORT_START+N`.
- `services/plane-client.ts` — optional Plane.so integration.
- `services/compose-generator.ts` (via `utils/`) — emits `docker-compose.yml` for a project from its services.

## Dependencies

Runtime: `express`, `express-ws`, `cors`, `helmet`, `morgan`, `knex`, `pg`, `sqlite3`, `sql.js`, `dockerode`, `zod`, `pino`, `chokidar`, `diff`, `date-fns`, `uuid`, `yaml`, `dotenv`.

Dev: `tsx`, `typescript`, `vitest`, `@vitest/coverage-v8`, `supertest`, `eslint` + typescript-eslint.

External services: Postgres (prod) or SQLite file (dev), Docker daemon via socket, optional Plane.so API, optional Anthropic API (or mounted Claude credentials).

## Contracts

### HTTP API (base path `/api`, mounted in `src/index.ts`)

| Mount | Router | Resource |
|---|---|---|
| `/api/projects` | `routes/projects.ts` | Projects CRUD + `compose`/`start`/`stop`/`rebuild` |
| `/api/projects/:projectId/services` | `routes/services.ts` | Services (node/next/python/go/static/database/custom) + files |
| `/api/projects/:projectId/actions` | `routes/actions.ts` | DAG actions + per-action chat/files |
| `/api/projects/:projectId/edges` | `routes/edges.ts` | DAG edges (`success`/`failure`) |
| `/api/projects/:projectId/dag` | `routes/dag.ts` | DAG read + `validate` |
| `/api/projects/:projectId/build` | `routes/build.ts` | Builds, runs, logs, file changes |
| `/api/projects/:projectId/task` | `routes/task.ts` | Ad-hoc task dispatch + logs |
| `/api/projects/:projectId/editor` | `routes/editor.ts` | code-server lifecycle per project |
| `/api/projects/:projectId/chat` | `routes/chat.ts` | Project-scoped chat |
| `/api/integrations/plane` | `routes/plane.ts` | Plane.so passthrough |
| `/api/scopes` | `routes/scopes.ts` | Scopes CRUD |
| `/api/oracles` | `routes/oracles-routes.ts` | Oracles list/CRUD, `state`, `query`, `queries` |
| `/api/coordinator` | `routes/coordinator-routes.ts` | SSE coordinator chat (`text/event-stream`) |
| `/api/developers` | `routes/developers-routes.ts` | Developers CRUD, `secret`, `dispatch`, `runs`, `runs/:id/logs` |
| `/health` | inline | Liveness probe |

Error envelope: `{ error: { message, code } }` with HTTP status from `AppError` (see `utils/error-handler.ts`).

### WebSocket contract — developer worker

Endpoint: `ws://<backend>/api/developers/connect/:id?secret=<secret>`

Worker → server messages (JSON):
- `{ type: 'heartbeat' }` — every 30s.
- `{ type: 'run_update', runId, status, git_sha_start?, git_sha_end?, response?, error_message? }` — status ∈ `running | success | failure | no_changes`.
- `{ type: 'event', runId, event_type, data }` — streamed Claude Code stdout events + `stderr` / `raw` fallbacks.

Server → worker messages:
- `{ type: 'dispatch', runId, instructions, mode: 'implement' | 'clarify' }`.

### SSE contract — coordinator

`/api/coordinator` streams `data: <JSON CoordinatorEvent>\n\n` events (see `services/coordinator.ts`). The coordinator parses `[save, <domain>] … [end]` blocks out of assistant output and merges them into oracle state via `oracle-engine.mergeIntoState`.

### Shared types / Zod schemas

All request/response shapes are defined as Zod schemas in `src/schemas/` and inferred into TS types. The frontend re-declares matching interfaces in `platform/frontend/lib/api.ts` — **these must stay in sync**.

- `schemas/project.ts` — `Project`, `CreateProject`, `UpdateProject`, `ProjectStatus` (`draft|building|ready|error|stopped`).
- `schemas/service.ts` — `Service`, template (`node|next|python|go|static|database|custom`), status (`pending|building|ready|error`).
- `schemas/action.ts` — `Action`, action type (`start|end|build|unit-test|api-test|integration-test|e2e-test|fixer|router|custom`), `actionConfigSchema` (promptTemplate, maxRetries, timeoutMinutes, testCommand, testPattern, …).
- `schemas/edge.ts` — `Edge`, type `success|failure`.
- `schemas/build.ts` — `Build`, `ActionRun`, `AgentLog`, `FileChange`.
- `schemas/oracle.ts` — `Oracle`, status `active|inactive|error`.
- `schemas/scope.ts` — `Scope` (name, description, path).
- `schemas/developer.ts` — `Developer`, `DeveloperRun`, `DeveloperLog`, status (`offline|idle|busy|error`), run mode (`implement|clarify`), run status (`pending|running|success|failure|cancelled|no_changes`), `Dispatch`.
- `schemas/api.ts` — `Pagination`, `CreateTask`, `ChatMessage`, `StartEditor`, `DagValidation` (error types: `cycle|orphan|missing_start|missing_end|invalid_edge`).

### Database schema

Defined by Knex migrations under `src/db/migrations/`:
- `001_initial.ts` — core tables (projects, services, actions, edges, builds, action_runs, agent_logs, file_changes, tasks, task_logs, scopes, chat messages).
- `002_action_chats.ts` — per-action chat messages.
- `003_oracle_builder_coordinator.ts` — oracles, oracle_queries, coordinator tables.
- `004_coordinator_chats.ts` — coordinator chat persistence.
- `004_developers.ts` — developers, developer_runs, developer_logs.

Query helpers in `src/db/queries/` wrap Knex and return typed rows matching the Zod schemas above.

### File formats / CLI

- `docker-compose.yml` for a project is generated by `utils/compose-generator.ts` from the project's services and stored on `projects.composeConfig`.
- Oracle state is persisted as files under `ORACLE_STATE_DIR/<domain>/`, written by `oracle-engine.mergeIntoState`.
- CLI surface is limited to `scripts` in `package.json`: `dev`, `build`, `start`, `test`, `lint`, `db:migrate`, `db:migrate:make`, `db:rollback`, `db:seed`.
