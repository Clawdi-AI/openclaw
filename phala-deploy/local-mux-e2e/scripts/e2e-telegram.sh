#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${STACK_DIR}/docker-compose.yml"
: "${MUX_ADMIN_TOKEN:=local-mux-e2e-admin-token}"
: "${MUX_BASE_URL:=http://127.0.0.1:18891}"
: "${POLL_TIMEOUT:=60}"
: "${LLM_TIMEOUT:=60}"

compose() {
  docker compose -f "${COMPOSE_FILE}" "$@"
}

# ---------- pre-checks ----------

for cmd in tgcli jq curl docker; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "[e2e] FATAL: $cmd is required but not found" >&2
    exit 1
  fi
done

# Source .env.local files so secrets don't need to be manually exported.
REPO_ROOT="$(cd "${STACK_DIR}/../.." && pwd)"
for envfile in "${STACK_DIR}/.env.local" "${REPO_ROOT}/.env.local"; do
  if [[ -f "${envfile}" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "${envfile}"
    set +a
  fi
done

# Accept alias name for local e2e token.
if [[ -z "${TELEGRAM_BOT_TOKEN:-}" && -n "${TELEGRAM_BOT_TOKEN_E2E:-}" ]]; then
  export TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN_E2E}"
fi

# Resolve TELEGRAM_BOT_TOKEN from mux-server container if not in env.
if [[ -z "${TELEGRAM_BOT_TOKEN:-}" ]]; then
  TELEGRAM_BOT_TOKEN="$(docker exec mux-server-local-e2e printenv TELEGRAM_BOT_TOKEN 2>/dev/null)" || true
fi
if [[ -z "${TELEGRAM_BOT_TOKEN:-}" ]]; then
  echo "[e2e] FATAL: TELEGRAM_BOT_TOKEN not set and not found in mux-server container" >&2
  exit 1
fi

# Derive bot chat ID from token (the part before ':' is the bot user ID,
# which is also the private chat ID for DMs with the bot).
: "${TELEGRAM_E2E_BOT_CHAT_ID:=${TELEGRAM_BOT_TOKEN%%:*}}"

if [[ -z "${MODEL_PRIMARY:-}" ]]; then
  echo "[e2e] FATAL: MODEL_PRIMARY not set — LLM is required for full round-trip tests" >&2
  exit 1
fi

BOT_CHAT_ID="${TELEGRAM_E2E_BOT_CHAT_ID}"

# Ensure tgcli knows about the bot chat (first-run requires sync).
echo "[e2e] syncing tgcli chat list..."
tgcli sync >/dev/null 2>&1 || true

# ---------- temp file cleanup ----------

TMPFILES=()
cleanup() {
  for f in "${TMPFILES[@]}"; do
    rm -f "$f"
  done
}
trap cleanup EXIT

# ---------- ensure stack is running ----------

if ! docker ps --format '{{.Names}}' | grep -q 'openclaw-local-e2e'; then
  echo "[e2e] openclaw-local-e2e not running — calling up.sh" >&2
  "${SCRIPT_DIR}/up.sh"
fi

if ! docker ps --format '{{.Names}}' | grep -q 'mux-server-local-e2e'; then
  echo "[e2e] mux-server-local-e2e not running — calling up.sh" >&2
  "${SCRIPT_DIR}/up.sh"
fi

echo "[e2e] stack is running"

# ---------- mux-server health check ----------

echo "[e2e] checking mux-server health..."
mux_health="$(curl -sS "${MUX_BASE_URL}/health" 2>&1)" || true
if echo "${mux_health}" | grep -q '"ok":true'; then
  echo "[e2e] mux-server health: OK"
else
  echo "[e2e] FATAL: mux-server health check failed: ${mux_health}" >&2
  exit 1
fi

# Verify openclaw can reach mux-server via docker network (file proxy depends on this).
cross_health="$(docker exec openclaw-local-e2e curl -s http://mux-server:18891/health 2>&1)" || true
if echo "${cross_health}" | grep -q '"ok":true'; then
  echo "[e2e] cross-container mux-server health: OK"
else
  echo "[e2e] FATAL: openclaw cannot reach mux-server (cross-container): ${cross_health}" >&2
  exit 1
fi

# ---------- helpers ----------

UUID="$(uuidgen | tr -d '-' | head -c 12)"

PASS=0
FAIL=0

pass() {
  echo "[e2e] PASS: $*"
  ((PASS++)) || true
}

fail() {
  echo "[e2e] FAIL: $*"
  ((FAIL++)) || true
}

# Line count in the mux-server structured log file (/data/mux-server.log
# inside the container).  Updated by fence() so that wait helpers only
# look at entries produced after the fence.
MUX_LOG="/data/mux-server.log"
FENCE_LINES="$(docker exec mux-server-local-e2e wc -l "${MUX_LOG}" 2>/dev/null | tr -dc '0-9')"
: "${FENCE_LINES:=0}"

# Return structured log lines added since the last fence.
mux_log_tail() {
  docker exec mux-server-local-e2e tail -n "+$(( FENCE_LINES + 1 ))" "${MUX_LOG}" 2>/dev/null || true
}

# Poll until the mux-server log shows "telegram_inbound_forwarded" since fence.
# Proves: tgcli → Telegram API → mux-server long-poll → HTTP POST to OpenClaw → 200.
# Writes elapsed seconds to stdout on success.  Returns 1 on timeout.
wait_for_inbound() {
  local timeout="${1:-$POLL_TIMEOUT}"
  local start
  start="$(date +%s)"
  while true; do
    local now elapsed
    now="$(date +%s)"
    elapsed=$(( now - start ))
    if (( elapsed >= timeout )); then
      return 1
    fi
    if mux_log_tail | grep -q '"telegram_inbound_forwarded"'; then
      echo "${elapsed}"
      return 0
    fi
    sleep 3
  done
}

# Poll until the mux-server log shows an outbound_request containing the
# given telegram method (e.g. "sendMessage", "setMessageReaction").
# Proves: OpenClaw AI → mux outbound → Telegram Bot API.
# Writes elapsed seconds to stdout on success.  Returns 1 on timeout.
wait_for_outbound_method() {
  local method="$1"
  local timeout="${2:-$LLM_TIMEOUT}"
  local start
  start="$(date +%s)"
  while true; do
    local now elapsed
    now="$(date +%s)"
    elapsed=$(( now - start ))
    if (( elapsed >= timeout )); then
      return 1
    fi
    # Single grep avoids pipefail + SIGPIPE issue with chained grep -q
    if mux_log_tail | grep -q "\"outbound_request\".*\"method\":\"${method}\""; then
      echo "${elapsed}"
      return 0
    fi
    sleep 3
  done
}

# Record current log line count so subsequent waits ignore earlier entries.
fence() {
  sleep 2
  FENCE_LINES="$(docker exec mux-server-local-e2e wc -l "${MUX_LOG}" 2>/dev/null | tr -dc '0-9')"
  : "${FENCE_LINES:=0}"
}

# Poll until a log line since the fence matches ALL given patterns.
# Each pattern is an extended grep regex; lines must match every pattern.
# Writes elapsed seconds to stdout on success.  Returns 1 on timeout.
wait_for_outbound_fields() {
  local timeout="$1"
  shift
  local patterns=("$@")
  local start
  start="$(date +%s)"
  while true; do
    local now elapsed
    now="$(date +%s)"
    elapsed=$(( now - start ))
    if (( elapsed >= timeout )); then
      return 1
    fi
    local matched
    matched="$(mux_log_tail)"
    for pattern in "${patterns[@]}"; do
      matched="$(echo "${matched}" | grep "${pattern}" 2>/dev/null || true)"
      if [[ -z "${matched}" ]]; then
        break
      fi
    done
    if [[ -n "${matched}" ]]; then
      echo "${elapsed}"
      return 0
    fi
    sleep 3
  done
}

# ---------- pairing (idempotent) ----------

echo "[e2e] pairing: issuing token for telegram"
pair_response="$("${SCRIPT_DIR}/pair-token.sh" telegram 2>&1)" || true
token="$(echo "${pair_response}" | grep -oP 'mpt_[A-Za-z0-9_-]+' | head -1)" || true

if [[ -z "${token}" ]]; then
  echo "[e2e] pairing: no token extracted (may already be paired), continuing" >&2
else
  echo "[e2e] pairing: sending /start ${token} to bot"
  tgcli send --to "${BOT_CHAT_ID}" --message "/start ${token}"
  sleep 5
  echo "[e2e] pairing: confirmed (token sent)"
fi

fence

# ==========================================================================
# Full round-trip tests
#
# Each test sends a message via tgcli → Telegram API and verifies both:
#   1. Inbound:  mux-server forwards to OpenClaw  (telegram_inbound_forwarded)
#   2. Outbound: OpenClaw AI replies via mux       (outbound_request + method)
# ==========================================================================

# ---------- test 1: text round-trip ----------

echo "[e2e] test 1: text round-trip"
tgcli send --to "${BOT_CHAT_ID}" --message "e2e-text-${UUID}. Reply with exactly: CONFIRMED_${UUID}"

if elapsed="$(wait_for_inbound "${POLL_TIMEOUT}")"; then
  pass "text inbound — forwarded in ${elapsed}s"
else
  fail "text inbound — no telegram_inbound_forwarded within ${POLL_TIMEOUT}s"
fi

if elapsed="$(wait_for_outbound_method "sendMessage" "${LLM_TIMEOUT}")"; then
  pass "text outbound — AI replied via sendMessage in ${elapsed}s"
else
  fail "text outbound — no sendMessage outbound within ${LLM_TIMEOUT}s"
fi

fence

# ---------- test 2: photo round-trip ----------

PHOTO="/tmp/e2e-test-${UUID}.png"
TMPFILES+=("$PHOTO")

# Generate a 50x50 solid-color test image. Filename intentionally omits the
# color so the AI cannot guess — it must actually see the image pixels.
if command -v convert >/dev/null 2>&1; then
  convert -size 50x50 xc:'#FF6600' "$PHOTO"
elif command -v magick >/dev/null 2>&1; then
  magick -size 50x50 xc:'#FF6600' "$PHOTO"
else
  # Fallback: use Python to generate a 50x50 orange PNG.
  python3 -c "
import struct, zlib
w, h = 50, 50
raw = b''
for _ in range(h):
    raw += b'\x00' + b'\xff\x66\x00' * w
compressed = zlib.compress(raw)
def chunk(ctype, data):
    c = ctype + data
    return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)
ihdr = struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)
with open('$PHOTO', 'wb') as f:
    f.write(b'\x89PNG\r\n\x1a\n')
    f.write(chunk(b'IHDR', ihdr))
    f.write(chunk(b'IDAT', compressed))
    f.write(chunk(b'IEND', b''))
"
fi

echo "[e2e] test 2: photo round-trip"
tgcli send --to "${BOT_CHAT_ID}" --photo "$PHOTO" --caption "e2e-photo-${UUID}. Describe what you see in this image. What color is it?"

if elapsed="$(wait_for_inbound "${POLL_TIMEOUT}")"; then
  pass "photo inbound — forwarded in ${elapsed}s"
else
  fail "photo inbound — no telegram_inbound_forwarded within ${POLL_TIMEOUT}s"
fi

if elapsed="$(wait_for_outbound_method "sendMessage" "${LLM_TIMEOUT}")"; then
  pass "photo outbound — AI replied via sendMessage in ${elapsed}s"
else
  fail "photo outbound — no sendMessage outbound within ${LLM_TIMEOUT}s"
fi

fence

# ---------- test 3: AI multi-action round-trip ----------
#
# This is the core e2e test.  One prompt asks the AI to exercise multiple
# Telegram actions, each of which must flow through the full mux outbound
# path:  OpenClaw → buildTelegramRaw* → sendViaMux → mux-server → Telegram API.

echo "[e2e] test 3: AI multi-action round-trip"

read -r -d '' PROMPT <<'PROMPT_EOF' || true
Please do all three of these things:

1. React to this message with a thumbs-up.
2. Reply with a message that includes the word "CONFIRMED" and briefly explain why you chose each action.
3. Download the PDF at https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf and send it to me as a document.
PROMPT_EOF

tgcli send --to "${BOT_CHAT_ID}" --message "${PROMPT}"

if elapsed="$(wait_for_inbound "${POLL_TIMEOUT}")"; then
  pass "multi-action inbound — forwarded in ${elapsed}s"
else
  fail "multi-action inbound — no telegram_inbound_forwarded within ${POLL_TIMEOUT}s"
fi

# Wait for each outbound method the AI should produce.
# Check sendMessage first, then sendDocument (slowest — involves download + upload),
# then setMessageReaction (should already be in the log by that point).

if elapsed="$(wait_for_outbound_method "sendMessage" "${LLM_TIMEOUT}")"; then
  pass "multi-action outbound sendMessage — AI text reply in ${elapsed}s"
else
  fail "multi-action outbound sendMessage — no sendMessage within ${LLM_TIMEOUT}s"
fi

# The AI sends a document via mediaUrl — this goes through sendDocument or sendPhoto.
if elapsed="$(wait_for_outbound_method "sendDocument" "${LLM_TIMEOUT}")"; then
  pass "multi-action outbound sendDocument — AI sent document in ${elapsed}s"
elif elapsed="$(wait_for_outbound_method "sendPhoto" "${LLM_TIMEOUT}")"; then
  pass "multi-action outbound sendPhoto — AI sent media in ${elapsed}s"
else
  fail "multi-action outbound send media — no sendDocument/sendPhoto within ${LLM_TIMEOUT}s"
fi

if elapsed="$(wait_for_outbound_method "setMessageReaction" "${LLM_TIMEOUT}")"; then
  pass "multi-action outbound setMessageReaction — AI reacted in ${elapsed}s"
else
  fail "multi-action outbound setMessageReaction — no reaction within ${LLM_TIMEOUT}s"
fi

fence

# ---------- test 4: file proxy ----------

echo "[e2e] test 4: file proxy"

: "${MUX_REGISTER_KEY:=local-mux-e2e-register-key}"

e2e_openclaw_id="$(compose exec -T openclaw node -e "
  const fs = require('fs');
  const d = JSON.parse(fs.readFileSync('/root/.openclaw/identity/device.json','utf8'));
  process.stdout.write(d.deviceId.trim());
" 2>/dev/null)" || true

runtime_token=""
if [[ -n "${e2e_openclaw_id}" ]]; then
  register_response="$(curl -sS -X POST "${MUX_BASE_URL}/v1/instances/register" \
    -H "Authorization: Bearer ${MUX_REGISTER_KEY}" \
    -H "Content-Type: application/json" \
    --data "{\"openclawId\":\"${e2e_openclaw_id}\",\"inboundUrl\":\"http://openclaw:18789/v1/mux/inbound\"}" \
    )" || true
  runtime_token="$(echo "${register_response}" | jq -r '.runtimeToken // empty')" || true
fi

user_chat_id="$(compose exec -T mux-server grep -oP '"telegram_pairing_token_(claimed|ignored_bound_route)".*"routeKey":"telegram:default:chat:\K[0-9]+' \
  "${MUX_LOG}" 2>/dev/null | tail -1)" || true

file_id=""
if [[ -n "${user_chat_id}" && -f "${PHOTO}" ]]; then
  send_photo_response="$(curl -sS \
    -F "chat_id=${user_chat_id}" \
    -F "photo=@${PHOTO}" \
    -F "caption=e2e-proxy-probe" \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto")" || true
  file_id="$(echo "${send_photo_response}" \
    | jq -r '.result.photo[-1].file_id // empty')" || true
fi

if [[ -z "${file_id}" ]]; then
  fail "file proxy — could not obtain a file_id"
elif [[ -z "${runtime_token}" ]]; then
  fail "file proxy — no runtime JWT available"
else
  TMPFILES+=("/tmp/e2e-proxy-response")
  proxy_status="$(curl -s -o /tmp/e2e-proxy-response -w '%{http_code}' \
    -H "Authorization: Bearer ${runtime_token}" \
    -H "X-OpenClaw-Id: ${e2e_openclaw_id}" \
    "${MUX_BASE_URL}/v1/mux/files/telegram?fileId=${file_id}")" || true

  if [[ "${proxy_status}" == "200" ]]; then
    proxy_size="$(wc -c < /tmp/e2e-proxy-response)"
    if (( proxy_size > 0 )); then
      pass "file proxy returned 200 (${proxy_size} bytes)"
    else
      fail "file proxy returned 200 but empty body"
    fi
  else
    fail "file proxy returned HTTP ${proxy_status}"
  fi
fi

# ==========================================================================
# Transport-only tests (no AI — fast, no LLM cost)
#
# These tests verify mux transport fidelity without triggering LLM calls.
# They use command interception (/reasoning argsMenu) and direct API calls.
# ==========================================================================

fence

# ---------- test 5: argsMenu inline keyboard buttons ----------
#
# Sends /reasoning (no args).  mux-http.ts command menu interception
# responds directly with inline keyboard buttons — no AI involved.
# Proves: command interception + button serialization + mux outbound.

echo "[e2e] test 5: argsMenu inline keyboard buttons (no AI)"
tgcli send --to "${BOT_CHAT_ID}" --message "/reasoning"

if elapsed="$(wait_for_inbound "${POLL_TIMEOUT}")"; then
  pass "argsMenu inbound — forwarded in ${elapsed}s"
else
  fail "argsMenu inbound — no telegram_inbound_forwarded within ${POLL_TIMEOUT}s"
fi

if elapsed="$(wait_for_outbound_fields "${POLL_TIMEOUT}" \
  '"outbound_request"' '"method":"sendMessage"' '"reply_markup"')"; then
  pass "argsMenu outbound — sendMessage with reply_markup in ${elapsed}s"
else
  fail "argsMenu outbound — no sendMessage with reply_markup within ${POLL_TIMEOUT}s"
fi

fence

# ---------- test 6: sticker inbound ----------
#
# Sends a sticker via tgcli.  Verifies mux-server forwards sticker messages.
# Requires tgcli sticker packs — skips gracefully if none are available.

echo "[e2e] test 6: sticker inbound (no AI)"

sticker_file_id=""
# Try tgcli sticker search first, then list.
sticker_pack="$(tgcli stickers search --emoji "👍" --output json 2>/dev/null \
  | jq -r '.[0].name // empty' 2>/dev/null)" || true
if [[ -z "${sticker_pack}" ]]; then
  sticker_pack="$(tgcli stickers list --output json 2>/dev/null \
    | jq -r '.[0].name // empty' 2>/dev/null)" || true
fi
if [[ -n "${sticker_pack}" ]]; then
  sticker_file_id="$(tgcli stickers show --pack "${sticker_pack}" --output json 2>/dev/null \
    | jq -r '.[0].file_id // empty' 2>/dev/null)" || true
fi

if [[ -z "${sticker_file_id}" ]]; then
  echo "[e2e] SKIP: sticker inbound — no sticker packs found via tgcli"
else
  tgcli send --to "${BOT_CHAT_ID}" --sticker "${sticker_file_id}"

  if elapsed="$(wait_for_inbound "${POLL_TIMEOUT}")"; then
    pass "sticker inbound — forwarded in ${elapsed}s"
  else
    fail "sticker inbound — no telegram_inbound_forwarded within ${POLL_TIMEOUT}s"
  fi
fi

fence

# ---------- test 7: document inbound ----------
#
# Sends a plain-text file as a document.  Verifies mux-server forwards
# document messages to OpenClaw.

echo "[e2e] test 7: document inbound (no AI)"

DOC_FILE="/tmp/e2e-doc-${UUID}.txt"
TMPFILES+=("$DOC_FILE")
printf 'e2e document test %s\n' "${UUID}" > "$DOC_FILE"

tgcli send --to "${BOT_CHAT_ID}" --file "$DOC_FILE" --caption "e2e-doc-${UUID}"

if elapsed="$(wait_for_inbound "${POLL_TIMEOUT}")"; then
  pass "document inbound — forwarded in ${elapsed}s"
else
  fail "document inbound — no telegram_inbound_forwarded within ${POLL_TIMEOUT}s"
fi

fence

# ---------- test 8: threaded mode (forum topics) ----------
#
# Creates a forum topic in the bot DM via Bot API, sends /reasoning in
# that topic, and verifies message_thread_id is preserved in outbound.
# No separate group or manual setup needed — the bot has topics enabled.
# Old e2e topics from previous runs are cleaned up automatically.

echo "[e2e] test 8: threaded mode (forum topics, no AI)"

if [[ -z "${user_chat_id}" ]]; then
  echo "[e2e] SKIP: threaded mode — user_chat_id not resolved (test 4 dependency)"
else
  # Clean up topics left over from previous e2e runs.
  E2E_THREADS_FILE="${STACK_DIR}/state/e2e-thread-ids.txt"
  if [[ -f "${E2E_THREADS_FILE}" ]]; then
    echo "[e2e] cleaning up old e2e topics..."
    while IFS= read -r old_thread_id; do
      if [[ -n "${old_thread_id}" ]]; then
        curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteForumTopic" \
          -H "Content-Type: application/json" \
          --data "{\"chat_id\":\"${user_chat_id}\",\"message_thread_id\":${old_thread_id}}" >/dev/null 2>&1 || true
      fi
    done < "${E2E_THREADS_FILE}"
    rm -f "${E2E_THREADS_FILE}"
  fi

  # Create a fresh topic for this run.
  topic_response="$(curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createForumTopic" \
    -H "Content-Type: application/json" \
    --data "{\"chat_id\":\"${user_chat_id}\",\"name\":\"e2e-thread-${UUID}\"}")"
  E2E_TOPIC_ID="$(echo "${topic_response}" | jq -r '.result.message_thread_id // empty')"

  if [[ -z "${E2E_TOPIC_ID}" ]]; then
    echo "[e2e] SKIP: threaded mode — createForumTopic failed: ${topic_response}"
  else
    # Persist topic ID so next run can clean it up if this run crashes.
    mkdir -p "${STACK_DIR}/state"
    echo "${E2E_TOPIC_ID}" >> "${E2E_THREADS_FILE}"

    echo "[e2e] created topic ${E2E_TOPIC_ID} in bot DM"

    fence

    # Send /reasoning in the topic.  Command interception responds with
    # inline buttons — no AI needed.  The outbound must include
    # message_thread_id (topic preservation through the mux path).
    tgcli send --to "${BOT_CHAT_ID}" --topic "${E2E_TOPIC_ID}" \
      --message "/reasoning"

    if elapsed="$(wait_for_inbound "${POLL_TIMEOUT}")"; then
      pass "threaded inbound — forwarded in ${elapsed}s"
    else
      fail "threaded inbound — no telegram_inbound_forwarded within ${POLL_TIMEOUT}s"
    fi

    if elapsed="$(wait_for_outbound_fields "${POLL_TIMEOUT}" \
      '"outbound_request"' '"method":"sendMessage"' '"message_thread_id"')"; then
      pass "threaded outbound — sendMessage with message_thread_id in ${elapsed}s"
    else
      fail "threaded outbound — no sendMessage with message_thread_id within ${POLL_TIMEOUT}s"
    fi

    # Clean up — delete the topic so it doesn't accumulate.
    curl -sS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteForumTopic" \
      -H "Content-Type: application/json" \
      --data "{\"chat_id\":\"${user_chat_id}\",\"message_thread_id\":${E2E_TOPIC_ID}}" >/dev/null 2>&1 || true
    sed -i "/${E2E_TOPIC_ID}/d" "${E2E_THREADS_FILE}" 2>/dev/null || true
  fi
fi

# ---------- summary ----------

TOTAL=$(( PASS + FAIL ))
echo ""
echo "[e2e] ========================================"
echo "[e2e] result: ${PASS}/${TOTAL} passed"
echo "[e2e] ========================================"

if (( FAIL > 0 )); then
  exit 1
fi
