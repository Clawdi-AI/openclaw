# Mux Fidelity Refactor — Transport-Only Principle

## Core Principle

**Mux is a transport layer.** It relays messages between Telegram/Discord/WhatsApp and OpenClaw. All channel-specific _behavior_ (command menus, callback routing, inline keyboards, etc.) should be handled by the same code paths the direct bot uses. The mux layer should never duplicate or reimplement logic that already exists in the direct path.

When a feature works in the direct Telegram bot but not via mux, the fix belongs in the **mux inbound/outbound adapter** (making it route through the existing logic), NOT in the shared directive/reply layer (which would duplicate the direct path's implementation).

## Architecture Overview

### Direct Bot Path (v2026.2.17 baseline)

```
Telegram API → grammY Bot
  ├─ bot.command() handlers (bot-native-commands.ts:440)
  │   ├─ resolveCommandArgMenu() → inline keyboard buttons (lines 503-539)
  │   └─ dispatch to MsgContext → dispatchInboundMessage()
  ├─ bot.on("callback_query") (bot-handlers.ts:695)
  │   └─ resolveTelegramCallbackAction() → forward/edit/noop
  ├─ bot.on("message") (bot-handlers.ts:1038)
  │   └─ dispatchTelegramMessage() → draft-stream → deliverReplies()
  └─ bot.on("message_reaction") (bot-handlers.ts:435)
```

### Mux Path

```
Telegram API → mux-server → POST /v1/mux/inbound → mux-http.ts
  ├─ callback payloads → resolveTelegramCallbackAction() (shared!)
  ├─ command menu interception → resolveCommandArgMenu() (added in this fix)
  └─ regular messages → dispatchMuxTelegram()
      ├─ createTelegramStreamingDispatch() (shared lifecycle wrapper)
      │   ├─ onPartialReply → dedup + draftStream.update()
      │   ├─ tryFinalize → tryFinalizeDraftAsEdit() + edit-in-place
      │   └─ cleanup → cleanupDraftStream()
      └─ routeReply() → telegramOutbound → sendMessageTelegram(mux: opts)
```

### Transport Abstraction Points

The mux integration touches upstream code at these transport boundary points:

| Layer                | File                                        | Change                                                                                                                                                                                                                                                                     |
| -------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Send API**         | `src/telegram/send.ts`                      | Added `mux?: MuxTransportOpts` to all send functions. When present, sends via `sendViaMux()` instead of grammY API.                                                                                                                                                        |
| **Draft Stream**     | `src/telegram/draft-stream.ts`              | Refactored from `Bot["api"].sendMessageDraft()` to `TelegramDraftStreamTransport` interface (send/edit/delete). `createTelegramStreamingDispatch()` wraps the full lifecycle (create → partial dedup → finalize-as-edit → cleanup) so both paths share one implementation. |
| **Outbound Adapter** | `src/channels/plugins/outbound/telegram.ts` | Added `resolveMuxOpts()` — when mux is enabled for the account, passes `mux` opts through to `sendMessageTelegram()`.                                                                                                                                                      |
| **Callback Actions** | `src/telegram/callback-actions.ts`          | New file, but the `resolveTelegramCallbackAction()` function is shared between the direct `bot.on("callback_query")` handler and `mux-http.ts` callback handling.                                                                                                          |

## Files in This Branch

### New files (mux-specific, not modifying upstream)

| File                                                | Purpose                                                                                                                                               |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/gateway/mux-http.ts`                           | HTTP inbound handler. Receives mux-server payloads, builds `MsgContext`, dispatches.                                                                  |
| `src/gateway/mux-http.test.ts`                      | Tests for mux inbound.                                                                                                                                |
| `src/gateway/mux-jwt.ts`                            | JWT verification for mux ↔ openclaw auth.                                                                                                             |
| `src/channels/plugins/mux-envelope.ts`              | Shared envelope types & builders (`buildTelegramRawSend`, `buildTelegramReplyMarkup`, `TelegramButtons`, etc.). Used by both mux-server and openclaw. |
| `src/channels/plugins/outbound/mux.ts`              | `sendViaMux()`, `isMuxEnabled()`, file proxy. Core mux outbound transport.                                                                            |
| `src/channels/plugins/outbound/mux-routing.test.ts` | Tests for mux outbound routing.                                                                                                                       |
| `src/channels/plugins/outbound/mux-runtime.test.ts` | Tests for mux runtime JWT.                                                                                                                            |
| `src/config/types.mux.ts`                           | Mux config types.                                                                                                                                     |
| `src/telegram/callback-actions.ts`                  | Extracted from bot-handlers.ts so both direct and mux paths can resolve callbacks.                                                                    |

### Modified upstream files (minimal, transport-only changes)

| File                                        | Change Summary                                                                                                                                                                                               |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/telegram/send.ts`                      | Added `mux?: MuxTransportOpts` to send/edit/delete/react functions. When `mux` is present, builds raw envelope and sends via `sendViaMux()` instead of grammY API. ~327 lines added.                         |
| `src/telegram/draft-stream.ts`              | Refactored to `TelegramDraftStreamTransport` interface. Extracted `tryFinalizeDraftAsEdit()`, `cleanupDraftStream()`, and `createTelegramStreamingDispatch()` (shared lifecycle wrapper used by both paths). |
| `src/telegram/bot-message-dispatch.ts`      | Uses `createTelegramStreamingDispatch()` for stream creation, finalization, and cleanup. Block-mode chunking and regressive text suppression remain direct-path-specific.                                    |
| `src/channels/plugins/outbound/telegram.ts` | Added `resolveMuxOpts()`, plumbed `mux` option through `sendText`/`sendMedia`/`sendPayload`.                                                                                                                 |
| `src/channels/plugins/outbound/discord.ts`  | Same pattern: `isMuxEnabled()` check, `sendViaMux()` fallback.                                                                                                                                               |
| `src/channels/plugins/outbound/whatsapp.ts` | Same pattern.                                                                                                                                                                                                |
| `src/gateway/server-http.ts`                | Registered mux inbound HTTP route.                                                                                                                                                                           |
| `src/gateway/server.impl.ts`                | Wired mux handler into server startup.                                                                                                                                                                       |
| `src/config/types.gateway.ts`               | Added mux gateway config types.                                                                                                                                                                              |
| `src/config/types.telegram.ts`              | Added `mux?` field to Telegram account config.                                                                                                                                                               |
| `src/config/types.discord.ts`               | Added `mux?` field.                                                                                                                                                                                          |
| `src/config/types.whatsapp.ts`              | Added `mux?` field.                                                                                                                                                                                          |
| `src/config/zod-schema.*.ts`                | Schema validation for mux config fields.                                                                                                                                                                     |
| `src/plugin-sdk/index.ts`                   | Re-exported `isMuxEnabled`, `sendViaMux`.                                                                                                                                                                    |

## Fidelity Gaps (Known)

Features that work in the direct bot path but need work in the mux path:

### Fixed in this branch

| Gap                                                                                                                                                     | Fix                               | Approach                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Inline keyboard buttons for argsMenu commands** (`/reasoning`, `/thinking`, `/verbose`, `/elevated`, `/activation`, `/model`, `/debug`, `/heartbeat`) | `mux-http.ts:dispatchMuxTelegram` | Command menu interception using `resolveCommandArgMenu()` from the command registry — same logic as `bot-native-commands.ts:503-539`. Single interception point before dispatch.                                                                   |
| **Draft stream finalization**                                                                                                                           | `draft-stream.ts` refactor        | Extracted `tryFinalizeDraftAsEdit()` + `cleanupDraftStream()` so both paths share the same finalization logic.                                                                                                                                     |
| **Draft stream replyTo + plain text**                                                                                                                   | `mux-http.ts` transport           | Direct path streams plain text (no `parse_mode`) with `reply_parameters` pointing to inbound message; mux transport now does the same via `sendViaMux` directly instead of `sendMessageTelegram`. Finalization edit still uses `textMode: "html"`. |
| **Mux lifecycle duplication**                                                                                                                           | `draft-stream.ts` extraction      | Extracted `createTelegramStreamingDispatch()` — shared lifecycle wrapper (create + partial dedup + finalize-as-edit + cleanup). Eliminates ~80 lines of duplicated wiring from `mux-http.ts`. Both direct and mux paths now use the same wrapper.  |

### Not yet addressed

| Gap                                                                | Direct Path Location                                         | Notes                                                                                                                                                                     |
| ------------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Plugin commands** (`bot.command` for plugin-registered commands) | `bot-native-commands.ts:651`                                 | Plugin commands registered via `pluginCommandSpecs` get grammY handlers in the direct path. Mux path would need similar interception or a generic command dispatch layer. |
| **Message reactions (inbound)**                                    | `bot-handlers.ts:435` `bot.on("message_reaction")`           | Direct path handles inbound reactions. Mux-server would need to forward reaction events.                                                                                  |
| **Inline query**                                                   | Not currently implemented                                    | Neither path has this, but if added to direct path, mux would need forwarding.                                                                                            |
| **Chat migration**                                                 | `bot-handlers.ts:987` `bot.on("message:migrate_to_chat_id")` | Direct path handles Telegram chat migration events. Mux-server would need to forward these.                                                                               |
| **Channel posts**                                                  | `bot-handlers.ts:1105` `bot.on("channel_post")`              | Direct path handles Telegram channel posts. Mux doesn't currently forward these.                                                                                          |
| **Sticker cache/vision**                                           | `bot-message-dispatch.ts`                                    | Direct path has sticker-to-image conversion with caching. Mux path handles stickers as attachments but may not have vision fallback.                                      |

## Decision Log

### 2026-02-22: Inline buttons — transport interception, not directive-handler duplication

**Problem:** `/reasoning` (no args) via mux returned plain text without inline keyboard buttons.

**Wrong approach (reverted):** Add `maybeTelegramButtons()` helper to `directive-handling.shared.ts`, attach `channelData.telegram.buttons` to 4 directive branches in `directive-handling.impl.ts`, preserve `channelData` in reply merge in `get-reply-directives-apply.ts`. This modified 3 upstream core files and duplicated the button-building logic that already exists in the command registry.

**Correct approach:** Add command menu interception to `dispatchMuxTelegram()` in `mux-http.ts` — the exact same pattern as `bot-native-commands.ts:503-539`. Uses `findCommandByNativeName()` + `resolveCommandArgMenu()` + `buildCommandTextFromArgs()` from the command registry. Produces identical output to the direct path. Modifies 0 upstream files.

**Lesson:** When a feature works in the direct path, the mux fix belongs in the mux adapter layer, not in shared/core code. The command registry already knows about arg menus, choices, and button layout — use it, don't duplicate it.

### 2026-02-22: Shared streaming dispatch — extract lifecycle, not the full dispatch loop

**Problem:** `mux-http.ts:dispatchMuxTelegram` duplicated ~80 lines of draft-stream lifecycle wiring from the direct path: stream creation, `lastPartialText` dedup, `finalizedViaPreviewMessage` state, `tryFinalizeDraftAsEdit` call with `hasMedia`/`isError` plumbing, and `cleanupDraftStream` with the finalization flag. Every edge-case fix in one path had to be manually mirrored in the other.

**Considered but rejected:** Extracting the full `dispatchReplyWithBufferedBlockDispatcher` call into a shared function. The direct path has ~200 lines of additional complexity (block-mode chunking, `forceNewMessage`, sticker vision, media local roots, skill filtering, voice recording) that would require extensive parameterization, making the shared function harder to read than the duplication it eliminates.

**Chosen approach:** Extract only the **common lifecycle pattern** into `createTelegramStreamingDispatch()` in `draft-stream.ts`. Returns `{ draftStream, onPartialReply, tryFinalize, cleanup }`. Mux path uses all four methods directly. Direct path uses `draftStream` for block-mode-specific operations (chunker, `forceNewMessage`), `tryFinalize` for finalization (with a `previewButtons` closure for the editFn), and `cleanup` for teardown.

**What this eliminates from mux-http.ts:** `createTelegramDraftStream()` call, `lastPartialText` state + dedup logic, `finalizedViaPreviewMessage` state, `tryFinalizeDraftAsEdit()` call with plumbing, `cleanupDraftStream()` call. The deliver callback is reduced to one line: `if (info.kind === "final" && await streaming.tryFinalize(payload)) return;`.

**What remains mux-specific:** Transport creation (`sendViaMux` calls), `routeReply` fallback, typing indicator, command menu interception, ack reaction.

## How to Verify Fidelity

```bash
# Unit tests
npx vitest run src/auto-reply/ src/gateway/

# Build
pnpm build

# E2E (requires local mux-server + Telegram bot)
bash phala-deploy/local-mux-e2e/scripts/e2e-telegram.sh

# E2E with threaded mode (requires a supergroup with topics)
TELEGRAM_E2E_GROUP_ID=<supergroup_id> bash phala-deploy/local-mux-e2e/scripts/e2e-telegram.sh
```

### Automated E2E coverage

| Test                | What it proves                                                   | AI? |
| ------------------- | ---------------------------------------------------------------- | --- |
| 1. Text round-trip  | inbound forwarding + AI sendMessage outbound                     | Yes |
| 2. Photo round-trip | image inbound + AI sendMessage outbound                          | Yes |
| 3. Multi-action     | sendMessage + sendDocument + setMessageReaction outbound         | Yes |
| 4. File proxy       | mux file proxy GET returns file bytes                            | No  |
| 5. argsMenu buttons | command interception → sendMessage with reply_markup             | No  |
| 6. Sticker inbound  | sticker forwarding (skips if no tgcli sticker packs)             | No  |
| 7. Document inbound | document forwarding                                              | No  |
| 8. Threaded mode    | creates topic in bot DM, message_thread_id preserved in outbound | No  |

### Not yet covered by automated tests

- Callback query (inline button tap) — tgcli cannot simulate button clicks
- deleteMessage outbound — implicitly exercised by draft stream cleanup in AI tests
- editMessageText outbound — implicitly exercised by draft stream in AI tests
- sendChatAction (typing indicator) — implicit in AI tests
- Discord / WhatsApp inbound+outbound — separate e2e scripts needed

### Manual Telegram test checklist

- [ ] `/reasoning` → shows inline buttons [on] [off] [stream]
- [ ] `/thinking` → shows inline buttons (provider-dependent levels)
- [ ] `/verbose` → shows inline buttons [on] [full] [off]
- [ ] `/elevated` → shows inline buttons [on] [off] [ask] [full]
- [ ] `/model` → shows model selection keyboard (argsMenu with explicit spec)
- [ ] Tapping a button → processes command correctly (callback flow)
- [ ] Regular message → streams via draft-stream as before
- [ ] `/status` → returns status text (no argsMenu, goes through directive handling)
