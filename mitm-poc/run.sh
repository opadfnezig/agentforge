#!/usr/bin/env bash
# Run a single Claude Code invocation through the mitmproxy with capture addon.
#
# Usage:  RUN_TAG=baseline_low EFFORT=low BUDGET_OVERRIDE= ./run.sh
#         RUN_TAG=override_4k_low EFFORT=low BUDGET_OVERRIDE=4096 ./run.sh
#
# Requires:
#   - mitm-poc/.venv with mitmproxy installed
#   - ~/.mitmproxy/mitmproxy-ca-cert.pem (auto-generated on first run)
#   - /tmp/claudehome/.claude/.credentials.json copied from ~/.claude/

set -u
cd "$(dirname "$0")"

RUN_TAG="${RUN_TAG:?set RUN_TAG (e.g. baseline_low, override_4k_low)}"
EFFORT="${EFFORT:?set EFFORT (low|medium|high|xhigh|max)}"
BUDGET_OVERRIDE="${BUDGET_OVERRIDE:-}"
PROMPT_FILE="${PROMPT_FILE:-tasks/reasoning-prompt.txt}"
TIMEOUT_SEC="${TIMEOUT_SEC:-180}"
PROXY_PORT="${PROXY_PORT:-18080}"
OUT_DIR="samples/_runs/${RUN_TAG}"

mkdir -p "${OUT_DIR}"
LOG="${OUT_DIR}/_run.log"
RESULT_JSON="${OUT_DIR}/_claude_result.json"
MITM_LOG="${OUT_DIR}/_mitm.log"
DEBUG_LOG="${OUT_DIR}/_claude_debug.log"

echo "[run.sh] RUN_TAG=${RUN_TAG} EFFORT=${EFFORT} BUDGET_OVERRIDE='${BUDGET_OVERRIDE}'" | tee "${LOG}"
echo "[run.sh] Prompt file: ${PROMPT_FILE}" | tee -a "${LOG}"
echo "[run.sh] Out dir:     ${OUT_DIR}" | tee -a "${LOG}"

if [[ ! -f /tmp/claudehome/.claude/.credentials.json ]]; then
  mkdir -p /tmp/claudehome/.claude
  cp "$HOME/.claude/.credentials.json" /tmp/claudehome/.claude/.credentials.json
  chmod 600 /tmp/claudehome/.claude/.credentials.json
fi

# Start the proxy
RUN_TAG="${RUN_TAG}" OUT_DIR="${PWD}/${OUT_DIR}" \
  BUDGET_OVERRIDE="${BUDGET_OVERRIDE}" \
  EFFORT_OVERRIDE="${EFFORT_OVERRIDE:-}" \
  .venv/bin/mitmdump --listen-port "${PROXY_PORT}" -s addons/capture.py -q \
  > "${MITM_LOG}" 2>&1 &
PROXY_PID=$!
echo "[run.sh] mitmproxy PID=${PROXY_PID}" | tee -a "${LOG}"

# Wait for proxy to bind
for _ in $(seq 1 20); do
  ss -ltn 2>/dev/null | grep -q ":${PROXY_PORT}" && break
  sleep 0.25
done

# Run claude
PROMPT=$(cat "${PROMPT_FILE}")
env -i PATH="$PATH" HOME=/tmp/claudehome \
    HTTPS_PROXY="http://127.0.0.1:${PROXY_PORT}" \
    HTTP_PROXY="http://127.0.0.1:${PROXY_PORT}" \
    NODE_EXTRA_CA_CERTS="$HOME/.mitmproxy/mitmproxy-ca-cert.pem" \
    timeout "${TIMEOUT_SEC}" \
    claude -p "${PROMPT}" \
      --model opus \
      --effort "${EFFORT}" \
      --output-format json \
      --debug --debug-file "${DEBUG_LOG}" \
  > "${RESULT_JSON}" 2>>"${LOG}"
CLAUDE_EXIT=$?
echo "[run.sh] claude exit=${CLAUDE_EXIT}" | tee -a "${LOG}"

# Tear down proxy
kill "${PROXY_PID}" 2>/dev/null
wait "${PROXY_PID}" 2>/dev/null

echo "[run.sh] done. Outputs in ${OUT_DIR}/" | tee -a "${LOG}"
exit ${CLAUDE_EXIT}
