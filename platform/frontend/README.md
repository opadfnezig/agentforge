# @agentforge/frontend

Next.js 16 (App Router) + React 19 UI for AgentForge. Renders the project builder, DAG editor, coordinator/oracle/developer consoles, and proxies API calls to the backend.

## Purpose

- Visual UI for creating projects and services, editing DAG workflows, and running builds.
- Consoles for the Coordinator (SSE chat), Oracles (domain state), and Developers (dispatching remote Claude Code workers).
- Proxy browser → backend requests through a catch-all Next.js route so the browser only ever talks to the frontend origin.

## Entry points

- `app/layout.tsx` — root layout + top nav (Coordinator / Oracles / Developers / Projects).
- `app/page.tsx` — landing page.
- `app/api/[...path]/route.ts` — catch-all proxy that forwards everything under `/api/**` to `BACKEND_URL`, preserving method, headers, SSE / chunked streaming, and 204s.
- `next.config.js`, `tailwind.config.js`, `postcss.config.js`, `tsconfig.json`.

## Layout

```
app/
  layout.tsx, page.tsx, globals.css
  api/[...path]/route.ts       Backend proxy
  coordinator/page.tsx         Coordinator SSE chat console
  oracles/page.tsx, [id]/…     Oracle list + detail
  developers/page.tsx, [id]/…  Developer registry + dispatch
  projects/
    new/page.tsx               Create project
    [id]/
      page.tsx, project-actions.tsx
      build/…                  Build runs + logs
      dag/…                    DAG editor (ReactFlow)
      editor/…                 code-server iframe
      services/…               Services CRUD
components/
  ui/                          shadcn-style primitives (button, input, toaster, …)
  dag/                         ActionNode, ActionPanel, Chat, DeletableEdge, EndNode,
                               FileBrowser, StartNode, WorkflowList, WorkflowSelector
  agent/StreamViewer.tsx       Agent event stream renderer
  editor/                      (placeholder)
lib/
  api.ts                       Typed API client + type declarations
  websocket.ts                 WS client helpers
  utils.ts                     cn() etc.
e2e/, tests/                   Playwright + vitest
public/                        Static assets
```

## Run

From repo root:

```bash
pnpm --filter frontend install
pnpm --filter frontend dev           # next dev on :3000
pnpm --filter frontend build
pnpm --filter frontend start
pnpm --filter frontend test          # vitest
pnpm --filter frontend test:e2e      # playwright
pnpm --filter frontend test:e2e:ui
```

Or via Docker Compose: `pnpm docker:up` (builds from `./platform/frontend/Dockerfile`, depends on `backend`).

Env vars:

- `BACKEND_URL` — where the proxy forwards; defaults to `http://backend:3001` (Docker network). Set to `http://localhost:3001` for local dev.

Note: `lib/api.ts` hardcodes `http://backend:3001` for server-side rendering because runtime env vars don't survive Next.js standalone output. Client-side requests use relative `/api/*` and go through the catch-all proxy.

## Key modules

- `app/api/[...path]/route.ts` — stateless proxy. Strips `host`, forwards body for non-GET/HEAD, streams SSE and chunked responses, returns `{ error: { message: 'Backend unavailable', code: 'PROXY_ERROR' } }` on fetch failure.
- `lib/api.ts` — typed wrappers over every backend route group (`projectsApi`, `servicesApi`, `actionsApi`, `edgesApi`, `buildsApi`, `tasksApi`, `editorApi`, `actionChatApi`, `actionFilesApi`, `oraclesApi`, `developersApi`) plus exported TS interfaces.
- `components/dag/*` — DAG authoring UI built on `reactflow`.
- `components/agent/StreamViewer.tsx` — consumes streamed agent events from the backend.
- `lib/websocket.ts` — WS wrapper used by consoles that subscribe to developer runs.

## Dependencies

Runtime: `next@16`, `react@19`, `react-dom@19`, `reactflow`, `swr`, `zustand`, `zod`, `@monaco-editor/react`, Radix UI primitives (`dialog`, `dropdown-menu`, `popover`, `scroll-area`, `select`, `separator`, `slot`, `tabs`, `toast`, `tooltip`), `class-variance-authority`, `clsx`, `tailwind-merge`, `tailwindcss`, `@tailwindcss/typography`, `lucide-react`, `react-markdown`, `remark-gfm`, `date-fns`.

Dev: `@playwright/test`, `@testing-library/react`, `@testing-library/jest-dom`, `vitest`, `@vitejs/plugin-react`, `jsdom`, `eslint-config-next`, `autoprefixer`, `postcss`, `typescript`.

## Contracts

### Upstream (consumed from backend)

The frontend has **no independent API**; its surface is everything the backend exposes under `/api/**`. See `platform/backend/README.md` for the authoritative list. `lib/api.ts` is a thin typed wrapper over:

- `projectsApi` — `/projects`, `/projects/:id`, `/projects/:id/{compose,start,stop,rebuild}`
- `servicesApi` — `/projects/:id/services[/:sid][/files[/*]]`
- `actionsApi` — `/projects/:id/actions`, `/projects/:id/dag`, `/projects/:id/dag/validate`
- `edgesApi` — `/projects/:id/edges[/:eid]`
- `buildsApi` — `/projects/:id/build[/:bid][/cancel|/runs[/:rid][/logs|/files]]`
- `tasksApi` — `/projects/:id/task[/:tid][/logs]`
- `editorApi` — `/projects/:id/editor[/url]`
- `actionChatApi` / `actionFilesApi` — `/projects/:id/actions/:aid/{chat,files}`
- `oraclesApi` — `/oracles[/:id][/state|/query|/queries]`
- `developersApi` — `/developers[/:id][/secret|/dispatch|/runs[/:rid][/logs]]`

### Shared types

TS interfaces mirroring backend Zod schemas are declared locally in `lib/api.ts`:
`Project`, `CreateProject`, `UpdateProject`, `Service`, `CreateService`, `UpdateService`, `Action`, `CreateAction`, `UpdateAction`, `Edge`, `CreateEdge`, `DagValidation`, `Build`, `ActionRun`, `AgentLog`, `FileChange`, `FileInfo`, `Task`, `CreateTask`, `TaskLog`, `ChatMessage`, `CreateChatMessage`, `ActionFile`, `Scope`, `Oracle`, `OracleQuery`, `OracleStateFile`, `Developer`, `DeveloperRun`, `DeveloperLog`.

**Invariant:** these must match `platform/backend/src/schemas/*.ts`. Changes to a backend Zod schema require updating the matching interface here.

### Proxy contract (`app/api/[...path]/route.ts`)

- Methods: `GET`, `POST`, `PATCH`, `PUT`, `DELETE`.
- Request: path under `/api/**` forwards 1:1 to `${BACKEND_URL}/api/**`.
- Headers: all preserved except `host`.
- Body: forwarded verbatim for non-GET/HEAD.
- Responses: `204` returned as bodyless; `text/event-stream` and `transfer-encoding: chunked` streamed through; `transfer-encoding` header stripped (Next handles its own chunking).
- Error: fetch failure → `502` with `{ error: { message, code: 'PROXY_ERROR' } }`.

### Routes (pages the user navigates to)

`/`, `/coordinator`, `/oracles`, `/oracles/:id`, `/developers`, `/developers/:id`, `/projects`, `/projects/new`, `/projects/:id`, `/projects/:id/{dag,build,services,editor}`.
