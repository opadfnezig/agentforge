"""
mitmproxy addon: capture + optionally rewrite Anthropic Messages API traffic.

Each /v1/messages request is recorded to OUT_DIR (default mitm-poc/samples/_runs/<RUN_TAG>)
as a JSON file containing the request body, response status, and parsed
streaming usage stats. Sensitive headers are redacted.

Env vars:
  RUN_TAG         label written into each capture filename (e.g. low_default)
  OUT_DIR         override the run directory
  BUDGET_OVERRIDE if set to a non-empty integer, all outbound /v1/messages
                  bodies will have their `thinking.budget_tokens` rewritten to
                  this value. If `thinking` is missing or disabled, an
                  enabled block with this budget is inserted. `max_tokens`
                  is bumped above budget when needed (Anthropic requires
                  max_tokens > thinking.budget_tokens).
"""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import Any

from mitmproxy import http
from mitmproxy import ctx


REDACT_HEADERS = {
    "authorization",
    "x-api-key",
    "cookie",
    "set-cookie",
    "proxy-authorization",
}


def _redact_headers(items):
    out = {}
    for k, v in items:
        if k.lower() in REDACT_HEADERS:
            out[k] = f"<redacted len={len(v)}>"
        else:
            out[k] = v
    return out


def _safe_run_tag(tag: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", tag) or "run"


class Capture:
    def __init__(self) -> None:
        self.run_tag = _safe_run_tag(os.environ.get("RUN_TAG", "run"))
        out_root = os.environ.get(
            "OUT_DIR",
            str(Path(__file__).resolve().parent.parent / "samples" / "_runs" / self.run_tag),
        )
        self.out_dir = Path(out_root)
        self.out_dir.mkdir(parents=True, exist_ok=True)

        budget_env = os.environ.get("BUDGET_OVERRIDE", "").strip()
        self.budget_override: int | None = int(budget_env) if budget_env else None

        effort_env = os.environ.get("EFFORT_OVERRIDE", "").strip()
        self.effort_override: str | None = effort_env or None

        # Per-flow accumulator for SSE response bodies
        self._stream_buf: dict[int, list[bytes]] = {}
        self._req_meta: dict[int, dict[str, Any]] = {}
        self._counter = 0

        ctx.log.info(
            f"[capture] run_tag={self.run_tag} out_dir={self.out_dir} "
            f"budget_override={self.budget_override}"
        )

    # ---- request side ----

    def request(self, flow: http.HTTPFlow) -> None:
        url = flow.request.pretty_url
        if "api.anthropic.com" not in url:
            return
        if "/v1/messages" not in url:
            # Still log, just don't rewrite — useful to see preflight handshake
            self._req_meta[id(flow)] = {
                "kind": "non-messages",
                "url": url,
                "method": flow.request.method,
                "request_headers": _redact_headers(flow.request.headers.items()),
            }
            return

        try:
            body = json.loads(flow.request.get_text() or "{}")
        except Exception as e:
            ctx.log.warn(f"[capture] failed to parse request body: {e}")
            return

        original_thinking = body.get("thinking")
        original_max_tokens = body.get("max_tokens")
        original_output_config = body.get("output_config")
        rewritten = False

        if self.budget_override is not None:
            new_budget = self.budget_override
            body["thinking"] = {"type": "enabled", "budget_tokens": new_budget}
            # max_tokens must exceed budget_tokens for the API to accept the call
            cur_max = int(body.get("max_tokens") or 0)
            if cur_max <= new_budget:
                body["max_tokens"] = new_budget + 1024
            rewritten = True
            ctx.log.info(
                f"[capture] rewrote budget_tokens -> {new_budget} "
                f"(was thinking={original_thinking}, max_tokens={original_max_tokens})"
            )

        if self.effort_override is not None:
            oc = body.get("output_config") or {}
            oc = dict(oc)
            oc["effort"] = self.effort_override
            body["output_config"] = oc
            rewritten = True
            ctx.log.info(
                f"[capture] rewrote output_config.effort -> {self.effort_override} "
                f"(was {original_output_config})"
            )

        if rewritten:
            flow.request.set_text(json.dumps(body))

        self._req_meta[id(flow)] = {
            "kind": "messages",
            "url": url,
            "method": flow.request.method,
            "request_headers": _redact_headers(flow.request.headers.items()),
            "request_body": body,
            "original_thinking": original_thinking,
            "original_max_tokens": original_max_tokens,
            "rewritten": rewritten,
            "rewritten_to_budget": self.budget_override,
            "rewritten_to_effort": self.effort_override,
            "original_output_config": original_output_config,
        }

    # ---- response side: stream-aware ----

    def responseheaders(self, flow: http.HTTPFlow) -> None:
        # SSE responses must be streamed through, otherwise mitmproxy buffers
        # the entire stream and Claude Code blocks waiting for tokens.
        # We capture chunks via a passthrough streamer so we still see the body.
        ctype = flow.response.headers.get("content-type", "")
        if "text/event-stream" in ctype:
            chunks: list[bytes] = []
            self._stream_buf[id(flow)] = chunks

            def streamer(chunk: bytes) -> bytes:
                if chunk:
                    chunks.append(chunk)
                return chunk

            flow.response.stream = streamer

    def response(self, flow: http.HTTPFlow) -> None:
        meta = self._req_meta.pop(id(flow), None)
        if meta is None:
            return

        # If we streamed the response, reassemble from captured chunks.
        text = ""
        raw = b""
        chunks = self._stream_buf.pop(id(flow), None)
        if chunks is not None:
            raw = b"".join(chunks)
            encoding = flow.response.headers.get("content-encoding", "").lower()
            if encoding == "gzip":
                import gzip
                try:
                    raw = gzip.decompress(raw)
                except Exception as e:
                    ctx.log.warn(f"[capture] gzip decode failed: {e}")
            elif encoding in ("br", "brotli"):
                try:
                    import brotli  # type: ignore
                    raw = brotli.decompress(raw)
                except Exception as e:
                    ctx.log.warn(f"[capture] brotli decode failed: {e}")
            elif encoding in ("deflate", "zstd"):
                ctx.log.warn(f"[capture] unhandled encoding: {encoding}")
            try:
                text = raw.decode("utf-8", errors="replace")
            except Exception:
                text = ""
        else:
            try:
                text = flow.response.get_text() or ""
            except Exception:
                text = ""

        usage = self._parse_sse_usage(text) if "text/event-stream" in flow.response.headers.get(
            "content-type", ""
        ) else self._parse_json_usage(text)

        record = {
            **meta,
            "response_status": flow.response.status_code,
            "response_headers": _redact_headers(flow.response.headers.items()),
            "response_content_type": flow.response.headers.get("content-type"),
            "response_usage_summary": usage,
            # Keep the raw response trimmed to keep files small but useful.
            "response_body_excerpt": text[:8000],
            "captured_at": time.time(),
        }

        self._counter += 1
        out_file = self.out_dir / f"{self._counter:03d}_{flow.request.method}_{flow.request.path.split('?')[0].replace('/', '_')}.json"
        out_file.write_text(json.dumps(record, indent=2, default=str))
        # For SSE, also dump the full decoded stream alongside (without truncation).
        if "text/event-stream" in (flow.response.headers.get("content-type") or "") and text:
            out_file.with_suffix(".sse").write_text(text)
        ctx.log.info(
            f"[capture] {flow.response.status_code} {flow.request.method} "
            f"{flow.request.pretty_url} -> {out_file.name} usage={usage}"
        )

    # ---- parsers ----

    def _parse_json_usage(self, text: str) -> dict | None:
        try:
            data = json.loads(text)
        except Exception:
            return None
        return data.get("usage") if isinstance(data, dict) else None

    def _parse_sse_usage(self, text: str) -> dict:
        """Walk an SSE stream and surface the usage info we care about.

        Returns a dict with input_tokens / output_tokens / cache_*_tokens /
        thinking_tokens (if reported) plus model id, stop reason, and a
        crude count of thinking deltas.
        """
        usage: dict[str, Any] = {}
        thinking_text_chars = 0
        thinking_blocks = 0
        text_blocks = 0
        text_chars = 0

        for line in text.splitlines():
            if not line.startswith("data: "):
                continue
            payload = line[6:].strip()
            if not payload or payload == "[DONE]":
                continue
            try:
                ev = json.loads(payload)
            except Exception:
                continue

            t = ev.get("type")
            if t == "message_start":
                msg = ev.get("message", {}) or {}
                usage.setdefault("model", msg.get("model"))
                u = msg.get("usage") or {}
                for k in ("input_tokens", "cache_read_input_tokens",
                          "cache_creation_input_tokens", "output_tokens"):
                    if k in u:
                        usage[k] = u[k]
            elif t == "message_delta":
                u = ev.get("usage") or {}
                for k in ("input_tokens", "output_tokens",
                          "cache_read_input_tokens", "cache_creation_input_tokens"):
                    if k in u:
                        usage[k] = u[k]
                d = ev.get("delta") or {}
                if "stop_reason" in d:
                    usage["stop_reason"] = d["stop_reason"]
            elif t == "content_block_start":
                cb = ev.get("content_block", {}) or {}
                if cb.get("type") == "thinking":
                    thinking_blocks += 1
                elif cb.get("type") == "text":
                    text_blocks += 1
            elif t == "content_block_delta":
                d = ev.get("delta", {}) or {}
                if d.get("type") == "thinking_delta":
                    thinking_text_chars += len(d.get("thinking", ""))
                elif d.get("type") == "text_delta":
                    text_chars += len(d.get("text", ""))

        usage["thinking_blocks_seen"] = thinking_blocks
        usage["thinking_chars_seen"] = thinking_text_chars
        usage["text_blocks_seen"] = text_blocks
        usage["text_chars_seen"] = text_chars
        return usage


addons = [Capture()]
