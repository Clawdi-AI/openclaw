# Local Mux E2E Stack

This stack mirrors the production shape on one machine:

- `openclaw` container (same `phala-deploy/Dockerfile` path used for CVM image)
- `mux-server` container (Telegram + Discord + WhatsApp inbound/outbound)
- one shared register key (`MUX_REGISTER_KEY`) used only for `POST /v1/instances/register`
- per-instance runtime JWT (mux -> OpenClaw) used for runtime mux APIs (outbound/etc)
- one admin token (`MUX_ADMIN_TOKEN`) used only for control-plane APIs (pairing token issuance)
- per-delivery inbound JWT (mux -> OpenClaw) used for inbound delivery to OpenClaw

## Why this is safe for testing

- Real credentials are used at runtime.
- No production state is reused:
  - OpenClaw state is in local Docker volumes (`openclaw_data`, `openclaw_docker_data`).
  - mux DB/logs are in local Docker volume (`mux_data`).
  - WhatsApp auth is copied to `phala-deploy/local-mux-e2e/state/wa-auth/default` as a test snapshot.

## Credential guardrail (required)

- Do not reuse production WhatsApp auth/session files for local e2e testing.
- Keep a dedicated local test session and point `WA_AUTH_SOURCE` to that test-only path.
- If local auth gets corrupted, relink locally and refresh the local snapshot. Do not copy production creds into local test state.

## Prerequisites

- Docker (Compose v2)
- `curl`, `jq`
- Secrets available via `.env.local` files (repo-root for `CODEX_API_KEY`/`CODEX_API_ENDPOINT`, stack-level for `MODEL_PRIMARY` etc.) or direct env exports
- Required secrets:
  - `TELEGRAM_BOT_TOKEN` (or `DISCORD_BOT_TOKEN` for Discord tests)
  - `CODEX_API_KEY` + `CODEX_API_ENDPOINT` (when `MODEL_PRIMARY` is set)
- For Telegram e2e tests: `tgcli` (synced automatically by the e2e script)
- Optional: a valid WhatsApp auth dir if you want to test WhatsApp:
  - `WA_AUTH_SOURCE=<path-to-local-test-auth>`
- Optional override:
  - `MUX_REGISTER_KEY` (defaults to `local-mux-e2e-register-key`)

## Bring Up

```bash
./phala-deploy/local-mux-e2e/scripts/up.sh
```

What `up.sh` does:

1. Sources `.env.local` from both the stack dir and the repo root (for secrets like `CODEX_API_KEY`).
2. Optionally copies WhatsApp auth snapshot into local state (if `WA_AUTH_SOURCE` is set).
3. Generates the OpenClaw config JSON with model provider, mux gateway, and channel settings.
4. Runs `docker compose up -d --build --remove-orphans`.
5. Writes the config into the running container and restarts OpenClaw.

To enable WhatsApp inbound, set `WA_AUTH_SOURCE` inline or in `phala-deploy/local-mux-e2e/.env.local` (from `.env.example`).

Listener defaults in local e2e:

- Telegram inbound starts automatically when `TELEGRAM_BOT_TOKEN` is present.
- Discord inbound starts automatically when `DISCORD_BOT_TOKEN` is present.
- WhatsApp inbound starts automatically when `state/wa-auth/default/creds.json` exists.

## Pairing UX Test

Generate one-time pairing token:

```bash
./phala-deploy/local-mux-e2e/scripts/pair-token.sh telegram
./phala-deploy/local-mux-e2e/scripts/pair-token.sh discord
./phala-deploy/local-mux-e2e/scripts/pair-token.sh whatsapp
```

What `pair-token.sh` does:

1. Reads `openclawId` from the OpenClaw container device identity.
   - OpenClaw creates this identity on first boot and persists it at `/root/.openclaw/identity/device.json`.
   - When `MASTER_KEY` is set (default in this stack), the device identity is derived deterministically so accidental deletion of `device.json` is recoverable after restart.
2. Calls `POST /v1/admin/pairings/token` using `MUX_ADMIN_TOKEN` (idempotent; also upserts the tenant inbound target).

Then redeem token in channel:

- Telegram: `/start <token>`
- Discord DM: send `<token>`
- WhatsApp DM: send `<token>`

Expected first reply:

- `Paired successfully. You can chat now.`

## Automated E2E Tests

The e2e script handles pairing, tgcli sync, and all assertions automatically:

```bash
# Just two commands — no manual env setup needed:
./phala-deploy/local-mux-e2e/scripts/up.sh
./phala-deploy/local-mux-e2e/scripts/e2e-telegram.sh
```

The e2e script auto-resolves all required values:

- `TELEGRAM_BOT_TOKEN` — from `.env.local` files or the mux-server container
- `TELEGRAM_E2E_BOT_CHAT_ID` — derived from the bot token (part before `:`)
- `MODEL_PRIMARY` — from `.env.local`
- `tgcli sync` — runs automatically before first send

What the Telegram e2e tests cover:

**AI round-trip tests (tests 1–3):**

1. **Text round-trip** — send text, verify inbound forwarding + AI reply
2. **Photo round-trip** — send image, verify inbound forwarding + AI reply
3. **Multi-action round-trip** — one prompt triggers sendMessage + sendDocument + setMessageReaction

**Transport-only tests (tests 4–9, no AI — fast, no LLM cost):**

4. **File proxy** — verify mux file proxy returns 200 with content
5. **argsMenu inline buttons** — send `/reasoning`, verify outbound sendMessage contains `reply_markup`
6. **Sticker inbound** — send sticker, verify mux-server forwards it (skips if no sticker packs in tgcli)
7. **Document inbound** — send text file, verify mux-server forwards it
8. **Threaded mode (forum topics)** — create topic in bot DM, send `/reasoning` in it, verify `message_thread_id` preserved in outbound, then delete topic

## Smoke Flow (Manual)

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
