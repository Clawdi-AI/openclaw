#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${STACK_DIR}/docker-compose.yml"

"${SCRIPT_DIR}/prepare-whatsapp-auth.sh"

if ! command -v docker >/dev/null 2>&1; then
  echo "[local-mux-e2e] docker is required." >&2
  exit 1
fi

if ! command -v rv-exec >/dev/null 2>&1; then
  echo "[local-mux-e2e] rv-exec is required for secret injection." >&2
  exit 1
fi

# Optional local overrides for non-secret values.
if [[ -f "${STACK_DIR}/.env.local" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${STACK_DIR}/.env.local"
  set +a
fi

rv-exec MUX_ADMIN_TOKEN TELEGRAM_BOT_TOKEN DISCORD_BOT_TOKEN REDPILL_API_KEY \
  -- docker compose -f "${COMPOSE_FILE}" up -d --build --remove-orphans

echo "[local-mux-e2e] stack is up"
echo "[local-mux-e2e] run ${SCRIPT_DIR}/bootstrap-tenant.sh next"
