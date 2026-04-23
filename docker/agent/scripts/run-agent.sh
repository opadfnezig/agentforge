#!/bin/bash
# AgentForge Agent Runner Script
# Runs Claude Code with full permissions and streaming output

set -e

SERVICE_NAME="${SERVICE_NAME:-unknown}"
LOG_DIR="/logs"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
LOG_FILE="${LOG_DIR}/agent_${SERVICE_NAME}_${TIMESTAMP}.log"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}=============================================="
echo -e "AgentForge Agent: ${SERVICE_NAME}"
echo -e "==============================================${NC}"
echo ""

# Check prerequisites
if [ -z "$ANTHROPIC_API_KEY" ]; then
    echo -e "${RED}ERROR: ANTHROPIC_API_KEY not set${NC}"
    exit 1
fi

# Get prompt from file or argument
if [ -f "/prompts/task.md" ]; then
    TASK_PROMPT=$(cat /prompts/task.md)
    echo -e "${YELLOW}Task prompt loaded from /prompts/task.md${NC}"
elif [ -n "$1" ]; then
    TASK_PROMPT="$1"
    echo -e "${YELLOW}Task prompt from argument${NC}"
else
    echo -e "${RED}ERROR: No task prompt provided${NC}"
    echo "Either mount a task.md file to /prompts/task.md or pass prompt as argument"
    exit 1
fi

echo -e "${YELLOW}Log file: ${LOG_FILE}${NC}"
echo ""

# Ensure log directory exists
mkdir -p "$LOG_DIR"

# Run Claude Code
echo -e "${GREEN}Starting Claude Code...${NC}"
echo ""

claude \
    --dangerously-skip-permissions \
    --verbose \
    --print \
    --output-format stream-json \
    --max-turns 100 \
    "$TASK_PROMPT" \
    2>&1 | tee "$LOG_FILE"

EXIT_CODE=$?

echo ""
echo -e "${BLUE}=============================================="
if [ $EXIT_CODE -eq 0 ]; then
    echo -e "${GREEN}Agent completed successfully${NC}"

    # Create completion marker
    echo "Completed at $(date)" > /completion/completion.md
else
    echo -e "${RED}Agent exited with code: ${EXIT_CODE}${NC}"
fi
echo -e "Log saved to: ${LOG_FILE}"
echo -e "==============================================${NC}"

exit $EXIT_CODE
