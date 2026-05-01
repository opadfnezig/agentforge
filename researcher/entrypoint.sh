#!/bin/sh
set -e

# Fix ownership on mounted dirs. Spawner creates them as uid 10001 on the
# host; agent inside container is uid 1000. Without this chown, claude
# can't write memories, session JSONLs, or research results.
mkdir -p /home/agent/.claude/projects/-workspace/memory
chown -R agent:agent /home/agent/.claude || true
mkdir -p /workspace/results
chown -R agent:agent /workspace/results || true

exec runuser -u agent -- "$@"
