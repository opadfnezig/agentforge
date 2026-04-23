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

# Fix ownership so agent user can run + write logs
RUN chown -R agent:agent /app

# Entrypoint runs as root to set up SSH keys, then drops to agent
ENTRYPOINT ["/usr/local/bin/dev-entrypoint.sh"]
CMD ["node", "dist/index.js"]
