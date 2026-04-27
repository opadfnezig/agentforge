# Spawner frontend integration — CLARIFY

Generated: 2026-04-27T19:27:33Z
Mode: clarify only — answers the questionnaire before implementation. Per the
session brief, implementation immediately follows in the same dispatch.

---

## Up-front: backend path discrepancy with the brief

The brief says:

> Backend endpoints for #2 are being designed in a parallel doc — assume they
> exist as `/api/spawner-hosts` REST CRUD for now; flag in Section 3 if the
> real shape differs once known.

The real shape is now known — the backend dispatch from earlier in this
session shipped at **`/api/spawners`**, not `/api/spawner-hosts`. The
already-shipped surface is verified live (see
`docs/clarify/spawner-backend-clarify-20260427T181550Z.md` §2.2 + the live
smoke tests in commit `376d539`):

| Method  | Path                                | Purpose                                |
| ------- | ----------------------------------- | -------------------------------------- |
| `GET`   | `/api/spawners`                     | list                                   |
| `POST`  | `/api/spawners`                     | create                                 |
| `GET`   | `/api/spawners/:id`                 | get                                    |
| `PATCH` | `/api/spawners/:id`                 | update                                 |
| `DELETE`| `/api/spawners/:id`                 | delete                                 |
| `POST`  | `/api/spawners/:id/probe`           | health probe + status writeback        |
| `GET`   | `/api/spawners/:id/spawns`          | latest known primitive states per host |
| `POST`  | `/api/spawners/:hostId/events`      | spawner-side lifecycle ingest          |

I'm wiring the frontend to **`/api/spawners`**, matching what's deployed.
Surfaced as Ambiguity #1.

---

## Section 1 — Repo state findings

### 1.1 Frontend framework + version

- **Framework:** Next.js **16.0.0** (App Router) with React 19. Node-side
  proxy in front of the Express backend.
  - `platform/frontend/package.json:32` → `"next": "^16.0.0"`.
  - `platform/frontend/package.json:33-34` → `"react": "^19.0.0"`.
- **Router:** App Router (file-based) under `platform/frontend/app/`. Root
  layout at `platform/frontend/app/layout.tsx`.
- **State management:** there is **no global store**. `zustand` and `swr`
  are listed in `package.json` but neither is imported anywhere I can see
  in the coordinator or admin paths — every component owns its state with
  `useState` / `useEffect`. The dispatch approval flow is a clean example
  (see §1.6).
- **TS:** TypeScript 5.3.3, `strict` per `tsconfig.json`. Path alias
  `@/*` → `./platform/frontend/*` (used everywhere).

### 1.2 File tree of the coordinator UI

```
platform/frontend/
├── app/
│   ├── layout.tsx                    Root layout + nav (links: /, /coordinator, /oracles, /developers, /projects)
│   ├── page.tsx                      Dashboard (server-component, fetches oracles+developers)
│   ├── globals.css                   HSL CSS vars + dark-mode overrides
│   ├── api/[...path]/route.ts        Generic proxy → BACKEND_URL/api/<path>
│   ├── coordinator/
│   │   └── page.tsx                  *Single 1129-line page*. SSE consumer, message rendering, all badges inlined.
│   ├── developers/
│   │   ├── page.tsx                  List + create form (representative CRUD page)
│   │   └── [id]/page.tsx             Detail (941 lines): metadata, dispatch, runs, logs, timer, retry/continue
│   ├── oracles/
│   │   ├── page.tsx                  List (read-only)
│   │   └── [id]/page.tsx             Detail
│   └── projects/                     DAG/services UI (out of scope here)
├── components/
│   ├── ui/                           shadcn-style Radix wrappers: button, input, label, textarea, toaster, use-toast
│   ├── agent/                        (future home for shared agent badges; mostly empty today — only shared dispatch view stuff)
│   ├── dag/                          ReactFlow components
│   └── editor/                       Monaco wrappers
└── lib/
    ├── api.ts                        Typed API client (517 lines, grouped by resource)
    ├── utils.ts                      cn() helper
    └── websocket.ts                  WS client (used elsewhere, not coordinator)
```

The coordinator UI is exactly **one file**: `app/coordinator/page.tsx`
(1129 lines). All badges, blocks, parsers, and the SSE consumer live there
inline.

### 1.3 Existing badge components — paste

There is **no `<Badge>` component** in the design system. Everything is
either inline Tailwind on a `<span>` or a small named function inside
`coordinator/page.tsx`. The named ones:

#### `RunIdChip` — `coordinator/page.tsx:1080-1102`

```tsx
function RunIdChip({ runId }: { runId: string }) {
  const [copied, setCopied] = useState(false)
  const onClick = async (e: React.MouseEvent) => { /* clipboard */ }
  const short = runId.length >= 8 ? runId.slice(0, 8) : runId
  return (
    <button
      type="button"
      onClick={onClick}
      title={`runId: ${runId} (click to copy)`}
      className="px-1 py-0.5 rounded bg-zinc-800 text-zinc-500 hover:text-zinc-200 font-mono text-[10px]"
    >
      {copied ? 'copied' : short}
    </button>
  )
}
```

#### `PushStatusBadge` — `coordinator/page.tsx:1104-1129`

```tsx
function PushStatusBadge({ pushStatus, pushError }: {
  pushStatus: 'pushed' | 'failed' | 'not_attempted'
  pushError: string | null
}) {
  if (pushStatus === 'pushed') {
    return <span className="px-1 py-0.5 rounded bg-green-950/50 text-green-400 text-[10px] font-mono border border-green-900/50">pushed</span>
  }
  if (pushStatus === 'failed') {
    return <span className="px-1 py-0.5 rounded bg-red-950/50 text-red-400 text-[10px] font-mono border border-red-900/50" title={pushError || 'push failed'}>push failed</span>
  }
  return null
}
```

#### Status badge inside `DispatchBadge` — `coordinator/page.tsx:710-718, 796`

```tsx
const statusColor: Record<string, string> = {
  pending: 'text-amber-400',
  queued: 'text-zinc-400',
  running: 'text-yellow-400',
  success: 'text-green-400',
  failure: 'text-red-400',
  cancelled: 'text-zinc-400',
  no_changes: 'text-blue-400',
}
// rendered as:
<span className={`font-medium ${statusColor[status] || 'text-zinc-400'}`}>{status}</span>
```

#### Online dot + status pill in `/developers/page.tsx:224-245`

```tsx
function OnlineDot({ online }: { online: boolean }) {
  return <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${online ? 'bg-green-500' : 'bg-zinc-600'}`} />
}
function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    idle: 'bg-green-600', busy: 'bg-yellow-600', error: 'bg-red-600', offline: 'bg-zinc-600',
  }
  return <span className={`px-2 py-0.5 text-xs font-medium text-white rounded ${colors[status] || 'bg-zinc-600'}`}>{status}</span>
}
```

#### Color-token convention (observed across the codebase)

| Token            | Used for                                                       |
| ---------------- | -------------------------------------------------------------- |
| `text-amber-400` | pending / awaiting approval                                    |
| `text-zinc-400`  | queued / cancelled / inert                                     |
| `text-yellow-400`| running / busy                                                 |
| `text-green-400` | success / online                                               |
| `text-red-400`   | failure / error                                                |
| `text-blue-400`  | no_changes (terminal but neutral)                              |
| `text-indigo-400`| **entity name** — developer name in dispatch/read badges       |
| `text-emerald-400`| inline code in markdown, `system`-role messages, success pills |

### 1.4 Is `text-violet-400` used today?

**No.** Confirmed by `grep -r "violet" platform/frontend --include="*.tsx" --include="*.ts"` → zero hits. The default Tailwind palette has it (no extension needed), so adding `text-violet-400` Just Works without touching `tailwind.config.js`.

The closest "entity-name" color today is `text-indigo-400` (developer name on
dispatch badges, line 642/794/833 of `coordinator/page.tsx`). The brief's
request for `text-violet-400` on spawn badges intentionally puts spawn at a
distinct hue from dispatch — the two will sit side by side and need to be
distinguishable at a glance. Good call.

### 1.5 Command grammar parser — entrypoint

**Frontend does NOT parse `[dispatch, ...]` / `[query, ...]` / `[read, ...]`.**
Parsing happens server-side in the coordinator service; the frontend only
consumes already-typed SSE events.

The relevant frontend code:

- **SSE event router** — `app/coordinator/page.tsx:299-352`. A simple
  if/else-if chain on `event.type ∈ {status, oracle, dispatch, read, text, done}`
  appends typed payloads onto per-message arrays.
- **History sentinels** — when the coordinator persists messages, it
  embeds the structured payloads as HTML-comment sentinels in the markdown
  body so they survive reload. The frontend parses them on
  `loadChat()` at `coordinator/page.tsx:97-114`:

  ```ts
  const ORACLE_SENTINEL_REGEX  = /\n*<!--ORACLES:[\s\S]*?:ORACLES-->\s*$/
  const DISPATCH_SENTINEL_REGEX = /\n*<!--DISPATCHES:[\s\S]*?:DISPATCHES-->\s*$/g
  const READ_SENTINEL_REGEX    = /\n*<!--READS:[\s\S]*?:READS-->\s*$/g
  ```

- **Live save-block detection** — only `[save, domain]` is detected
  client-side, and only to route to a different endpoint. See `SAVE_REGEX`
  at line 51 and `hasSaveCommands()` at line 52-55.

**Adding a new "spawn" command from the frontend side requires backend
co-operation** (the backend coordinator service must emit `event.type ==='spawn'` SSE events when the assistant emits `[spawn, ...]` blocks, and
must persist a `<!--SPAWNS:[…]:SPAWNS-->` sentinel for history). Backend
work is **out of scope** per the brief, so the frontend implementation in
this dispatch is **rendering-only**: it ships the data structures, the
SSE handler clause, the badge component, and the history-sentinel parser.
All of it is dead code until the backend emits those events. Surfaced as
Ambiguity #2.

To register a new command-type renderer end-to-end, you'd touch:

1. `coordinator/page.tsx:33-49` — add the `SpawnInfo` interface.
2. `coordinator/page.tsx:230-235` — add `spawns: []` to the placeholder
   message.
3. `coordinator/page.tsx:253-256` — add `accSpawns: SpawnInfo[] = []`.
4. `coordinator/page.tsx:299-352` — add `else if (event.type === 'spawn')`.
5. `coordinator/page.tsx:266-280` — include `spawns: accSpawns` in the
   `flush()` setMessages call.
6. `coordinator/page.tsx:548-555` — render `<SpawnBadge ... />` rows.
7. `coordinator/page.tsx:51-71, 97-114` — add `SPAWNS_SENTINEL_REGEX` for
   history reload.
8. New component `SpawnBadge` — see §2.2.

### 1.6 Approval flow — where it lives

The dispatch approval flow is **entirely inside the `DispatchBadge`
component** (`coordinator/page.tsx:655-1021`). Specifics:

- **State store:** local `useState`. No global store, no zustand.

  ```tsx
  // coordinator/page.tsx:657-663
  const [run, setRun] = useState<DeveloperRun | null>(null)
  const [now, setNow] = useState<number>(() => Date.now())
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState(dispatch.instructions)
  const [actionBusy, setActionBusy] = useState<null | 'approve' | 'cancel' | 'edit' | 'retry' | 'continue'>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [liveChildExists, setLiveChildExists] = useState(false)
  ```

- **Polling:** `coordinator/page.tsx:667-687`. Poll
  `developersApi.getRun()` every 1.5s until terminal status. On error,
  back off to 3s. Never gives up while mounted.
- **Approve/cancel/edit/retry/continue functions:**
  `coordinator/page.tsx:720-783`. All follow the same shape:
  1. `setActionBusy('approve')` (or whatever)
  2. await api call
  3. on success: `setRun(updated)` (no optimistic update — server is source of truth)
  4. on error: `setActionError(err.message)`
  5. `setActionBusy(null)` in finally
- **API methods:** `developersApi.approveRun`, `cancelRun`, `retryRun`,
  `continueRun`, `editRunInstructions` (see `lib/api.ts:477-486`).
- **UI:** the badge `<details>` is `open={isPending}`
  (`coordinator/page.tsx:791`) so pending runs auto-expand. Approve/Cancel/Edit
  buttons render in an `amber-950/20` background panel
  (`coordinator/page.tsx:827-862`).

**No optimistic updates.** Every action waits for server response. If the
user wants instant feedback, the `actionBusy` flag drives an "Approving…"
button label but the underlying `run` state only flips after the server
returns.

### 1.7 Settings/admin pages — pattern

There are **no `/admin/*` or `/settings/*` routes**. CRUD pages live at flat
top-level paths:

- `/developers` (list) + `/developers/[id]` (detail)
- `/oracles` (list) + `/oracles/[id]` (detail)
- `/projects` (with sub-routes for services, actions, etc.)

`/developers/page.tsx` (245 lines) is the representative CRUD page. Pattern:

1. **Local state** for list + form fields + create error + post-create
   secret modal (lines 10-23).
2. **`refresh()`** — single function that re-fetches the list. Called from
   `useEffect(() => refresh(), [])` and after any mutation.
3. **Header** with `<h1>` + description + `<Button>` to toggle the form.
4. **Inline form** below the header, conditionally rendered. Uses
   `<Input>` from `@/components/ui/input`. Validation via local state
   checks (`if (!formName.trim() || !formWorkspace.trim()) return`).
   Error display: `<p className="text-sm text-red-400">{createError}</p>`.
5. **Empty state** dashed-border box (`border-dashed`) when list is empty
   (line 181-184).
6. **Card grid** — `grid gap-4 md:grid-cols-2 lg:grid-cols-3` of
   `<Link>` cards (line 186-219).

A new admin page (`/spawners`) follows this exact shape. See §2.5.

### 1.8 Streaming / message rendering pipeline

- **Stream consumption:** `coordinator/page.tsx:238-364`. `fetch().body.getReader()` + manual `data: <json>\n` line splitting. Coalesces frames via `requestAnimationFrame` to avoid the markdown re-parser pegging the main thread (lines 263-289).
- **Per-message accumulator pattern:** `accText`, `accOracles`,
  `accDispatches`, `accReads` all live in the closure scope of `handleChat`
  (lines 253-256) and are flushed into a single `setMessages` per frame
  (lines 264-281).
- **Renderer mapping:** `MessageRow` (around line 460ff) renders each
  message; the per-type child arrays render through dedicated memoized
  components (`OracleBlock`, `DispatchBadge`, `ReadBlock`) at
  `coordinator/page.tsx:540-564`.

A new `spawn` event hooks in by:
1. Adding the case at line 303-352 (alongside `oracle`/`dispatch`/`read`).
2. Adding an accumulator at line 256.
3. Adding a render block at line 555-564.
4. Adding the memoized `SpawnBadge` component.

### 1.9 Tailwind config + global styles

`platform/frontend/tailwind.config.js` (54 lines):

```js
module.exports = {
  darkMode: 'class',
  content: ['./app/**/*.{js,ts,jsx,tsx,mdx}', './components/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: { extend: {
    colors: {
      border: 'hsl(var(--border))',
      input:  'hsl(var(--input))',
      ring:   'hsl(var(--ring))',
      background: 'hsl(var(--background))',
      foreground: 'hsl(var(--foreground))',
      primary:    { DEFAULT: 'hsl(var(--primary))',     foreground: 'hsl(var(--primary-foreground))' },
      secondary:  { DEFAULT: 'hsl(var(--secondary))',   foreground: 'hsl(var(--secondary-foreground))' },
      destructive:{ DEFAULT: 'hsl(var(--destructive))', foreground: 'hsl(var(--destructive-foreground))' },
      muted:      { DEFAULT: 'hsl(var(--muted))',       foreground: 'hsl(var(--muted-foreground))' },
      accent:     { DEFAULT: 'hsl(var(--accent))',      foreground: 'hsl(var(--accent-foreground))' },
      card:       { DEFAULT: 'hsl(var(--card))',        foreground: 'hsl(var(--card-foreground))' },
    },
    borderRadius: { lg: 'var(--radius)', md: 'calc(var(--radius) - 2px)', sm: 'calc(var(--radius) - 4px)' },
    fontFamily: { sans: ['var(--font-sans)', …], mono: ['var(--font-mono)', …] },
  } },
  plugins: [require('@tailwindcss/typography')],
}
```

- **Dark mode:** `class`-based, applied by `<html lang="en" className="dark">` in `app/layout.tsx:28`. Every page assumes dark background.
- **Custom tokens:** only the shadcn-style design-system slots
  (`background`, `foreground`, `primary`, etc.) backed by HSL CSS vars in
  `globals.css`. **No custom violet tokens.** Tailwind's default
  `violet-{50..950}` palette is available.

---

## Section 2 — Build plan proposal

### 2.1 `[spawn, ...]` command grammar

**Frontend assumes the backend coordinator emits a typed SSE event with the
shape below, and persists a `<!--SPAWNS:…:SPAWNS-->` history sentinel.
Backend changes are out of scope for this dispatch.**

Assumed live-stream event:

```jsonc
{
  "type": "spawn",
  "spawnerHostId": "uuid",      // internal id of spawner_hosts row
  "hostId": "host-eu-1",        // spawner-supplied identifier (display)
  "primitiveName": "dev-alpha",
  "primitiveKind": "developer", // developer | researcher | oracle
  "image": "ghcr.io/x/y:tag",
  "spawnIntentId": "uuid",      // backend-generated; key for approve/cancel API
  "pending": true,              // awaiting user approval
  "queued": false               // approved, waiting for spawner mutex
}
```

History-sentinel shape (analogous to `<!--DISPATCHES:[…]:DISPATCHES-->`):

```html
<!--SPAWNS:[{"spawnerHostId":"…","hostId":"…","primitiveName":"…","primitiveKind":"…","image":"…","spawnIntentId":"…","pending":true,"queued":false}]:SPAWNS-->
```

Frontend additions:
- `SpawnInfo` interface alongside `DispatchInfo` (line 23-31).
- `spawns?: SpawnInfo[]` field on `Message` (line 41-49).
- `accSpawns: SpawnInfo[]` accumulator (line 256).
- `else if (event.type === 'spawn') { accSpawns = [...accSpawns, …]; … }`
  branch (line ~344).
- `spawns: accSpawns` in the `flush()` setMessages call (line 270-280).
- `SPAWNS_SENTINEL_REGEX = /\n*<!--SPAWNS:[\s\S]*?:SPAWNS-->\s*$/g` plus
  matching `loadChat()` parse + `stripSentinel` removal.
- `<SpawnBadge>` rows rendered alongside dispatch/oracle/read (line 555).

### 2.2 Violet `SpawnBadge` component

File: `platform/frontend/app/coordinator/page.tsx` (added inline alongside
`DispatchBadge` to match the existing pattern).

Props:

```ts
interface SpawnInfo {
  spawnerHostId: string
  hostId: string                                       // for display
  primitiveName: string
  primitiveKind: 'developer' | 'researcher' | 'oracle'
  image: string
  spawnIntentId: string
  pending?: boolean
  queued?: boolean
}
```

State machine (mapped from `spawner_hosts` lifecycle + intent gate):

| State        | Color (Tailwind)     | When                             |
| ------------ | -------------------- | -------------------------------- |
| `pending`    | `text-amber-400`     | awaiting user approval           |
| `queued`     | `text-zinc-400`      | approved, host mutex busy        |
| `creating`   | `text-yellow-400`    | spawner is mid-spawn             |
| `running`    | `text-blue-400`      | container up                     |
| `crashed`    | `text-red-400`       | spawner reports `crashed`        |
| `orphaned`   | `text-red-400`       | recovery exhausted               |
| `destroyed`  | `text-zinc-500`      | terminal good                    |
| `cancelled`  | `text-zinc-400`      | rejected before spawn            |

Tailwind shape (mirrors `DispatchBadge`):

```tsx
<details className="bg-zinc-900 border border-zinc-800 rounded text-xs" open={isPending}>
  <summary className="px-3 py-1.5 cursor-pointer text-zinc-400 hover:text-zinc-200 flex items-center gap-2 flex-wrap">
    <span>Spawn:</span>
    <span className="font-medium text-violet-400">{primitiveName}</span>
    <span className="px-1 py-0.5 rounded bg-zinc-800 text-zinc-400 font-mono">{primitiveKind}</span>
    <span className={`font-medium ${statusColor[state] || 'text-zinc-400'}`}>{state}</span>
    <span className="text-zinc-500 font-mono text-[10px]">@ {hostId}</span>
    <span className="text-zinc-500 font-mono text-[10px]" title={image}>{shortImage(image)}</span>
    <a href={`/spawners/${spawnerHostId}`} className="text-zinc-500 hover:text-zinc-300 underline-offset-2 hover:underline ml-auto">view host</a>
  </summary>
  {/* approval block, intent body, lifecycle log — see §2.3 */}
</details>
```

`text-violet-400` is used **only** for the `primitiveName` (the entity
name), to mirror how `text-indigo-400` is used for developer name on
dispatch badges. Status uses the existing color tokens for consistency.

### 2.3 Approval-flow reuse — concrete diff

The dispatch approval flow is **forked, not generalized.** The two flows
have enough divergent semantics (developer poll vs. spawner poll, retry/
continue vs. no analog, edit-instructions vs. no analog) that a shared
hook would be over-abstraction at this stage. Forked components are
already the team's pattern (`OracleBlock` / `ReadBlock` / `DispatchBadge`
are all peer components, not derived from a shared base).

**Reused (verbatim copy of pattern, not abstraction):**
- The `useState<null|'approve'|'cancel'|…>('actionBusy')` shape.
- The `useState<string|null>('actionError')` shape.
- The amber `<div className="px-3 py-2 bg-amber-950/20">` approval panel.
- The polling-until-terminal `useEffect` shape.

**Forked + simplified for spawns:**
- No edit (you can't change a spawn spec post-emission; `[spawn, ...]`
  args are immutable once parsed).
- No retry/continue (a destroyed/crashed spawn restarts via a fresh
  `[spawn, ...]` invocation; this is the spawner's threat model).

**Diff sketch** of what `SpawnBadge` looks like vs. `DispatchBadge`:

```diff
- const [run, setRun] = useState<DeveloperRun | null>(null)
+ const [spawn, setSpawn] = useState<Spawn | null>(null)

- const tick = async () => { const r = await developersApi.getRun(...); setRun(r); ... }
+ const tick = async () => { const s = await spawnersApi.getSpawn(spawnerHostId, primitiveName); setSpawn(s); ... }

- const approve = () => developersApi.approveRun(developerId, runId)
+ const approve = () => spawnersApi.approveSpawn(spawnerHostId, spawnIntentId)

- const cancel  = () => developersApi.cancelRun(developerId, runId)
+ const cancel  = () => spawnersApi.cancelSpawn(spawnerHostId, spawnIntentId)

- // (retry/continue/edit removed — not applicable to spawns)
```

### 2.4 Routing — backend wire path

Approve flow:

1. User clicks **Approve** in `SpawnBadge`.
2. Frontend calls `spawnersApi.approveSpawn(spawnerHostId, spawnIntentId)`
   → `POST /api/spawners/{spawnerHostId}/spawn-intents/{spawnIntentId}/approve`
   (assumed — backend dispatch must define it).
3. Backend translates that into a `SpawnerClient.spawn(spec)` call against
   the registered spawner host. The spawner's `POST /spawns` returns 201
   with the new primitive's state.
4. Backend responds with a `Spawn` row reflecting the new state.

**API client methods to add** in `platform/frontend/lib/api.ts`:

```ts
export const spawnersApi = {
  list: () => fetchAPI<SpawnerHost[]>('/spawners'),
  get: (id: string) => fetchAPI<SpawnerHost>(`/spawners/${id}`),
  create: (data: CreateSpawnerHost) => fetchAPI<SpawnerHost>('/spawners', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: UpdateSpawnerHost) => fetchAPI<SpawnerHost>(`/spawners/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  delete: (id: string) => fetchAPI<void>(`/spawners/${id}`, { method: 'DELETE' }),
  probe: (id: string) => fetchAPI<ProbeResult>(`/spawners/${id}/probe`, { method: 'POST' }),
  listSpawns: (id: string) => fetchAPI<Spawn[]>(`/spawners/${id}/spawns`),
  // STUBS (backend dispatch pending):
  getSpawn: (id: string, primitiveName: string) =>
    fetchAPI<Spawn>(`/spawners/${id}/spawns/${primitiveName}`),
  approveSpawn: (id: string, spawnIntentId: string) =>
    fetchAPI<Spawn>(`/spawners/${id}/spawn-intents/${spawnIntentId}/approve`, { method: 'POST' }),
  cancelSpawn: (id: string, spawnIntentId: string) =>
    fetchAPI<Spawn>(`/spawners/${id}/spawn-intents/${spawnIntentId}/cancel`, { method: 'POST' }),
}
```

Stubs marked `// STUBS` will 404 today and need backend wire-up. The
implementation will mark them with a comment so the next backend dispatch
knows what the frontend assumes.

### 2.5 `spawner_hosts` admin page

Route: `/spawners` (list) + `/spawners/[id]` (detail). Matches the flat
convention of `/developers` and `/oracles`.

**`/spawners` — list page** (`app/spawners/page.tsx`):

Mirror of `/developers/page.tsx`:

- Header: `<h1>Spawner Hosts</h1>` + description + `New Spawner Host`
  button toggling the inline create form.
- Create form fields (Zod-aligned with `createSpawnerHostSchema`):
  - `hostId` (the spawner-supplied identifier, e.g. `host-eu-1`) — required.
  - `name` (display label) — required.
  - `baseUrl` (e.g. `http://10.0.5.7:9898`) — required, URL validation.
- Empty state: dashed-border box, "No spawner hosts registered yet".
- Card grid: `grid gap-4 md:grid-cols-2 lg:grid-cols-3`. Each card shows:
  - status dot (online/offline/error/unknown) + display name
  - status pill
  - `host_id` mono'd
  - `base_url` truncated mono
  - capabilities (e.g. `spawn`, `destroy`) as small zinc pills
  - `last_seen` freshness — using `date-fns` (already a dep) `formatDistanceToNow(new Date(lastSeenAt), { addSuffix: true })` — "30s ago" / "never seen" if null
- Card-as-`<Link>` to `/spawners/{id}`.

**`/spawners/[id]` — detail page** (`app/spawners/[id]/page.tsx`):

- Header: name + status pill.
- Edit form (toggle): `name`, `baseUrl` editable; `host_id` immutable
  (it's the URL the spawner uses to push events — changing would break
  the live spawner). Save → `spawnersApi.update(id, …)`.
- Probe button (top right): `spawnersApi.probe(id)` → toast result, refresh.
- Detail panel: `id`, `host_id`, `base_url`, `version`, `capabilities[]`,
  `last_seen_at`, `last_event_at`, `last_error`, raw `config` JSON.
- **Spawns table** below: `spawnersApi.listSpawns(id)` → list of
  primitives with `name`, `kind`, `state`, `last_event_at`. Empty state
  if none.
- Delete button (footer): with `confirm()` dialog; cascades on backend
  (verified live in the backend dispatch — `spawn_events` and `spawns`
  child rows cascade-delete via FK).

**Form validation:** manual checks (matches `/developers/page.tsx`).
`baseUrl` runs through `try { new URL(formBaseUrl) } catch { … }` before
submit. Backend Zod will catch anything subtler.

**Status-freshness indicator (last_seen):**

```tsx
function LastSeenBadge({ lastSeenAt }: { lastSeenAt: string | null }) {
  if (!lastSeenAt) return <span className="text-zinc-500 text-xs">never seen</span>
  const diff = Date.now() - new Date(lastSeenAt).getTime()
  const stale = diff > 5 * 60 * 1000  // >5min = stale
  const cls = stale ? 'text-amber-400' : 'text-zinc-400'
  return <span className={`${cls} text-xs`}>{formatDistanceToNow(new Date(lastSeenAt), { addSuffix: true })}</span>
}
```

### 2.6 File tree diff

**New files:**

```
platform/frontend/app/spawners/
  page.tsx              List + create form (~210 lines, mirrors developers/page.tsx)
  [id]/page.tsx         Detail + edit + probe + spawns table + delete (~280 lines)
```

**Modified files:**

```
platform/frontend/lib/api.ts                +60 lines  (SpawnerHost, Spawn, ProbeResult types + spawnersApi)
platform/frontend/app/coordinator/page.tsx  +~120 lines (SpawnInfo, accSpawns, event handler, sentinel parse, SpawnBadge)
platform/frontend/app/layout.tsx            +1 line    (nav: Spawners link)
```

No other files touched. No new dependencies (`date-fns` is already in
`package.json`).

### 2.7 Loading / error / empty states

**Coordinator `SpawnBadge`:**

- **Loading initial spawn state:** show the badge with the `pending`
  state from the SSE event; the `useEffect` poll will populate `spawn` on
  first tick. Until then, no extra UI — same pattern as `DispatchBadge`.
- **Error during poll:** the poll backs off to 3s on error
  (matches dispatch). No user-facing error unless an action button fails.
- **Action error:** inline `<span className="text-red-400 text-[11px]">{actionError}</span>`
  next to the busy buttons (matches dispatch).
- **Backend not yet emitting `spawn` events:** badge never appears
  (event handler never fires) — fail-safe.

**`/spawners` list:**

- **Loading:** `<div className="container mx-auto py-16 text-center text-zinc-500">Loading spawners…</div>`.
- **Error:** `<div … text-red-400>Failed to load: {error}</div>`.
- **Empty:** dashed-border box matching `/developers/page.tsx:181-184`.

**`/spawners/[id]`:**

- **Loading:** "Loading host…".
- **404:** "Spawner host not found" with a link back to `/spawners`.
- **Probe failure:** toast (using existing `useToast()`).
- **Delete:** confirm dialog → on success navigate back to `/spawners`.

---

## Section 3 — Ambiguities + questions

### A1. Backend route prefix mismatch

- (a) Brief says assume `/api/spawner-hosts`; backend ships `/api/spawners`.
- (b) Options: (i) wire frontend to the deployed `/api/spawners`;
  (ii) rename backend route to `/api/spawner-hosts` (touches backend);
  (iii) alias both.
- (c) **Recommendation:** (i). Path is already shipped, smoke-tested, and
  matches the `spawner_hosts` table prefix without being awkwardly
  hyphenated. Frontend uses `/api/spawners`.

### A2. `[spawn, ...]` parsing is server-side; backend out of scope

- (a) The frontend `SpawnBadge` and SSE handler are useless until the
  backend coordinator service emits `event.type === 'spawn'` events when
  the assistant produces `[spawn, ...]` blocks. That backend work is
  excluded from this dispatch.
- (b) Options: (i) ship the frontend rendering side now (dead code until
  backend lands); (ii) defer all spawn UI work until backend is ready.
- (c) **Recommendation:** (i). The visual + interaction design needs
  iteration anyway; landing rendering scaffolding now lets the backend
  dispatch focus narrowly. **All `SpawnBadge`/`SpawnInfo` code is
  inert until backend coordinator emits matching events.**

### A3. Assumed `event.type === 'spawn'` SSE payload shape

- (a) Backend hasn't been written yet. Frontend assumes the shape in §2.1.
- (b) Options: (i) commit to that shape and have backend match;
  (ii) make the frontend tolerant of multiple shapes; (iii) wait.
- (c) **Recommendation:** (i). Shape is conservative — mirrors `dispatch`
  field-for-field with renames (`developer→primitiveName`,
  `developerId→spawnerHostId`, `runId→spawnIntentId`, plus
  `primitiveKind` and `image`). Document so backend can match.

### A4. Assumed approve/cancel API shapes

- (a) Backend doesn't have spawn approval today. Frontend assumes
  `POST /api/spawners/{hostId}/spawn-intents/{intentId}/approve` and
  …/cancel.
- (b) Options: (i) commit; (ii) match dispatch's
  `/runs/{runId}/approve` shape using a `pending_spawns` table;
  (iii) different verb (`/spawns/{name}/start`).
- (c) **Recommendation:** (i). "Spawn intent" is a clearer name than
  "pending spawn" because it pre-dates the actual `spawns` row (which
  only exists after the spawner returns success). Document for backend.

### A5. State source for live spawn polling

- (a) The `SpawnBadge` polls for "current state" — should it hit:
  (i) `GET /api/spawners/{hostId}/spawns/{primitiveName}` (one-row
  endpoint that doesn't exist yet); (ii) `GET /api/spawners/{hostId}/spawns`
  (whole list); (iii) subscribe to a future SSE feed?
- (b) Options as above.
- (c) **Recommendation:** (i) for the badge, with (ii) on the admin
  page. Document the new endpoint as a backend follow-up. The
  `getSpawn(id, primitiveName)` API client method is added as a stub.

### A6. Should the admin page allow direct spawn (skip approval)?

- (a) Power-user feature: from `/spawners/[id]`, manually trigger
  `SpawnerClient.spawn(spec)` via a form, bypassing the assistant.
- (b) Options: (i) skip — keep admin page read-only-ish for v1; (ii)
  add a "spawn primitive" form.
- (c) **Recommendation:** (i). Adds backend complexity (need a
  spawn-from-UI endpoint) and isn't asked for. Easy to add later.

### A7. Should admin page show event history (not just current state)?

- (a) Backend already persists every event in `spawn_events` (append-only
  audit log). Useful for debugging.
- (b) Options: (i) skip for v1; (ii) add a collapsible event log per
  primitive on the detail page; (iii) full event log per host.
- (c) **Recommendation:** (i). Need an endpoint
  (`GET /api/spawners/{hostId}/spawns/{primitive}/events`) that doesn't
  exist; admin page is already plenty for v1. Easy follow-up.

### A8. Probe response display

- (a) Backend probe returns `{ status: 'online' | 'offline' | 'error',
  reason?, version?, capabilities?, primitiveCount?, latencyMs? }` (200
  online, 502 otherwise per A9 in the backend clarify doc).
- (b) Options: (i) toast result; (ii) inline panel under the host;
  (iii) badge next to status that flashes after probe.
- (c) **Recommendation:** (i) + writeback. The host row's `status` and
  `version` get persisted server-side automatically; the toast just
  acknowledges. Refresh after.

### A9. Delete-host confirmation

- (a) Deleting a host cascade-deletes its `spawns` and `spawn_events`
  rows. Should we warn?
- (b) Options: (i) `confirm('Delete? This removes N tracked spawns.')`;
  (ii) plain `confirm('Delete?')`; (iii) modal with type-to-confirm.
- (c) **Recommendation:** (i). Existing pattern (developers page has
  no delete; oracles page no delete; matching nothing exactly), but
  cascade delete merits a count.

### A10. `host_id` editable from the admin page?

- (a) `host_id` is the URL the spawner pushes events to and is set by
  `NTFR_HOST_ID` env on the spawner side. Changing it server-side
  silently would break the spawner immediately.
- (b) Options: (i) read-only after creation; (ii) editable but warn;
  (iii) editable with a "are you sure" gate.
- (c) **Recommendation:** (i). Matches `developers.workspacePath` (also
  effectively immutable post-create — the worker uses it as cwd).

### A11. Where does the spawn lifecycle log come from?

- (a) `spawn_events` is append-only, but there's no
  `GET /api/spawners/{id}/spawns/{name}/events` endpoint. The admin page
  has no way to show a history view today.
- (b) Options: (i) just show current state on `/spawners/[id]`;
  (ii) add the event log endpoint backend-side;
  (iii) defer.
- (c) **Recommendation:** (i) for v1. Document the endpoint as a
  follow-up.

### A12. Dark mode only?

- (a) The whole app is `<html className="dark">`-locked
  (`app/layout.tsx:28`). No light-mode classes are defined.
- (b) Options: (i) match — assume dark always; (ii) add light variants.
- (c) **Recommendation:** (i). Out of scope, and every existing badge
  hardcodes dark colors.

---

## Section 4 — Files I read while answering

- `CLAUDE.md`
- `platform/frontend/package.json`
- `platform/frontend/tailwind.config.js`
- `platform/frontend/app/layout.tsx`
- `platform/frontend/app/page.tsx` (head)
- `platform/frontend/app/api/[...path]/route.ts`
- `platform/frontend/app/coordinator/page.tsx` (lines 1-200, 230-540, 540-1129)
- `platform/frontend/app/developers/page.tsx`
- `platform/frontend/lib/api.ts` (header + developers section)
- listings of `platform/frontend/{app,components,lib,components/ui}`
- (Explore agent verified: `globals.css`, `oracles/page.tsx`, `developers/[id]/page.tsx` and others)
