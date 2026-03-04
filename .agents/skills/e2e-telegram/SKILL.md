---
name: e2e-telegram
description: Run the local Telegram end-to-end suite against mux-server + OpenClaw docker-compose, including onboarding lifecycle, DM round-trip, media/file proxy, and forum topic routing checks.
---

# Telegram E2E Test

Exercises the full pipeline:

tgcli (real MTProto sender) -> Telegram API -> mux-server (Bot API poll) -> OpenClaw (HTTP inbound) -> OpenClaw reply/tool actions -> mux-server (outbound send) -> Telegram API.

## Current Workflow

- No `rv-exec` required.
- No `phala-deploy/openclaw.tgz` build/pack step required.
- The script auto-loads env files from:
  - `phala-deploy/local-mux-e2e/.env.local`
  - repo root `.env.local` (fallback)
- The script reuses a running stack and only calls `up.sh` when required containers are missing.

## One-Time Setup

### 1. Install dependencies

```bash
# Rust toolchain (needed for tgcli)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# tgcli (MTProto CLI)
cargo install tgcli

# Also needed: jq, curl, docker, uuidgen
```

### 2. Authenticate tgcli user session

```bash
tgcli auth
```

Use a Telegram user account (not a bot). Session persists in `~/.tgcli/`.

### 3. Ensure the bot is discoverable in tgcli

Send one manual DM to the bot and run:

```bash
tgcli sync
```

## Environment Variables

Set these in `phala-deploy/local-mux-e2e/.env.local` (preferred):

- Required:
  - `MODEL_PRIMARY`
  - `TELEGRAM_BOT_TOKEN` (or alias `TELEGRAM_BOT_TOKEN_E2E`)
- Optional:
  - `TELEGRAM_E2E_BOT_CHAT_ID` (defaults to bot user ID from token prefix)
  - `MUX_BASE_URL` (default `http://127.0.0.1:18891`)
  - `MUX_ADMIN_TOKEN`
  - `MUX_REGISTER_KEY`
  - `POLL_TIMEOUT`, `LLM_TIMEOUT`
  - `TELEGRAM_E2E_SEND_COOLDOWN_SEC`
  - `TELEGRAM_E2E_FORUM_CHAT_ID`, `TELEGRAM_E2E_FORUM_TOPIC_ID`, `TELEGRAM_E2E_FORUM_SECOND_TOPIC_ID`

If `TELEGRAM_BOT_TOKEN` is not set in env files, the script also tries:

```bash
docker exec mux-server-local-e2e printenv TELEGRAM_BOT_TOKEN
```

## Run

```bash
bash phala-deploy/local-mux-e2e/scripts/e2e-telegram.sh
```

## What The Suite Verifies

The script currently runs onboarding + transport + AI round-trip checks:

1. Unpaired DM hint behavior (`Clawdi` intro text).
2. Fresh pairing claim flow (`claimType=fresh`, synthetic inbound, intro reply).
3. Re-pairing flow (`claimType=repaired`, reconnect notice, no synthetic inbound).
4. DM text round-trip.
5. DM photo round-trip.
6. AI multi-action flow (`sendMessage`, `sendDocument`/`sendPhoto`, `setMessageReaction`).
7. Telegram file proxy fetch with runtime JWT auth.
8. Args-menu inline keyboard transport path (`/reasoning`).
9. Sticker inbound forward (skips if tgcli has no sticker packs).
10. Document inbound forward.
11. Forum group behavior across two topics (chat-wide pairing + topic session routing).

Pass/fail is determined from mux-server structured logs (`/data/mux-server.log`) and Telegram chat observations.

## Stack Scripts

All in `phala-deploy/local-mux-e2e/scripts/`:

| Script                    | Purpose                                    |
| ------------------------- | ------------------------------------------ |
| `up.sh`                   | Build + start containers, wait for health  |
| `down.sh`                 | Stop containers (`--wipe` removes volumes) |
| `pair-token.sh <channel>` | Issue a pairing token                      |
| `logs.sh [service]`       | Tail container logs                        |
| `e2e-telegram.sh`         | Run the full Telegram E2E suite            |

## Troubleshooting

- `tgcli is required`: install with `cargo install tgcli`.
- `TELEGRAM_BOT_TOKEN not set`: define it in `phala-deploy/local-mux-e2e/.env.local` (or use `TELEGRAM_BOT_TOKEN_E2E`).
- `MODEL_PRIMARY not set`: add a valid model slug in `.env.local`.
- `mux-server health check failed`: verify stack and port mapping, then inspect compose logs.
- `openclaw cannot reach mux-server`: check docker network/container health.
