#!/bin/sh
set -e

# Fix ownership on mounted dirs. The host creates these via the spawner
# (uid 10001) while the in-container agent user is uid 1000 — without
# this chown, agent can't write to its own memory or session files.
# Scope the chown to /projects (the parent of the mount) — chowning all
# of /home/agent/.claude would hit the read-only credentials.json mount.
mkdir -p /home/agent/.claude/projects/-workspace/memory
chown -R agent:agent /home/agent/.claude/projects 2>/dev/null || true
mkdir -p /data
chown -R agent:agent /data 2>/dev/null || true

exec runuser -u agent -- "$@"
