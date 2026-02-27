# Telegram Forum Group E2E Handoff

Last validated: **2026-02-27**

## Goal

Validate Telegram behavior in a real forum group (not only bot DM) in `phala-deploy/local-mux-e2e`.

## Known test group

- Human label provided in request: `Forum Testbed`
- Actual tgcli chat name observed on this machine: `Forum Testbench`
- Bot in scope: `@ClawPhalaTest1bot`
- Current local tgcli IDs (2026-02-27):
  - `chat_id=3856835228`
  - primary topic: `topic_id=1` (`General`)
  - second topic: `topic_id=14` (`Topic1`)

## Critical behavior

Group messages are **not** forwarded until the forum group chat is paired.

Observed sequence:

1. Send message in forum topic without pairing.
2. mux log shows only:
   - `telegram_inbound_ack_committed`
3. No `telegram_inbound_forwarded` until pairing is claimed in any topic of that forum chat.

## General topic nuance (`topicId=1`)

Telegram can reject `sendMessage` with `message_thread_id=1` in forum General:

- API error: `400 Bad Request: message thread not found`

Mux behavior validated on **2026-02-27**:

1. For forum General notices (`topicId=1`, group chat ID), mux sends notice **without** `message_thread_id`.
2. For other topic IDs, mux tries topic-scoped notice first; if Telegram returns
   `message thread not found`, mux retries once without thread ID.
3. Result: `/bot_help` and other bot-control notices still respond even if topic thread lookup fails.

Code/tests:

- `mux-server/src/server.ts` (`sendTelegramPairingNotice`)
- `mux-server/test/server.test.ts`
  - `handles unpaired /bot_help in forum General without message_thread_id`
  - `retries unpaired notice without topic thread when Telegram rejects thread ID`

## Required pairing flow for group tests

1. Mint pairing token (`pair-token.sh telegram` or admin API).
. Send `/start <token>` **inside the target forum topic** (via `tgcli send --to <group_id> --topic <topic_id>`).
3. Confirm mux log emits `telegram_pairing_token_claimed` with group route, for example:
   - `routeKey: telegram:default:chat:-100...:topic:1`
   - `sessionKey: agent:main:telegram:group:-100...:topic:1`

After this, normal group/topic traffic is forwarded.

## Useful tgcli commands

```bash
# Sync local cache
tgcli sync

# Find forum groups
tgcli chats list --output json | jq -r '.[] | select(.kind=="group" and .is_forum==true)'

# List topics in a forum group
tgcli topics list --chat <group_id> --output json

# Send in a forum topic
tgcli send --to <group_id> --topic <topic_id> --message "/reasoning"
```

## Automated script behavior (current)

`phala-deploy/local-mux-e2e/scripts/e2e-telegram.sh` test 8 now:

1. Resolves forum chat ID from:
   - `TELEGRAM_E2E_FORUM_CHAT_ID`, else
   - tgcli chat name match (`Forum Testbed` or `Forum Testbench`, forum-only)
2. Claims pairing in the primary forum topic (`/start <token>`).
3. Sends `/reasoning` in the primary topic.
4. Sends `/reasoning` in a second forum topic (`TELEGRAM_E2E_FORUM_SECOND_TOPIC_ID` or first non-primary topic from `tgcli topics list`) **without re-pairing**.
5. Verifies:
   - `telegram_inbound_forwarded` for group/topic session key
   - outbound `sendMessage` with `reply_markup` for that same session key

Optional overrides:

- `TELEGRAM_E2E_SEND_COOLDOWN_SEC=<seconds>` (default `2`, use `0` to disable pacing)
- `TELEGRAM_E2E_FORUM_CHAT_ID=<group_id>`
- `TELEGRAM_E2E_FORUM_TOPIC_ID=<topic_id>` (default `1`)
- `TELEGRAM_E2E_FORUM_SECOND_TOPIC_ID=<topic_id>` (optional; auto-resolved when omitted)
