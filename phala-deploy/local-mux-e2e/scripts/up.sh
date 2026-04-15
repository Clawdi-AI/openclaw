#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${STACK_DIR}/../.." && pwd)"
COMPOSE_FILE="${STACK_DIR}/docker-compose.yml"
TEMPLATE_PATH="${REPO_ROOT}/phala-deploy/openclaw.template.json"
RENDERER_PATH="${REPO_ROOT}/phala-deploy/render-openclaw-config.mjs"
MUX_BASE_INTERNAL="http://mux-server:18891"
OPENCLAW_INBOUND_INTERNAL="http://openclaw:18789/v1/mux/inbound"

: "${HOST_MUX_PORT:=18891}"
: "${HOST_OPENCLAW_PORT:=18789}"
: "${MUX_REGISTER_KEY:=local-mux-e2e-register-key}"
: "${MASTER_KEY:=local-mux-e2e-master-key}"
: "${MODEL_PRIMARY:=}"

if ! command -v docker >/dev/null 2>&1; then
  echo "[local-mux-e2e] docker is required." >&2
  exit 1
fi

if [[ -f "${STACK_DIR}/.env.local" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${STACK_DIR}/.env.local"
  set +a
fi

if [[ -f "${REPO_ROOT}/.env.local" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${REPO_ROOT}/.env.local"
  set +a
fi

"${SCRIPT_DIR}/prepare-whatsapp-auth.sh"

GATEWAY_AUTH_TOKEN=$(node -e "
  const c = require('crypto');
  const key = c.hkdfSync('sha256', process.argv[1], '', 'gateway-auth-token', 32);
  process.stdout.write(Buffer.from(key).toString('base64'));
" -- "$MASTER_KEY" | tr -d '/+=' | head -c 32)

# Static mock JWT: satisfies pi-ai's extractAccountId for codex oauth-shaped models.
CODEX_MOCK_JWT="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdF9zdWIyYXBpX3Byb3h5In0sImV4cCI6OTk5OTk5OTk5OX0.c3ViMmFwaQ"

CONFIG_JSON=$(
  RENDER_GATEWAY_AUTH_TOKEN="$GATEWAY_AUTH_TOKEN" \
  RENDER_MUX_BASE_URL="$MUX_BASE_INTERNAL" \
  RENDER_MUX_REGISTER_KEY="$MUX_REGISTER_KEY" \
  RENDER_MUX_INBOUND_URL="$OPENCLAW_INBOUND_INTERNAL" \
  RENDER_MODEL_PRIMARY="${MODEL_PRIMARY:-openai-codex/gpt-5.3-codex}" \
  RENDER_OPENAI_BASE_URL="${CODEX_API_ENDPOINT:-}" \
  RENDER_OPENAI_API_KEY="${CODEX_API_KEY:-}" \
  RENDER_OPENAI_HEADER_API_KEY="${CODEX_API_KEY:-}" \
  RENDER_CODEX_API_ENDPOINT="${CODEX_API_ENDPOINT:-}" \
  RENDER_CODEX_API_KEY="$CODEX_MOCK_JWT" \
  RENDER_CODEX_HEADER_API_KEY="${CODEX_API_KEY:-}" \
  node "$RENDERER_PATH" "$TEMPLATE_PATH"
)

OPENCLAW_CONFIG_B64=$(printf '%s' "$CONFIG_JSON" | base64 -w0)
export OPENCLAW_CONFIG_B64

if command -v rv-exec >/dev/null 2>&1; then
  rv-exec TELEGRAM_BOT_TOKEN DISCORD_BOT_TOKEN CODEX_API_KEY CODEX_API_ENDPOINT \
    -- docker compose -f "${COMPOSE_FILE}" up -d --build --remove-orphans
else
  if [[ -z "${TELEGRAM_BOT_TOKEN:-}" ]]; then
    echo "[local-mux-e2e] WARNING: TELEGRAM_BOT_TOKEN not set and rv-exec not found." >&2
    echo "[local-mux-e2e] Install rv-exec or export secrets manually." >&2
  fi
  docker compose -f "${COMPOSE_FILE}" up -d --build --remove-orphans
fi

echo "[local-mux-e2e] writing config into openclaw container..."
printf '%s' "$CONFIG_JSON" | docker exec -i openclaw-local-e2e sh -c 'cat > /root/.openclaw/openclaw.json'
docker restart openclaw-local-e2e

echo "[local-mux-e2e] waiting for gateway health..."
for i in $(seq 1 120); do
  if curl -so /dev/null "http://127.0.0.1:${HOST_OPENCLAW_PORT}/v1/mux/inbound" 2>/dev/null; then
    break
  fi
  sleep 2
done

echo "[local-mux-e2e] stack is up"
echo "[local-mux-e2e] generate pairing token with: ${SCRIPT_DIR}/pair-token.sh telegram"
