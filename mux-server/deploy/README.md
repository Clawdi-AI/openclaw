# Mux Server Deploy (Phala CVM)

This is the canonical deployment guide for production `mux-server` on Phala CVMs.

All production deploys should use:

- `mux-server/deploy/docker-compose.yml`

Do not use a separate "basic" compose for production.

## Files

- `mux-server/deploy/build-pin-mux.sh`: build/push image and pin digest in compose
- `mux-server/deploy/deploy-mux.sh`: deploy mux CVM and run smoke tests
- `mux-server/deploy/mux-pair-token.sh`: issue pairing tokens
- `mux-server/deploy/docker-compose.yml`: production compose with nginx access control

## Required Environment Variables

- `MUX_REGISTER_KEY`
- `MUX_ADMIN_TOKEN`
- `TELEGRAM_BOT_TOKEN`
- `DISCORD_BOT_TOKEN`
- `MUX_PROXY_PROMETHEUS_PASSWORD_HASH`
- `MUX_PROXY_BIND_IP` (optional; default `127.0.0.1`)

Generate metrics password hash:

```bash
docker run --rm httpd:2.4-alpine htpasswd -nbB prometheus 'strong-password' | cut -d: -f2
```

For token issuance via `mux-pair-token.sh`, use:

- `MUX_ADMIN_TOKEN`

## Build and Pin

```bash
./mux-server/deploy/build-pin-mux.sh
```

Optional:

```bash
./mux-server/deploy/build-pin-mux.sh --image-repo your-user/openclaw-mux --image-tag 2026.3.1
```

## Deploy

```bash
export MUX_REGISTER_KEY=replace-with-shared-register-key
export MUX_ADMIN_TOKEN=replace-with-mux-admin-token
export TELEGRAM_BOT_TOKEN=replace-with-telegram-token
export DISCORD_BOT_TOKEN=replace-with-discord-token
export MUX_PROXY_PROMETHEUS_PASSWORD_HASH='$2y$05$replace.with.bcrypt.hash'

bash mux-server/deploy/deploy-mux.sh \
  --openclaw-cvm openclaw-dev \
  --mux-cvm openclaw-mux-dev
```

Notes:

- `deploy-mux.sh` defaults to `mux-server/deploy/docker-compose.yml`.
- `--openclaw-cvm` is required unless `--skip-test` is used.
- `--dry-run`, `--skip-test`, and `--test-only` are supported.

## Pairing Token

```bash
export MUX_ADMIN_TOKEN=replace-with-mux-admin-token

./mux-server/deploy/mux-pair-token.sh \
  --openclaw-cvm openclaw-dev \
  --mux-cvm openclaw-mux-dev \
  telegram agent:main:main
```

## Health Check

```bash
phala ssh <mux-cvm-name> -- "curl -fsS http://127.0.0.1:18891/health | jq ."
```

Notes:

- Health endpoints are localhost-only in the default compose.
- Port binding defaults to loopback (`MUX_PROXY_BIND_IP=127.0.0.1`) to reduce accidental public exposure.

## Troubleshooting

- If Telegram shows `poll_conflict`, ensure no second poller is running (local e2e stack is a common cause).
- If pairing works but no inbound forwarding, verify OpenClaw `gateway.http.endpoints.mux.inboundUrl` is reachable from mux.
- For local integration tests, use `phala-deploy/local-mux-e2e/` only.
