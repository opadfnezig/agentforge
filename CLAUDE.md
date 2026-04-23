# AgentForge

AgentForge is a visual, DAG-based builder for agent-driven microservices. A Next.js frontend talks to an Express backend, which orchestrates Docker containers and dispatches runs to remote Claude Code workers ("developers").

## Monorepo layout

```
/workspace
├── platform/
│   ├── backend/       @agentforge/backend — Express + Knex API, Docker orchestration, WS hub
│   └── frontend/      @agentforge/frontend — Next.js 16 UI + API proxy
├── developer/         @agentforge/developer — standalone Claude Code WS worker
├── docker/agent/      Dockerfile for the claude-agent base image used by runs
├── docker-compose.yml Compose for postgres + backend + frontend + developer + agent-builder
├── package.json       Root pnpm scripts (dev / build / test / docker:up)
├── pnpm-workspace.yaml Includes platform/backend and platform/frontend only; `developer/` is built directly via its own Dockerfile
├── core/              Separate @hearth/core project (has its own .git; ignored)
└── .env.example       Canonical env var list
```

## Per-project docs

Each project ships its own mdfile. Read those first when working inside that project.

- [platform/backend/README.md](platform/backend/README.md) — HTTP routes, WS dispatch protocol, Zod schemas, Knex migrations, services (docker/coordinator/oracle/developer-registry).
- [platform/frontend/README.md](platform/frontend/README.md) — App Router layout, backend proxy (`app/api/[...path]/route.ts`), typed API client (`lib/api.ts`), DAG/ReactFlow components.
- [developer/README.md](developer/README.md) — WS dispatch message shapes, implement/clarify modes, git commit/push behaviour, env vars.

## Contracts (where they live)

The three projects share contracts that must be kept in sync:

- **HTTP API** — defined in `platform/backend/src/routes/*.ts` and mounted in `platform/backend/src/index.ts`. The frontend proxies everything at `platform/frontend/app/api/[...path]/route.ts` and wraps it typed in `platform/frontend/lib/api.ts`.
- **Zod schemas / shared types** — authoritative in `platform/backend/src/schemas/*.ts`. Mirrored as TS interfaces in `platform/frontend/lib/api.ts`. Changing a backend schema requires updating the frontend interface.
- **Developer WebSocket protocol** — defined by `platform/backend/src/routes/developers-routes.ts` (server side) and `developer/src/index.ts` (worker side). Message shapes (`dispatch`, `run_update`, `event`, `heartbeat`) are documented in both READMEs.
- **Coordinator SSE events** — `platform/backend/src/services/coordinator.ts` (`CoordinatorEvent`); the frontend consumes the stream at `app/coordinator/page.tsx`.
- **Database schema** — Knex migrations under `platform/backend/src/db/migrations/`.
- **Docker compose** — `docker-compose.yml` at the repo root; per-project compose for user projects is generated at runtime by `platform/backend/src/utils/compose-generator.ts`.

## Running locally

```bash
cp .env.example .env           # fill in ANTHROPIC_API_KEY, POSTGRES_PASSWORD, …
pnpm install
pnpm docker:up                 # postgres + backend + frontend + developer
# or, for hot-reload outside Docker:
pnpm --filter backend db:migrate
pnpm dev                       # pnpm -r --parallel run dev (backend + frontend)
# developer worker is not in pnpm-workspace.yaml; run it directly:
cd developer && npm install && npm run dev
```

Frontend on `:3000`, backend on `:3001`, code-server range `:8900-:8910`, Postgres `:5432`.

## Ignored / local-only directories

See `.gitignore`. Notable: `data/`, `sessions_clean/`, `yes_unpacked/`, `yes.tar.gz`, `core/` (separate repo), and all `node_modules/` / build outputs.
