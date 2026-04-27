#!/usr/bin/env bash
# Bring up the nested-mux topology: msg-router → mux-server → OpenClaw.
#
# This is the migration rehearsal stack (Stage A). It provisions msg-router
# at runtime (mints a mux-super tenant + bot token) before bringing up
# mux-server, because mux-server's TG bot token in this topology is one
# that only exists after msg-router is alive.
#
# Real TG/Discord bot tokens (the upstream-provider credentials) come from
# `.env.local` or `.env.test`; msg-router uses them to talk to api.telegram.org
# and discord.com. mux-server only sees the msg-router-minted tokens —
# never the real ones.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${STACK_DIR}/../.." && pwd)"
COMPOSE_BASE="${STACK_DIR}/docker-compose.yml"
COMPOSE_NESTED="${STACK_DIR}/docker-compose.nested.yml"
TEMPLATE_PATH="${REPO_ROOT}/phala-deploy/openclaw.template.json"
RENDERER_PATH="${REPO_ROOT}/phala-deploy/render-openclaw-config.mjs"
MUX_BASE_INTERNAL="http://mux-server:18891"
OPENCLAW_INBOUND_INTERNAL="http://openclaw:18789/v1/mux/inbound"

: "${HOST_MUX_PORT:=18891}"
: "${HOST_OPENCLAW_PORT:=18789}"
: "${HOST_MSG_ROUTER_PORT:=18890}"
: "${MUX_REGISTER_KEY:=local-mux-e2e-register-key}"
: "${MASTER_KEY:=local-mux-e2e-master-key}"
: "${MSG_ROUTER_ADMIN_TOKEN:=local-msg-router-admin-token}"
: "${MODEL_PRIMARY:=}"

if ! command -v docker >/dev/null 2>&1; then
  echo "[up-nested] docker is required." >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "[up-nested] jq is required." >&2
  exit 1
fi

# Source env files (stack-local, repo-root, and ~/tmp/claw/.env.test
# which holds the real bot tokens — see LOCAL_CONFIG.md).
for envfile in "${STACK_DIR}/.env.local" "${REPO_ROOT}/.env.local" "${HOME}/tmp/claw/.env.test"; do
  if [[ -f "${envfile}" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${envfile}"
    set +a
  fi
done

if [[ -z "${TELEGRAM_BOT_TOKEN:-}" ]]; then
  echo "[up-nested] TELEGRAM_BOT_TOKEN missing (set it in .env.local or ~/tmp/claw/.env.test)." >&2
  exit 1
fi

# ──────────────────────────────────────────────────────────────────────
# Step 1: build + start msg-router only
# ──────────────────────────────────────────────────────────────────────
echo "[up-nested] starting msg-router..."
MSG_ROUTER_ADMIN_TOKEN="${MSG_ROUTER_ADMIN_TOKEN}" \
  docker compose \
    -f "${COMPOSE_BASE}" \
    -f "${COMPOSE_NESTED}" \
    up -d --build --remove-orphans msg-router

echo "[up-nested] waiting for msg-router /health..."
MSG_ROUTER_URL="http://127.0.0.1:${HOST_MSG_ROUTER_PORT}"
for i in $(seq 1 60); do
  if curl -sf "${MSG_ROUTER_URL}/health" >/dev/null 2>&1; then
    break
  fi
  if [[ "${i}" == "60" ]]; then
    echo "[up-nested] msg-router did not become healthy" >&2
    docker compose -f "${COMPOSE_BASE}" -f "${COMPOSE_NESTED}" logs msg-router | tail -50 >&2
    exit 1
  fi
  sleep 1
done

# ──────────────────────────────────────────────────────────────────────
# Step 2: provision msg-router (TG only — Discord deferred to Stage B)
# ──────────────────────────────────────────────────────────────────────
ADMIN_HDR="x-admin-token: ${MSG_ROUTER_ADMIN_TOKEN}"
JSON_HDR="content-type: application/json"

# (Re)register the real TG bot as a provider. POST is idempotent on the
# msg-router side (duplicate provider_token returns the existing bot).
echo "[up-nested] registering TG bot with msg-router..."
TG_BOT_ID=$(curl -sf "${MSG_ROUTER_URL}/admin/bots" \
  -H "${ADMIN_HDR}" -H "${JSON_HDR}" \
  -d "$(jq -nc --arg t "${TELEGRAM_BOT_TOKEN}" '{channel:"telegram", providerToken:$t}')" \
  | jq -r '.id')
if [[ -z "${TG_BOT_ID}" || "${TG_BOT_ID}" == "null" ]]; then
  echo "[up-nested] failed to register TG bot" >&2
  exit 1
fi

# Mint the mux-super tenant + its TG bot token first — we need its id to
# wire it into the channel assignment as the super-tenant fallback so
# msg-router routes inbound for unbound chats to mux-server.
echo "[up-nested] minting mux-super tenant + TG bot token..."
TENANT_RES=$(curl -sf -X POST "${MSG_ROUTER_URL}/admin/tenants" -H "${ADMIN_HDR}")
MUX_SUPER_TENANT_ID=$(echo "${TENANT_RES}" | jq -r '.id')
MUX_SUPER_API_KEY=$(echo "${TENANT_RES}" | jq -r '.apiKey')

CRED_RES=$(curl -sf -X POST "${MSG_ROUTER_URL}/admin/tenants/${MUX_SUPER_TENANT_ID}/channels/telegram" \
  -H "${ADMIN_HDR}")
MUX_SUPER_TG_BOT_TOKEN=$(echo "${CRED_RES}" | jq -r '.botToken')

# Now wire the assignment with the mux-super tenant as the fallback.
# Inbound to any chat on this bot that isn't explicitly bound flows to
# mux-server (which sub-routes per-chat using its own bindings table).
curl -sf "${MSG_ROUTER_URL}/admin/channels/telegram/assignment" \
  -H "${ADMIN_HDR}" -H "${JSON_HDR}" \
  -d "$(jq -nc --arg id "${TG_BOT_ID}" --arg s "${MUX_SUPER_TENANT_ID}" \
        '{botId:$id, superTenantId:$s}')" >/dev/null
if [[ -z "${MUX_SUPER_TG_BOT_TOKEN}" || "${MUX_SUPER_TG_BOT_TOKEN}" == "null" ]]; then
  echo "[up-nested] failed to mint mux-super TG bot token" >&2
  echo "${CRED_RES}" >&2
  exit 1
fi

# Start msg-router's polling loop so inbound TG events get pulled.
curl -sf -X POST "${MSG_ROUTER_URL}/admin/polling/start" \
  -H "${ADMIN_HDR}" >/dev/null || true

echo "[up-nested] mux-super tenantId=${MUX_SUPER_TENANT_ID}"
echo "[up-nested] mux-super tg-token=${MUX_SUPER_TG_BOT_TOKEN:0:8}..."

# Persist provisioning state so e2e scripts and rehearsal steps can
# look it up later (binding flips, migration calls, etc.).
STATE_FILE="${STACK_DIR}/state/nested-provisioning.json"
mkdir -p "$(dirname "${STATE_FILE}")"
jq -nc \
  --arg tenant "${MUX_SUPER_TENANT_ID}" \
  --arg apikey "${MUX_SUPER_API_KEY}" \
  --arg tgtoken "${MUX_SUPER_TG_BOT_TOKEN}" \
  --arg msgrouter "${MSG_ROUTER_URL}" \
  --arg admin "${MSG_ROUTER_ADMIN_TOKEN}" \
  '{muxSuperTenantId:$tenant, muxSuperApiKey:$apikey, muxSuperTgBotToken:$tgtoken, msgRouterUrl:$msgrouter, msgRouterAdminToken:$admin}' \
  > "${STATE_FILE}"

# ──────────────────────────────────────────────────────────────────────
# Step 3: render OpenClaw config (same as up.sh)
# ──────────────────────────────────────────────────────────────────────
GATEWAY_AUTH_TOKEN=$(node -e "
  const c = require('crypto');
  const key = c.hkdfSync('sha256', process.argv[1], '', 'gateway-auth-token', 32);
  process.stdout.write(Buffer.from(key).toString('base64'));
" -- "$MASTER_KEY" | tr -d '/+=' | head -c 32)

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

# ──────────────────────────────────────────────────────────────────────
# Step 4: bring up mux-server + openclaw with the nested overlay.
# mux-server's TELEGRAM_BOT_TOKEN is the msg-router-minted one (env
# substitution into docker-compose.nested.yml).
# ──────────────────────────────────────────────────────────────────────
echo "[up-nested] starting mux-server + openclaw (nested topology)..."
export OPENCLAW_CONFIG_B64
export MUX_SUPER_TG_BOT_TOKEN
export MUX_SUPER_DISCORD_BOT_TOKEN="${MUX_SUPER_DISCORD_BOT_TOKEN:-}"

docker compose \
  -f "${COMPOSE_BASE}" \
  -f "${COMPOSE_NESTED}" \
  up -d --remove-orphans

echo "[up-nested] writing config into openclaw container..."
printf '%s' "$CONFIG_JSON" | docker exec -i openclaw-local-e2e sh -c 'cat > /root/.openclaw/openclaw.json'
docker restart openclaw-local-e2e

echo "[up-nested] waiting for openclaw mux endpoint..."
for i in $(seq 1 120); do
  if curl -so /dev/null "http://127.0.0.1:${HOST_OPENCLAW_PORT}/v1/mux/inbound" 2>/dev/null; then
    break
  fi
  sleep 2
done

echo "[up-nested] nested-mux stack is up"
echo "[up-nested]  - msg-router:  http://127.0.0.1:${HOST_MSG_ROUTER_PORT}"
echo "[up-nested]  - mux-server:  http://127.0.0.1:${HOST_MUX_PORT}"
echo "[up-nested]  - openclaw:    http://127.0.0.1:${HOST_OPENCLAW_PORT}"
echo "[up-nested] state:         ${STATE_FILE}"
echo "[up-nested] generate pairing token with: ${SCRIPT_DIR}/pair-token.sh telegram"
