# mitm-poc — thinking-budget interception PoC

Throwaway proof-of-concept that intercepts Claude Code's calls to
`api.anthropic.com` so we can (a) see what Claude Code sends in the
`thinking` field, and (b) test whether rewriting it server-side controls
how hard Opus actually thinks.

**This folder is not meant to ship into production.** It is a recon tool.
The conclusions live in [`findings/findings.md`](findings/findings.md).

## Layout

```
mitm-poc/
├── README.md              ← this file
├── run.sh                 ← one-shot harness: starts mitm, runs claude through it, kills mitm
├── sanitize.py            ← strips PII out of raw captures into samples/<run>/
├── addons/
│   └── capture.py         ← mitmproxy addon: capture + optionally rewrite /v1/messages
├── tasks/
│   ├── reasoning-prompt.txt        ← lightbulb riddle (control; too easy)
│   └── hard-reasoning-prompt.txt   ← combinatorics question (engages thinking)
├── samples/                        ← sanitized captures, committed
│   ├── baseline_low/         baseline runs across all five effort levels
│   ├── baseline_medium/         (same prompt, no MITM rewriting)
│   ├── baseline_high/
│   ├── baseline_xhigh/
│   ├── baseline_max/
│   ├── baseline_low_hard/        baseline at low/max on the hard prompt
│   ├── baseline_max_hard/
│   ├── override_1k_low/         MITM rewriting thinking.budget_tokens
│   ├── override_4k_low/         to 1024 / 4096 / 16384 on lightbulb riddle
│   ├── override_16k_low/
│   ├── override_16k_low_hard/   same override on the hard prompt
│   └── effort_max_via_mitm_low_hard/   MITM rewriting output_config.effort low→max
├── findings/
│   └── findings.md        ← table + verdict
└── _runs/                 (gitignored — raw, unsanitized captures with PII)
```

## Setup

```bash
cd mitm-poc
python3 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install mitmproxy

# First mitmdump invocation generates ~/.mitmproxy/mitmproxy-ca-cert.pem
.venv/bin/mitmdump --listen-port 18080 -q   # ctrl-C immediately

# Make the credentials file accessible from a writable HOME (see "Pitfalls")
mkdir -p /tmp/claudehome/.claude
cp ~/.claude/.credentials.json /tmp/claudehome/.claude/.credentials.json
chmod 600 /tmp/claudehome/.claude/.credentials.json
```

## How a single capture run works

```bash
# Baseline: just observe what Claude Code sends, don't rewrite anything.
RUN_TAG=baseline_low EFFORT=low ./run.sh

# Override the thinking budget on every outbound /v1/messages.
RUN_TAG=override_4k_low EFFORT=low BUDGET_OVERRIDE=4096 ./run.sh

# Override the effort knob (the field that actually drives Opus's thinking).
RUN_TAG=effort_max_via_mitm_low EFFORT=low EFFORT_OVERRIDE=max ./run.sh

# Use a different prompt (default is tasks/reasoning-prompt.txt).
RUN_TAG=baseline_low_hard EFFORT=low PROMPT_FILE=tasks/hard-reasoning-prompt.txt \
  TIMEOUT_SEC=300 ./run.sh
```

Each invocation drops a new directory at `samples/_runs/${RUN_TAG}/` containing:

* `_run.log`              — what `run.sh` decided
* `_mitm.log`             — mitmproxy stderr
* `_claude_debug.log`     — claude `--debug` log
* `_claude_result.json`   — claude `--output-format json` final
* `NNN_*.json`            — one record per intercepted HTTPS call
* `NNN_*v1_messages.sse`  — full decoded SSE body for `/v1/messages` calls

After capturing, run `python3 sanitize.py` to copy a redacted version of
each run from `samples/_runs/<tag>/` to `samples/<tag>/` (only the latter
is committed). The sanitizer strips `metadata.user_id`, redacts
organization/account/device UUIDs, masks the user email, and drops the
debug + mitm logs.

## How `addons/capture.py` works

* Picks up `RUN_TAG`, `OUT_DIR`, `BUDGET_OVERRIDE`, `EFFORT_OVERRIDE` from
  the environment.
* On any outbound `https://api.anthropic.com/...` request:
  * Records the request URL, method, headers (with `Authorization`,
    `Cookie`, `x-api-key` redacted), and JSON body.
  * If the URL is `/v1/messages` and `BUDGET_OVERRIDE` is set: replaces
    `body.thinking` with `{type: "enabled", budget_tokens: N}` and bumps
    `max_tokens` above `N` if needed (Anthropic requires
    `max_tokens > thinking.budget_tokens`).
  * If the URL is `/v1/messages` and `EFFORT_OVERRIDE` is set: rewrites
    `body.output_config.effort` to that value.
* On the response:
  * If `Content-Type: text/event-stream`, streams the response through
    (otherwise mitmproxy buffers the whole stream and Claude Code blocks).
  * Captures the chunks, gzip-decompresses, parses the SSE for `usage`,
    block types, and per-delta type counts.
  * Writes a JSON record + (for SSE) a `.sse` file with the full decoded
    body.

Filename collisions across endpoints are avoided by the `NNN_` counter
prefix.

## Pitfalls if you re-run this PoC

* Claude Code in this environment is `2.1.119`; the body shape and the
  `effort-2025-11-24` beta flag may move in newer releases. The addon
  doesn't pin a version — re-capture if Claude Code updates.
* Don't run the parent agent's `claude` and the child `claude` against
  the same `~/.claude.json`. The parent already holds the file lock and
  the child will hang. Always run the child with `HOME=/tmp/claudehome`
  pointing at a writable directory.
* The harness session's `CLAUDECODE`, `CLAUDE_CODE_*` env vars confuse a
  child `claude --print`. The runner uses `env -i PATH=$PATH HOME=...` to
  scrub them.
* Anthropic gzips SSE responses. The capture addon decompresses; if you
  add another consumer, do the same.
* The mitmproxy CA cert (`~/.mitmproxy/mitmproxy-ca-cert.pem`) is appended
  via `NODE_EXTRA_CA_CERTS`. Claude Code's debug log confirms it accepts
  the appended cert; no patching of the CLI was required.
* Don't commit `samples/_runs/` — it contains raw OAuth-bearing requests
  and the user's account/org/device identifiers. `.gitignore` handles
  this; don't disable it.

## When you're done

Findings are in [`findings/findings.md`](findings/findings.md). The
sanitized captures behind the table are in `samples/<tag>/`. Everything
else is scaffolding for repeating the experiment.
