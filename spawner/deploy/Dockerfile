# ntfr-spawner — standalone spawn-node service.
#
# Bundles the spawner Node app + the docker CLI, and shells out to
# `docker compose` against the host's docker socket which is mounted into
# the container at runtime (see deploy/docker-compose.yml).

FROM node:22-bookworm-slim

# Install docker CLI and tar (used for archive-on-destroy). We do NOT install
# the docker daemon — the spawner uses the host daemon via /var/run/docker.sock.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg tar \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg \
      -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
 && rm -rf /var/lib/apt/lists/*

# Create the shared `ntfr` user (uid 10001) used by spawner + every primitive.
# Per-primitive uid splitting is deferred — isolation is via mount permissions.
RUN groupadd -g 10001 ntfr && useradd -u 10001 -g 10001 -m -s /bin/bash ntfr

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-fund --no-audit

COPY tsconfig.json ./
COPY src ./src
RUN npm install --no-fund --no-audit \
 && npx tsc \
 && npm prune --omit=dev

ENV NODE_ENV=production
ENV NTFR_PORT=9898
ENV NTFR_WORKDIR=/ntfr/ntfr

# Ensure workdir exists and is owned by the ntfr user. The host's workdir
# is bind-mounted on top at runtime (at the same path, so Docker daemon
# and spawner see identical paths for compose file + volume sources).
RUN mkdir -p /ntfr/ntfr && chown -R ntfr:ntfr /ntfr /app

EXPOSE 9898

# Drop privileges. The spawner needs RW on /ntfr and access to the docker
# socket; both are bind-mounted from the host. The docker socket group must
# be made accessible — see deploy/docker-compose.yml for `group_add`.
USER ntfr

CMD ["node", "dist/index.js"]
