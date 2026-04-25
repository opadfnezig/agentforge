FROM agentforge/claude-agent:latest

USER root
WORKDIR /app

RUN pacman -Sy --noconfirm --needed openssh git || true

COPY package.json ./
COPY tsconfig.json ./
RUN npm install

COPY src ./src
RUN npx tsc

COPY entrypoint.sh /usr/local/bin/dev-entrypoint.sh
RUN chmod +x /usr/local/bin/dev-entrypoint.sh

# Fix ownership so agent user can run + write logs.
# Pre-create writable .claude dir so the RO credential mount has a parent the
# CLI can write cache/debug/projects subdirs into.
RUN mkdir -p /home/agent/.claude && chown -R agent:agent /app /home/agent/.claude

# Entrypoint runs as root to set up SSH keys, then drops to agent
ENTRYPOINT ["/usr/local/bin/dev-entrypoint.sh"]
CMD ["node", "dist/index.js"]
