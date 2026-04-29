#!/bin/sh
set -e

# Mirror developer entrypoint: oracle has no SSH/git needs, but we keep
# the user-drop pattern so claude memories land under agent's HOME and
# the pinned WORKDIR (/workspace) is owned by agent.
exec runuser -u agent -- "$@"
