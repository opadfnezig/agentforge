#!/bin/bash
set -e

echo "=============================================="
echo "AgentForge Claude Agent Container"
echo "Service: ${SERVICE_NAME:-unknown}"
echo "=============================================="
echo ""

# Fix ownership of mounted volumes
sudo chown -R agent:agent /workspace /logs 2>/dev/null || true
sudo chown -R agent:agent /home/agent/.claude 2>/dev/null || true

echo "Environment:"
echo "  - Node: $(node --version)"
echo "  - pnpm: $(pnpm --version)"
echo "  - Claude Code: $(claude --version 2>/dev/null || echo 'checking...')"
echo ""
echo "Workspace: /workspace"
echo "Specs: /specs"
echo "Prompts: /prompts"
echo ""

# Check if Claude auth exists
if [ -d "/home/agent/.claude" ]; then
    echo "Claude auth: found"
else
    echo "WARNING: Claude auth not found!"
    echo "Mount ~/.claude to /home/agent/.claude"
fi

echo ""
echo "=============================================="
echo "To run agent manually:"
echo ""
echo "  /scripts/run-agent.sh"
echo ""
echo "=============================================="
echo ""

# Execute the passed command
exec "$@"
