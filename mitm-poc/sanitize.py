#!/usr/bin/env python3
"""
Sanitize captured runs from samples/_runs/ into samples/<run_tag>/ for committing.

Drops or redacts:
  - metadata.user_id (contains device_id + account_uuid + session_id)
  - response header anthropic-organization-id
  - response/request header x-client-request-id, x-claude-code-session-id
  - request_id, msg_ ids in body excerpts → kept (not PII)
  - cache_control nonces are kept

Filters:
  - Skip per-run debug logs and mitm logs (too noisy and may leak prompts).
  - Keep _claude_result.json (already free of secrets) but strip session_id.
"""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "samples" / "_runs"
DST = ROOT / "samples"

REDACT_HEADER_KEYS = {
    "anthropic-organization-id",
    "x-client-request-id",
    "x-claude-code-session-id",
    "request-id",
}

# String-level purges: regex -> replacement. Applied to the serialized JSON
# text of every saved record after structural redaction. This catches PII
# embedded in system prompts, free-text excerpts, etc.
STRING_PURGES = [
    # Generic email addresses.
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "<redacted-email>"),
    # Anthropic account / org / device UUIDs we know belong to this user.
    (re.compile(r"b37355a2-0117-4e72-b9f8-28111d399311"), "<redacted-account-uuid>"),
    (re.compile(r"16ff7f9e-d4c8-400b-9a9a-b098f024dc51"), "<redacted-org-uuid>"),
    (re.compile(r"67b7ab06efc16243636b19645279999067cf72f5013cf4d4d40c288644e19b2c"), "<redacted-device-id>"),
    # Per-run session UUIDs are random; leaving them in is fine, but the
    # account_uuid line that some claude-cli endpoints embed is normalized too.
]

KEEP_FILES_GLOB = ("0*v1_messages*.json", "0*v1_messages*.sse", "_claude_result.json", "_run.log")


def redact_metadata_user_id(body):
    md = body.get("metadata") if isinstance(body, dict) else None
    if isinstance(md, dict) and "user_id" in md:
        md["user_id"] = "<redacted: device_id + account_uuid + session_id>"
    return body


def redact_headers(headers):
    if not isinstance(headers, dict):
        return headers
    out = {}
    for k, v in headers.items():
        if k.lower() in REDACT_HEADER_KEYS:
            out[k] = "<redacted>"
        else:
            out[k] = v
    return out


def redact_record(rec):
    if "request_body" in rec:
        rec["request_body"] = redact_metadata_user_id(rec["request_body"])
    if "request_headers" in rec:
        rec["request_headers"] = redact_headers(rec["request_headers"])
    if "response_headers" in rec:
        rec["response_headers"] = redact_headers(rec["response_headers"])
    return rec


def redact_claude_result(rec):
    for k in ("session_id", "uuid"):
        if k in rec:
            rec[k] = f"<redacted-{k}>"
    return rec


def purge_strings(text: str) -> str:
    for pat, rep in STRING_PURGES:
        text = pat.sub(rep, text)
    return text


def sanitize_run(src_dir: Path, dst_dir: Path):
    if dst_dir.exists():
        shutil.rmtree(dst_dir)
    dst_dir.mkdir(parents=True, exist_ok=True)

    for pattern in KEEP_FILES_GLOB:
        for f in sorted(src_dir.glob(pattern)):
            target = dst_dir / f.name
            if f.suffix == ".json":
                rec = json.loads(f.read_text())
                if f.name == "_claude_result.json":
                    rec = redact_claude_result(rec)
                else:
                    rec = redact_record(rec)
                serialized = json.dumps(rec, indent=2, default=str)
                target.write_text(purge_strings(serialized))
            else:
                target.write_text(purge_strings(f.read_text()))


def main():
    if not SRC.exists():
        print("no source runs found at", SRC)
        return
    for run_dir in sorted(SRC.iterdir()):
        if not run_dir.is_dir():
            continue
        if run_dir.name == "latest":
            continue
        out = DST / run_dir.name
        sanitize_run(run_dir, out)
        print(f"sanitized {run_dir.name} -> {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
