FROM agentforge/claude-agent:latest

USER root
WORKDIR /app

COPY package.json ./
COPY tsconfig.json ./
RUN npm install

COPY src ./src
RUN npx tsc

# Fix ownership so agent user can run + write logs
RUN chown -R agent:agent /app

USER agent
CMD ["node", "dist/index.js"]
