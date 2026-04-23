#!/bin/sh
set -e

SRC_DIR=/mnt/claude-src
SRC_JSON=/mnt/claude-src.json
DST_DIR=/home/appuser/.claude
DST_JSON=/home/appuser/.claude.json

if [ -d "$SRC_DIR" ]; then
  rm -rf "$DST_DIR"
  mkdir -p "$DST_DIR"
  cp -aL "$SRC_DIR/." "$DST_DIR/" 2>/dev/null || true
  chown -R appuser:appuser "$DST_DIR"
  chmod -R u+rwX "$DST_DIR"
fi

if [ -f "$SRC_JSON" ]; then
  cp -aL "$SRC_JSON" "$DST_JSON"
  chown appuser:appuser "$DST_JSON"
  chmod u+rw "$DST_JSON"
fi

exec su-exec appuser "$@"
