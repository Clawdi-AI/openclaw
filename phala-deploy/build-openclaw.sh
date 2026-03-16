#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

FULL_IMAGE_REPO="${PHALA_IMAGE_REPO:-h4x3rotab/openclaw-cvm}"
BASE_IMAGE_REPO="${PHALA_BASE_IMAGE_REPO:-${FULL_IMAGE_REPO}-base}"
IMAGE_TAG="${PHALA_IMAGE_TAG:-$(bash "$SCRIPT_DIR/release-meta.sh" full-version "$ROOT_DIR/package.json")}"

FULL_IMAGE_REF="${FULL_IMAGE_REPO}:${IMAGE_TAG}"
BASE_IMAGE_REF="${BASE_IMAGE_REPO}:${IMAGE_TAG}"

pnpm --dir "$ROOT_DIR" ui:install
PACK_OUT="$(npm --prefix "$ROOT_DIR" pack --pack-destination "$SCRIPT_DIR")"
TGZ_NAME="$(printf '%s\n' "$PACK_OUT" | tail -n 1 | tr -d '[:space:]')"
rm -f "$SCRIPT_DIR/openclaw.tgz"
mv -f "$SCRIPT_DIR/$TGZ_NAME" "$SCRIPT_DIR/openclaw.tgz"

docker build --target full -f "$SCRIPT_DIR/Dockerfile" -t "$FULL_IMAGE_REF" "$ROOT_DIR"
docker build --target base -f "$SCRIPT_DIR/Dockerfile" -t "$BASE_IMAGE_REF" "$ROOT_DIR"

if [[ "${PHALA_NO_PUSH:-0}" != "1" ]]; then
  docker push "$FULL_IMAGE_REF"
  docker push "$BASE_IMAGE_REF"
fi
