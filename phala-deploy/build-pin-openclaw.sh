#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
RELEASE_META_SCRIPT="${SCRIPT_DIR}/release-meta.sh"

FULL_IMAGE_REPO="${PHALA_IMAGE_REPO:-h4x3rotab/openclaw-cvm}"
BASE_IMAGE_REPO="${PHALA_BASE_IMAGE_REPO:-${FULL_IMAGE_REPO}-base}"
IMAGE_TAG="${PHALA_IMAGE_TAG:-}"
NO_PUSH=0
DRY_RUN=0

log() {
  printf '[build-pin-openclaw] %s\n' "$*"
}

die() {
  printf '[build-pin-openclaw] ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<USAGE
Usage:
  $(basename "$0") [options]

Options:
  --image-repo <repo>      Full image repo (default: h4x3rotab/openclaw-cvm)
  --base-image-repo <repo> Base image repo (default: <image-repo>-base)
  --image-tag <tag>        Docker image tag (default: package.json phala version)
  --no-push                Build image(s) only (skip push)
  --dry-run                Print commands without executing
  -h, --help               Show this help
USAGE
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '%q ' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --image-repo)
      FULL_IMAGE_REPO="${2:-}"
      shift 2
      ;;
    --base-image-repo)
      BASE_IMAGE_REPO="${2:-}"
      shift 2
      ;;
    --image-tag)
      IMAGE_TAG="${2:-}"
      shift 2
      ;;
    --no-push)
      NO_PUSH=1
      shift
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

require_cmd docker
require_cmd pnpm
require_cmd npm
require_cmd node
[[ -f "$RELEASE_META_SCRIPT" ]] || die "missing required script: $RELEASE_META_SCRIPT"

if [[ -z "$IMAGE_TAG" ]]; then
  IMAGE_TAG="$(bash "$RELEASE_META_SCRIPT" full-version "$ROOT_DIR/package.json")"
fi
[[ -n "$IMAGE_TAG" ]] || die "could not resolve image tag from package.json version"
[[ -n "$FULL_IMAGE_REPO" ]] || die "full image repo is empty"
[[ -n "$BASE_IMAGE_REPO" ]] || die "base image repo is empty"

log "preparing OpenClaw tarball"
run pnpm --dir "$ROOT_DIR" ui:install
if [[ "$DRY_RUN" -eq 1 ]]; then
  printf '%q ' npm --prefix "$ROOT_DIR" pack --pack-destination "$SCRIPT_DIR"
  printf '\n'
else
  PACK_OUT="$(npm --prefix "$ROOT_DIR" pack --pack-destination "$SCRIPT_DIR")"
  TGZ_NAME="$(printf '%s\n' "$PACK_OUT" | tail -n 1 | tr -d '[:space:]')"
  [[ -n "$TGZ_NAME" ]] || die "failed to resolve npm pack output"
  rm -f "$SCRIPT_DIR/openclaw.tgz"
  mv -f "$SCRIPT_DIR/$TGZ_NAME" "$SCRIPT_DIR/openclaw.tgz"
fi

FULL_IMAGE_REF="${FULL_IMAGE_REPO}:${IMAGE_TAG}"
BASE_IMAGE_REF="${BASE_IMAGE_REPO}:${IMAGE_TAG}"

log "building full image: $FULL_IMAGE_REF"
run docker build --target full -f "$SCRIPT_DIR/Dockerfile" -t "$FULL_IMAGE_REF" "$ROOT_DIR"

log "building base image: $BASE_IMAGE_REF"
run docker build --target base -f "$SCRIPT_DIR/Dockerfile" -t "$BASE_IMAGE_REF" "$ROOT_DIR"

if [[ "$NO_PUSH" -eq 0 ]]; then
  log "pushing full image: $FULL_IMAGE_REF"
  run docker push "$FULL_IMAGE_REF"

  log "pushing base image: $BASE_IMAGE_REF"
  run docker push "$BASE_IMAGE_REF"
else
  log "no-push: skipping docker push"
fi
