#!/bin/sh
set -e

# Fix ownership on mounted dirs. Spawner creates them as uid 10001 on the
# host; agent inside container is uid 1000. Without this chown, claude
# can't write memories, session JSONLs, or research results. Scope the
# chown to /projects so it doesn't hit the read-only credentials.json.
mkdir -p /home/agent/.claude/projects/-workspace/memory
chown -R agent:agent /home/agent/.claude/projects 2>/dev/null || true
mkdir -p /workspace/results
chown -R agent:agent /workspace/results 2>/dev/null || true

exec runuser -u agent -- "$@"
