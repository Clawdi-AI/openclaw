#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

die() {
  printf '[release-meta] ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage:
  release-meta.sh full-version [package-json-path]
  release-meta.sh base-version [package-json-path]
  release-meta.sh validate-ref [full-version] [git-ref] [git-ref-name]

Commands:
  full-version   Print package.json version and enforce <base>-phala.<minor>.
  base-version   Print upstream base version (strip -phala.<minor> suffix).
  validate-ref   Validate ref mode and print one of: release | integration
                 - release: refs/tags/v* and v-tag must equal full version
                 - integration: refs/heads/phala-*
USAGE
}

resolve_full_version() {
  local package_json="${1:-$ROOT_DIR/package.json}"
  local version
  version="$(node -e 'const fs=require("fs");const path=require("path");const p=path.resolve(process.argv[1]);const pkg=JSON.parse(fs.readFileSync(p,"utf8"));process.stdout.write(String(pkg.version||""));' "$package_json")"
  [[ -n "$version" ]] || die "package.json version is empty: $package_json"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+-phala\.[0-9]+$ ]] \
    || die "version must match <base>-phala.<minor>; got: $version"
  printf '%s\n' "$version"
}

resolve_base_version() {
  local full_version="$1"
  [[ "$full_version" == *-phala.* ]] || die "invalid full version: $full_version"
  printf '%s\n' "${full_version%%-phala.*}"
}

validate_ref_mode() {
  local full_version="$1"
  local git_ref="${2:-${GITHUB_REF:-}}"
  local git_ref_name="${3:-${GITHUB_REF_NAME:-}}"

  [[ -n "$git_ref" ]] || die "git ref is required (arg or GITHUB_REF)"
  [[ -n "$git_ref_name" ]] || git_ref_name="${git_ref##*/}"

  if [[ "$git_ref" == refs/tags/v* ]]; then
    local tag_version="${git_ref_name#v}"
    [[ "$tag_version" == "$full_version" ]] \
      || die "release tag/version mismatch: tag=${tag_version}, package=${full_version}"
    printf 'release\n'
    return 0
  fi

  if [[ "$git_ref" == refs/heads/phala-* ]]; then
    printf 'integration\n'
    return 0
  fi

  die "unsupported ref for phala release workflow: $git_ref"
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    full-version)
      shift
      resolve_full_version "${1:-$ROOT_DIR/package.json}"
      ;;
    base-version)
      shift
      local full
      full="$(resolve_full_version "${1:-$ROOT_DIR/package.json}")"
      resolve_base_version "$full"
      ;;
    validate-ref)
      shift
      local full="${1:-}"
      local ref="${2:-${GITHUB_REF:-}}"
      local ref_name="${3:-${GITHUB_REF_NAME:-}}"
      if [[ -z "$full" ]]; then
        full="$(resolve_full_version "$ROOT_DIR/package.json")"
      fi
      validate_ref_mode "$full" "$ref" "$ref_name"
      ;;
    -h|--help)
      usage
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main "$@"
