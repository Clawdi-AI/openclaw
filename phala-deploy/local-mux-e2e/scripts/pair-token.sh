#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TENANT_STATE_FILE="${STACK_DIR}/state/tenant.env"

CHANNEL="${1:-}"
SESSION_KEY="${2:-}"
ROUTE_KEY="${3:-}"
TTL_SEC="${TTL_SEC:-900}"

if [[ -z "${CHANNEL}" ]]; then
  echo "usage: $0 <telegram|discord|whatsapp> [sessionKey] [routeKey]" >&2
  exit 1
fi

if [[ ! -f "${TENANT_STATE_FILE}" ]]; then
  echo "[local-mux-e2e] tenant state file not found: ${TENANT_STATE_FILE}" >&2
  echo "[local-mux-e2e] run bootstrap-tenant.sh first" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${TENANT_STATE_FILE}"
set +a

if [[ -z "${TENANT_API_KEY:-}" || -z "${MUX_BASE_URL:-}" ]]; then
  echo "[local-mux-e2e] tenant state file is missing TENANT_API_KEY or MUX_BASE_URL" >&2
  exit 1
fi

payload="$(jq -nc \
  --arg channel "${CHANNEL}" \
  --arg sessionKey "${SESSION_KEY}" \
  --arg routeKey "${ROUTE_KEY}" \
  --argjson ttlSec "${TTL_SEC}" \
  '{channel:$channel,ttlSec:$ttlSec}
   + (if $sessionKey == "" then {} else {sessionKey:$sessionKey} end)
   + (if $routeKey == "" then {} else {routeKey:$routeKey} end)')"

response="$(curl -sS -X POST "${MUX_BASE_URL}/v1/pairings/token" \
  -H "Authorization: Bearer ${TENANT_API_KEY}" \
  -H "Content-Type: application/json" \
  --data "${payload}")"

echo "${response}" | jq .

token="$(echo "${response}" | jq -r '.token // empty')"
if [[ -n "${token}" ]]; then
  echo "[local-mux-e2e] token: ${token}"
fi
