#!/bin/sh
set -e

# Copy SSH keys from mounted location to agent's home with correct ownership/perms
if [ -d /mnt/ssh-src ]; then
  mkdir -p /home/agent/.ssh
  cp -aL /mnt/ssh-src/. /home/agent/.ssh/ 2>/dev/null || true
  chown -R agent:agent /home/agent/.ssh
  chmod 700 /home/agent/.ssh
  find /home/agent/.ssh -type f -exec chmod 600 {} \;
  # known_hosts and authorized_keys can be 644
  [ -f /home/agent/.ssh/known_hosts ] && chmod 644 /home/agent/.ssh/known_hosts
  [ -f /home/agent/.ssh/authorized_keys ] && chmod 644 /home/agent/.ssh/authorized_keys

  # Ensure github.com is in known_hosts (for fresh environments)
  if ! grep -q "github.com" /home/agent/.ssh/known_hosts 2>/dev/null; then
    ssh-keyscan -t rsa,ed25519 github.com >> /home/agent/.ssh/known_hosts 2>/dev/null || true
    chown agent:agent /home/agent/.ssh/known_hosts
    chmod 644 /home/agent/.ssh/known_hosts
  fi
fi

# Configure git identity (required for commits)
runuser -u agent -- git config --global user.email "developer@agentforge.local"
runuser -u agent -- git config --global user.name "AgentForge Developer"
runuser -u agent -- git config --global --add safe.directory /workspace

# Fix ownership on the persistent claude memory/session mount. The
# spawner creates these dirs as uid 10001 on the host, but the agent
# user inside the container is uid 1000 — without this, claude can't
# write its memory files or session JSONLs. Scope the chown to
# /projects so it doesn't hit the read-only credentials.json mount.
mkdir -p /home/agent/.claude/projects/-workspace/memory
chown -R agent:agent /home/agent/.claude/projects 2>/dev/null || true

exec runuser -u agent -- "$@"
