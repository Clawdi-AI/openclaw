# Local Mux E2E Stack

This stack mirrors the production shape on one machine:

- `openclaw` container (same `phala-deploy/Dockerfile` path used for CVM image)
- `mux-server` container (Telegram + Discord + WhatsApp inbound/outbound)
- one tenant key shared across:
  - OpenClaw `gateway.http.endpoints.mux.token`
  - OpenClaw outbound auth to mux
  - mux inbound auth back to OpenClaw

## Why this is safe for testing

- Real credentials are used at runtime.
- No production state is reused:
  - OpenClaw state is in local Docker volumes (`openclaw_data`, `openclaw_docker_data`).
  - mux DB/logs are in local Docker volume (`mux_data`).
  - WhatsApp auth is copied to `phala-deploy/local-mux-e2e/state/wa-auth/default` as a test snapshot.

## Prerequisites

- Docker (Compose v2)
- `curl`, `jq`, `openssl`
- `rv-exec` configured with:
  - `MUX_ADMIN_TOKEN`
  - `TELEGRAM_BOT_TOKEN`
  - `DISCORD_BOT_TOKEN`
- A valid WhatsApp auth dir at:
  - default: `~/.openclaw/credentials/whatsapp/default`
  - override: `WA_AUTH_SOURCE=<path>`

## Bring Up

```bash
./phala-deploy/local-mux-e2e/scripts/up.sh
```

What `up.sh` does:

1. Copies WhatsApp auth snapshot into local state.
2. Pulls secrets from `rv` into a temp env file.
3. Runs `docker compose up -d --build`.

Optional overrides: create `phala-deploy/local-mux-e2e/.env.local` from `.env.example`.

## Bootstrap One Tenant

```bash
./phala-deploy/local-mux-e2e/scripts/bootstrap-tenant.sh
```

Optional args:

```bash
./phala-deploy/local-mux-e2e/scripts/bootstrap-tenant.sh <tenant-id> <tenant-api-key>
```

What bootstrap does:

1. Updates OpenClaw config in-container:
   - `gateway.http.endpoints.mux.baseUrl=http://mux-server:18891`
   - `gateway.http.endpoints.mux.token=<tenant-api-key>`
   - enables mux account routing for `telegram`, `discord`, `whatsapp`
2. Restarts OpenClaw gateway.
3. Calls mux admin API `POST /v1/admin/tenants/bootstrap` with inbound target:
   - `http://openclaw:18789/v1/mux/inbound`
4. Stores tenant info in `phala-deploy/local-mux-e2e/state/tenant.env`.

## Pairing UX Test

Generate one-time pairing token:

```bash
./phala-deploy/local-mux-e2e/scripts/pair-token.sh telegram
./phala-deploy/local-mux-e2e/scripts/pair-token.sh discord
./phala-deploy/local-mux-e2e/scripts/pair-token.sh whatsapp
```

Then redeem token in channel:

- Telegram: `/start <token>`
- Discord DM: send `<token>`
- WhatsApp DM: send `<token>`

Expected first reply:

- `Paired successfully. You can chat now.`

## Smoke Flow

1. Pair one chat per channel.
2. Send `/help`.
3. Send text + image.
4. Confirm OpenClaw reply arrives through mux path.

Follow logs:

```bash
./phala-deploy/local-mux-e2e/scripts/logs.sh
./phala-deploy/local-mux-e2e/scripts/logs.sh mux-server
./phala-deploy/local-mux-e2e/scripts/logs.sh openclaw
```

## Stop / Reset

Stop only:

```bash
./phala-deploy/local-mux-e2e/scripts/down.sh
```

Stop and wipe local test state:

```bash
./phala-deploy/local-mux-e2e/scripts/down.sh --wipe
```
