FROM agentforge/claude-agent:latest

USER root
WORKDIR /app

COPY package.json ./
COPY tsconfig.json ./
RUN npm install

COPY src ./src
# zod + @modelcontextprotocol/sdk type inference is heavy enough that tsc
# OOMs at the default ~1.7 GB heap. 4 GB is comfortable; bump again only
# if tools are added and emit starts failing.
RUN NODE_OPTIONS=--max-old-space-size=4096 npx tsc

COPY entrypoint.sh /usr/local/bin/oracle-entrypoint.sh
RUN chmod +x /usr/local/bin/oracle-entrypoint.sh

# Pre-create the pinned cwd and memory dir so the RO credential mount
# has a parent the CLI can write cache/debug/projects subdirs into. The
# memory subpath mirrors how `claude` encodes cwd `/workspace` → `-workspace`.
RUN mkdir -p /workspace /home/agent/.claude/projects/-workspace/memory \
 && chown -R agent:agent /app /workspace /home/agent/.claude

# Pin WORKDIR to /workspace so the claude CLI resolves its memory dir to
# a stable, mountable path (~/.claude/projects/-workspace/memory).
WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/oracle-entrypoint.sh"]
CMD ["node", "/app/dist/index.js"]
