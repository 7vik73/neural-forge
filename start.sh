#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if command -v node >/dev/null 2>&1; then
  exec node scripts/manage.mjs "${1:-start}"
fi
case "${1:-start}" in
  start|setup)
    docker run --rm -e "FORGE_HOST_ROOT=$PWD" -v "$PWD:/project" -w /project node:24.18.0-bookworm-slim node scripts/manage.mjs setup
    if [ "${1:-start}" = start ]; then
      if docker run --rm --network host -v "$PWD:/project:ro" -w /project node:24.18.0-bookworm-slim node scripts/ollama-check.mjs >/dev/null 2>&1; then
        echo host > .local/network-mode
        docker compose --profile app up -d --build --wait
      else
        echo bridge > .local/network-mode
        docker compose -f compose.yaml -f compose.bridge.yaml --profile app up -d --build --wait
      fi
      docker run --rm -v "$PWD:/project:ro" -w /project node:24.18.0-bookworm-slim node scripts/manage.mjs link
    fi
    ;;
  stop) docker compose --profile app stop ;;
  status) docker compose --profile app ps ;;
  diagnostics) docker compose --profile app logs --tail=30 api worker ;;
  *) echo "Use the app’s Settings for encrypted backups, or install Node.js 24 to use the extended command-line tools."; exit 1 ;;
esac
