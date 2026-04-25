# @agentforge/spawner — ntfr spawn-node

Standalone HTTP service that spawns/destroys ntfr "primitives" (developer,
researcher, oracle containers) on a single host. The ntfr backend talks to
one spawner per host; users hit the backend, never the spawner directly.

This package is the **spawner only**. The backend-side spawner registry +
HTTP client is a separate follow-up.

## Quickstart (local dev)

```bash
cd spawner
npm install
export NTFR_HOST_ID=host-local
export NTFR_WORKDIR=$HOME/ntfr-dev
# optional: export NTFR_SERVER_URL=https://ntfr.example.com/api
npm run dev
# spawner now listening on :9898
curl http://127.0.0.1:9898/health
```

## Quickstart (docker, single host)

```bash
cd spawner/deploy
cp .env.example .env  &&  $EDITOR .env       # fill NTFR_HOST_ID etc
./deploy.sh
```

The host's `~/ntfr/` (or whatever `NTFR_HOST_WORKDIR` points at) is bind-
mounted into the container as `/ntfr`. All primitives live under that
directory.

## Folder layout (managed by spawner)

```
${NTFR_WORKDIR}/                # default $HOME/ntfr
  compose.yml                   # spawner-managed; do not hand-edit
  .archive/                     # tarballs of destroyed primitives
  .spawner/
    state.db                    # sqlite: lifecycle event outbox + host metadata
    spawner.log                 # JSON-per-line app log
  <primitive-name>/
    state.json                  # source of truth for that primitive
    workspace/                  # primitive's R/W folder
    .meta/                      # spawner-owned, primitive RO
```

## Endpoints (no auth, plaintext HTTP — see docs/spawner/api-contract.md)

| Method | Path                          | Purpose                                      |
| ------ | ----------------------------- | -------------------------------------------- |
| GET    | `/health`                     | Liveness                                     |
| GET    | `/info`                       | Host id, version, capabilities, count, uptime |
| POST   | `/spawns`                     | Spawn a primitive                            |
| GET    | `/spawns`                     | List primitives + state                      |
| GET    | `/spawns/{name}`              | Inspect (state + history + last event)       |
| POST   | `/spawns/{name}/destroy`      | Archive → tear down → delete folder          |
| GET    | `/spawns/{name}/logs`         | `tail`/`since` querystring                   |
| POST   | `/update`                     | **501** — future work                        |

## Locked design notes

- **No auth.** Plaintext HTTP. `ed25519`/signing pass will land for every
  primitive at once — see `docs/spawner/architecture.md`.
- **Single shared compose file** at `${NTFR_WORKDIR}/compose.yml`. All
  writes go through an in-process mutex. `docker compose up -d <svc>` is
  used to converge (not full-project up/down).
- **`restart: always`** on every primitive.
- **Archive on destroy**: tar the folder before `compose rm -fsv` + folder
  removal. Hard-delete original after archive succeeds.
- **State transitions push-only** to ntfr server, best-effort, retried 5×
  with exponential backoff, persisted in sqlite outbox so events survive
  spawner restart. Drops are logged.
- **Orphan recovery on startup** — if `state.json` says `running` but no
  container exists, `compose up -d <name>` up to 3× with 10 s backoff;
  after that mark `state: orphaned` and emit an event.
- **Shared `ntfr` uid (10001)** for spawner + every primitive. Per-primitive
  uid splitting is deferred.

## Source layout

```
src/
  index.ts                       Entrypoint: bootstrap, server, signal handlers
  config.ts                      Env-var schema + path helpers
  routes/
    spawns.ts                    POST/GET /spawns, /spawns/:name(/destroy|/logs)
    system.ts                    /health, /info, /update (501)
  services/
    lifecycle.ts                 spawn/destroy/inspect/list, orphan recovery
    lifecycle-events.ts          state-transition recorder + outbox delivery loop
    primitive-state.ts           state.json read/write/transition
    archive.ts                   tar primitive folder → .archive/
  lib/
    db.ts                        better-sqlite3 schema + outbox queries
    docker.ts                    `docker compose ...` shell helpers
    compose-file.ts              read/write compose.yml + buildServiceBlock
    mutex.ts                     compose-write serialization
    logger.ts                    line-JSON logger to stdout + spawner.log
    error-handler.ts             express error middleware
    types.ts                     Zod schemas + state types
```

## Env vars

See `deploy/.env.example` for the full list with defaults. The minimum is
`NTFR_HOST_ID`. `NTFR_SERVER_URL` is optional but lifecycle events will be
dropped (with a warning) if unset.

## Tests / smoke

There is no test suite yet. Smoke procedure documented in
`docs/spawner/deploy.md`.
