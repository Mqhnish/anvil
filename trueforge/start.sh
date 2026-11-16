#!/usr/bin/env bash
# Start TrueForge in local mode for Anvil.
#
# Anvil hosts the workspace MCP server on 127.0.0.1 and TrueForge must be allowed to call it back:
# TrueForge's outbound SSRF guard blocks private addresses by default, so we allow-list the loopback host.
# Nothing else is changed; data stays in a local SQLite file (override with SQLITE_PATH).
set -euo pipefail
export OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]'
export PORT="${PORT:-8790}"
echo "Starting TrueForge on http://localhost:${PORT} (loopback allowed for MCP callbacks)…"
exec npx -y @truefoundry/trueforge@latest "$@"
