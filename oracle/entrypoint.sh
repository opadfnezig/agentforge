#!/bin/sh
set -e

# Fix ownership on mounted dirs. The host creates these via the spawner
# (uid 10001) while the in-container agent user is uid 1000 — without
# this chown, agent can't write to its own memory or session files.
# We chown the parent claude project dir (which is the mount root) plus
# /data (migrate staging). Both are bind-mounted from the host so this
# only affects the container's view; host UIDs stay as-is.
mkdir -p /home/agent/.claude/projects/-workspace/memory
chown -R agent:agent /home/agent/.claude
mkdir -p /data
chown -R agent:agent /data || true

exec runuser -u agent -- "$@"
