#!/usr/bin/env bash
#
# Manual deploy script for ntfr-spawner. Future: pull a published image
# from a docker registry — for now we build from source on the host.
#
# Usage:  ./deploy.sh           # validates env, builds, starts
#         ./deploy.sh --logs    # also tails spawner logs after start
#
set -euo pipefail

cd "$(dirname "$0")"

if [[ ! -f .env ]]; then
  echo "ERROR: .env missing. Copy .env.example → .env and fill it in." >&2
  exit 1
fi

# Validate required vars
set -a
# shellcheck disable=SC1091
source .env
set +a

: "${NTFR_HOST_ID:?NTFR_HOST_ID must be set in .env}"
: "${NTFR_HOST_WORKDIR:?NTFR_HOST_WORKDIR must be set in .env}"

# Make sure the host workdir exists and is writable.
mkdir -p "${NTFR_HOST_WORKDIR}/.spawner" "${NTFR_HOST_WORKDIR}/.archive"

# Auto-detect docker GID if not pinned.
if [[ -z "${NTFR_DOCKER_GID:-}" ]] || [[ "${NTFR_DOCKER_GID}" == "998" ]]; then
  detected=$(getent group docker | cut -d: -f3 || true)
  if [[ -n "${detected}" ]] && [[ "${detected}" != "${NTFR_DOCKER_GID:-}" ]]; then
    echo "Detected host docker GID = ${detected} (was ${NTFR_DOCKER_GID:-unset})." >&2
    export NTFR_DOCKER_GID="${detected}"
  fi
fi

# --- Install claude-refresh systemd service on the host (idempotent) ---
#
# Claude OAuth token expires every ~8h. Containers spawned by ntfr that need
# the token can't refresh it themselves (RO mount + multiple consumers). This
# host service refreshes ~1h before expiry and mirrors creds to a stable-inode
# location at ${CLAUDE_MIRROR_DIR} that containers RO-mount.
#
# Skip with: SKIP_CLAUDE_REFRESH=1 ./deploy.sh
if [[ -z "${SKIP_CLAUDE_REFRESH:-}" ]]; then
  CLAUDE_USER="${CLAUDE_USER:-$(id -un)}"
  CLAUDE_HOME=$(getent passwd "$CLAUDE_USER" | cut -d: -f6)
  CLAUDE_MIRROR_DIR="${CLAUDE_MIRROR_DIR:-/var/lib/agentforge-creds}"

  if [[ -z "$CLAUDE_HOME" ]] || [[ ! -d "$CLAUDE_HOME" ]]; then
    echo "ERROR: home dir for user '$CLAUDE_USER' not found." >&2
    exit 1
  fi

  if [[ ! -f "$CLAUDE_HOME/.claude/.credentials.json" ]]; then
    echo "ERROR: $CLAUDE_HOME/.claude/.credentials.json missing." >&2
    echo "       Run 'claude' interactively as $CLAUDE_USER first to log in." >&2
    echo "       Then re-run deploy. Or pass SKIP_CLAUDE_REFRESH=1 to skip." >&2
    exit 1
  fi

  CLAUDE_BIN=$(sudo -u "$CLAUDE_USER" -i which claude 2>/dev/null || true)
  if [[ -z "$CLAUDE_BIN" ]]; then
    echo "WARN: 'claude' CLI not found in $CLAUDE_USER's PATH; service may fail." >&2
    CLAUDE_BIN="claude"
  fi

  echo "Installing claude-refresh.service (user=$CLAUDE_USER, mirror=$CLAUDE_MIRROR_DIR)..."
  sudo install -m 755 claude-refresh.sh /usr/local/bin/claude-refresh.sh
  sudo mkdir -p "$CLAUDE_MIRROR_DIR"
  sudo touch "$CLAUDE_MIRROR_DIR/credentials.json" "$CLAUDE_MIRROR_DIR/claude.json"
  sudo chown "$CLAUDE_USER:$CLAUDE_USER" "$CLAUDE_MIRROR_DIR" \
                                         "$CLAUDE_MIRROR_DIR/credentials.json" \
                                         "$CLAUDE_MIRROR_DIR/claude.json"
  sudo chmod 644 "$CLAUDE_MIRROR_DIR/credentials.json" "$CLAUDE_MIRROR_DIR/claude.json"

  sudo tee /etc/systemd/system/claude-refresh.service > /dev/null <<EOF
[Unit]
Description=Refresh Claude OAuth token before expiration (ntfr-spawner)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$CLAUDE_USER
Environment=HOME=$CLAUDE_HOME
Environment=MIRROR_DIR=$CLAUDE_MIRROR_DIR
Environment=CLAUDE_BIN=$CLAUDE_BIN
ExecStart=/usr/local/bin/claude-refresh.sh
Restart=on-failure
RestartSec=30
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

  sudo systemctl daemon-reload
  sudo systemctl enable --now claude-refresh.service
  echo "claude-refresh.service active. Containers can mount $CLAUDE_MIRROR_DIR/credentials.json RO."
fi

echo "Building spawner image..."
docker compose build

echo "Starting spawner (host_id=${NTFR_HOST_ID}, port=${NTFR_PORT:-9898})..."
docker compose up -d

echo "Waiting for /health..."
for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${NTFR_PORT:-9898}/health" >/dev/null 2>&1; then
    echo "Spawner healthy."
    curl -s "http://127.0.0.1:${NTFR_PORT:-9898}/info" | head -c 1024
    echo
    exit 0
  fi
  sleep 1
done

echo "Spawner did not become healthy. Recent logs:" >&2
docker compose logs --tail 100
exit 1
