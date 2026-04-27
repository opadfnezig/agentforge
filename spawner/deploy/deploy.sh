#!/usr/bin/env bash
#
# Manual deploy script for ntfr-spawner. Future: pull a published image
# from a docker registry — for now we build from source on the host.
#
# Usage:  ./deploy.sh           # validates env, builds, starts
#         ./deploy.sh --logs    # also tails spawner logs after start
#
# Claude credentials: NOT handled here. If primitives spawned on this host
# need Claude auth, deploy the claude-token-broker client separately
# (https://github.com/opadfnezig/claude-token-broker, client/ subdir).
# The broker client maintains a stable-inode credential file the primitives
# bind-mount RO.
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
