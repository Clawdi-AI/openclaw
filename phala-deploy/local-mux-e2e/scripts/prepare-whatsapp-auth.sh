#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STACK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

SRC="${WA_AUTH_SOURCE:-${HOME}/.openclaw/credentials/whatsapp/default}"
DST="${STACK_DIR}/state/wa-auth/default"

if [[ ! -d "${SRC}" ]]; then
  echo "[local-mux-e2e] WhatsApp auth source not found: ${SRC}" >&2
  echo "[local-mux-e2e] Set WA_AUTH_SOURCE to your bot auth directory and retry." >&2
  exit 1
fi

rm -rf "${DST}"
mkdir -p "${DST}"
cp -a "${SRC}/." "${DST}/"

echo "[local-mux-e2e] Copied WhatsApp auth snapshot to ${DST}"
