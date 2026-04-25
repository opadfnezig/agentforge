# ntfr-spawner HTTP API contract

All endpoints are JSON over plaintext HTTP. **No auth.** Bind only to
private interfaces. See `docs/spawner/architecture.md` for the rationale +
future auth pass.

Base URL: `http://<host>:<NTFR_PORT>` (default port `9898`).

---

## `GET /health`

Liveness probe.

**200**
```json
{ "status": "ok", "timestamp": "2026-04-25T12:00:00.000Z" }
```

## `GET /info`

Host metadata.

**200**
```json
{
  "host_id": "host-eu-1",
  "version": "0.1.0",
  "capabilities": ["spawn", "destroy", "list", "inspect", "logs"],
  "primitive_count": 3,
  "uptime_ms": 51234,
  "server_url_configured": true
}
```

---

## `POST /spawns`

Spawn a primitive. Mutex-serialized: at most one spawn-or-destroy per host
runs at a time.

**Request body**
```json
{
  "name":  "dev-alpha",         // required, [a-z0-9][a-z0-9_-]*, ≤63 chars, unique on host
  "kind":  "developer",         // required, one of developer|researcher|oracle
  "image": "ghcr.io/x/y:tag",   // required
  "workdir": "workspace",       // optional, reserved for future, default "workspace"
  "env":   { "FOO": "bar" },    // optional, env vars for the container
  "mounts": [                   // optional, EXTRA mounts — base mounts are added automatically
    { "source": "/host/path", "target": "/in/container", "readOnly": false }
  ],
  "command": ["node", "x.js"],  // optional; passed as compose `command:`
  "args":    ["--flag"]         // optional; only used if `command` is absent
}
```

The base volume layout is always added by the spawner:
- `./<name>/workspace:/workspace:rw`
- `./<name>/.meta:/meta:ro`

**Response 201** (state.json after the transition to `running`)
```json
{
  "name": "dev-alpha",
  "kind": "developer",
  "state": "running",
  "image": "ghcr.io/x/y:tag",
  "container_id": "abc123",
  "created_at": "...",
  "updated_at": "...",
  "last_event_at": "...",
  "last_event_id": "uuid",
  "spec": { /* echoed request */ }
}
```

**Errors**
| status | code                    | when |
| ------ | ----------------------- | ---- |
| 400    | `VALIDATION_ERROR`      | bad name / missing fields |
| 409    | `PRIMITIVE_EXISTS`      | another primitive on this host already uses that name |
| 409    | `COMPOSE_SERVICE_EXISTS`| compose.yml already has a service of that name (out-of-band edit?) |
| 500    | `COMPOSE_UP_FAILED`     | `docker compose up -d` exited non-zero. Folder is created with `state: crashed`; compose entry is rolled back |

---

## `GET /spawns`

List all primitives on this host with their current state.

**Response 200** — array of `state.json` objects (same shape as the spawn
response).

---

## `GET /spawns/{name}`

Inspect: state + folder path + lifecycle history (every recorded
transition) + delivery status of the most recent event.

**Response 200**
```json
{
  "state": { /* state.json */ },
  "folder": "/home/ntfr/ntfr/dev-alpha",
  "history": [
    {
      "event_id": "uuid",
      "state": "creating",
      "prev_state": null,
      "timestamp": "...",
      "delivered": true,
      "attempts": 1,
      "last_error": null
    },
    {
      "event_id": "uuid",
      "state": "running",
      "prev_state": "creating",
      "timestamp": "...",
      "delivered": false,
      "attempts": 2,
      "last_error": "HTTP 502: bad gateway"
    }
  ],
  "last_event": { "id": "uuid", "at": "...", "delivered": false }
}
```

**Errors**
| status | code                  |
| ------ | --------------------- |
| 404    | `PRIMITIVE_NOT_FOUND` |

---

## `POST /spawns/{name}/destroy`

Archive + tear down + delete folder. Mutex-serialized.

Sequence:
1. `tar -czf .archive/<name>-<ts>.tar.gz <name>` (must succeed, else abort).
2. `docker compose rm -fsv <name>` (failure logged but doesn't abort).
3. Remove the service entry from `compose.yml`.
4. Record transition → `destroyed` (and emit lifecycle event).
5. Delete the primitive folder.

**Response 200**
```json
{
  "ok": true,
  "archive_path": "/home/ntfr/ntfr/.archive/dev-alpha-2026-04-25T12-00-00-000Z.tar.gz",
  "archive_bytes": 4321,
  "compose_rm_code": 0
}
```

**Errors**
| status | code                  |
| ------ | --------------------- |
| 404    | `PRIMITIVE_NOT_FOUND` |
| 500    | (uncoded)             | tar failed — folder NOT deleted, primitive intact |

---

## `GET /spawns/{name}/logs?tail=200&since=10m`

Tails docker logs for the primitive's container.

| query  | type             | default | meaning |
| ------ | ---------------- | ------- | ------- |
| `tail` | int or `"all"`   | `200`   | last N lines |
| `since`| docker duration  | —       | passed straight through (`5m`, `1h`, RFC3339) |

**Response 200**
```json
{
  "service": "dev-alpha",
  "tail": 200,
  "since": null,
  "exit_code": 0,
  "stdout": "...",
  "stderr": ""
}
```

**Errors**
| status | code                  |
| ------ | --------------------- |
| 400    | `BAD_TAIL`            |
| 404    | `PRIMITIVE_NOT_FOUND` |

---

## `POST /update`

**501 Not Implemented.** Reserved for in-place primitive reconfiguration.

```json
{
  "error": {
    "message": "POST /update is not yet implemented",
    "code": "NOT_IMPLEMENTED",
    "future_work": true
  }
}
```

---

## Lifecycle event POST (spawner → ntfr server)

The spawner POSTs every state transition to the backend.

`POST {NTFR_SERVER_URL}/spawners/{NTFR_HOST_ID}/events`
Headers: `Content-Type: application/json`

**Body**
```json
{
  "event_id":      "uuid",
  "primitive_name":"dev-alpha",
  "primitive_kind":"developer",
  "state":         "running",
  "prev_state":    "creating",
  "timestamp":     "2026-04-25T12:00:00.000Z",
  "host_id":       "host-eu-1",
  "payload": {
    "image": "ghcr.io/x/y:tag",
    "container_id": "abc123",
    "recovered":    false
  }
}
```

`payload` is best-effort context. Stable fields:

| state       | payload keys                                                        |
| ----------- | ------------------------------------------------------------------- |
| `creating`  | `image`, `container_id` (always null)                               |
| `running`   | `image`, `container_id`, optionally `recovered: true`, `attempts`   |
| `crashed`   | `image`, `container_id`, `reason`, `stderr`                         |
| `orphaned`  | `image`, `container_id`, `reason`, `attempts`                       |
| `destroyed` | `image`, `container_id`, `archive_path`, `archive_bytes`, `compose_rm_code` |

**Server response contract (what the spawner expects):**
- 2xx → mark delivered.
- non-2xx → schedule retry (exponential backoff,
  `NTFR_LIFECYCLE_RETRY_BACKOFF_MS * 2^(attempts-1)`).
- After `NTFR_LIFECYCLE_RETRY_MAX` failures → drop with a warning log
  line (`event_id`, `state`, `attempts`, `last_error`).

The server SHOULD dedupe by `event_id` — restart-induced re-delivery and
in-flight retries are both possible.
