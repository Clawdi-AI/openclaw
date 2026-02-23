#!/usr/bin/env bash
# Deploy mux-server to a Phala CVM and run smoke tests.
#
# Required args:
#   --mux-cvm <name>
#
# Required for smoke tests (default and --test-only):
#   --openclaw-cvm <name>
#
# Required env vars:
#   MUX_REGISTER_KEY MUX_ADMIN_TOKEN TELEGRAM_BOT_TOKEN DISCORD_BOT_TOKEN
# Accepted aliases:
#   TELEGRAM_BOT_TOKEN_PROD -> TELEGRAM_BOT_TOKEN
#   DISCORD_BOT_TOKEN_PROD  -> DISCORD_BOT_TOKEN
#
# Usage:
#   MUX_REGISTER_KEY=... MUX_ADMIN_TOKEN=... \
#     TELEGRAM_BOT_TOKEN=... DISCORD_BOT_TOKEN=... \
#     bash phala-deploy/deploy-mux.sh \
#       --openclaw-cvm openclaw-dev \
#       --mux-cvm openclaw-mux-dev
#
#   bash phala-deploy/deploy-mux.sh --openclaw-cvm openclaw-dev --mux-cvm openclaw-mux-dev --dry-run
#   bash phala-deploy/deploy-mux.sh --openclaw-cvm openclaw-dev --mux-cvm openclaw-mux-dev --skip-test
#   bash phala-deploy/deploy-mux.sh --openclaw-cvm openclaw-dev --mux-cvm openclaw-mux-dev --test-only
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DRY_RUN=0
SKIP_TEST=0
TEST_ONLY=0
HEALTH_TIMEOUT=120
HEALTH_INTERVAL=10
NEED_OPENCLAW=1

OPENCLAW_CVM=""
MUX_CVM=""
OPENCLAW_APP_ID=""
OPENCLAW_GATEWAY_DOMAIN=""
MUX_APP_ID=""
MUX_GATEWAY_DOMAIN=""

COMPOSE_FILE="${SCRIPT_DIR}/mux-server-compose.yml"
DEPLOY_ENV_FILE="/tmp/mux-phala-deploy.env"

# ── helpers ──────────────────────────────────────────────────────────────────

log()  { printf '\033[1;34m[deploy-mux]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[deploy-mux] ✓\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[deploy-mux] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

map_env_alias() {
  local canonical="$1"
  local alias="$2"
  if [[ -z "${!canonical:-}" && -n "${!alias:-}" ]]; then
    printf -v "$canonical" '%s' "${!alias}"
    export "$canonical"
  fi
}

# Execute a shell command inside the OpenClaw container.
exec_in_openclaw() {
  local cmd="$1"
  local escaped
  escaped=${cmd//\'/\'\"\'\"\'}
  phala ssh "$OPENCLAW_CVM" -- "docker exec openclaw sh -lc '$escaped'"
}

# ── parse args ───────────────────────────────────────────────────────────────

while [[ $# -gt 0 ]]; do
  case "$1" in
    --openclaw-cvm) OPENCLAW_CVM="${2:?}"; shift 2 ;;
    --mux-cvm)      MUX_CVM="${2:?}"; shift 2 ;;
    --dry-run)      DRY_RUN=1; shift ;;
    --skip-test)    SKIP_TEST=1; shift ;;
    --test-only)    TEST_ONLY=1; shift ;;
    --timeout)      HEALTH_TIMEOUT="${2:?}"; shift 2 ;;
    -h|--help)
      sed -n '2,/^[^#]/{ /^#/s/^# \?//p }' "$0"
      exit 0
      ;;
    --) shift; break ;;
    -*) die "unknown argument: $1" ;;
    *) break ;;
  esac
done

[[ $# -eq 0 ]] || die "unexpected positional args: $*"
[[ -n "$MUX_CVM" ]] || die "missing required arg: --mux-cvm <name>"

if [[ "$TEST_ONLY" -eq 1 || "$SKIP_TEST" -eq 0 ]]; then
  NEED_OPENCLAW=1
else
  NEED_OPENCLAW=0
fi

if [[ "$NEED_OPENCLAW" -eq 1 && -z "$OPENCLAW_CVM" ]]; then
  die "missing required arg: --openclaw-cvm <name> (required when running smoke tests)"
fi

require_cmd phala
require_cmd curl
require_cmd node

# Normalize optional aliases so callers can pass either naming style.
map_env_alias TELEGRAM_BOT_TOKEN TELEGRAM_BOT_TOKEN_PROD
map_env_alias DISCORD_BOT_TOKEN DISCORD_BOT_TOKEN_PROD

# ── resolve gateway domain ───────────────────────────────────────────────────

resolve_cvm_info() {
  phala cvms get "$1" --json 2>/dev/null | node -e '
    let d = ""; process.stdin.on("data", c => d += c);
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(d);
        const appId = j.app_id || "";
        const baseDomain = j.gateway?.base_domain || "";
        if (!appId || !baseDomain) process.exit(1);
        process.stdout.write(`${appId}|${baseDomain}`);
      }
      catch { process.exit(1); }
    });'
}

log "Resolving CVM endpoints..."
IFS='|' read -r MUX_APP_ID MUX_GATEWAY_DOMAIN <<<"$(resolve_cvm_info "$MUX_CVM")" \
  || die "failed to resolve app_id/gateway for CVM ${MUX_CVM}"
[[ -n "$MUX_APP_ID" && -n "$MUX_GATEWAY_DOMAIN" ]] \
  || die "empty app_id/gateway for CVM ${MUX_CVM}"
ok "Mux endpoint: ${MUX_APP_ID}.${MUX_GATEWAY_DOMAIN}"

if [[ "$NEED_OPENCLAW" -eq 1 ]]; then
  IFS='|' read -r OPENCLAW_APP_ID OPENCLAW_GATEWAY_DOMAIN <<<"$(resolve_cvm_info "$OPENCLAW_CVM")" \
    || die "failed to resolve app_id/gateway for CVM ${OPENCLAW_CVM}"
  [[ -n "$OPENCLAW_APP_ID" && -n "$OPENCLAW_GATEWAY_DOMAIN" ]] \
    || die "empty app_id/gateway for CVM ${OPENCLAW_CVM}"
  ok "OpenClaw endpoint: ${OPENCLAW_APP_ID}.${OPENCLAW_GATEWAY_DOMAIN}"
fi

MUX_HEALTH_URL="https://${MUX_APP_ID}-18891.${MUX_GATEWAY_DOMAIN}/health"
MUX_BASE_URL="https://${MUX_APP_ID}-18891.${MUX_GATEWAY_DOMAIN}"

# ── preflight: validate secrets ──────────────────────────────────────────────

preflight_secrets() {
  log "Preflight: checking env vars..."
  local missing=()
  for key in MUX_REGISTER_KEY MUX_ADMIN_TOKEN TELEGRAM_BOT_TOKEN DISCORD_BOT_TOKEN; do
    if [[ -z "${!key:-}" ]]; then
      missing+=("$key")
    fi
  done

  if [[ ${#missing[@]} -gt 0 ]]; then
    die "missing required env vars: ${missing[*]}"
  fi
  ok "All required env vars are present"
}

# ── deploy ───────────────────────────────────────────────────────────────────

deploy() {
  log "Deploying mux-server (CVM: ${MUX_CVM})..."

  [[ -f "$COMPOSE_FILE" ]] || die "compose file not found: $COMPOSE_FILE"

  cat > "$DEPLOY_ENV_FILE" <<EOF_ENV
MUX_REGISTER_KEY=${MUX_REGISTER_KEY}
MUX_ADMIN_TOKEN=${MUX_ADMIN_TOKEN}
TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN}
EOF_ENV
  chmod 600 "$DEPLOY_ENV_FILE"

  if (( DRY_RUN )); then
    log "[dry-run] phala deploy --cvm-id $MUX_CVM -c $COMPOSE_FILE -e $DEPLOY_ENV_FILE"
    return 0
  fi

  phala deploy --cvm-id "$MUX_CVM" -c "$COMPOSE_FILE" -e "$DEPLOY_ENV_FILE"
}

# ── wait for health ──────────────────────────────────────────────────────────

wait_for_mux_health() {
  log "Waiting for mux-server health (${MUX_HEALTH_URL})..."
  local elapsed=0
  while [[ $elapsed -lt $HEALTH_TIMEOUT ]]; do
    if curl -fsS --max-time 5 "$MUX_HEALTH_URL" >/dev/null 2>&1; then
      ok "mux-server healthy"
      return 0
    fi
    sleep "$HEALTH_INTERVAL"
    elapsed=$((elapsed + HEALTH_INTERVAL))
  done
  die "mux-server not healthy after ${HEALTH_TIMEOUT}s"
}

# ── smoke test ───────────────────────────────────────────────────────────────

smoke_test() {
  log "Running smoke tests..."

  # 1. mux-server /health
  log "  mux-server /health..."
  local mux_body
  mux_body="$(curl -fsS --max-time 10 "$MUX_HEALTH_URL" 2>&1)" \
    || die "mux-server /health request failed"
  [[ "$mux_body" == *'"ok":true'* ]] || die "mux-server /health failed: ${mux_body}"
  ok "  mux-server /health -> ok"

  # 2. mux registration probe (needs openclaw CVM to read device ID)
  log "  mux registration probe..."

  local device_id
  device_id="$(exec_in_openclaw 'node -e "
    const fs = require(\"fs\");
    try {
      const d = JSON.parse(fs.readFileSync(\"/root/.openclaw/identity/device.json\", \"utf8\"));
      process.stdout.write(d.deviceId);
    } catch { process.exit(1); }
  "' 2>/dev/null)" || die "could not read device ID from openclaw CVM"
  [[ -n "$device_id" ]] || die "device ID is empty"

  local register_url="${MUX_BASE_URL}/v1/instances/register"
  local inbound_url="https://${OPENCLAW_APP_ID}-18789.${OPENCLAW_GATEWAY_DOMAIN}/v1/mux/inbound"
  local register_code
  register_code="$(curl -o /dev/null -sS -w "%{http_code}" --max-time 10 \
    "$register_url" \
    -X POST \
    -H "Authorization: Bearer ${MUX_REGISTER_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"openclawId\":\"${device_id}\",\"inboundUrl\":\"${inbound_url}\"}" 2>/dev/null)" \
    || die "mux registration request failed"
  [[ "$register_code" == "200" ]] || die "mux registration failed: HTTP ${register_code}"
  ok "  mux registration: device ${device_id:0:12}... registered (HTTP 200)"
  ok "All smoke tests passed"
}

# ── main ─────────────────────────────────────────────────────────────────────

if [[ "$TEST_ONLY" -eq 1 ]]; then
  smoke_test
  exit 0
fi

preflight_secrets
deploy

if [[ "$DRY_RUN" -eq 1 ]]; then
  log "Dry-run complete."
  exit 0
fi

log "CVM updated. Waiting for mux-server..."
wait_for_mux_health

if [[ "$SKIP_TEST" -eq 0 ]]; then
  smoke_test
fi

log "Deploy complete."
