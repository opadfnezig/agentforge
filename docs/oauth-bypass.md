# Core OAuth Bypass — Reference

This document describes how `core` (the `@hearth/core` library that lives at
`/workspace/core/`) calls the Anthropic Messages API while authenticated as a
Claude Max subscriber instead of via a paid `ANTHROPIC_API_KEY`. The user
iterated on this implementation 3–4 times last week; the version on disk is
treated as the **reference contract** for any future re-implementation
(coordinator refactor in Task 4, researcher build in Task 3.2). **Read-only —
do not modify.**

Everything below is in a single file: `core/src/providers/anthropic.js`. The
only consumer is `core/src/executors/llm.js`, which routes any model whose id
begins with `claude-` through this provider.

## 1. Where credentials live

`~/.claude/.credentials.json`, the file that the Claude Code CLI writes when
the user logs in to a Max subscription. Shape:

```json
{
  "claudeAiOauth": {
    "accessToken":  "sk-ant-oat01-...",
    "refreshToken": "sk-ant-ort01-...",
    "expiresAt":    1777132964902,
    "scopes":       [...],
    "subscriptionType": "max",
    "rateLimitTier":    "..."
  }
}
```

The provider reads it with `readFileSync(join(homedir(), '.claude', '.credentials.json'))`
on first use and on every cache miss
(`core/src/providers/anthropic.js:32`, `:120`).

Selection precedence (`getCredentials()`, `:110`):

1. `process.env.ANTHROPIC_API_KEY` if set → returned with `isOAuth: false`.
2. Cached OAuth credential, if read in the last 60 s.
3. Fresh read of the credentials file → returned with `isOAuth: true`.

When a brand-new access token is observed (different from the last cached
value), `_oauthSessionActive` is reset so the preflight handshake will run
again on the next request.

## 2. Token acquisition + refresh

Core does **not** speak the OAuth token endpoint itself. It delegates refresh
back to the Claude Code CLI:

```js
execSync('claude -p "ok" --max-turns 1', { timeout: 30000, stdio: 'pipe', env: { ...process.env, HOME: homedir() } })
```

(`refreshOAuthToken`, `:30`–`:68`.) The trick: invoking `claude` non-
interactively triggers its own OAuth refresh logic during init, which
rewrites `~/.claude/.credentials.json`. Core then re-reads the file and, if
the access token changed, considers the refresh successful. The actual
`claude -p "ok"` request is allowed to fail; only the credential file
mutation matters.

Refresh is triggered:

* When the API returns **401** on attempt ≥ 2 of a request (`:248`).
* Never proactively on `expiresAt` — the code does not check expiry before
  sending; it relies on 401 → refresh → retry.

## 3. The preflight "session activation" handshake

Before the first `/v1/messages` call (and again every 10 minutes, or after
any 5xx), the provider fires four GETs in parallel against api.anthropic.com
to make Anthropic accept the OAuth token for direct browser-style calls
(`activateOAuthSession`, `:73`):

| Endpoint                                        | UA used                                                              |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| `/api/claude_code_penguin_mode`                 | `axios/1.8.4`                                                        |
| `/api/oauth/claude_cli/client_data`             | `claude-code/2.1.76` (+ `Content-Type: application/json`)            |
| `/api/oauth/account/settings`                   | `claude-code/2.1.76`                                                 |
| `/api/claude_code_grove`                        | `claude-cli/2.1.76 (external, claude-vscode, agent-sdk/0.2.73)`      |

All four carry `Authorization: Bearer <accessToken>` and
`anthropic-beta: oauth-2025-04-20`. None of the four responses are inspected
— the comment is *"required preflight call before v1/messages works"*. After
they complete, `_oauthSessionActive = true` is set and the timestamp is
recorded; the gate is re-armed by:

* TTL expiry (`OAUTH_SESSION_TTL = 10 min`, `:21`).
* Any 401 (`:247`).
* Any 5xx (`:260`, with `force=true` to bypass the TTL gate).
* The credential file producing a different access token (`:128`).

## 4. The `/v1/messages` request shape (OAuth path)

URL: `https://api.anthropic.com/v1/messages?beta=true` (note the query
param — `:192`).

Headers:

```
Content-Type: application/json
Authorization: Bearer <accessToken>
anthropic-version: 2023-06-01
anthropic-beta: claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advanced-tool-use-2025-11-20,effort-2025-11-24
anthropic-dangerous-direct-browser-access: true
User-Agent: claude-cli/2.1.77 (external, claude-vscode, agent-sdk/0.2.73)
x-app: cli
X-Stainless-Arch: x64
X-Stainless-Lang: js
X-Stainless-OS: Linux
X-Stainless-Package-Version: 0.74.0
X-Stainless-Retry-Count: 0
X-Stainless-Runtime: node
X-Stainless-Runtime-Version: v24.3.0
X-Stainless-Timeout: 600
```

Constants live at the top of the file (`:11`–`:15`).

Body — same shape as a normal Messages-API call (`chatCompletion` /
`chatCompletionStream`, `:322`/`:354`), except for one OAuth-specific
mutation: the system field is **prepended with a billing block** so usage is
attributed to the Claude Code subscription instead of being billed as a
direct API call (`:194`–`:206`):

```js
const billingBlock = { type: 'text', text: CC_BILLING_HEADER };
//   CC_BILLING_HEADER = 'x-anthropic-billing-header: cc_version=2.1.77.e19; cc_entrypoint=claude-vscode; cch=2976e;'

if (typeof body.system === 'string')   body.system = [billingBlock, { type: 'text', text: body.system }];
else if (Array.isArray(body.system))   body.system = [billingBlock, ...body.system];
else                                   body.system = [billingBlock];
```

Yes — the billing identifier is shipped as a `text` block inside `system`,
not as an HTTP header (despite its `x-...:` shape). That is intentional and
matches what real Claude Code sends.

The rest of the body is whatever the caller passed (`model`, `messages`,
`max_tokens`, optional `temperature`, optional `system`). There is no
`thinking` field added by core; if one is passed in via the LLM action's
`api.thinking` config (`core/src/executors/llm.js:91`,`:199`), it is
forwarded verbatim — but in practice the bypass is currently used **without
a thinking config**.

## 5. Error handling that touches OAuth

| Status      | Behaviour                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------- |
| 401         | Drop cache, on attempt ≥ 2 force a `refreshOAuthToken()`, sleep 1 s, retry.                       |
| 429         | Exponential backoff up to 30 s, retry.                                                            |
| 500–599 OAuth | Re-arm session (`activateOAuthSession(force=true)`), backoff up to 10 s, retry.                |
| 500–599 API-key| Backoff only.                                                                                  |
| 529         | Treated as overloaded — slower backoff (start 2 s).                                              |
| Other       | Throw.                                                                                            |

`MAX_RETRIES = 3` (`:13`).

## 6. API surface reached

* `POST /v1/messages?beta=true` — the only data-path call.
* `GET  /api/claude_code_penguin_mode`
* `GET  /api/oauth/claude_cli/client_data`
* `GET  /api/oauth/account/settings`
* `GET  /api/claude_code_grove`

(All on `https://api.anthropic.com`.) Token endpoint
(`/api/oauth/token`, etc.) is **not** called by core directly — the CLI
shell-out is the refresh mechanism.

## 7. File-reference summary

| Concern                          | Location                                                               |
| -------------------------------- | ---------------------------------------------------------------------- |
| Constants (UA, beta flags, etc.) | `core/src/providers/anthropic.js:11-15`                                |
| Credential read + cache          | `core/src/providers/anthropic.js:110-138`                              |
| Refresh-via-CLI                  | `core/src/providers/anthropic.js:30-68`                                |
| Session-activation handshake     | `core/src/providers/anthropic.js:73-105`                               |
| Per-request header build         | `core/src/providers/anthropic.js:174-189`                              |
| Billing-block injection          | `core/src/providers/anthropic.js:194-206`                              |
| Retry / refresh on 401 / 5xx     | `core/src/providers/anthropic.js:228-272`                              |
| Public completion API            | `core/src/providers/anthropic.js:322-414` (`chatCompletion`/`...Stream`)|
| Routing `claude-*` → this file   | `core/src/executors/llm.js:10-19`                                      |
