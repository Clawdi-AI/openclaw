#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

FULL_IMAGE_REPO="${PHALA_IMAGE_REPO:-h4x3rotab/openclaw-cvm}"
BASE_IMAGE_REPO="${PHALA_BASE_IMAGE_REPO:-${FULL_IMAGE_REPO}-base}"
IMAGE_TAG="${PHALA_IMAGE_TAG:-}"
COMPOSE_FILE="${PHALA_COMPOSE_FILE:-${SCRIPT_DIR}/docker-compose.yml}"
IMAGE_REF_DIR="${SCRIPT_DIR}/image-refs"
BASE_IMAGE_REF_FILE="${IMAGE_REF_DIR}/openclaw-base-image.ref"
FULL_IMAGE_REF_FILE="${IMAGE_REF_DIR}/openclaw-full-image.ref"
NO_BUILD=0
NO_UI_INSTALL=0
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
  --image-repo <repo>     Full image repo (default: h4x3rotab/openclaw-cvm)
  --base-image-repo <repo> Base image repo (default: <image-repo>-base)
  --image-tag <tag>       Docker image tag (default: package.json version)
  --compose <path>        Compose file path (default: phala-deploy/docker-compose.yml)
  --no-build              Skip pnpm build/ui/npm pack steps
  --no-ui-install         Skip pnpm ui:install (useful if already installed)
  --no-push               Build image(s) only (skip push/digest updates)
  --dry-run               Print commands without executing
  -h, --help              Show this help

Environment:
  PHALA_IMAGE_REPO        Full image repo override
  PHALA_BASE_IMAGE_REPO   Base image repo override
  PHALA_IMAGE_TAG         Docker tag override (default: package.json version)
  PHALA_COMPOSE_FILE      Compose file override

Examples:
  $(basename "$0")
  $(basename "$0") --image-repo your-user/openclaw-cvm --image-tag 2026.2.12
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

resolve_tag_from_package_json() {
  node -e 'const pkg=require(process.argv[1]); process.stdout.write(String(pkg.version || ""));' \
    "$ROOT_DIR/package.json"
}

resolve_ref_with_digest() {
  local image_ref="$1"
  local repo_digest digest
  repo_digest="$(docker inspect --format='{{index .RepoDigests 0}}' "$image_ref")"
  [[ -n "$repo_digest" ]] || die "failed to resolve image digest for ${image_ref}"
  digest="${repo_digest#*@}"
  [[ -n "$digest" ]] || die "failed to parse image digest from ${repo_digest}"
  printf '%s@%s\n' "$image_ref" "$digest"
}

update_compose_image() {
  local image_ref_with_digest="$1"
  local tmp_file
  tmp_file="$(mktemp)"
  awk -v image_ref="$image_ref_with_digest" '
    BEGIN { updated = 0 }
    {
      if (!updated && $1 == "image:") {
        print "    image: " image_ref
        updated = 1
        next
      }
      print
    }
    END {
      if (!updated) {
        exit 10
      }
    }
  ' "$COMPOSE_FILE" > "$tmp_file" || {
    rm -f "$tmp_file"
    die "could not find image: line in $COMPOSE_FILE"
  }
  mv "$tmp_file" "$COMPOSE_FILE"
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
    --compose)
      COMPOSE_FILE="${2:-}"
      shift 2
      ;;
    --no-build)
      NO_BUILD=1
      shift
      ;;
    --no-ui-install)
      NO_UI_INSTALL=1
      shift
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
[[ -f "$COMPOSE_FILE" ]] || die "compose file not found: $COMPOSE_FILE"
mkdir -p "$IMAGE_REF_DIR"

if [[ -z "$IMAGE_TAG" ]]; then
  IMAGE_TAG="$(resolve_tag_from_package_json)"
fi
[[ -n "$IMAGE_TAG" ]] || die "could not resolve image tag from package.json version"

[[ -n "$FULL_IMAGE_REPO" ]] || die "full image repo is empty"
[[ -n "$BASE_IMAGE_REPO" ]] || die "base image repo is empty"

FULL_IMAGE_REF="${FULL_IMAGE_REPO}:${IMAGE_TAG}"
BASE_IMAGE_REF="${BASE_IMAGE_REPO}:${IMAGE_TAG}"

if [[ "$NO_BUILD" -eq 0 ]]; then
  log "building OpenClaw package tarball"
  run pnpm --dir "$ROOT_DIR" build
  if [[ "$NO_UI_INSTALL" -eq 0 ]]; then
    run pnpm --dir "$ROOT_DIR" ui:install
  fi
  run pnpm --dir "$ROOT_DIR" ui:build

  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf '%q ' npm --prefix "$ROOT_DIR" pack --pack-destination "$SCRIPT_DIR"
    printf '\n'
    log "dry-run: skipping tarball creation"
  else
    PACK_OUT="$(npm --prefix "$ROOT_DIR" pack --pack-destination "$SCRIPT_DIR")"
    TGZ_NAME="$(printf '%s\n' "$PACK_OUT" | tail -n 1 | tr -d '[:space:]')"
    [[ -n "$TGZ_NAME" ]] || die "failed to resolve npm pack output"
    rm -f "$SCRIPT_DIR/openclaw.tgz"
    mv -f "$SCRIPT_DIR/$TGZ_NAME" "$SCRIPT_DIR/openclaw.tgz"
    log "updated tarball: $SCRIPT_DIR/openclaw.tgz"
  fi
fi

log "building full Docker image: $FULL_IMAGE_REF"
run docker build --target full -f "$SCRIPT_DIR/Dockerfile" -t "$FULL_IMAGE_REF" "$ROOT_DIR"
log "building base Docker image: $BASE_IMAGE_REF"
run docker build --target base -f "$SCRIPT_DIR/Dockerfile" -t "$BASE_IMAGE_REF" "$ROOT_DIR"

if [[ "$NO_PUSH" -eq 0 ]]; then
  log "pushing full Docker image: $FULL_IMAGE_REF"
  run docker push "$FULL_IMAGE_REF"
  log "pushing base Docker image: $BASE_IMAGE_REF"
  run docker push "$BASE_IMAGE_REF"
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  log "dry-run: skipping compose image update"
  exit 0
fi

if [[ "$NO_PUSH" -eq 1 ]]; then
  log "no-push: skipping compose/image-ref updates"
  exit 0
fi

FULL_IMAGE_REF_WITH_DIGEST="$(resolve_ref_with_digest "$FULL_IMAGE_REF")"
BASE_IMAGE_REF_WITH_DIGEST="$(resolve_ref_with_digest "$BASE_IMAGE_REF")"

update_compose_image "$FULL_IMAGE_REF_WITH_DIGEST"
log "updated compose image ref to ${FULL_IMAGE_REF_WITH_DIGEST} in $COMPOSE_FILE"

printf '%s\n' "$BASE_IMAGE_REF_WITH_DIGEST" > "$BASE_IMAGE_REF_FILE"
log "wrote pinned base image ref to ${BASE_IMAGE_REF_FILE}"

printf '%s\n' "$FULL_IMAGE_REF_WITH_DIGEST" > "$FULL_IMAGE_REF_FILE"
log "wrote pinned full image ref to ${FULL_IMAGE_REF_FILE}"
