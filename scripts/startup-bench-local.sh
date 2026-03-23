#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-18789}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-180}"
RESULTS_TSV="${RESULTS_TSV:-$ROOT_DIR/.local/startup-results.tsv}"
DESCRIPTION="${DESCRIPTION:-baseline}"
CASE_ID="${CASE_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
EXTRA_ARGS="${EXTRA_ARGS:-}"
ENV_FILE="${ENV_FILE:-}"
WORKDIR="${WORKDIR:-$(mktemp -d "${TMPDIR:-/tmp}/openclaw-startup.XXXXXX")}"
STATE_DIR="${WORKDIR}/state"
HOME_DIR="${WORKDIR}/home"
CONFIG_FILE="${CONFIG_FILE:-${STATE_DIR}/openclaw.json}"
LOG_FILE="${WORKDIR}/gateway.log"
PID_FILE="${WORKDIR}/gateway.pid"
LISTEN_LINE=""
READY_TS=""

cleanup() {
  if [[ -f "$PID_FILE" ]]; then
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" >/dev/null 2>&1 || true
      wait "$pid" >/dev/null 2>&1 || true
    fi
  fi
}
trap cleanup EXIT

if [[ ! -f "$ROOT_DIR/openclaw.mjs" ]]; then
  echo "missing=openclaw.mjs root=$ROOT_DIR" >&2
  exit 1
fi

if [[ ! -f "$ROOT_DIR/dist/entry.js" && ! -f "$ROOT_DIR/dist/entry.mjs" ]]; then
  echo "missing=dist run='pnpm build:docker'" >&2
  exit 1
fi

mkdir -p "$STATE_DIR" "$HOME_DIR" "$(dirname "$RESULTS_TSV")"

if [[ ! -f "$CONFIG_FILE" ]]; then
  cat >"$CONFIG_FILE" <<EOF
{
  "gateway": {
    "mode": "local",
    "auth": {
      "mode": "token",
      "token": "benchmark-token"
    },
    "controlUi": {
      "allowedOrigins": [
        "http://127.0.0.1:${PORT}",
        "http://localhost:${PORT}"
      ]
    }
  },
  "update": {
    "checkOnStart": false
  }
}
EOF
fi

if [[ ! -f "$RESULTS_TSV" ]]; then
  printf 'case_id\tstartup_seconds\tstatus\tdescription\tconfig_file\tenv_file\textra_args\tlog_file\n' >"$RESULTS_TSV"
fi

if [[ -n "$ENV_FILE" && ! -f "$ENV_FILE" ]]; then
  echo "missing=env_file path=$ENV_FILE" >&2
  exit 1
fi

START_TS="$(date +%s)"

(
  export HOME="$HOME_DIR"
  export OPENCLAW_HOME="$HOME_DIR"
  export OPENCLAW_STATE_DIR="$STATE_DIR"
  export OPENCLAW_CONFIG_PATH="$CONFIG_FILE"
  export OPENCLAW_PROFILE="startup-bench"
  export OPENCLAW_NO_RESPAWN="1"
  if [[ -n "$ENV_FILE" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
  fi
  cd "$ROOT_DIR"
  exec node ./openclaw.mjs gateway run --bind lan --port "$PORT" $EXTRA_ARGS >"$LOG_FILE" 2>&1
) &
GATEWAY_PID=$!
echo "$GATEWAY_PID" >"$PID_FILE"

SECONDS_WAITED=0
while [[ "$SECONDS_WAITED" -lt "$TIMEOUT_SECONDS" ]]; do
  if grep -q "\\[gateway\\] listening on ws://" "$LOG_FILE" 2>/dev/null; then
    LISTEN_LINE="$(grep -n "\\[gateway\\] listening on ws://" "$LOG_FILE" | head -n1)"
    break
  fi
  if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
    break
  fi
  sleep 1
  SECONDS_WAITED=$((SECONDS_WAITED + 1))
done

STATUS="ok"
if [[ -z "$LISTEN_LINE" ]]; then
  STATUS="missing_listen_log"
fi

if [[ "$STATUS" == "ok" ]]; then
  SECONDS_WAITED=0
  while [[ "$SECONDS_WAITED" -lt "$TIMEOUT_SECONDS" ]]; do
    if curl -sS "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
      READY_TS="$(date +%s)"
      break
    fi
    if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
      STATUS="process_exited_before_ready"
      break
    fi
    sleep 1
    SECONDS_WAITED=$((SECONDS_WAITED + 1))
  done
fi

if [[ "$STATUS" == "ok" && -z "$READY_TS" ]]; then
  STATUS="http_not_ready"
fi

STARTUP_SECONDS="0"
if [[ -n "$READY_TS" ]]; then
  STARTUP_SECONDS="$((READY_TS - START_TS))"
fi

printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
  "$CASE_ID" \
  "$STARTUP_SECONDS" \
  "$STATUS" \
  "$DESCRIPTION" \
  "$CONFIG_FILE" \
  "${ENV_FILE:-}" \
  "$EXTRA_ARGS" \
  "$LOG_FILE" >>"$RESULTS_TSV"

echo "case_id=$CASE_ID"
echo "status=$STATUS"
echo "startup_seconds=$STARTUP_SECONDS"
echo "config_file=$CONFIG_FILE"
echo "env_file=${ENV_FILE:-}"
echo "extra_args=$EXTRA_ARGS"
echo "log_file=$LOG_FILE"
if [[ -n "$LISTEN_LINE" ]]; then
  echo "listen_line=$LISTEN_LINE"
fi

if [[ "$STATUS" != "ok" ]]; then
  echo "--- gateway log ---"
  cat "$LOG_FILE"
  exit 1
fi
