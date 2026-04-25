#!/bin/sh
# Credentials are now mounted directly RO from host (host service refreshes them).
# This entrypoint just drops privileges to appuser.
set -e
exec su-exec appuser "$@"
