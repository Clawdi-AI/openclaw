#!/usr/bin/env bash
set -euo pipefail

IMAGE="${1:-ghcr.io/clawdi-ai/openclaw-base:2026.3.13-phala.3}"
CONTAINER_NAME="${CONTAINER_NAME:-openclaw-startup-bench-$$}"
PORT="${PORT:-18789}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-180}"
WORKDIR="$(mktemp -d)"
LOG_FILE="${WORKDIR}/container.log"
STATE_DIR="${WORKDIR}/state"
CONFIG_FILE="${STATE_DIR}/openclaw.json"

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker run --rm \
    -v "${WORKDIR}:/work" \
    --entrypoint sh \
    "$IMAGE" \
    -c 'rm -rf /work/*' >/dev/null 2>&1 || true
  rmdir "$WORKDIR" >/dev/null 2>&1 || true
}
trap cleanup EXIT

mkdir -p "$STATE_DIR"

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

START_TS="$(date +%s)"

docker run -d \
  --name "$CONTAINER_NAME" \
  --entrypoint openclaw \
  -p "${PORT}:18789" \
  -v "${STATE_DIR}:/root/.openclaw" \
  "$IMAGE" \
  gateway run --bind lan --port 18789 --force >/dev/null

echo "container=$CONTAINER_NAME image=$IMAGE start_ts=$START_TS"

SECONDS_WAITED=0
READY_TS=""
while [ "$SECONDS_WAITED" -lt "$TIMEOUT_SECONDS" ]; do
  docker logs "$CONTAINER_NAME" >"$LOG_FILE" 2>&1 || true
  if grep -q "listening on ws://" "$LOG_FILE"; then
    LISTEN_TS_LINE="$(grep -n "listening on ws://" "$LOG_FILE" | head -n1)"
    break
  fi
  sleep 1
  SECONDS_WAITED=$((SECONDS_WAITED + 1))
done

if [ "${LISTEN_TS_LINE:-}" = "" ]; then
  echo "failed=missing_listen_log timeout=${TIMEOUT_SECONDS}s"
  cat "$LOG_FILE"
  exit 1
fi

SECONDS_WAITED=0
while [ "$SECONDS_WAITED" -lt "$TIMEOUT_SECONDS" ]; do
  if curl -fsS "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
    READY_TS="$(date +%s)"
    break
  fi
  sleep 1
  SECONDS_WAITED=$((SECONDS_WAITED + 1))
done

docker logs "$CONTAINER_NAME" >"$LOG_FILE" 2>&1 || true
echo "listen_line=$LISTEN_TS_LINE"

if [ "$READY_TS" = "" ]; then
  echo "failed=http_not_ready timeout=${TIMEOUT_SECONDS}s"
  cat "$LOG_FILE"
  exit 1
fi

echo "http_ready_ts=$READY_TS startup_seconds=$((READY_TS - START_TS))"
echo "--- container log ---"
cat "$LOG_FILE"
