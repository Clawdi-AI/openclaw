#!/usr/bin/env bash
set -euo pipefail

MUX_CVM_ID="${PHALA_MUX_CVM_ID:-}"
OPENCLAW_CVM_ID="${PHALA_OPENCLAW_CVM_ID:-}"
MUX_BASE_URL="${PHALA_MUX_BASE_URL:-}"
OPENCLAW_INBOUND_URL="${PHALA_OPENCLAW_INBOUND_URL:-}"
INBOUND_TIMEOUT_MS="${PHALA_MUX_INBOUND_TIMEOUT_MS:-15000}"
DRY_RUN=0

log() {
  printf '[set-inbound-target] %s\n' "$*"
}

die() {
  printf '[set-inbound-target] ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<USAGE
Usage:
  $(basename "$0") [options]

Options:
  --mux-cvm-id <uuid>            mux CVM UUID (used to derive mux base URL)
  --openclaw-cvm-id <uuid>       OpenClaw CVM UUID (used to derive inbound URL)
  --mux-base-url <url>           mux base URL override (example: https://<app>-18891.<gateway>)
  --openclaw-inbound-url <url>   OpenClaw inbound URL override (example: https://<app>-18789.<gateway>/v1/mux/inbound)
  --timeout-ms <ms>              inbound timeout in milliseconds (default: 15000)
  --dry-run                      Print commands without executing
  -h, --help                     Show this help

Environment:
  PHALA_MUX_CVM_ID
  PHALA_OPENCLAW_CVM_ID
  PHALA_MUX_BASE_URL
  PHALA_OPENCLAW_INBOUND_URL
  PHALA_MUX_INBOUND_TIMEOUT_MS

Notes:
  - Uses rv-exec with MUX_API_KEY.
  - Ensures inbound target wiring for the tenant identified by MUX_API_KEY.
  - Does not call admin tenant bootstrap by default.
  - If `PHALA_MUX_CVM_IDS` / `PHALA_OPENCLAW_CVM_IDS` are set, they must contain exactly one ID each.
USAGE
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

split_csv() {
  local raw="$1"
  local IFS=','
  read -r -a items <<<"$raw"
  for item in "${items[@]}"; do
    item="${item#${item%%[![:space:]]*}}"
    item="${item%${item##*[![:space:]]}}"
    [[ -n "$item" ]] && printf '%s\n' "$item"
  done
}

resolve_single_csv_id() {
  local raw="$1"
  local flag_name="$2"
  local var_name="$3"
  mapfile -t ids < <(split_csv "$raw")
  if [[ ${#ids[@]} -eq 1 ]]; then
    printf '%s' "${ids[0]}"
    return 0
  fi
  if [[ ${#ids[@]} -gt 1 ]]; then
    die "${var_name} has multiple IDs; pass ${flag_name} explicitly"
  fi
  printf '%s' ""
}

resolve_mux_base_url() {
  local cvm_id="$1"
  phala cvms get "$cvm_id" --json | node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const parsed = JSON.parse(input);
      const appId = typeof parsed.app_id === "string" ? parsed.app_id : "";
      const baseDomain =
        parsed && parsed.gateway && typeof parsed.gateway.base_domain === "string"
          ? parsed.gateway.base_domain
          : "";
      if (!appId || !baseDomain) {
        process.exit(2);
      }
      process.stdout.write(`https://${appId}-18891.${baseDomain}`);
    });
  '
}

resolve_openclaw_inbound_url() {
  local cvm_id="$1"
  phala cvms get "$cvm_id" --json | node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const parsed = JSON.parse(input);
      const appId = typeof parsed.app_id === "string" ? parsed.app_id : "";
      const baseDomain =
        parsed && parsed.gateway && typeof parsed.gateway.base_domain === "string"
          ? parsed.gateway.base_domain
          : "";
      if (!appId || !baseDomain) {
        process.exit(2);
      }
      process.stdout.write(`https://${appId}-18789.${baseDomain}/v1/mux/inbound`);
    });
  '
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mux-cvm-id)
      MUX_CVM_ID="${2:-}"
      shift 2
      ;;
    --openclaw-cvm-id)
      OPENCLAW_CVM_ID="${2:-}"
      shift 2
      ;;
    --mux-base-url)
      MUX_BASE_URL="${2:-}"
      shift 2
      ;;
    --openclaw-inbound-url)
      OPENCLAW_INBOUND_URL="${2:-}"
      shift 2
      ;;
    --timeout-ms)
      INBOUND_TIMEOUT_MS="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ "$INBOUND_TIMEOUT_MS" =~ ^[0-9]+$ ]] || die "timeout must be a positive integer"

if [[ -z "$MUX_CVM_ID" && -n "${PHALA_MUX_CVM_IDS:-}" ]]; then
  MUX_CVM_ID="$(resolve_single_csv_id "$PHALA_MUX_CVM_IDS" "--mux-cvm-id" "PHALA_MUX_CVM_IDS")"
fi

if [[ -z "$OPENCLAW_CVM_ID" && -n "${PHALA_OPENCLAW_CVM_IDS:-}" ]]; then
  OPENCLAW_CVM_ID="$(
    resolve_single_csv_id "$PHALA_OPENCLAW_CVM_IDS" "--openclaw-cvm-id" "PHALA_OPENCLAW_CVM_IDS"
  )"
fi

require_cmd rv-exec
require_cmd curl
require_cmd node

if [[ -z "$MUX_BASE_URL" ]]; then
  require_cmd phala
  [[ -n "$MUX_CVM_ID" ]] || die "provide --mux-base-url or --mux-cvm-id"
  MUX_BASE_URL="$(resolve_mux_base_url "$MUX_CVM_ID")"
fi

if [[ -z "$OPENCLAW_INBOUND_URL" ]]; then
  require_cmd phala
  [[ -n "$OPENCLAW_CVM_ID" ]] || die "provide --openclaw-inbound-url or --openclaw-cvm-id"
  OPENCLAW_INBOUND_URL="$(resolve_openclaw_inbound_url "$OPENCLAW_CVM_ID")"
fi

log "mux base URL: $MUX_BASE_URL"
log "openclaw inbound URL: $OPENCLAW_INBOUND_URL"
log "timeout: ${INBOUND_TIMEOUT_MS}ms"

if [[ "$DRY_RUN" -eq 1 ]]; then
  printf '%s\n' "rv-exec MUX_API_KEY -- bash -lc '<POST/GET /v1/tenant/inbound-target>'"
  exit 0
fi

MUX_BASE_URL="$MUX_BASE_URL" \
OPENCLAW_INBOUND_URL="$OPENCLAW_INBOUND_URL" \
INBOUND_TIMEOUT_MS="$INBOUND_TIMEOUT_MS" \
rv-exec MUX_API_KEY -- bash -lc '
  payload="$(printf "{\"inboundUrl\":\"%s\",\"inboundTimeoutMs\":%s}" "$OPENCLAW_INBOUND_URL" "$INBOUND_TIMEOUT_MS")"

  curl -fsS -X POST "$MUX_BASE_URL/v1/tenant/inbound-target" \
    -H "Authorization: Bearer $MUX_API_KEY" \
    -H "Content-Type: application/json" \
    --data "$payload"
  echo

  curl -fsS -H "Authorization: Bearer $MUX_API_KEY" \
    "$MUX_BASE_URL/v1/tenant/inbound-target"
  echo
'

log "tenant inbound target synchronized"
