#!/usr/bin/env bash
set -euo pipefail

# Generate OPENCLAW_CONFIG_B64 for CVM deployments.
#
# Renders openclaw.template.json with deployment-specific values derived
# from environment variables.
#
# Required env vars:
#   MASTER_KEY         — derives gateway auth token via HKDF-SHA256
#   MUX_BASE_URL       — external mux-server URL (e.g. https://<hash>-18891.dstack-prod.phala.network)
#   MUX_REGISTER_KEY   — shared key for mux registration
#   CODEX_API_ENDPOINT — sub2api endpoint for OpenAI Codex (e.g. https://sub2api.example.com/v1)
#   CODEX_API_KEY      — sub2api x-api-key for Codex proxy auth
#
# Optional env vars:
#   BRAVE_SEARCH_API_KEY — Brave Search API key (web search tool, omitted if unset)
#
# Output: prints OPENCLAW_CONFIG_B64 to stdout (base64, no line wrapping).

: "${MASTER_KEY:?MASTER_KEY is required}"
: "${MUX_BASE_URL:?MUX_BASE_URL is required}"
: "${MUX_REGISTER_KEY:?MUX_REGISTER_KEY is required}"
: "${CODEX_API_ENDPOINT:?CODEX_API_ENDPOINT is required}"
: "${CODEX_API_KEY:?CODEX_API_KEY is required}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="${SCRIPT_DIR}/openclaw.template.json"
RENDERER="${SCRIPT_DIR}/render-openclaw-config.mjs"
[[ -f "$TEMPLATE" ]] || { echo "ERROR: template not found: $TEMPLATE" >&2; exit 1; }
[[ -f "$RENDERER" ]] || { echo "ERROR: renderer not found: $RENDERER" >&2; exit 1; }

GATEWAY_PORT=18789
MODEL_PRIMARY="openai-codex/gpt-5.3-codex"

# --- Derive GATEWAY_AUTH_TOKEN from MASTER_KEY (same HKDF as entrypoint.sh) ---
GATEWAY_AUTH_TOKEN=$(node -e "
  const c = require('crypto');
  const key = c.hkdfSync('sha256', process.argv[1], '', 'gateway-auth-token', 32);
  process.stdout.write(Buffer.from(key).toString('base64'));
" "$MASTER_KEY" | tr -d '/+=' | head -c 32)

# inboundUrl uses ${DSTACK_APP_ID} / ${DSTACK_GATEWAY_DOMAIN} placeholders —
# resolved by the config loader's env-substitution (vars forwarded via docker-compose.yml)
INBOUND_URL="https://\${DSTACK_APP_ID}-${GATEWAY_PORT}.\${DSTACK_GATEWAY_DOMAIN}/v1/mux/inbound"

# Static mock JWT: satisfies pi-ai's extractAccountId (parses chatgpt_account_id
# from JWT payload). Sub2api ignores this — real auth is via x-api-key header.
# Payload: {"https://api.openai.com/auth":{"chatgpt_account_id":"acct_sub2api_proxy"},"exp":9999999999}
CODEX_MOCK_JWT="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdF9zdWIyYXBpX3Byb3h5In0sImV4cCI6OTk5OTk5OTk5OX0.c3ViMmFwaQ"

CONFIG_JSON=$(
  RENDER_GATEWAY_AUTH_TOKEN="$GATEWAY_AUTH_TOKEN" \
  RENDER_MUX_BASE_URL="$MUX_BASE_URL" \
  RENDER_MUX_REGISTER_KEY="$MUX_REGISTER_KEY" \
  RENDER_MUX_INBOUND_URL="$INBOUND_URL" \
  RENDER_MODEL_PRIMARY="$MODEL_PRIMARY" \
  RENDER_OPENAI_BASE_URL="$CODEX_API_ENDPOINT" \
  RENDER_OPENAI_API_KEY="$CODEX_API_KEY" \
  RENDER_OPENAI_HEADER_API_KEY="$CODEX_API_KEY" \
  RENDER_CODEX_API_ENDPOINT="$CODEX_API_ENDPOINT" \
  RENDER_CODEX_API_KEY="$CODEX_MOCK_JWT" \
  RENDER_CODEX_HEADER_API_KEY="$CODEX_API_KEY" \
  node "$RENDERER" "$TEMPLATE"
)

printf '%s' "$CONFIG_JSON" | base64 -w0
