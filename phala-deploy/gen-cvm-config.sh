#!/usr/bin/env bash
set -euo pipefail

# Generate OPENCLAW_CONFIG_B64 for CVM deployments.
#
# Reads openclaw.template.json for static config, then merges in dynamic
# values (secrets, URLs, model config) derived from environment variables.
#
# Required env vars:
#   MASTER_KEY         — derives gateway auth token via HKDF-SHA256
#   MUX_BASE_URL       — external mux-server URL (e.g. https://<hash>-18891.dstack-prod.phala.network)
#   MUX_REGISTER_KEY   — shared key for mux registration
#   CODEX_API_ENDPOINT — sub2api endpoint for OpenAI Codex (e.g. https://sub2api.example.com/v1)
#   CODEX_API_KEY      — sub2api x-api-key for Codex proxy auth
#
# Optional env vars:
#   BRAVE_SEARCH_API_KEY — Brave Search API key (web search tool, omitted if unset)
#
# Output: prints OPENCLAW_CONFIG_B64 to stdout (base64, no line wrapping).

: "${MASTER_KEY:?MASTER_KEY is required}"
: "${MUX_BASE_URL:?MUX_BASE_URL is required}"
: "${MUX_REGISTER_KEY:?MUX_REGISTER_KEY is required}"
: "${CODEX_API_ENDPOINT:?CODEX_API_ENDPOINT is required}"
: "${CODEX_API_KEY:?CODEX_API_KEY is required}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="${SCRIPT_DIR}/openclaw.template.json"
[[ -f "$TEMPLATE" ]] || { echo "ERROR: template not found: $TEMPLATE" >&2; exit 1; }

GATEWAY_PORT=18789
MODEL_PRIMARY="openai-codex/gpt-5.3-codex"

# --- Derive GATEWAY_AUTH_TOKEN from MASTER_KEY (same HKDF as entrypoint.sh) ---
GATEWAY_AUTH_TOKEN=$(node -e "
  const c = require('crypto');
  const key = c.hkdfSync('sha256', process.argv[1], '', 'gateway-auth-token', 32);
  process.stdout.write(Buffer.from(key).toString('base64'));
" "$MASTER_KEY" | tr -d '/+=' | head -c 32)

# inboundUrl uses ${DSTACK_APP_ID} / ${DSTACK_GATEWAY_DOMAIN} placeholders —
# resolved by the config loader's env-substitution (vars forwarded via docker-compose.yml)
INBOUND_URL="https://\${DSTACK_APP_ID}-${GATEWAY_PORT}.\${DSTACK_GATEWAY_DOMAIN}/v1/mux/inbound"

# Static mock JWT: satisfies pi-ai's extractAccountId (parses chatgpt_account_id
# from JWT payload). Sub2api ignores this — real auth is via x-api-key header.
# Payload: {"https://api.openai.com/auth":{"chatgpt_account_id":"acct_sub2api_proxy"},"exp":9999999999}
CODEX_MOCK_JWT="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdF9zdWIyYXBpX3Byb3h5In0sImV4cCI6OTk5OTk5OTk5OX0.c3ViMmFwaQ"

# --- Merge dynamic values into template ---
CONFIG_JSON=$(node -e "
  const fs = require('fs');
  const cfg = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));

  // Gateway auth + mux endpoint (dynamic/secret)
  cfg.gateway.auth = { mode: 'token', token: process.argv[2] };
  cfg.gateway.http = {
    endpoints: {
      mux: {
        enabled: true,
        baseUrl: process.argv[3],
        registerKey: process.argv[4],
        inboundUrl: process.argv[5],
      },
    },
  };

  // Model config — Codex via sub2api.
  // Preserve template-provided model definitions and only inject runtime auth/baseUrl.
  cfg.agents = cfg.agents || {};
  cfg.agents.defaults = cfg.agents.defaults || {};
  cfg.agents.defaults.model = { primary: process.argv[6] };
  cfg.agents.defaults.models = cfg.agents.defaults.models || {};
  if (!cfg.agents.defaults.models['openai-codex/gpt-5.3-codex']) {
    cfg.agents.defaults.models['openai-codex/gpt-5.3-codex'] = { alias: 'Codex' };
  }
  if (!cfg.agents.defaults.models['openai-codex/gpt-5.1-codex-mini']) {
    cfg.agents.defaults.models['openai-codex/gpt-5.1-codex-mini'] = { alias: 'Codex Mini' };
  }

  cfg.models = cfg.models || {};
  cfg.models.providers = cfg.models.providers || {};
  const codexProvider = cfg.models.providers['openai-codex'] || {};
  const requiredSwitchModels = [
    { id: 'gpt-5.3-codex', name: 'gpt-5.3-codex', reasoning: true, input: ['text', 'image'] },
    { id: 'gpt-5.1-codex-mini', name: 'gpt-5.1-codex-mini', reasoning: true, input: ['text', 'image'] },
  ];
  const existingModels = Array.isArray(codexProvider.models) ? codexProvider.models : [];
  for (const model of requiredSwitchModels) {
    const existingIndex = existingModels.findIndex((entry) => entry?.id === model.id);
    if (existingIndex === -1) {
      existingModels.push(model);
      continue;
    }
    const current = existingModels[existingIndex] || {};
    const currentInput = Array.isArray(current.input)
      ? current.input.filter((value) => typeof value === 'string')
      : [];
    existingModels[existingIndex] = {
      ...current,
      ...model,
      input: Array.from(new Set([...currentInput, ...model.input])),
      reasoning: true,
    };
  }
  cfg.models.providers['openai-codex'] = {
    ...codexProvider,
    baseUrl: process.argv[7],
    apiKey: process.argv[8],
    headers: {
      ...(codexProvider.headers || {}),
      'x-api-key': process.argv[9],
    },
    models: existingModels,
  };

  // Brave Search web tool (optional)
  const braveKey = process.argv[10] || '';
  if (braveKey) {
    cfg.tools = { web: { search: { enabled: true, provider: 'brave', apiKey: braveKey } } };
  }

  process.stdout.write(JSON.stringify(cfg, null, 2));
" "$TEMPLATE" "$GATEWAY_AUTH_TOKEN" "$MUX_BASE_URL" "$MUX_REGISTER_KEY" "$INBOUND_URL" "$MODEL_PRIMARY" "$CODEX_API_ENDPOINT" "$CODEX_MOCK_JWT" "$CODEX_API_KEY" "${BRAVE_SEARCH_API_KEY:-}")

printf '%s' "$CONFIG_JSON" | base64 -w0
