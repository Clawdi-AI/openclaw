#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${STACK_DIR}/docker-compose.yml"
STATE_DIR="${STACK_DIR}/state"
TENANT_STATE_FILE="${STATE_DIR}/tenant.env"

TENANT_ID="${1:-tenant-local-1}"
TENANT_API_KEY="${2:-$(openssl rand -hex 24)}"
MUX_BASE_INTERNAL="http://mux-server:18891"
MUX_BASE_EXTERNAL="${MUX_BASE_URL:-http://127.0.0.1:18891}"
OPENCLAW_INBOUND_INTERNAL="http://openclaw:18789/v1/mux/inbound"

mkdir -p "${STATE_DIR}"

# Keep compose env injection simple and explicit.
: "${MUX_ADMIN_TOKEN:=dummy}"
: "${TELEGRAM_BOT_TOKEN:=dummy}"
: "${DISCORD_BOT_TOKEN:=dummy}"
export MUX_ADMIN_TOKEN TELEGRAM_BOT_TOKEN DISCORD_BOT_TOKEN

compose() {
  docker compose -f "${COMPOSE_FILE}" "$@"
}

mux_admin_token="${MUX_ADMIN_TOKEN:-}"
if [[ -z "${mux_admin_token}" ]]; then
  if ! command -v rv-exec >/dev/null 2>&1; then
    echo "[local-mux-e2e] MUX_ADMIN_TOKEN is missing and rv-exec is unavailable." >&2
    exit 1
  fi
  mux_admin_token="$(
    rv-exec --no-mask MUX_ADMIN_TOKEN -- bash -lc 'printf %s "${MUX_ADMIN_TOKEN:-}"'
  )"
fi

if [[ -z "${mux_admin_token}" ]]; then
  echo "[local-mux-e2e] MUX_ADMIN_TOKEN is required." >&2
  exit 1
fi

compose exec -T openclaw node - "${TENANT_API_KEY}" "${MUX_BASE_INTERNAL}" <<'NODE'
const fs = require("fs");
const path = "/root/.openclaw/openclaw.json";
const tenantApiKey = process.argv[2];
const muxBaseUrl = process.argv[3];

if (!tenantApiKey || !muxBaseUrl) {
  throw new Error("tenantApiKey and muxBaseUrl are required");
}

const cfg = JSON.parse(fs.readFileSync(path, "utf8"));
cfg.gateway = cfg.gateway || {};
cfg.gateway.http = cfg.gateway.http || {};
cfg.gateway.http.endpoints = cfg.gateway.http.endpoints || {};
cfg.gateway.http.endpoints.mux = {
  enabled: true,
  baseUrl: muxBaseUrl,
  token: tenantApiKey,
};

cfg.channels = cfg.channels || {};
for (const channel of ["telegram", "discord", "whatsapp"]) {
  const channelCfg = (cfg.channels[channel] = cfg.channels[channel] || {});
  if ("enabled" in channelCfg) {
    delete channelCfg.enabled;
  }

  if (channelCfg.mux && typeof channelCfg.mux === "object") {
    delete channelCfg.mux.baseUrl;
    delete channelCfg.mux.apiKey;
  }

  channelCfg.accounts = channelCfg.accounts || {};
  channelCfg.accounts.default = channelCfg.accounts.default || {};
  channelCfg.accounts.default.enabled = false;
  channelCfg.accounts.mux = channelCfg.accounts.mux || {};
  channelCfg.accounts.mux.enabled = true;
  channelCfg.accounts.mux.mux = {
    ...(channelCfg.accounts.mux.mux && typeof channelCfg.accounts.mux.mux === "object"
      ? channelCfg.accounts.mux.mux
      : {}),
    enabled: true,
    timeoutMs: 30000,
  };
}

cfg.plugins = cfg.plugins || {};
cfg.plugins.entries = cfg.plugins.entries || {};
for (const channel of ["telegram", "discord", "whatsapp"]) {
  const entry = cfg.plugins.entries[channel] || {};
  cfg.plugins.entries[channel] = { ...entry, enabled: true };
}

fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
NODE

# Reload gateway with the new mux config.
compose restart openclaw >/dev/null
sleep 4

payload="$(jq -nc \
  --arg tenantId "${TENANT_ID}" \
  --arg name "${TENANT_ID}" \
  --arg apiKey "${TENANT_API_KEY}" \
  --arg inboundUrl "${OPENCLAW_INBOUND_INTERNAL}" \
  '{tenantId:$tenantId,name:$name,apiKey:$apiKey,inboundUrl:$inboundUrl,inboundTimeoutMs:15000}')"

response="$(curl -sS -X POST "${MUX_BASE_EXTERNAL}/v1/admin/tenants/bootstrap" \
  -H "Authorization: Bearer ${mux_admin_token}" \
  -H "Content-Type: application/json" \
  --data "${payload}")"

echo "${response}" | jq .
if [[ "$(echo "${response}" | jq -r '.ok // false')" != "true" ]]; then
  echo "[local-mux-e2e] tenant bootstrap failed." >&2
  exit 1
fi

cat > "${TENANT_STATE_FILE}" <<ENV
TENANT_ID=${TENANT_ID}
TENANT_API_KEY=${TENANT_API_KEY}
MUX_BASE_URL=${MUX_BASE_EXTERNAL}
ENV

echo "[local-mux-e2e] tenant bootstrapped: ${TENANT_ID}"
echo "[local-mux-e2e] tenant state: ${TENANT_STATE_FILE}"
echo "[local-mux-e2e] generate pairing token with: ${SCRIPT_DIR}/pair-token.sh telegram"
