# @agentforge/developer

Standalone WebSocket worker that executes Claude Code runs on dispatch from the AgentForge backend. Ships as a single-file TypeScript program (`src/index.ts`) that connects to the coordinator, spawns `claude`, streams events back, and commits/pushes changes on success.

## Purpose

- Register a long-lived worker with the backend over WebSocket.
- Receive `dispatch` messages and run Claude Code (`claude --dangerously-skip-permissions --print --verbose --output-format stream-json`) against a workspace directory.
- Stream every Claude event (`assistant`, `tool_use`, `tool_result`, `stderr`, etc.) back to the backend in real time.
- On `implement` mode: `git pull --rebase` → run → if changes, `git add -A && git commit && git push`. On `clarify` mode: return the assistant's final message without committing.

## Entry points

- `src/index.ts` — the whole worker (config, logging, git helpers, prompt templates, WebSocket client, Claude subprocess).
- `Dockerfile` — extends `agentforge/claude-agent:latest`, compiles TS, runs as user `agent`.
- `package.json` scripts: `dev` (tsx watch), `build` (tsc), `start` (node dist).

## Layout

```
Dockerfile
tsconfig.json
package.json
src/
  index.ts    Single-file worker (see "Key modules" for sections)
```

## Run

Local:

```bash
cd developer
npm install
npm run dev    # tsx watch src/index.ts
# or
npm run build && npm start
```

Docker Compose (from repo root): `pnpm docker:up` starts the `developer` service, which builds from `./developer/Dockerfile` and mounts:
- `/home/user/agentforge:/workspace` — the target workspace the agent edits.
- `~/.claude:/home/agent/.claude` + `~/.claude.json:/home/agent/.claude.json` — Claude session credentials.

### Required env

- `COORDINATOR_URL` — backend WS base, e.g. `ws://backend:3001`.
- `DEVELOPER_ID` — UUID registered via `POST /api/developers` on the backend.
- `DEVELOPER_SECRET` — shared secret returned when the developer was created.
- `WORKSPACE_PATH` — absolute path of the directory the worker runs `claude` in (usually `/workspace`).
- `GIT_BRANCH` — branch to pull/push (default `main`).
- `MAX_TURNS` — Claude turn cap (default `300`).

The worker auto-detects whether `WORKSPACE_PATH` is a git repo. If not, all git operations are skipped and `implement` runs report `success` without committing.

## Key modules (sections of `src/index.ts`)

- **Config** (`loadConfig`) — reads env, throws on missing required vars.
- **Logging** (`log`, `logErr`) — timestamped stdout/stderr.
- **Git helpers** — `git`, `gitHeadSha`, `gitPullRebase`, `gitHasChanges`, `gitCommitAndPush`.
- **Prompt templates** — `buildImplementPrompt`, `buildClarifyPrompt`.
- **`DeveloperClient`** — WS connect + exponential-backoff reconnect (up to 60s) with jitter, 30s heartbeat, `handleDispatch` state machine, `runClaude` subprocess manager with line-delimited JSON parsing.
- **Entrypoint** — `main()` loads config and starts the client; installs `SIGINT`/`SIGTERM` handlers that kill the in-flight `claude` child.

Concurrency: at most one run in flight. A second `dispatch` while busy is rejected with a `run_update` of `status: 'failure'` and `error_message: 'Developer is busy with another run'`.

## Dependencies

Runtime: `ws`, `dotenv`.
Dev: `typescript`, `tsx`, `@types/node`, `@types/ws`.

The container base image `agentforge/claude-agent:latest` (built from `docker/agent/`) provides the `claude` CLI and Node runtime.

## Contracts

### WebSocket endpoint

Connects to: `${COORDINATOR_URL}/api/developers/connect/${DEVELOPER_ID}?secret=${DEVELOPER_SECRET}`.

### Incoming messages (server → worker)

```ts
type DispatchMessage = {
  type: 'dispatch'
  runId: string
  instructions: string
  mode: 'implement' | 'clarify'
}
```

Other `type` values are logged and ignored.

### Outgoing messages (worker → server)

All JSON. `runId` corresponds to the dispatch being reported.

- Heartbeat (every 30s):
  ```json
  { "type": "heartbeat" }
  ```
- Run lifecycle:
  ```ts
  { type: 'run_update', runId, status: 'running', git_sha_start: string | null }
  { type: 'run_update', runId, status: 'success',  git_sha_end?: string, response?: string }
  { type: 'run_update', runId, status: 'no_changes', git_sha_end: string, response: string }  // implement, no diff
  { type: 'run_update', runId, status: 'failure', error_message: string }
  ```
- Per-event stream (one per Claude stream-json line):
  ```ts
  { type: 'event', runId, event_type: string, data: unknown }
  ```
  `event_type` mirrors Claude's JSON `type` (`assistant`, `tool_use`, `tool_result`, `system`, `result`, …). Non-JSON stdout lines are forwarded as `event_type: 'raw'` with `data: { text }`. Stderr is forwarded as `event_type: 'stderr'` with `data: { text }`.

The `response` returned in terminal `run_update` messages is the concatenated `text` parts of the **last** `assistant` message seen in the stream.

### Git behaviour (implement mode only, when workspace is a git repo)

1. Record `gitShaStart`.
2. `git pull --rebase origin <GIT_BRANCH>` (failures logged but non-fatal).
3. Run Claude with `buildImplementPrompt(instructions)`.
4. If `git status --porcelain` is non-empty:
   - `git add -A`
   - `git commit -m "agentforge: <first line of instructions, trimmed to 200 chars>"`
   - `git push origin <GIT_BRANCH>`
5. Report `success` with `git_sha_end`, or `failure` if commit/push failed.

### CLI surface

None. The program has no arguments and no stdin interaction — it is configured entirely via env vars and runs until `SIGINT`/`SIGTERM`.

### Prompt templates (committed text contract)

- `buildImplementPrompt(instructions)` — embeds instructions inside the AgentForge developer guidance block ("bulk reads", "don't assume", …). Changing this template changes how every implement run behaves.
- `buildClarifyPrompt(instructions)` — instructs Claude not to edit files and to return clarifying questions only.
