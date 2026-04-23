FROM node:22-alpine

# Install dependencies for native modules and code-server
RUN apk add --no-cache python3 make g++ curl bash gcompat libstdc++ su-exec

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Create non-root user (Claude CLI refuses --dangerously-skip-permissions as root)
RUN addgroup -S appuser && adduser -S appuser -G appuser

# Install code-server standalone (avoid npm issues with Alpine)
ARG CODE_SERVER_VERSION=4.96.4
RUN curl -fsSL "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-linux-amd64.tar.gz" \
    | tar -xz -C /usr/local/lib \
    && ln -s "/usr/local/lib/code-server-${CODE_SERVER_VERSION}-linux-amd64/bin/code-server" /usr/local/bin/code-server

# Install Claude Code extension (if available in Open VSX)
# Note: code-server uses Open VSX registry, not VS Code marketplace
RUN code-server --install-extension anthropic.claude-code 2>/dev/null || echo "Claude Code extension not available in Open VSX"

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source
COPY . .

# Build TypeScript
RUN npm run build

# Clean up .d.ts files from migrations (knex doesn't like them)
RUN find dist -name "*.d.ts" -delete && find dist -name "*.d.ts.map" -delete

# Remove TS knexfile to avoid conflict, use CJS version
RUN rm -f knexfile.ts

# Ensure appuser owns the app dir and create home
RUN chown -R appuser:appuser /app /home/appuser

ENV HOME=/home/appuser

# Entrypoint runs as root: copies bind-mounted Claude creds into appuser-owned
# location, then drops privileges via su-exec. Container stays non-root for the
# actual workload (Claude CLI refuses --dangerously-skip-permissions as root).
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

# Expose port
EXPOSE 3001

CMD ["sh", "-c", "cd /app && npx knex migrate:latest --knexfile knexfile.cjs && npm start"]
