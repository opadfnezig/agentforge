# ntfr-spawner deploy

The current deploy path is **manual clone + `docker compose build` on each
host**. A registry-pull path (`image: ghcr.io/...`) is future work.

## 1. Prerequisites

- Linux host with docker engine ≥ 24 (we need the modern `docker compose`
  plugin, not legacy `docker-compose`).
- A user with read/write access to the docker group.
- Outbound HTTP(S) reachability to `NTFR_SERVER_URL` (if set). Ingress on
  the spawner port from the ntfr backend.

## 2. Clone + build

```bash
git clone https://github.com/<org>/agentforge.git
cd agentforge/spawner/deploy
cp .env.example .env
$EDITOR .env
./deploy.sh
```

`deploy.sh` validates required env vars, auto-detects the host docker GID
(needed so the in-container non-root `ntfr` user can talk to
`/var/run/docker.sock`), builds the image, brings up the spawner, and
polls `/health` until it answers.

## 3. Validation steps

```bash
# /health
curl -s http://127.0.0.1:9898/health | jq .

# /info
curl -s http://127.0.0.1:9898/info | jq .

# spawn an alpine "smoke" primitive
curl -sX POST -H 'content-type: application/json' \
  -d '{"name":"smoke","kind":"developer","image":"alpine:3.20","command":["sh","-c","while sleep 5; do echo tick; done"]}' \
  http://127.0.0.1:9898/spawns | jq .

# list
curl -s http://127.0.0.1:9898/spawns | jq .

# inspect (look for "state":"running" and lifecycle history)
curl -s http://127.0.0.1:9898/spawns/smoke | jq .

# logs (after ~10 s should show "tick")
curl -s 'http://127.0.0.1:9898/spawns/smoke/logs?tail=20' | jq .

# destroy
curl -sX POST http://127.0.0.1:9898/spawns/smoke/destroy | jq .

# verify archive landed
ls -la "$NTFR_HOST_WORKDIR/.archive/"
```

## 4. Env var reference

| Var                                | Required | Default              | Notes |
| ---------------------------------- | -------- | -------------------- | ----- |
| `NTFR_HOST_ID`                     | yes      | —                    | stable identifier; backend keys spawner registry by this |
| `NTFR_PORT`                        | no       | `9898`               | listen port |
| `NTFR_WORKDIR`                     | no       | `~/ntfr`             | path INSIDE the container; the deploy compose binds the host dir to this |
| `NTFR_HOST_WORKDIR`                | no (compose) | `/home/ntfr/ntfr` | host path bind-mounted into the container as `/ntfr` |
| `NTFR_SERVER_URL`                  | no       | —                    | if unset, lifecycle events drop with a warning |
| `NTFR_LOG_LEVEL`                   | no       | `info`               | `debug` \| `info` \| `warn` \| `error` |
| `DOCKER_SOCKET`                    | no       | `/var/run/docker.sock` | reserved for future use |
| `NTFR_LIFECYCLE_RETRY_MAX`         | no       | `5`                  | retries before dropping a lifecycle event |
| `NTFR_LIFECYCLE_RETRY_BACKOFF_MS`  | no       | `1000`               | base; backoff is `base * 2^(attempts-1)` |
| `NTFR_ORPHAN_RETRY_MAX`            | no       | `3`                  | retries during orphan recovery |
| `NTFR_ORPHAN_RETRY_BACKOFF_MS`     | no       | `10000`              | sleep between orphan retries |
| `NTFR_DOCKER_GID` (compose only)   | no       | auto-detected        | host docker group GID; required for non-root socket access |

## 5. Verifying lifecycle event delivery

Watch the spawner log and the backend log together:

```bash
docker logs -f ntfr-spawner | grep lifecycle
```

You should see one `lifecycle transition` and then `lifecycle event delivered`
within a second or so. If the backend is unreachable, you'll see one
`lifecycle event retry scheduled` per failed attempt, then a single
`Lifecycle event dropped after retry exhaustion`. The event row stays in
sqlite for forensic inspection (the spawner does not GC the outbox).

## 6. Verifying orphan recovery

Pick a primitive (e.g. `smoke` from the validation steps), kill its
container outside docker compose, then restart the spawner:

```bash
docker rm -f ntfr-smoke
docker restart ntfr-spawner

# within ~12 s, the spawner should have brought it back:
docker logs ntfr-spawner --tail 40 | grep -E 'orphan|recover'
curl -s http://127.0.0.1:9898/spawns/smoke | jq '.state.state, .history[-1]'
# expected: "running" with payload { recovered: true, attempts: N }
```

## 7. Backups

The sqlite outbox at `${NTFR_HOST_WORKDIR}/.spawner/state.db` is the only
durable spawner-only state. Loss = lifecycle history + pending events
gone. Per-primitive `state.json` is recoverable from compose.yml + a
fresh inspect once the primitive is observed running.

A nightly snapshot of `${NTFR_HOST_WORKDIR}/` (excluding `.archive/`) is
sufficient to reconstruct any host's primitives.

## 8. Future: docker registry pull

Once the spawner image is published, replace the `build:` block in
`deploy/docker-compose.yml` with `image: ghcr.io/<org>/ntfr-spawner:<tag>`
and skip the build step in `deploy.sh`. The rest of the deploy story is
unchanged.
