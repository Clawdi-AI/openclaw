#!/usr/bin/env bash
# Issue a mux pairing token for a channel.
#
# Required args:
#   --openclaw-cvm <name>
#   --mux-cvm <name>
#
# Usage:
#   ./phala-deploy/mux-pair-token.sh \
#     --openclaw-cvm openclaw-dev \
#     --mux-cvm openclaw-mux-dev \
#     telegram
#
#   ./phala-deploy/mux-pair-token.sh \
#     --openclaw-cvm openclaw-dev \
#     --mux-cvm openclaw-mux-dev \
#     telegram agent:main:main
#
# Requires MUX_ADMIN_TOKEN in the environment.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

OPENCLAW_CVM=""
MUX_CVM=""
CHANNEL=""
SESSION_KEY=""
TTL_SEC="${TTL_SEC:-900}"
INBOUND_TIMEOUT_MS="${INBOUND_TIMEOUT_MS:-15000}"

die() {
  printf '\033[1;31m[mux-pair-token] ERROR:\033[0m %s\n' "$*" >&2
  exit 1
}

log() {
  printf '\033[1;34m[mux-pair-token]\033[0m %s\n' "$*"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

# ── parse args ───────────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --openclaw-cvm) OPENCLAW_CVM="${2:?}"; shift 2 ;;
    --mux-cvm)      MUX_CVM="${2:?}"; shift 2 ;;
    -h|--help)
      sed -n '2,/^[^#]/{ /^#/s/^# \?//p }' "$0"
      exit 0
      ;;
    --) shift; break ;;
    -*) die "unknown argument: $1" ;;
    *) break ;;
  esac
done

[[ -n "$OPENCLAW_CVM" ]] || die "missing required arg: --openclaw-cvm <name>"
[[ -n "$MUX_CVM" ]] || die "missing required arg: --mux-cvm <name>"

if [[ $# -lt 1 || $# -gt 2 ]]; then
  die "usage: mux-pair-token.sh --openclaw-cvm <name> --mux-cvm <name> <channel> [sessionKey]"
fi
CHANNEL="$1"
SESSION_KEY="${2:-}"

require_cmd curl
require_cmd jq
require_cmd phala

[[ -n "${MUX_ADMIN_TOKEN:-}" ]] || die "set MUX_ADMIN_TOKEN in the environment"

# ── resolve endpoints from CVM info ─────────────────────────────────────────

resolve_base_from_cvm() {
  local cvm_id="$1" port_suffix="$2"
  local json app_id base_domain
  json="$(phala cvms get "$cvm_id" --json 2>/dev/null)"
  app_id="$(printf '%s' "$json" | jq -r '.app_id // empty')"
  base_domain="$(printf '%s' "$json" | jq -r '.gateway.base_domain // empty')"
  [[ -n "$app_id" && -n "$base_domain" ]] || die "failed to resolve endpoint for CVM ${cvm_id}"
  printf 'https://%s-%s.%s' "$app_id" "$port_suffix" "$base_domain"
}

log "Resolving endpoints..."
MUX_BASE_URL="$(resolve_base_from_cvm "$MUX_CVM" "18891")"
OPENCLAW_INBOUND_URL="$(resolve_base_from_cvm "$OPENCLAW_CVM" "18789")/v1/mux/inbound"

# ── resolve device ID ───────────────────────────────────────────────────────

log "Reading device ID from CVM..."
OPENCLAW_ID="$(phala ssh "$OPENCLAW_CVM" -- \
  'docker exec openclaw cat /root/.openclaw/identity/device.json' 2>/dev/null \
  | jq -r '.deviceId // empty' | tr -d '[:space:]')" \
  || die "failed to read device ID from CVM"
[[ -n "$OPENCLAW_ID" ]] || die "device ID is empty"

log "Channel:      ${CHANNEL}"
log "OpenClaw ID:  ${OPENCLAW_ID:0:16}..."
log "Mux URL:      ${MUX_BASE_URL}"
log "Inbound URL:  ${OPENCLAW_INBOUND_URL}"

pair_payload="$(jq -nc \
  --arg openclawId "$OPENCLAW_ID" \
  --arg inboundUrl "$OPENCLAW_INBOUND_URL" \
  --argjson inboundTimeoutMs "$INBOUND_TIMEOUT_MS" \
  --arg channel "$CHANNEL" \
  --arg sessionKey "$SESSION_KEY" \
  --argjson ttlSec "$TTL_SEC" \
  '{openclawId:$openclawId,inboundUrl:$inboundUrl,inboundTimeoutMs:$inboundTimeoutMs,channel:$channel,ttlSec:$ttlSec}
   + (if $sessionKey == "" then {} else {sessionKey:$sessionKey} end)')"

pair_response="$(curl -fsS -X POST "${MUX_BASE_URL}/v1/admin/pairings/token" \
  -H "Authorization: Bearer ${MUX_ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "$pair_payload" 2>/dev/null)" || die "pairing token request failed"

echo ""
printf '%s\n' "$pair_response" | jq .

token="$(printf '%s' "$pair_response" | jq -r '.token // empty')"
start_cmd="$(printf '%s' "$pair_response" | jq -r '.startCommand // empty')"

echo ""
if [[ -n "$start_cmd" ]]; then
  log "Send to bot: ${start_cmd}"
elif [[ -n "$token" ]]; then
  log "Token: ${token}"
fi
