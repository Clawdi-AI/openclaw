#!/usr/bin/env bash
# Deploy OpenClaw to a Phala CVM and run smoke tests.
#
# Required args:
#   --openclaw-cvm <name>
#   --mux-cvm <name>
#
# Required env vars:
#   MASTER_KEY REDPILL_API_KEY MUX_REGISTER_KEY
# Optional env vars (required only for S3 mode):
#   S3_BUCKET S3_ENDPOINT S3_PROVIDER S3_REGION
#   AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
# Optional env vars:
#   CODEX_API_ENDPOINT CODEX_API_KEY
#
# Usage:
#   MASTER_KEY=... REDPILL_API_KEY=... MUX_REGISTER_KEY=... \
#     S3_BUCKET=... S3_ENDPOINT=... S3_PROVIDER=... S3_REGION=... \
#     AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
#     bash phala-deploy/deploy-openclaw.sh \
#       --openclaw-cvm openclaw-dev \
#       --mux-cvm openclaw-mux-dev
#
#   bash phala-deploy/deploy-openclaw.sh --openclaw-cvm openclaw-dev --mux-cvm openclaw-mux-dev --dry-run
#   bash phala-deploy/deploy-openclaw.sh --openclaw-cvm openclaw-dev --mux-cvm openclaw-mux-dev --skip-test
#   bash phala-deploy/deploy-openclaw.sh --openclaw-cvm openclaw-dev --mux-cvm openclaw-mux-dev --test-only
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DRY_RUN=0
SKIP_TEST=0
TEST_ONLY=0
HEALTH_TIMEOUT=120
HEALTH_INTERVAL=10

OPENCLAW_CVM=""
MUX_CVM=""
OPENCLAW_APP_ID=""
OPENCLAW_GATEWAY_DOMAIN=""
MUX_APP_ID=""
MUX_GATEWAY_DOMAIN=""

COMPOSE_FILE="${SCRIPT_DIR}/docker-compose.yml"
DEPLOY_ENV_FILE="/tmp/openclaw-phala-deploy.env"
REQUIRED_SECRETS="MASTER_KEY REDPILL_API_KEY MUX_REGISTER_KEY"
S3_SECRETS="S3_BUCKET S3_ENDPOINT S3_PROVIDER S3_REGION AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY"

# ── helpers ──────────────────────────────────────────────────────────────────

log()  { printf '\033[1;34m[deploy-openclaw]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[deploy-openclaw] ✓\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[deploy-openclaw] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
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
[[ -n "$OPENCLAW_CVM" ]] || die "missing required arg: --openclaw-cvm <name>"
[[ -n "$MUX_CVM" ]] || die "missing required arg: --mux-cvm <name>"

require_cmd phala
require_cmd curl
require_cmd node

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
IFS='|' read -r OPENCLAW_APP_ID OPENCLAW_GATEWAY_DOMAIN <<<"$(resolve_cvm_info "$OPENCLAW_CVM")" \
  || die "failed to resolve app_id/gateway for CVM ${OPENCLAW_CVM}"
IFS='|' read -r MUX_APP_ID MUX_GATEWAY_DOMAIN <<<"$(resolve_cvm_info "$MUX_CVM")" \
  || die "failed to resolve app_id/gateway for CVM ${MUX_CVM}"
[[ -n "$OPENCLAW_APP_ID" && -n "$OPENCLAW_GATEWAY_DOMAIN" ]] \
  || die "empty app_id/gateway for CVM ${OPENCLAW_CVM}"
[[ -n "$MUX_APP_ID" && -n "$MUX_GATEWAY_DOMAIN" ]] \
  || die "empty app_id/gateway for CVM ${MUX_CVM}"
ok "OpenClaw endpoint: ${OPENCLAW_APP_ID}.${OPENCLAW_GATEWAY_DOMAIN}"
ok "Mux endpoint: ${MUX_APP_ID}.${MUX_GATEWAY_DOMAIN}"

MUX_BASE_URL="https://${MUX_APP_ID}-18891.${MUX_GATEWAY_DOMAIN}"

# ── preflight: validate secrets ──────────────────────────────────────────────

preflight_secrets() {
  log "Preflight: checking env vars..."
  local missing=()
  for key in $REQUIRED_SECRETS; do
    if [[ -z "${!key:-}" ]]; then
      missing+=("$key")
    fi
  done

  local s3_enabled=0
  for key in $S3_SECRETS; do
    if [[ -n "${!key:-}" ]]; then
      s3_enabled=1
      break
    fi
  done
  if [[ "$s3_enabled" -eq 1 ]]; then
    for key in $S3_SECRETS; do
      if [[ -z "${!key:-}" ]]; then
        missing+=("$key")
      fi
    done
  fi

  if [[ ${#missing[@]} -gt 0 ]]; then
    die "missing required env vars: ${missing[*]}"
  fi
  ok "All required env vars are present"
}

# ── generate openclaw config ─────────────────────────────────────────────────

generate_openclaw_config() {
  local env_file="$1"
  log "Generating OPENCLAW_CONFIG_B64..."

  local cfg
  cfg="$(MUX_BASE_URL="$MUX_BASE_URL" "$SCRIPT_DIR/gen-cvm-config.sh")" \
    || die "failed generating OPENCLAW_CONFIG_B64"
  printf 'OPENCLAW_CONFIG_B64=%s\n' "$cfg" >> "$env_file"
  ok "OPENCLAW_CONFIG_B64 appended to $env_file"
}

# ── deploy ───────────────────────────────────────────────────────────────────

deploy() {
  log "Deploying OpenClaw (CVM: ${OPENCLAW_CVM})..."

  [[ -f "$COMPOSE_FILE" ]] || die "compose file not found: $COMPOSE_FILE"

  : > "$DEPLOY_ENV_FILE"
  printf 'MASTER_KEY=%s\n' "$MASTER_KEY" >> "$DEPLOY_ENV_FILE"
  printf 'REDPILL_API_KEY=%s\n' "$REDPILL_API_KEY" >> "$DEPLOY_ENV_FILE"
  if [[ -n "${S3_BUCKET:-}" ]]; then
    printf 'S3_BUCKET=%s\n' "$S3_BUCKET" >> "$DEPLOY_ENV_FILE"
    printf 'S3_ENDPOINT=%s\n' "$S3_ENDPOINT" >> "$DEPLOY_ENV_FILE"
    printf 'S3_PROVIDER=%s\n' "$S3_PROVIDER" >> "$DEPLOY_ENV_FILE"
    printf 'S3_REGION=%s\n' "$S3_REGION" >> "$DEPLOY_ENV_FILE"
    printf 'AWS_ACCESS_KEY_ID=%s\n' "$AWS_ACCESS_KEY_ID" >> "$DEPLOY_ENV_FILE"
    printf 'AWS_SECRET_ACCESS_KEY=%s\n' "$AWS_SECRET_ACCESS_KEY" >> "$DEPLOY_ENV_FILE"
  fi
  chmod 600 "$DEPLOY_ENV_FILE"

  generate_openclaw_config "$DEPLOY_ENV_FILE"

  if (( DRY_RUN )); then
    log "[dry-run] phala deploy --cvm-id $OPENCLAW_CVM -c $COMPOSE_FILE -e $DEPLOY_ENV_FILE"
    return 0
  fi

  phala deploy --cvm-id "$OPENCLAW_CVM" -c "$COMPOSE_FILE" -e "$DEPLOY_ENV_FILE"
}

# ── wait for health ──────────────────────────────────────────────────────────

wait_for_openclaw() {
  log "Waiting for OpenClaw container on CVM ${OPENCLAW_CVM}..."
  local elapsed=0
  while [[ $elapsed -lt $HEALTH_TIMEOUT ]]; do
    if exec_in_openclaw 'true' >/dev/null 2>&1; then
      ok "OpenClaw container reachable"
      return 0
    fi
    sleep "$HEALTH_INTERVAL"
    elapsed=$((elapsed + HEALTH_INTERVAL))
  done
  die "OpenClaw container not reachable after ${HEALTH_TIMEOUT}s"
}

# ── smoke test ───────────────────────────────────────────────────────────────

smoke_test() {
  log "Running smoke tests..."

  # 1. openclaw --version
  log "  openclaw --version..."
  local version
  version="$(exec_in_openclaw 'openclaw --version' 2>/dev/null)" \
    || die "openclaw --version failed"
  [[ -n "$version" ]] || die "openclaw --version returned empty output"
  ok "  openclaw version: ${version}"

  # 2. openclaw channels status --probe (gateway reachable?)
  log "  openclaw channels status --probe..."
  local channels_output
  channels_output="$(exec_in_openclaw 'openclaw channels status --probe' 2>/dev/null)" \
    || die "openclaw channels status --probe failed"
  [[ "$channels_output" == *"Gateway reachable"* ]] \
    || die "gateway not reachable: $(printf '%s' "$channels_output" | head -n 1)"
  ok "  gateway reachable"

  # 3. mux config check (registerKey + inboundUrl present)
  log "  openclaw mux config..."
  local mux_config
  mux_config="$(exec_in_openclaw 'node -e "
    const fs = require(\"fs\");
    const cfg = JSON.parse(fs.readFileSync(\"/root/.openclaw/openclaw.json\", \"utf8\"));
    const m = cfg.gateway?.http?.endpoints?.mux || {};
    const ok = m.enabled && m.baseUrl && m.registerKey && m.inboundUrl;
    console.log(JSON.stringify({
      enabled: !!m.enabled,
      hasBaseUrl: !!m.baseUrl,
      hasRegisterKey: !!m.registerKey,
      hasInboundUrl: !!m.inboundUrl,
      ok: !!ok
    }));
  "' 2>/dev/null)" || die "failed to read mux config"
  [[ "$mux_config" == *'"ok":true'* ]] || die "mux config incomplete: ${mux_config}"
  ok "  mux config complete"

  # 4. mux registration probe
  log "  mux registration probe..."
  local device_id
  device_id="$(exec_in_openclaw 'node -e "
    const fs = require(\"fs\");
    try {
      const d = JSON.parse(fs.readFileSync(\"/root/.openclaw/identity/device.json\", \"utf8\"));
      process.stdout.write(d.deviceId);
    } catch { process.exit(1); }
  "' 2>/dev/null)" || die "could not read device ID"
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

log "CVM updated. Waiting for OpenClaw..."
wait_for_openclaw

if [[ "$SKIP_TEST" -eq 0 ]]; then
  smoke_test
fi

log "Deploy complete."
