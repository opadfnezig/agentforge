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

# Make sure the host workdir exists and is owned by the in-container ntfr
# user (uid/gid 10001). The spawner runs as ntfr inside the container and
# bind-mounts ${NTFR_HOST_WORKDIR} -> /ntfr; without matching ownership it
# can't write spawner.log, state.db, primitive folders, etc.
#
# Override with NTFR_UID / NTFR_GID if you've remapped the in-container uid.
NTFR_UID="${NTFR_UID:-10001}"
NTFR_GID="${NTFR_GID:-10001}"

mkdir -p "${NTFR_HOST_WORKDIR}/.spawner" "${NTFR_HOST_WORKDIR}/.archive"

if [[ $EUID -eq 0 ]]; then
  chown -R "${NTFR_UID}:${NTFR_GID}" "${NTFR_HOST_WORKDIR}"
  chmod 755 "${NTFR_HOST_WORKDIR}"
else
  current_uid=$(stat -c '%u' "${NTFR_HOST_WORKDIR}")
  if [[ "${current_uid}" != "${NTFR_UID}" ]]; then
    echo "WARN: ${NTFR_HOST_WORKDIR} is owned by uid ${current_uid}, expected ${NTFR_UID}." >&2
    echo "      Run as root (or sudo) to chown, or do it manually:" >&2
    echo "      sudo chown -R ${NTFR_UID}:${NTFR_GID} ${NTFR_HOST_WORKDIR}" >&2
  fi
fi

# Auto-detect docker GID if not pinned.
if [[ -z "${NTFR_DOCKER_GID:-}" ]] || [[ "${NTFR_DOCKER_GID}" == "998" ]]; then
  detected=$(getent group docker | cut -d: -f3 || true)
  if [[ -n "${detected}" ]] && [[ "${detected}" != "${NTFR_DOCKER_GID:-}" ]]; then
    echo "Detected host docker GID = ${detected} (was ${NTFR_DOCKER_GID:-unset})." >&2
    export NTFR_DOCKER_GID="${detected}"
  fi
fi

# Build the agentforge claude-agent base image. Primitive Dockerfiles
# (developer, oracle, researcher, …) all `FROM agentforge/claude-agent:latest`,
# so a host running the spawner needs this image present locally — even if
# the full agentforge stack isn't deployed here. Mirrors the `agent-builder`
# one-shot in the main agentforge docker-compose.yml.
NTFR_HOST_SRC="${NTFR_HOST_SRC:-/ntfr/agentforge}"
AGENT_BUILD_CTX="${NTFR_HOST_SRC}/docker/agent"

if [[ ! -f "${AGENT_BUILD_CTX}/Dockerfile" ]]; then
  echo "ERROR: agentforge source tree not present at expected path; spawner cannot bootstrap base image." >&2
  echo "       Looked for: ${AGENT_BUILD_CTX}/Dockerfile" >&2
  echo "       Set NTFR_HOST_SRC in .env to the host path of the agentforge checkout." >&2
  exit 1
fi

echo "Building agentforge/claude-agent:latest from ${AGENT_BUILD_CTX}..."
docker build -t agentforge/claude-agent:latest "${AGENT_BUILD_CTX}"

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
