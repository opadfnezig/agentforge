# ntfr-spawner architecture

## Multi-host topology

```
   user ─► frontend ─► ntfr backend ──HTTP──► spawner #1 (host-eu-1) ─► docker
                                          ├──► spawner #2 (host-us-1) ─► docker
                                          └──► spawner #N            ─► docker
```

- **One spawner per host.** A spawner manages every ntfr primitive on the
  host it runs on. Hosts do not talk to each other.
- The backend keeps a registry of spawners (`host_id` → URL); that registry
  is delivered in a separate dispatch and is **out of scope** here.
- Lifecycle events flow the *other* direction: spawner → backend, push-only.

## Primitive

A "primitive" is any single-container ntfr workload (developer / researcher
/ oracle). All three are managed identically by the spawner — `kind` is
metadata that the backend uses, not the spawner.

Per primitive on disk:

```
${NTFR_WORKDIR}/<name>/
  state.json     spawner-owned source of truth (state, kind, image, ids, …)
  workspace/     primitive R/W
  .meta/         spawner-owned, primitive RO (mounted at /meta:ro)
```

## Spawner state

```
${NTFR_WORKDIR}/
  compose.yml             single shared compose file (one `services:` map)
  .archive/               tarballs of destroyed primitives
  .spawner/state.db       sqlite — event outbox + host metadata
  .spawner/spawner.log    JSON-per-line application log
```

Compose-file writes are **always** funneled through one in-process mutex
(`src/lib/mutex.ts`) so concurrent spawn/destroy never race on read-modify-
write of `compose.yml`. The `docker compose up -d <name>` invocation runs
*inside* the same mutex so a spawn doesn't observe another spawn's half-
written file.

## Lifecycle states

```
                  spawn
                    │
            ┌───────▼───────┐
            │   creating    │
            └───────┬───────┘
                    │ compose up -d <name>
                    │   ok
            ┌───────▼───────┐
            │    running    │◄──────────────────┐
            └───────┬───────┘                   │
                    │ container exits abnormally│
                    │ (or compose up failed     │ orphan
                    │  during spawn)            │ recovered
            ┌───────▼───────┐                   │
            │    crashed    │                   │
            └───────────────┘                   │
                                                │
            startup reconcile finds container missing
            for state=running primitive ─►──── attempt
                                          up to N retries
                                                │ failed
                                          ┌─────▼─────┐
                                          │ orphaned  │
                                          └───────────┘

   destroy:  any state ─► destroyed (after archive + compose rm + folder rm)
```

Every transition writes `state.json` AND inserts a row in the `event_outbox`
table. The two writes are NOT atomic across processes — if the process is
killed between them, on next boot orphan recovery will re-emit a `running`
or `orphaned` event for the primitive, which is the desired forward-only
behavior (consumer dedupes by `event_id`).

## State model

`state.json` (per primitive) — see `src/lib/types.ts:PrimitiveState_t`.
Fields: `name`, `kind`, `state`, `image`, `container_id`, `created_at`,
`updated_at`, `last_event_at`, `last_event_id`, `spec` (the original
spawn request). `last_event_*` lets `inspect` answer "did the most recent
transition reach the server?" without re-querying the outbox.

## Lifecycle event delivery

POST shape — see `docs/spawner/api-contract.md` "Lifecycle event POST".

- Best-effort. The endpoint is plaintext HTTP, no auth, no signing —
  matches the no-auth threat model of the spawner itself.
- Persisted in `event_outbox` *before* the HTTP attempt. Survives spawner
  restart.
- Retry policy: up to `NTFR_LIFECYCLE_RETRY_MAX` attempts (default 5),
  exponential backoff `NTFR_LIFECYCLE_RETRY_BACKOFF_MS * 2^(attempts-1)`.
  After the cap, the row is marked dropped (`delivered=1` with
  `last_error="DROPPED: …"`) and a single warning is logged.
- Delivery loop (`startLifecycleDelivery`) ticks every 1 s, picks up to 50
  due rows. Server-down windows are absorbed by the outbox.

## Orphan recovery

On boot, before serving requests:

1. `listStates()` → all primitives recorded as `running`.
2. `docker compose ps --all` → service → container map.
3. For each `running` state with no `running` container, attempt
   `docker compose up -d <name>` up to `NTFR_ORPHAN_RETRY_MAX` (default 3),
   sleeping `NTFR_ORPHAN_RETRY_BACKOFF_MS` (default 10 s) between attempts.
4. On success → re-record `running` (this enqueues a fresh event with
   `recovered: true`).
5. On giving up → flip state to `orphaned`, enqueue an event, leave it.
   No further automatic recovery (operator must `destroy` and re-spawn).

The recovery runs in the background — the HTTP server starts immediately so
`/health` is reachable while recovery proceeds.

## Why no auth (yet)

Locked design decision: ed25519/signing/replay protection is deferred until
we do **all** ntfr primitives at once. Half-implemented signing would be
worse than none. Acceptable threat model: a same-network attacker who can
already reach the spawner port is one of many privileged surfaces, and
spawning one extra container on a host is a small marginal capability.

When the auth pass lands, it will:

- Sign every `POST /spawns` and `POST /destroy` with a backend-side ed25519
  key, with nonce + timestamp to prevent replay.
- Sign every lifecycle event POST with a per-host ed25519 key issued by the
  backend at spawner registration time.
- Reject unauthenticated requests on both directions.
- Force HTTPS at the network layer (current spec is plaintext).

Until then: **never expose the spawner port to the public internet.** Bind
to a private interface or a firewalled subnet.

## Failure modes the spawner accepts as out-of-band

- **Network plumbing.** The compose file does not declare networks. We
  attach to whatever bridge docker creates by default (or whatever the
  operator configures globally). The dispatch was explicit: no network
  engineering here.
- **Image pull failures during spawn.** Reported via the lifecycle event
  payload (`stderr`) and bounce the primitive into `crashed`. We do not
  retry the pull — the operator (or the backend re-spawning) must.
- **Disk full during archive.** `destroy` returns 500 with the tar stderr;
  the primitive folder is left intact (we only delete after archive
  succeeds). Operator must clear space and retry.

## Future work

- Per-primitive uid splitting (instead of the shared 10001).
- `POST /update` (currently 501): rebuild a primitive in place when its
  spec changes, without losing `workspace/`.
- `/start`, `/stop`, `/restart` endpoints. Right now the only way to pause
  a primitive is to destroy it.
- Push to a docker registry, replace `build:` with `image:` in deploy
  compose.
- Auth pass (ed25519, all primitives).
- Cross-host migration / rebalancing.
