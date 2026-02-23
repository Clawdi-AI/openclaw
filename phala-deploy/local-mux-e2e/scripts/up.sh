#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${STACK_DIR}/docker-compose.yml"
MUX_BASE_INTERNAL="http://mux-server:18891"
OPENCLAW_INBOUND_INTERNAL="http://openclaw:18789/v1/mux/inbound"
: "${MUX_REGISTER_KEY:=local-mux-e2e-register-key}"

if ! command -v docker >/dev/null 2>&1; then
  echo "[local-mux-e2e] docker is required." >&2
  exit 1
fi

# Optional local overrides for non-secret values.
if [[ -f "${STACK_DIR}/.env.local" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${STACK_DIR}/.env.local"
  set +a
fi

# Also source repo-root .env.local for secrets (CODEX_API_KEY, etc.)
REPO_ROOT="$(cd "${STACK_DIR}/../.." && pwd)"
if [[ -f "${REPO_ROOT}/.env.local" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${REPO_ROOT}/.env.local"
  set +a
fi

# Accept alias names while keeping canonical env names in compose/runtime.
if [[ -z "${TELEGRAM_BOT_TOKEN:-}" && -n "${TELEGRAM_BOT_TOKEN_E2E:-}" ]]; then
  export TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN_E2E}"
fi
if [[ -z "${DISCORD_BOT_TOKEN:-}" && -n "${DISCORD_BOT_TOKEN_E2E:-}" ]]; then
  export DISCORD_BOT_TOKEN="${DISCORD_BOT_TOKEN_E2E}"
fi

"${SCRIPT_DIR}/prepare-whatsapp-auth.sh"

# --- Derive GATEWAY_AUTH_TOKEN from MASTER_KEY (same HKDF as entrypoint.sh) ---
: "${MASTER_KEY:=local-mux-e2e-master-key}"

GATEWAY_AUTH_TOKEN=$(node -e "
  const c = require('crypto');
  const key = c.hkdfSync('sha256', process.argv[1], '', 'gateway-auth-token', 32);
  process.stdout.write(Buffer.from(key).toString('base64'));
" "$MASTER_KEY" | tr -d '/+=' | head -c 32)

# --- Model provider (optional — enables real LLM replies) ---
# When MODEL_PRIMARY is set, CODEX_API_KEY and CODEX_API_ENDPOINT must also be set.
: "${MODEL_PRIMARY:=}"

# Static mock JWT: satisfies pi-ai's extractAccountId (parses chatgpt_account_id
# from JWT payload). Sub2api ignores this — real auth is via x-api-key header.
# Payload: {"https://api.openai.com/auth":{"chatgpt_account_id":"acct_sub2api_proxy"},"exp":9999999999}
CODEX_MOCK_JWT="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdF9zdWIyYXBpX3Byb3h5In0sImV4cCI6OTk5OTk5OTk5OX0.c3ViMmFwaQ"

# --- Generate full openclaw config JSON ---
CONFIG_JSON=$(node -e "
  const cfg = {
    gateway: {
      mode: 'local',
      bind: 'lan',
      port: 18789,
      auth: { token: process.argv[1] },
      controlUi: { enabled: false },
      http: {
        endpoints: {
          mux: {
            enabled: true,
            baseUrl: process.argv[2],
            registerKey: process.argv[3],
            inboundUrl: process.argv[4],
          },
        },
      },
    },
    update: { checkOnStart: false },
    channels: {},
    plugins: { entries: {} },
    agents: { defaults: { workspace: '/root/.openclaw/workspace', maxConcurrent: 4 } },
  };
  for (const ch of ['telegram', 'discord', 'whatsapp']) {
    cfg.channels[ch] = {
      accounts: {
        default: { enabled: false },
        mux: { enabled: true, mux: { enabled: true, timeoutMs: 30000 } },
      },
    };
    cfg.plugins.entries[ch] = { enabled: true };
  }
  cfg.channels.telegram.reactionLevel = 'extensive';
  cfg.channels.telegram.actions = { sticker: true };

  const modelPrimary = process.argv[5] || '';
  const codexEndpoint = process.env.CODEX_API_ENDPOINT || '';
  const codexApiKey   = process.env.CODEX_API_KEY || '';
  const codexMockJwt  = process.argv[6] || '';
  if (modelPrimary && codexEndpoint && codexApiKey) {
    cfg.agents.defaults.model = { primary: modelPrimary };
    cfg.models = {
      providers: {
        'openai-codex': {
          baseUrl: codexEndpoint,
          apiKey: codexMockJwt,
          headers: { 'x-api-key': codexApiKey },
          models: [],
        },
      },
    };
  }

  process.stdout.write(JSON.stringify(cfg, null, 2));
" "$GATEWAY_AUTH_TOKEN" "$MUX_BASE_INTERNAL" "$MUX_REGISTER_KEY" "$OPENCLAW_INBOUND_INTERNAL" \
  "$MODEL_PRIMARY" "$CODEX_MOCK_JWT")

OPENCLAW_CONFIG_B64=$(printf '%s' "$CONFIG_JSON" | base64 -w0)
export OPENCLAW_CONFIG_B64

# --- Bring up the stack ---
if [[ -z "${TELEGRAM_BOT_TOKEN:-}" ]]; then
  echo "[local-mux-e2e] WARNING: TELEGRAM_BOT_TOKEN not set." >&2
fi
docker compose -f "${COMPOSE_FILE}" up -d --build --remove-orphans

# --- Force-update the config inside the running container ---
# The entrypoint only writes config on first boot (when the file doesn't exist).
# We always push the latest config so model/channel changes take effect.
echo "[local-mux-e2e] writing config into openclaw container..."
printf '%s' "$CONFIG_JSON" | docker exec -i openclaw-local-e2e sh -c 'cat > /root/.openclaw/openclaw.json'
docker restart openclaw-local-e2e

# --- Wait for gateway health ---
echo "[local-mux-e2e] waiting for gateway health..."
for i in $(seq 1 120); do
  if curl -so /dev/null http://127.0.0.1:18789/v1/mux/inbound 2>/dev/null; then
    break
  fi
  sleep 2
done

echo "[local-mux-e2e] stack is up"
echo "[local-mux-e2e] generate pairing token with: ${SCRIPT_DIR}/pair-token.sh telegram"
