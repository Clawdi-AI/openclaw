#!/usr/bin/env bash
# Migrate a running CVM's openclaw.json to the latest config shape.
#
# Downloads openclaw.json from the CVM container, runs each migration
# script locally, and uploads it back only if something changed.
# Each migration checks the config first and skips if already applied.
#
# Usage:
#   COMPOSEIO_ADMIN_API=... bash phala-deploy/migrate-openclaw.sh <CVM>
#   COMPOSEIO_ADMIN_API=... bash phala-deploy/migrate-openclaw.sh --dry-run <CVM>
#
# Migrations:
#   composio   — if COMPOSEIO_ADMIN_API is set and config is missing
#                COMPOSIO_MCP_URL, creates a Tool Router session and
#                injects COMPOSIO_MCP_URL + COMPOSIO_API_KEY
#   codex      — if CODEX_API_ENDPOINT + CODEX_API_KEY are set, migrates legacy
#                openai codex provider config to openai-codex
set -euo pipefail

log()  { printf '\033[1;34m[migrate]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[migrate] ✓\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[migrate] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

CVM=""
DRY_RUN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) sed -n '2,/^[^#]/{ /^#/s/^# \?//p }' "$0"; exit 0 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -*) die "unknown option: $1" ;;
    *)  CVM="$1"; shift ;;
  esac
done

[[ -n "$CVM" ]] || die "usage: migrate-openclaw.sh <CVM>"

REMOTE_CFG="/root/.openclaw/openclaw.json"
REMOTE_TMP="/tmp/openclaw.json"
LOCAL_TMP="$(mktemp /tmp/openclaw-migrate-XXXXXX.json)"
trap 'rm -f "$LOCAL_TMP"' EXIT

# ── download openclaw.json ──────────────────────────────────────────────────

log "Downloading openclaw.json from CVM ${CVM}..."
phala ssh "$CVM" -- docker cp "openclaw:${REMOTE_CFG}" "$REMOTE_TMP" \
  || die "docker cp from container failed"
phala cp "${CVM}:${REMOTE_TMP}" "$LOCAL_TMP" \
  || die "phala cp download failed"
ok "Downloaded openclaw.json ($(wc -c < "$LOCAL_TMP") bytes)"

CHECKSUM_BEFORE=$(md5sum "$LOCAL_TMP" | cut -d' ' -f1)

# ── migrations ──────────────────────────────────────────────────────────────
# Each migration is a self-contained node script that:
#   1. Reads the config from process.argv[1]
#   2. Checks if the migration is already applied → exits 0 if so
#   3. Makes any needed API calls
#   4. Patches the config and writes it back
# Secrets are passed via environment variables.

# --- Migration: Composio standalone ---
if [[ -n "${COMPOSEIO_ADMIN_API:-}" ]]; then
  log "Migration: composio..."
  COMPOSIO_API_KEY="${COMPOSEIO_ADMIN_API}" node -e '
    const fs = require("fs");

    async function main() {
      const cfgPath = process.argv[1];
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      const env = cfg.skills?.entries?.composio?.env || {};
      const apiKey = process.env.COMPOSIO_API_KEY;

      if (env.COMPOSIO_MCP_URL && env.COMPOSIO_API_KEY) {
        console.log("  composio: already configured, skipping.");
        return;
      }

      const res = await fetch("https://backend.composio.dev/api/v3/tool_router/session", {
        method: "POST",
        headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: "default" }),
      });
      if (!res.ok) throw new Error("API returned " + res.status + ": " + await res.text());
      const r = await res.json();
      const mcpUrl = r?.mcp?.url || r?.session?.mcp?.url || "";
      if (!mcpUrl) throw new Error("no MCP URL in response");

      if (!cfg.skills) cfg.skills = {};
      if (!cfg.skills.entries) cfg.skills.entries = {};
      if (!cfg.skills.entries.composio) cfg.skills.entries.composio = {};
      if (!cfg.skills.entries.composio.env) cfg.skills.entries.composio.env = {};
      cfg.skills.entries.composio.env.COMPOSIO_MCP_URL = mcpUrl;
      cfg.skills.entries.composio.env.COMPOSIO_API_KEY = apiKey;
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      console.log("  composio: configured (MCP URL: " + mcpUrl + ")");
    }
    main().catch(e => { console.error("  composio: " + e.message); process.exit(1); });
  ' "$LOCAL_TMP" || die "composio migration failed"
else
  log "Migration: composio — skipped (no COMPOSEIO_ADMIN_API)"
fi

# --- Migration: Brave Search web tool ---
if [[ -n "${BRAVE_SEARCH_API_KEY:-}" ]]; then
  log "Migration: brave-search..."
  BRAVE_KEY="${BRAVE_SEARCH_API_KEY}" node -e '
    const fs = require("fs");
    function main() {
      const cfgPath = process.argv[1];
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      if (cfg.tools?.web?.search?.apiKey) {
        console.log("  brave-search: already configured, skipping.");
        return;
      }
      if (!cfg.tools) cfg.tools = {};
      if (!cfg.tools.web) cfg.tools.web = {};
      cfg.tools.web.search = { enabled: true, provider: "brave", apiKey: process.env.BRAVE_KEY };
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      console.log("  brave-search: configured (provider: brave)");
    }
    main();
  ' "$LOCAL_TMP" || die "brave-search migration failed"
else
  log "Migration: brave-search — skipped (no BRAVE_SEARCH_API_KEY)"
fi

# --- Migration: openai-codex provider ---
if [[ -n "${CODEX_API_ENDPOINT:-}" && -n "${CODEX_API_KEY:-}" ]]; then
  CODEX_BASE_URL="${CODEX_API_ENDPOINT%/}"
  [[ "$CODEX_BASE_URL" == */v1 ]] || die "CODEX_API_ENDPOINT must end with /v1 (got: ${CODEX_API_ENDPOINT})"
  log "Migration: codex-provider..."
  CODEX_BASE_URL="$CODEX_BASE_URL" \
  CODEX_REAL_API_KEY="${CODEX_API_KEY}" \
  CODEX_MOCK_JWT="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdF9zdWIyYXBpX3Byb3h5In0sImV4cCI6OTk5OTk5OTk5OX0.c3ViMmFwaQ" \
  node -e '
    const fs = require("fs");

    function main() {
      const cfgPath = process.argv[1];
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      const providers = cfg.models?.providers;
      const codexBaseUrl = process.env.CODEX_BASE_URL;
      const codexApiKey = process.env.CODEX_REAL_API_KEY;
      let changed = false;

      if (!providers) {
        console.log("  codex-provider: no providers block, skipping.");
        return;
      }

      const old = providers["openai"];
      if (old) {
        providers["openai-codex"] = {
          baseUrl: codexBaseUrl,
          apiKey: process.env.CODEX_MOCK_JWT,
          headers: { "x-api-key": codexApiKey },
          models: old.models || [],
        };
        delete providers["openai"];
        changed = true;
        console.log("  codex-provider: migrated (openai -> openai-codex)");
      }

      const codex = providers["openai-codex"];
      if (codex) {
        if (codex.baseUrl !== codexBaseUrl) {
          codex.baseUrl = codexBaseUrl;
          changed = true;
          console.log("  codex-provider: normalized baseUrl");
        }
        if (!codex.headers || typeof codex.headers !== "object") {
          codex.headers = {};
        }
        if (codex.headers["x-api-key"] !== codexApiKey) {
          codex.headers["x-api-key"] = codexApiKey;
          changed = true;
          console.log("  codex-provider: updated x-api-key header");
        }
      }

      const defaults = cfg.agents?.defaults;
      if (defaults?.models?.["openai/gpt-5.2-codex"]) {
        defaults.models["openai-codex/gpt-5.3-codex"] = { alias: "Codex" };
        delete defaults.models["openai/gpt-5.2-codex"];
        changed = true;
      }
      if (defaults?.model?.primary === "openai/gpt-5.2-codex") {
        defaults.model.primary = "openai-codex/gpt-5.3-codex";
        changed = true;
      }

      if (!changed) {
        console.log("  codex-provider: already up to date, skipping.");
        return;
      }

      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      console.log("  codex-provider: updated");
    }

    main();
  ' "$LOCAL_TMP" || die "codex-provider migration failed"
else
  log "Migration: codex-provider — skipped (CODEX_API_ENDPOINT/CODEX_API_KEY not set)"
fi

# --- (future migrations go here) ---

# ── upload if changed ───────────────────────────────────────────────────────

CHECKSUM_AFTER=$(md5sum "$LOCAL_TMP" | cut -d' ' -f1)

if [[ "$CHECKSUM_BEFORE" == "$CHECKSUM_AFTER" ]]; then
  ok "No changes — config already up to date."
  exit 0
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  ok "Dry-run: migration would update config on CVM ${CVM}; skipping upload."
  exit 0
fi

log "Uploading openclaw.json to CVM..."
phala cp "$LOCAL_TMP" "${CVM}:${REMOTE_TMP}" \
  || die "phala cp upload failed"
phala ssh "$CVM" -- docker cp "${REMOTE_TMP}" "openclaw:${REMOTE_CFG}" \
  || die "docker cp into container failed"

ok "Done — openclaw.json migrated on CVM ${CVM}"
