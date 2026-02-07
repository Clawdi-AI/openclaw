#!/usr/bin/env bash
set -euo pipefail

MUX_BASE_URL="${MUX_BASE_URL:-http://127.0.0.1:18891}"
MUX_CHANNEL="${MUX_CHANNEL:-telegram}"
MUX_API_KEY="${MUX_API_KEY:-}"
MUX_SESSION_KEY="${MUX_SESSION_KEY:-}"
MUX_TEXT="${MUX_TEXT:-[mux smoke] local check}"
MUX_EXPECT_STATUS="${MUX_EXPECT_STATUS:-}"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

health_body="$(curl -sS "${MUX_BASE_URL}/health")"
if [[ "$health_body" != *'"ok":true'* ]]; then
  echo "[smoke] health failed: ${health_body}"
  exit 1
fi
echo "[smoke] health ok"

unauth_status="$(
  curl -sS -o "${tmp_dir}/unauth.json" -w "%{http_code}" \
    -X POST "${MUX_BASE_URL}/v1/mux/outbound/send" \
    -H "Authorization: Bearer wrong-key" \
    -H "Content-Type: application/json" \
    --data "{\"channel\":\"${MUX_CHANNEL}\",\"sessionKey\":\"smoke:unauthorized\",\"text\":\"x\"}"
)"
if [[ "$unauth_status" != "401" ]]; then
  echo "[smoke] expected 401 for unauthorized outbound, got ${unauth_status}"
  cat "${tmp_dir}/unauth.json"
  exit 1
fi
echo "[smoke] unauthorized guard ok (401)"

if [[ -n "$MUX_API_KEY" && -n "$MUX_SESSION_KEY" ]]; then
  auth_status="$(
    curl -sS -o "${tmp_dir}/auth.json" -w "%{http_code}" \
      -X POST "${MUX_BASE_URL}/v1/mux/outbound/send" \
      -H "Authorization: Bearer ${MUX_API_KEY}" \
      -H "Content-Type: application/json" \
      --data "{\"channel\":\"${MUX_CHANNEL}\",\"sessionKey\":\"${MUX_SESSION_KEY}\",\"text\":\"${MUX_TEXT}\"}"
  )"
  echo "[smoke] authorized outbound status=${auth_status}"
  cat "${tmp_dir}/auth.json"
  echo
  if [[ -n "$MUX_EXPECT_STATUS" && "$auth_status" != "$MUX_EXPECT_STATUS" ]]; then
    echo "[smoke] expected status ${MUX_EXPECT_STATUS}, got ${auth_status}"
    exit 1
  fi
fi

echo "[smoke] completed"
