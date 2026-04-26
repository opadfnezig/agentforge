#!/usr/bin/env bash
# Keep host Claude OAuth credentials fresh and mirror them to a stable-inode
# location that containers can RO-mount.
#
# Why: Docker single-file bind mounts pin the inode at mount time. When Claude
# CLI refreshes the OAuth token it does atomic-rename (write temp + rename),
# which creates a NEW inode. The container's mount stays glued to the old
# (expired) inode forever. Mirroring via truncate-write (`cat src > dst`)
# preserves the destination inode, so containers always see fresh content.
#
# Env (all optional, with defaults):
#   HOME                 — credentials live at $HOME/.claude/.credentials.json
#   MIRROR_DIR           — where to mirror, default /var/lib/agentforge-creds
#   CLAUDE_BIN           — path to claude CLI, default `claude` (uses PATH)
#   LEAD_SECONDS         — refresh this many seconds before expiry, default 3600
#   RETRY_SECONDS        — wait this long after a failure, default 300
#   MIRROR_POLL_SECONDS  — how often to re-mirror inside the wait window, default 15
set -u

HOST_CRED="${HOME:?HOME must be set}/.claude/.credentials.json"
HOST_CONFIG="$HOME/.claude.json"
MIRROR_DIR="${MIRROR_DIR:-/var/lib/agentforge-creds}"
MIRROR_CRED="$MIRROR_DIR/credentials.json"
MIRROR_CONFIG="$MIRROR_DIR/claude.json"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
LOCK="/tmp/claude-refresh.lock"
LEAD_SECONDS="${LEAD_SECONDS:-3600}"
RETRY_SECONDS="${RETRY_SECONDS:-300}"
MIRROR_POLL_SECONDS="${MIRROR_POLL_SECONDS:-15}"

mirror_creds() {
  if [ -f "$HOST_CRED" ]; then
    cat "$HOST_CRED" > "$MIRROR_CRED"
    chmod 644 "$MIRROR_CRED"
  fi
  if [ -f "$HOST_CONFIG" ]; then
    cat "$HOST_CONFIG" > "$MIRROR_CONFIG"
    chmod 644 "$MIRROR_CONFIG"
  fi
}

trigger_refresh() {
  echo "[claude-refresh] triggering refresh" >&2
  if flock -n "$LOCK" "$CLAUDE_BIN" -p "ok" --max-turns 1 >/dev/null 2>&1; then
    echo "[claude-refresh] refresh ok" >&2
    return 0
  else
    echo "[claude-refresh] refresh failed" >&2
    return 1
  fi
}

# Initial mirror so containers can start using fresh creds immediately.
mirror_creds

while true; do
  if [ ! -f "$HOST_CRED" ]; then
    echo "[claude-refresh] $HOST_CRED missing, sleeping ${RETRY_SECONDS}s" >&2
    sleep "$RETRY_SECONDS"
    continue
  fi

  expires_ms=$(python3 -c "import json,sys; print(json.load(open('$HOST_CRED'))['claudeAiOauth'].get('expiresAt',0))" 2>/dev/null)
  expires_ms=${expires_ms:-0}
  now_ms=$(date +%s%3N)
  sleep_s=$(( (expires_ms - now_ms) / 1000 - LEAD_SECONDS ))

  if [ "$sleep_s" -gt 0 ]; then
    # Sleep in chunks so we re-mirror periodically. Catches host CLI refreshes
    # that happen outside our schedule (e.g. interactive `claude` usage).
    while [ "$sleep_s" -gt 0 ]; do
      chunk=$(( sleep_s < MIRROR_POLL_SECONDS ? sleep_s : MIRROR_POLL_SECONDS ))
      sleep "$chunk"
      mirror_creds
      sleep_s=$(( sleep_s - chunk ))
    done
  fi

  if trigger_refresh; then
    mirror_creds
  else
    sleep "$RETRY_SECONDS"
  fi
done
