FROM agentforge/claude-agent:latest

USER root
WORKDIR /app

COPY package.json ./
COPY tsconfig.json ./
RUN npm install

COPY src ./src
RUN npx tsc

# Pre-create writable dirs so the RO credential mount has a parent the
# CLI can write cache/debug/projects subdirs into.
RUN mkdir -p /home/agent/.claude /workspace/results && chown -R agent:agent /app /home/agent/.claude /workspace/results

COPY entrypoint.sh /usr/local/bin/researcher-entrypoint.sh
RUN chmod +x /usr/local/bin/researcher-entrypoint.sh

WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/researcher-entrypoint.sh"]
CMD ["node", "/app/dist/index.js"]
