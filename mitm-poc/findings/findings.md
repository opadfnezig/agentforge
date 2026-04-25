# Thinking-budget MITM PoC — Findings

> Throwaway. The point is the verdict, not the code.
> Captures and the tabulator that produced this table live alongside.

## TL;DR

* Claude Code (v2.1.119) **does not** send a numeric `budget_tokens` on
  `/v1/messages`. It sends `thinking: {type: "adaptive"}` *plus* a top-level
  `output_config: {effort: "low|medium|high|xhigh|max"}` field.
* The `--effort` CLI flag is wired straight to that `output_config.effort`
  field. **All five levels send the identical Opus body except for that one
  string.**
* Anthropic happily accepts MITM-rewritten `thinking: {type:"enabled",
  budget_tokens: N}` for N ∈ {1024, 4096, 16384}. No 4xx/5xx, no cap.
* But on the same prompt, *adaptive Opus's actual thinking spend tracks the
  `output_config.effort` knob, not the explicit `budget_tokens` we injected*.
  Forcing `budget_tokens=16384` while leaving `effort=low` produced ~the same
  output token count as the unmodified `effort=low` baseline, ~7× less than
  `effort=max`.
* MITM rewriting `output_config.effort` from `low` → `max` (with thinking
  left as adaptive) **does** make Opus think more — output tokens jumped from
  ~1.9k to ~11k on the hard prompt. So the lever that matters can be
  controlled via MITM, just not via the field we initially hypothesized.

## What Claude Code actually sends to Opus

Captured request body (Opus call, hard prompt, `--effort max`, **non-MITM**):

```json
{
  "model": "claude-opus-4-7",
  "max_tokens": 64000,
  "stream": true,
  "thinking": { "type": "adaptive" },
  "output_config": { "effort": "max" },
  "context_management": { "edits": [{ "type": "clear_thinking_20251015", "keep": "all" }] },
  "metadata": { "user_id": "<redacted: device_id + account_uuid + session_id>" },
  "system": [ /* 4 blocks: billing tag, base prompt, project context, user-task wrapper */ ],
  "messages": [ /* user prompt */ ],
  "tools": [ /* full default toolset */ ]
}
```

Headers of interest on the same call:

```
Authorization: Bearer <oauth-access-token>
anthropic-beta: claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,
                context-management-2025-06-27,prompt-caching-scope-2026-01-05,
                advisor-tool-2026-03-01,advanced-tool-use-2025-11-20,
                effort-2025-11-24,cache-diagnosis-2026-04-07
User-Agent: claude-cli/2.1.119 (external, sdk-cli)
x-app: cli
X-Stainless-Package-Version: 0.81.0
```

Note the `effort-2025-11-24` beta — the `output_config.effort` field rides on
that beta.

The `--effort low|medium|high|xhigh|max` CLI flag changes **exactly one byte**
of the outbound body: `output_config.effort`. Five separate captures,
diffed, confirm this — all other body fields and headers are byte-identical
across effort levels (modulo per-call session/request UUIDs).

## Where the thinking actually happens

For the hard prompt `tasks/hard-reasoning-prompt.txt`
(a small combinatorics question), the SSE response includes one
`content_block_start` of `type: "thinking"` followed by **only**
`signature_delta` events — no `thinking_delta` events at all. The actual
chain-of-thought is **not streamed back to the client**; it lives entirely
on Anthropic's side, and the client only gets a signature for replay. But
the user is billed for those private thinking tokens — they show up as
`output_tokens` in the `message_delta` usage line.

Concretely, from `samples/baseline_max_hard/012_POST__v1_messages.sse`:

```
content_block_start: {type: "thinking", thinking: "", signature: ""}
... 1 signature_delta ...
content_block_start: {type: "text", text: ""}
... 28 text_delta events ...
message_delta usage: {output_tokens: 16960, ...}
```

≈15k of those 16960 output tokens were spent on private thinking; only ~2k
were the visible answer.

## The full table

Same Opus model, same hard reasoning prompt
(`tasks/hard-reasoning-prompt.txt`, all ran answer = `34`):

| Run                                | CLI `--effort` | `output_config.effort` (sent) | `thinking` (sent)                          | Status | Output tokens (Opus) | Cost (USD) | Visible answer |
| ---------------------------------- | -------------- | ----------------------------- | ------------------------------------------ | ------ | -------------------- | ---------- | -------------- |
| `baseline_low_hard`                | low            | low                           | `{type: "adaptive"}`                       | 200    | 1 981                | $0.116     | 34 ✓           |
| `baseline_max_hard`                | max            | max                           | `{type: "adaptive"}`                       | 200    | 16 960               | $0.437     | 34 ✓           |
| `override_16k_low_hard`            | low            | **low** (unchanged)           | `{type: "enabled", budget_tokens: 16384}`  | 200    | 2 162                | $0.067     | 34 ✓           |
| `effort_max_via_mitm_low_hard`     | low            | **max** (rewritten)           | `{type: "adaptive"}`                       | 200    | 11 084               | $0.290     | 34 ✓           |

And the lightbulb-puzzle baselines (control — too easy, adaptive Opus does
no thinking):

| Run                | CLI `--effort` | `output_config.effort` (sent) | `thinking` (sent)                          | Status | Output tokens (Opus) | Cost (USD) |
| ------------------ | -------------- | ----------------------------- | ------------------------------------------ | ------ | -------------------- | ---------- |
| `baseline_low`     | low            | low                           | `{type: "adaptive"}`                       | 200    | 239                  | $0.072     |
| `baseline_medium`  | medium         | medium                        | `{type: "adaptive"}`                       | 200    | 264                  | $0.072     |
| `baseline_high`    | high           | high                          | `{type: "adaptive"}`                       | 200    | 281                  | $0.073     |
| `baseline_xhigh`   | xhigh          | xhigh                         | `{type: "adaptive"}`                       | 200    | 266                  | $0.073     |
| `baseline_max`     | max            | max                           | `{type: "adaptive"}`                       | 200    | 323                  | $0.074     |
| `override_1k_low`  | low            | low                           | `{type: "enabled", budget_tokens: 1024}`   | 200    | 235                  | $0.019     |
| `override_4k_low`  | low            | low                           | `{type: "enabled", budget_tokens: 4096}`   | 200    | 234                  | $0.019     |
| `override_16k_low` | low            | low                           | `{type: "enabled", budget_tokens: 16384}`  | 200    | 229                  | $0.022     |

(All "answer quality" notes for the lightbulb runs were qualitatively
identical: 6-step procedure ending in "warm bulb / cold bulb / lit bulb".)

The difference in cost between override_*_low and baseline_low isn't the
override "saving money" — it's a prompt-cache effect. The override runs
were issued back-to-back so they hit the 5 m ephemeral cache from each
other, with `cache_creation_input_tokens` collapsing from ~9 100 to 0.

## Verdict on the questions the brief asked

1. **Does Claude Code currently pass shrunk `budget_tokens`?**
   **No.** It does not pass `budget_tokens` at all. It passes
   `thinking: {type: "adaptive"}` *plus* `output_config.effort`. The
   "intelligence drop" can only be the server's interpretation of
   `output_config.effort`, not a numeric budget the client is shrinking.

2. **Does the API accept higher `budget_tokens` overrides?**
   **Yes.** 1k, 4k, and 16k all returned 200, valid
   responses, no caps, no error reasoning. So the API is not the gate.

3. **Is shrunk-budget the cause of the perceived intelligence drop, and
   does override fix it?**
   **No on the cause; partially yes on the fix.** Shrunk `budget_tokens` is
   not the mechanism — `output_config.effort` is. Overriding
   `budget_tokens` while leaving `effort=low` did not measurably increase
   thinking on the hard prompt (1 981 vs 2 162 output tokens). Overriding
   `output_config.effort` itself from `low` to `max` *did* — 1 981 → 11 084
   output tokens.

   So MITM is still the right mechanism for what we want, but the field to
   rewrite is `output_config.effort`, not `thinking.budget_tokens`. (Or
   both, if we want to belt-and-braces it.)

## Practical recipe for the eventual "make Opus think harder" toggle

In the addon, set `EFFORT_OVERRIDE=max` (and keep `BUDGET_OVERRIDE` unset,
or set it to a large value as belt-and-braces). The addon rewrites
`output_config.effort` on every outbound `/v1/messages`, regardless of what
flag the user invoked Claude Code with. This is what `samples/effort_max_via_mitm_low_hard/`
demonstrates end-to-end.

If the eventual production wiring is decided to be a runtime proxy in front
of the developer container's egress, this is the field it needs to touch.

## Things this PoC did NOT establish

* Whether the `effort` field has a continuous effect (we tested only
  `low` ↔ `max` on the hard prompt). The five-level baseline on the
  lightbulb prompt showed no monotonic trend, but the prompt was too easy.
* Whether `effort=max` on a long agentic task scales linearly in cost —
  one-shot prompt only.
* Whether the `clear_thinking_20251015` context-management entry would
  affect anything once the conversation has more than one turn — single-
  turn captures only.
* Whether `output_config` accepts other fields besides `effort` (e.g. is
  there a hidden `output_config.budget_tokens`?).

## Blockers hit during the PoC, for the record

1. The agent harness mounts `~/.claude.json` read-only. Spawning a child
   `claude` from inside the harness session hangs forever trying to
   persist its config. Worked around with `HOME=/tmp/claudehome` plus a
   copy of `.credentials.json`. Not a Claude-Code issue, environmental.
2. `mitmproxy` buffers SSE responses by default → Claude Code blocks
   waiting for the first token while mitmproxy waits for the stream to
   end. Fixed by setting `flow.response.stream = streamer` for SSE
   responses in `addons/capture.py`.
3. Anthropic gzip-encodes the SSE stream. Captured chunks need
   `gzip.decompress` after concatenation before the SSE parser can read
   them.
4. CLAUDE_CODE_* env vars from the parent (harness) `claude` session
   confused the child `claude` in `--print` mode and made it hang.
   Worked around with `env -i PATH=$PATH HOME=...`.

None invalidated the experiment.
