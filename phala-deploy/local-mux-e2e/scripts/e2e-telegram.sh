#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${STACK_DIR}/docker-compose.yml"
: "${MUX_ADMIN_TOKEN:=local-mux-e2e-admin-token}"
: "${MUX_BASE_URL:=http://127.0.0.1:18891}"
: "${POLL_TIMEOUT:=60}"
: "${LLM_TIMEOUT:=60}"
: "${TELEGRAM_E2E_SEND_COOLDOWN_SEC:=2}"
: "${TELEGRAM_E2E_FORUM_CHAT_ID:=}"
: "${TELEGRAM_E2E_FORUM_TOPIC_ID:=1}"
: "${TELEGRAM_E2E_FORUM_SECOND_TOPIC_ID:=}"

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

# Gentle pacing between outbound test messages to reduce burstiness/rate limits.
cooldown_send() {
  local seconds="${TELEGRAM_E2E_SEND_COOLDOWN_SEC:-0}"
  if [[ "${seconds}" == "0" || "${seconds}" == "0.0" ]]; then
    return 0
  fi
  sleep "${seconds}"
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

# Poll until a log line since the fence matches ALL given patterns.
# Same as wait_for_outbound_fields but with a clearer name for general log entries.
wait_for_log_entry() {
  wait_for_outbound_fields "$@"
}

# Resolve the forum group used for local group behavior tests.
# Priority:
#   1) TELEGRAM_E2E_FORUM_CHAT_ID (explicit override)
#   2) tgcli chats list lookup by name ("Forum Testbed"/"Forum Testbench")
resolve_forum_chat_id() {
  if [[ -n "${TELEGRAM_E2E_FORUM_CHAT_ID:-}" ]]; then
    echo "${TELEGRAM_E2E_FORUM_CHAT_ID}"
    return 0
  fi
  tgcli chats list --output json 2>/dev/null \
    | jq -r '
        [ .[]
          | select((.is_forum == true) or (.kind == "group"))
          | select((.name // "") | test("Forum Testbed|Forum Testbench"; "i"))
          | .id
        ]
        | first // empty
      ' 2>/dev/null || true
}

# Resolve a second forum topic used to validate cross-topic pairing/routing.
# Priority:
#   1) TELEGRAM_E2E_FORUM_SECOND_TOPIC_ID (explicit override)
#   2) first topic from tgcli topics list that is not the primary topic
resolve_forum_second_topic_id() {
  local chat_id="$1"
  local primary_topic_id="$2"
  if [[ -n "${TELEGRAM_E2E_FORUM_SECOND_TOPIC_ID:-}" ]]; then
    echo "${TELEGRAM_E2E_FORUM_SECOND_TOPIC_ID}"
    return 0
  fi
  tgcli topics list --chat "${chat_id}" --output json 2>/dev/null \
    | jq -r --arg primary "${primary_topic_id}" '
        [ .topics[]?
          | .topic_id
          | tostring
          | select(. != $primary)
        ]
        | first // empty
      ' 2>/dev/null || true
}

# Issue a fresh pairing token via the admin API.
# Usage: issue_pairing_token <channel> [openclaw_id]
# Prints the token string to stdout. Returns 1 on failure.
issue_pairing_token() {
  local channel="$1"
  local oc_id="${2:-}"

  if [[ -z "${oc_id}" ]]; then
    oc_id="$(compose exec -T openclaw node -e "
      const fs = require('fs');
      const d = JSON.parse(fs.readFileSync('/root/.openclaw/identity/device.json','utf8'));
      process.stdout.write(d.deviceId.trim());
    " 2>/dev/null)" || true
  fi
  if [[ -z "${oc_id}" ]]; then
    echo "[e2e] issue_pairing_token: failed to resolve openclawId" >&2
    return 1
  fi

  local payload
  payload="$(jq -nc \
    --arg channel "${channel}" \
    --arg openclawId "${oc_id}" \
    --arg inboundUrl "http://openclaw:18789/v1/mux/inbound" \
    --argjson ttlSec 900 \
    --argjson inboundTimeoutMs 15000 \
    '{channel:$channel,ttlSec:$ttlSec,openclawId:$openclawId,inboundUrl:$inboundUrl,inboundTimeoutMs:$inboundTimeoutMs}'
  )"

  local response
  response="$(curl -sS -X POST "${MUX_BASE_URL}/v1/admin/pairings/token" \
    -H "Authorization: Bearer ${MUX_ADMIN_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "${payload}")" || true

  local tok
  tok="$(echo "${response}" | jq -r '.token // empty')" || true
  if [[ -z "${tok}" ]]; then
    echo "[e2e] issue_pairing_token: failed to issue token: ${response}" >&2
    return 1
  fi
  echo "${tok}"
}

# Unbind all active pairings for the given runtime token.
# Usage: unbind_all_pairings <runtime_token>
unbind_all_pairings() {
  local rt_token="$1"
  local bindings
  bindings="$(curl -sS "${MUX_BASE_URL}/v1/pairings" \
    -H "Authorization: Bearer ${rt_token}")" || true
  local ids
  ids="$(echo "${bindings}" | jq -r '.items[]?.bindingId // empty' 2>/dev/null)" || true
  for bid in ${ids}; do
    curl -sS -X POST "${MUX_BASE_URL}/v1/pairings/unbind" \
      -H "Authorization: Bearer ${rt_token}" \
      -H "Content-Type: application/json" \
      --data "{\"bindingId\":\"${bid}\"}" >/dev/null 2>&1 || true
  done
}

# ==========================================================================
# Onboarding polish tests
#
# These tests verify the pairing claim lifecycle: unpaired intro, fresh
# pairing, re-pairing (same tenant), and takeover (different tenant).
# They exercise the claim functions, notices, and post-pairing synthetic
# inbound without requiring an LLM (except the synthetic inbound round-trip).
# ==========================================================================

# Resolve openclaw identity for token issuance and runtime auth.
e2e_openclaw_id="$(compose exec -T openclaw node -e "
  const fs = require('fs');
  const d = JSON.parse(fs.readFileSync('/root/.openclaw/identity/device.json','utf8'));
  process.stdout.write(d.deviceId.trim());
" 2>/dev/null)" || true

if [[ -z "${e2e_openclaw_id}" ]]; then
  echo "[e2e] FATAL: cannot resolve openclaw device ID" >&2
  exit 1
fi

# Register the instance so we have a runtime token for API calls.
: "${MUX_REGISTER_KEY:=local-mux-e2e-register-key}"
register_response="$(curl -sS -X POST "${MUX_BASE_URL}/v1/instances/register" \
  -H "Authorization: Bearer ${MUX_REGISTER_KEY}" \
  -H "Content-Type: application/json" \
  --data "{\"openclawId\":\"${e2e_openclaw_id}\",\"inboundUrl\":\"http://openclaw:18789/v1/mux/inbound\"}" \
  )" || true
runtime_token="$(echo "${register_response}" | jq -r '.runtimeToken // empty')" || true

if [[ -z "${runtime_token}" ]]; then
  echo "[e2e] WARNING: no runtime token — some tests may be limited" >&2
fi

# ---------- unpair (clean slate for onboarding tests) ----------
#
# Ensure this chat starts fully unpaired.  Use both the API unbind
# and the in-chat /bot_unpair command as a belt-and-suspenders approach.

echo "[e2e] unpairing: clearing any existing bindings"

if [[ -n "${runtime_token}" ]]; then
  unbind_all_pairings "${runtime_token}"
fi

# Also send /bot_unpair via Telegram in case the API unbind missed anything
# (e.g. stale binding from a different openclaw identity).
tgcli send --to "${BOT_CHAT_ID}" --message "/bot_unpair"
cooldown_send
sleep 5

fence

# ---------- onboarding test 1: unpaired message shows Clawdi intro ----------
#
# Send a DM to the now-unpaired bot and verify it responds with the
# Clawdi intro notice (not the old technical pairing steps).

echo "[e2e] onboarding test 1: unpaired message shows Clawdi intro"

tgcli send --to "${BOT_CHAT_ID}" --message "hello from unpaired user ${UUID}"
cooldown_send

# Wait for the bot to process and reply.  The unpaired hint goes through
# sendTelegram("sendMessage", ...) which isn't logged as outbound_request.
# Instead, poll tgcli for new messages from the bot containing "Clawdi".
sleep 8
tgcli sync >/dev/null 2>&1 || true
recent_msgs="$(tgcli messages list --chat "${BOT_CHAT_ID}" --limit 5 --output json 2>/dev/null)" || true

if echo "${recent_msgs}" | jq -e '.messages[] | select(.text != null) | select(.text | test("Clawdi"; "i"))' >/dev/null 2>&1; then
  pass "unpaired hint — Clawdi intro received in chat"
elif echo "${recent_msgs}" | jq -e '.messages[] | select(.text != null) | select(.text | test("clawdi\\.ai"; "i"))' >/dev/null 2>&1; then
  pass "unpaired hint — Clawdi intro received in chat (clawdi.ai)"
else
  # Check if any bot reply was sent at all.
  if echo "${recent_msgs}" | jq -e '.messages[] | select(.text != null) | select(.text | test("not paired|pair this chat"; "i"))' >/dev/null 2>&1; then
    fail "unpaired hint — bot replied but with old text (not Clawdi intro)"
  else
    fail "unpaired hint — no Clawdi intro found in recent bot messages"
  fi
fi

fence

# ---------- onboarding test 2: fresh pairing (success + synthetic inbound) ----------
#
# Issue a new token, pair via /start, and verify:
#   a) claimType is "fresh" in the structured log
#   b) Synthetic inbound (post_pairing_synthetic_sent) is dispatched
#   c) AI intro response arrives (full round-trip)
#   d) "Paired successfully" text received in chat

echo "[e2e] onboarding test 2: fresh pairing"

fresh_token="$(issue_pairing_token telegram "${e2e_openclaw_id}")" || true

if [[ -z "${fresh_token}" ]]; then
  fail "fresh pairing — could not issue pairing token"
else
  tgcli send --to "${BOT_CHAT_ID}" --message "/start ${fresh_token}"
  cooldown_send

  # a) Verify claimType=fresh in structured log.
  if elapsed="$(wait_for_log_entry "${POLL_TIMEOUT}" \
    '"telegram_pairing_token_claimed"' '"claimType":"fresh"')"; then
    pass "fresh pairing — claimed with claimType=fresh in ${elapsed}s"
  else
    if mux_log_tail | grep -q '"telegram_pairing_token_claimed"'; then
      actual_type="$(mux_log_tail | grep '"telegram_pairing_token_claimed"' | grep -oP '"claimType":"\K[^"]+' | tail -1)"
      fail "fresh pairing — claimed but claimType='${actual_type}' (expected 'fresh')"
    else
      fail "fresh pairing — no telegram_pairing_token_claimed within ${POLL_TIMEOUT}s"
    fi
  fi

  # b) Verify synthetic inbound was dispatched.
  if elapsed="$(wait_for_log_entry "${POLL_TIMEOUT}" \
    '"post_pairing_synthetic_sent"')"; then
    pass "fresh pairing — synthetic inbound sent in ${elapsed}s"
  else
    if mux_log_tail | grep -q '"post_pairing_synthetic_error"'; then
      fail "fresh pairing — synthetic inbound failed (post_pairing_synthetic_error)"
    elif mux_log_tail | grep -q '"post_pairing_synthetic_skip_no_target"'; then
      fail "fresh pairing — synthetic inbound skipped (no target)"
    else
      fail "fresh pairing — no post_pairing_synthetic_sent within ${POLL_TIMEOUT}s"
    fi
  fi

  # c) Wait for the AI intro response triggered by the synthetic inbound.
  # This proves the full round-trip: synthetic → openclaw → AI → mux outbound.
  if elapsed="$(wait_for_outbound_method "sendMessage" "${LLM_TIMEOUT}")"; then
    pass "fresh pairing — AI intro response via sendMessage in ${elapsed}s"
  else
    fail "fresh pairing — no AI intro sendMessage within ${LLM_TIMEOUT}s"
  fi

  # d) Verify "Paired successfully" text was received in chat.
  sleep 3
  tgcli sync >/dev/null 2>&1 || true
  recent_msgs="$(tgcli messages list --chat "${BOT_CHAT_ID}" --limit 10 --output json 2>/dev/null)" || true
  if echo "${recent_msgs}" | jq -e '.messages[] | select(.text != null) | select(.text | test("Paired successfully"; "i"))' >/dev/null 2>&1; then
    pass "fresh pairing — 'Paired successfully' notice received in chat"
  elif echo "${recent_msgs}" | jq -e '.messages[] | select(.text != null) | select(.text | test("Paired"; "i"))' >/dev/null 2>&1; then
    pass "fresh pairing — pairing notice received in chat (text variant)"
  else
    fail "fresh pairing — no 'Paired successfully' notice in recent chat messages"
  fi
fi

fence

# ---------- onboarding test 3: re-pairing same tenant (reconnected, no synthetic) ----------
#
# Issue another token for the same openclaw, pair the same chat again.
# Verify:
#   a) claimType is "repaired"
#   b) "Reconnected" notice received in chat
#   c) No synthetic inbound (post_pairing_synthetic_sent should NOT appear)

echo "[e2e] onboarding test 3: re-pairing same tenant"

repaired_token="$(issue_pairing_token telegram "${e2e_openclaw_id}")" || true

if [[ -z "${repaired_token}" ]]; then
  fail "re-pairing — could not issue pairing token"
else
  tgcli send --to "${BOT_CHAT_ID}" --message "/start ${repaired_token}"
  cooldown_send

  # a) Verify claimType=repaired in structured log.
  if elapsed="$(wait_for_log_entry "${POLL_TIMEOUT}" \
    '"telegram_pairing_token_claimed"' '"claimType":"repaired"')"; then
    pass "re-pairing — claimed with claimType=repaired in ${elapsed}s"
  else
    if mux_log_tail | grep -q '"telegram_pairing_token_claimed"'; then
      actual_type="$(mux_log_tail | grep '"telegram_pairing_token_claimed"' | grep -oP '"claimType":"\K[^"]+' | tail -1)"
      fail "re-pairing — claimed but claimType='${actual_type}' (expected 'repaired')"
    else
      fail "re-pairing — no telegram_pairing_token_claimed within ${POLL_TIMEOUT}s"
    fi
  fi

  # b) Verify "Reconnected" notice received in chat.
  sleep 5
  tgcli sync >/dev/null 2>&1 || true
  recent_msgs="$(tgcli messages list --chat "${BOT_CHAT_ID}" --limit 5 --output json 2>/dev/null)" || true
  if echo "${recent_msgs}" | jq -e '.messages[] | select(.text != null) | select(.text | test("Reconnected"; "i"))' >/dev/null 2>&1; then
    pass "re-pairing — 'Reconnected successfully' notice received in chat"
  else
    fail "re-pairing — no 'Reconnected' notice in recent chat messages"
  fi

  # c) Verify NO synthetic inbound was sent (repaired claims skip the AI intro).
  sleep 5
  if mux_log_tail | grep -q '"post_pairing_synthetic_sent"'; then
    fail "re-pairing — synthetic inbound was sent (should be skipped for repaired)"
  else
    pass "re-pairing — no synthetic inbound (correct for repaired)"
  fi
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
cooldown_send

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
cooldown_send

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
cooldown_send

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

# e2e_openclaw_id and runtime_token resolved earlier in the onboarding section.

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
cooldown_send

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
  cooldown_send

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
cooldown_send

if elapsed="$(wait_for_inbound "${POLL_TIMEOUT}")"; then
  pass "document inbound — forwarded in ${elapsed}s"
else
  fail "document inbound — no telegram_inbound_forwarded within ${POLL_TIMEOUT}s"
fi

fence

# ---------- test 8: forum group behavior ----------
#
# Pairs once inside a real forum group and verifies command round-trips in two topics:
#   1) /start token + /reasoning in primary topic
#   2) /reasoning in second topic without re-pairing
#
# This validates group+topic routing in the same local stack used for DM tests.

echo "[e2e] test 8: forum group behavior (chat-wide pairing + two topics, no AI)"

forum_chat_id="$(resolve_forum_chat_id)"
forum_topic_id="${TELEGRAM_E2E_FORUM_TOPIC_ID}"

if [[ -z "${forum_chat_id}" ]]; then
  echo "[e2e] SKIP: forum group test — set TELEGRAM_E2E_FORUM_CHAT_ID or create a forum group named 'Forum Testbed'/'Forum Testbench' in tgcli"
else
  forum_second_topic_id="$(resolve_forum_second_topic_id "${forum_chat_id}" "${forum_topic_id}")"
  if [[ -z "${forum_second_topic_id}" ]]; then
    echo "[e2e] SKIP: forum second-topic test — set TELEGRAM_E2E_FORUM_SECOND_TOPIC_ID or create another topic in ${forum_chat_id}"
  fi

  forum_token="$(issue_pairing_token telegram "${e2e_openclaw_id}")" || true
  if [[ -z "${forum_token}" ]]; then
    fail "forum group pairing — could not issue pairing token"
  else
    fence
    tgcli send --to "${forum_chat_id}" --topic "${forum_topic_id}" --message "/start ${forum_token}"
    cooldown_send

    if elapsed="$(wait_for_log_entry "${POLL_TIMEOUT}" \
      '"telegram_pairing_token_claimed"' "topic:${forum_topic_id}\"")"; then
      pass "forum group pairing — token claimed in topic ${forum_topic_id} in ${elapsed}s"
    else
      fail "forum group pairing — no telegram_pairing_token_claimed for topic ${forum_topic_id} within ${POLL_TIMEOUT}s"
    fi

    forum_session_key="$(mux_log_tail \
      | grep '"telegram_pairing_token_claimed"' \
      | grep "topic:${forum_topic_id}\"" \
      | grep -oP '"sessionKey":"\K[^"]+' \
      | tail -1)" || true

    if [[ -z "${forum_session_key}" ]]; then
      fail "forum group pairing — could not resolve sessionKey from claim log"
    elif [[ "${forum_session_key}" == *":telegram:group:"* ]]; then
      pass "forum group pairing — resolved group session key ${forum_session_key}"
    else
      fail "forum group pairing — unexpected non-group session key ${forum_session_key}"
    fi

    if [[ -n "${forum_session_key}" && "${forum_session_key}" == *":telegram:group:"* ]]; then
      fence
      tgcli send --to "${forum_chat_id}" --topic "${forum_topic_id}" --message "/reasoning"
      cooldown_send

      if elapsed="$(wait_for_log_entry "${POLL_TIMEOUT}" \
        '"telegram_inbound_forwarded"' "\"sessionKey\":\"${forum_session_key}\"")"; then
        pass "forum group inbound — /reasoning forwarded in ${elapsed}s"
      else
        fail "forum group inbound — no forwarded /reasoning for ${forum_session_key} within ${POLL_TIMEOUT}s"
      fi

      if elapsed="$(wait_for_outbound_fields "${POLL_TIMEOUT}" \
        '"outbound_request"' "\"sessionKey\":\"${forum_session_key}\"" '"method":"sendMessage"' '"reply_markup"')"; then
        pass "forum group outbound — args menu sendMessage for ${forum_session_key} in ${elapsed}s"
      else
        fail "forum group outbound — no args menu sendMessage for ${forum_session_key} within ${POLL_TIMEOUT}s"
      fi
    fi
  fi

  if [[ -n "${forum_second_topic_id}" ]]; then
    fence
    tgcli send --to "${forum_chat_id}" --topic "${forum_second_topic_id}" --message "/reasoning"
    cooldown_send

    if elapsed="$(wait_for_log_entry "${POLL_TIMEOUT}" \
      '"telegram_inbound_forwarded"' "topic:${forum_second_topic_id}\"")"; then
      pass "forum group second-topic inbound — /reasoning forwarded without re-pairing in ${elapsed}s"
    else
      fail "forum group second-topic inbound — no forwarded /reasoning for topic ${forum_second_topic_id} within ${POLL_TIMEOUT}s"
    fi

    forum_session_key_2="$(mux_log_tail \
      | grep '"telegram_inbound_forwarded"' \
      | grep "topic:${forum_second_topic_id}\"" \
      | grep -oP '"sessionKey":"\K[^"]+' \
      | tail -1)" || true

    if [[ -z "${forum_session_key_2}" ]]; then
      fail "forum group second-topic inbound — could not resolve sessionKey from forward log"
    elif [[ "${forum_session_key_2}" == *":telegram:group:"* ]]; then
      pass "forum group second-topic inbound — resolved group session key ${forum_session_key_2}"
    else
      fail "forum group second-topic inbound — unexpected non-group session key ${forum_session_key_2}"
    fi

    if [[ -n "${forum_session_key:-}" && -n "${forum_session_key_2:-}" && "${forum_session_key}" != "${forum_session_key_2}" ]]; then
      pass "forum group second-topic inbound — distinct session keys across topics"
    fi

    if [[ -n "${forum_session_key_2}" && "${forum_session_key_2}" == *":telegram:group:"* ]]; then
      if elapsed="$(wait_for_outbound_fields "${POLL_TIMEOUT}" \
        '"outbound_request"' "\"sessionKey\":\"${forum_session_key_2}\"" '"method":"sendMessage"' '"reply_markup"')"; then
        pass "forum group second-topic outbound — args menu sendMessage for ${forum_session_key_2} in ${elapsed}s"
      else
        fail "forum group second-topic outbound — no args menu sendMessage for ${forum_session_key_2} within ${POLL_TIMEOUT}s"
      fi
    fi
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
