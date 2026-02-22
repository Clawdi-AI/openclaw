# Mux Upstream Reduction Plan

## Purpose

This document analyzes the current implementation against `v2026.2.17` and proposes an explicit refactor plan to reduce `mux-upstream` patch size while preserving mux fidelity.

Scope here is deliberately practical:

1. Keep behavior stable.
2. Reduce upstream-touching churn.
3. Move mux-specific logic into mux-specific modules where possible.
4. Make future rebase work smaller and more mechanical.

## Execution Log

### 2026-02-22: Phase 1 started (shared mux overlay extraction)

Implemented:

- Added shared helper module:
  - `src/channels/plugins/outbound/mux-overlay.ts`
  - helpers:
    - `resolveTelegramMuxTransportOpts`
    - `maybeSendDiscordViaMux`
    - `maybeSendWhatsAppViaMux`
- Exported helpers in plugin SDK:
  - `src/plugin-sdk/index.ts`
- Rewired core outbound adapters to use helper:
  - `src/channels/plugins/outbound/telegram.ts`
  - `src/channels/plugins/outbound/discord.ts`
  - `src/channels/plugins/outbound/whatsapp.ts`
- Rewired extension outbound adapters to use helper:
  - `extensions/telegram/src/channel.ts`
  - `extensions/discord/src/channel.ts`
  - `extensions/whatsapp/src/channel.ts`

Validation run:

- `pnpm exec vitest run src/channels/plugins/outbound/mux-routing.test.ts extensions/discord/src/mux-sendpayload.test.ts extensions/telegram/src/mux-sendpayload.test.ts extensions/whatsapp/src/mux-sendpayload.test.ts`
  - result: 4 files passed, 15 tests passed

Notes:

- `pnpm tsgo` currently has unrelated baseline errors in this branch; touched files from this phase do not report TypeScript errors.
- Metrics scripts (`pnpm metrics:patch`) read committed refs only, so post-refactor metric deltas should be checked after committing this phase.

### 2026-02-22: Phase 1 continued (shared payload fallback sequence extraction)

Implemented:

- Added shared payload sequence helper:
  - `src/channels/plugins/outbound/payload-sequence.ts`
  - helpers:
    - `resolvePayloadTextAndMedia`
    - `sendPayloadWithMediaSequence`
    - `PayloadSendSequenceStep`
- Exported helpers in plugin SDK:
  - `src/plugin-sdk/index.ts`
- Rewired extension outbound `sendPayload` paths to use shared helper:
  - `extensions/discord/src/channel.ts`
  - `extensions/telegram/src/channel.ts`
  - `extensions/whatsapp/src/channel.ts`
- Rewired core Telegram outbound `sendPayload` path to use shared helper:
  - `src/channels/plugins/outbound/telegram.ts`

Validation run:

- `pnpm exec oxfmt --check src/channels/plugins/outbound/payload-sequence.ts src/plugin-sdk/index.ts src/channels/plugins/outbound/telegram.ts extensions/discord/src/channel.ts extensions/whatsapp/src/channel.ts extensions/telegram/src/channel.ts`
- `pnpm vitest run src/channels/plugins/outbound/mux-routing.test.ts extensions/discord/src/mux-sendpayload.test.ts extensions/telegram/src/mux-sendpayload.test.ts extensions/whatsapp/src/mux-sendpayload.test.ts`
  - result: 4 files passed, 15 tests passed

Notes:

- `pnpm tsgo` baseline remains noisy in this branch; no new errors were reported for touched files in this slice.

### 2026-02-22: Phase 2 started (Telegram transport shim for mux delegation)

Implemented:

- Added transport shim:
  - `src/telegram/transport.ts`
  - helpers:
    - `resolveTelegramTransport`
    - `isTelegramMuxTransport`
    - `sendTelegramMuxRaw`
    - `reactMessageTelegramViaMux`
    - `deleteMessageTelegramViaMux`
    - `editMessageTelegramViaMux`
    - `sendStickerTelegramViaMux`
    - `sendPollTelegramViaMux`
    - `createForumTopicTelegramViaMux`
- Rewired `src/telegram/send.ts` mux branches to delegate via shim:
  - `sendMessageTelegram` / `sendMessageTelegramViaMux`
  - `reactMessageTelegram`
  - `deleteMessageTelegram`
  - `editMessageTelegram`
  - `sendStickerTelegram`
  - `sendPollTelegram`
  - `createForumTopicTelegram`
- Kept direct grammY path behavior intact; only mux-specific request construction/sending moved.

Validation run:

- `pnpm exec oxfmt --check src/telegram/send.ts src/telegram/transport.ts`
- `pnpm vitest run src/telegram/send.test.ts src/telegram/send.proxy.test.ts src/channels/plugins/outbound/mux-routing.test.ts`
  - result: 3 files passed, 76 tests passed

Notes:

- `MuxTransportOpts` remains exported from `src/telegram/send.ts` as a compatibility type alias to the transport shim type.

## Baseline

Date: 2026-02-22
Reference: `v2026.2.17`
PR side: `HEAD`

Current metrics (`pnpm metrics:patch`):

- `mux-upstream`: **1,681 lines** (`+1,327 / -354`) across 33 files
- `mux-new`: **19,192 lines**
- `patch size (modified-only)`: **2,136 lines**
- `complexity`: **27,420 lines**

Comparison (`pnpm metrics:patch -- --compare phala-2026.2.17`):

- Patch size: `1,485 -> 2,136` (`+651`)
- Complexity: `25,105 -> 27,420` (`+2,315`)
- Mux upstream: `1,031 -> 1,681` (`+650`)
- Mux new: `18,309 -> 19,192` (`+883`)

## What Was Corrected In This Pass

### Misclassification fix

The following files were moved out of `mux-upstream` and treated as mux-new work by group ordering and globs:

- `src/channels/plugins/mux-envelope.ts`
- `src/telegram/callback-actions.ts`
- `src/config/types.mux.ts`

Config changes in `patch-metrics.config.json`:

- Removed those files from `mux-upstream` patterns.
- Added `src/channels/plugins/mux-envelope.ts` and `src/telegram/callback-actions.ts` to `mux-new` patterns.
- Replaced broad `src/config/types.*.ts` match with explicit upstream files:
  - `src/config/types.telegram.ts`
  - `src/config/types.discord.ts`
  - `src/config/types.whatsapp.ts`
  - `src/config/types.gateway.ts`

Net effect:

- `mux-upstream` reduced from 2,565 to **1,681** lines.
- `mux-new` increased accordingly.

## Current Hotspots Inside mux-upstream

### Top files by line churn

- `src/telegram/send.ts`: 327
- `src/telegram/draft-stream.test.ts`: 196
- `src/telegram/bot-message-dispatch.ts`: 153
- `extensions/whatsapp/src/channel.ts`: 150
- `extensions/discord/src/channel.ts`: 149
- `src/telegram/draft-stream.ts`: 110
- `extensions/telegram/src/channel.ts`: 101
- `src/agents/tools/telegram-actions.ts`: 72
- `src/channels/plugins/outbound/discord.ts`: 63
- `src/channels/plugins/outbound/telegram.ts`: 53
- `src/channels/plugins/outbound/whatsapp.ts`: 52

### Functional buckets (inside 1,681 lines)

1. Telegram transport core: **643**

- `src/telegram/send.ts`
- `src/telegram/draft-stream.ts`
- `src/telegram/bot-message-dispatch.ts`
- `src/channels/plugins/outbound/telegram.ts`

2. Telegram transport tests: **221**

- `src/telegram/draft-stream.test.ts`
- `src/telegram/bot-message-dispatch.test.ts`
- `src/telegram/bot.create-telegram-bot.test.ts`

3. Extension outbound duplication: **400**

- `extensions/telegram/src/channel.ts`
- `extensions/discord/src/channel.ts`
- `extensions/whatsapp/src/channel.ts`

4. Core cross-channel outbound duplication: **115**

- `src/channels/plugins/outbound/discord.ts`
- `src/channels/plugins/outbound/whatsapp.ts`

5. Non-transport drift mixed into mux-upstream: **250**

- `src/telegram/bot-access.ts`
- `src/agents/tools/telegram-actions.ts`
- `src/infra/device-identity*.ts`
- `src/web/inbound/monitor.ts`
- `src/web/outbound.ts`
- `src/auto-reply/*`
- `src/infra/outbound/*`

6. Small plumbing: **52**

- config type touch points
- gateway route registration
- plugin-sdk exports

## Root Causes

### 1) Outbound mux logic is duplicated in two layers

Current state:

- Core outbound adapters (`src/channels/plugins/outbound/*.ts`) include mux checks and mux send logic.
- Extension channel plugins (`extensions/*/src/channel.ts`) also include mux checks and mux send logic.

Result:

- Behavior is harder to keep consistent.
- Any mux policy tweak touches multiple files.
- Rebase surface grows by duplicate edits.

### 2) Telegram send path multiplexes two transports inline

Current state:

- `src/telegram/send.ts` has direct API code and mux envelope code in same file and per-method branches.
- Many public send/edit/delete/react/poll/topic methods carry mux conditionals.

Result:

- Large core file churn.
- Harder to reason about behavior parity between direct and mux paths.

### 3) Draft stream refactor coupled transport concerns into dispatch logic

Current state:

- `src/telegram/draft-stream.ts` moved to transport interface.
- `src/telegram/bot-message-dispatch.ts` now owns explicit transport plumbing and finalize/edit fallback orchestration.

Result:

- More churn in direct-path dispatch code.
- Reusable logic is split across two files with significant touch area.

### 4) Non-mux behavior updates are bundled in mux-upstream group

Examples:

- Telegram allowFrom username normalization updates in `src/telegram/bot-access.ts`
- Tool path updates in `src/agents/tools/telegram-actions.ts`
- Infra and web monitor updates

Result:

- Metric signal is noisy for mux-only complexity.
- Makes “how big is mux patch?” harder to answer accurately.

## Refactor Principles

1. Keep mux-specific mechanics in mux-specific modules.
2. Keep direct-path channel implementations mostly unchanged.
3. Prefer one extension point over repeated per-channel conditionals.
4. Separate behavior changes from transport refactor changes.
5. Stage changes so each phase is testable and revertable.

## Target Architecture

### A. Single outbound mux overlay per channel family

Create one shared helper (example path):

- `src/channels/plugins/outbound/mux-overlay.ts`

Responsibilities:

- Resolve mux enablement once.
- Build normalized raw payload from channel-neutral context.
- Call `sendViaMux`.
- Return typed `OutboundDeliveryResult`.

Channel adapters then become:

- direct send path only
- optional call to shared overlay
- minimal per-channel raw builder hooks

### B. Extension plugins delegate outbound to shared adapters

Instead of implementing parallel mux logic in each extension plugin, extensions should:

- depend on shared outbound adapters from core, or
- use a tiny extension wrapper with no custom mux flow duplication

Goal:

- avoid N copies of `isMuxEnabled` + `sendViaMux` logic.

### C. Telegram transport boundary shim

Add Telegram transport shim (example):

- `src/telegram/transport.ts`

Expose a narrow interface for send/edit/delete/react/poll/topic operations.

`src/telegram/send.ts` should:

- resolve transport once (direct vs mux)
- call transport methods
- keep media and formatting decisions centralized
- avoid repeated `if (opts.mux)` branches per method

### D. Draft stream responsibilities re-split

Keep stream state machine in `draft-stream.ts` and keep dispatch orchestration thin.

Potential approach:

- provide helper that returns `{stream, finalize, cleanup}` for Telegram context
- hide edit-vs-send fallback complexity behind that helper

### E. Split non-transport changes out of mux-upstream tracking

Files that are not required for transport parity should either:

- be moved to non-mux groups in metrics config, and/or
- be split into separate commits/PRs during future iterations

## Detailed Phased Plan

### Phase 0 (done): metric hygiene and classification

Done in this pass.

- reclassified mux-new files out of mux-upstream
- removed broad globs that miscount mux-new as upstream

### Phase 1: remove duplicated outbound mux logic

Changes:

1. Add shared mux overlay helper.
2. Refactor core adapters:
   - `src/channels/plugins/outbound/telegram.ts`
   - `src/channels/plugins/outbound/discord.ts`
   - `src/channels/plugins/outbound/whatsapp.ts`
3. Refactor extension adapters:
   - `extensions/telegram/src/channel.ts`
   - `extensions/discord/src/channel.ts`
   - `extensions/whatsapp/src/channel.ts`
4. Ensure parity for `sendText`, `sendMedia`, `sendPayload`, `sendPoll` semantics.

Expected savings in mux-upstream:

- conservative: 280-350 lines
- likely: 350-450 lines

Risk:

- payload shape mismatch to mux-server (`raw.*` contract)

Mitigation:

- snapshot tests for generated outbound payloads
- integration smoke against local mux-server

### Phase 2: Telegram transport shim

Changes:

1. Introduce transport shim in `src/telegram`.
2. Move mux-specific request construction out of `send.ts` internals where possible.
3. Keep current public APIs stable.
4. Collapse repeated mux branches in:
   - `sendMessageTelegram`
   - `editMessageTelegram`
   - `deleteMessageTelegram`
   - `reactMessageTelegram`
   - `sendStickerTelegram`
   - `sendPollTelegram`
   - `createForumTopicTelegram`

Expected savings:

- conservative: 180-250 lines
- likely: 250-350 lines

Risk:

- regressions in media and caption split behavior

Mitigation:

- add parity fixtures for media method mapping
- explicit tests for split caption/follow-up text and thread/reply params

### Phase 3: Draft stream simplification

Changes:

1. Encapsulate finalize-edit fallback path into helper object.
2. Keep `bot-message-dispatch.ts` focused on sequencing, not transport details.
3. Reduce direct-path churn around preview lifecycle.

Expected savings:

- conservative: 80-120 lines
- likely: 120-180 lines

Risk:

- edge cases in stream finalization and cleanup ordering

Mitigation:

- keep old tests and add regression tests around:
  - regressive final text suppression
  - final too-long fallback path
  - preview clear behavior

### Phase 4: isolate non-transport drift

Changes:

1. Move non-transport files to non-mux metrics groups.
2. Optionally separate from mux branch or tag as independent workstream.

Expected savings in mux-upstream metric:

- immediate metric reduction: up to ~250 lines

Risk:

- none functionally; this is metric taxonomy and branch hygiene

Mitigation:

- keep explicit mapping in config and docs

## Savings Model

Starting point: `mux-upstream = 1,681`

Conservative path:

- Phase 1: -280
- Phase 2: -180
- Phase 3: -80
- Phase 4: -200
- Remaining: **~941**

Likely path:

- Phase 1: -380
- Phase 2: -280
- Phase 3: -140
- Phase 4: -250
- Remaining: **~631**

Aggressive but realistic path:

- Phase 1: -450
- Phase 2: -350
- Phase 3: -180
- Phase 4: -250
- Remaining: **~451**

Interpretation:

- A well-structured refactor can likely reduce mux-upstream by **~1,000 lines**.
- Getting below ~450 likely requires strict enforcement of transport-boundary isolation and no additional unrelated drift.

## Validation and Safety Gates

For each phase:

1. `pnpm metrics:patch`
2. `pnpm metrics:patch -- --compare phala-2026.2.17`
3. channel-targeted tests for touched adapters
4. mux-server local integration check (especially for raw payload shape)

Behavior gates to preserve:

- Telegram argsMenu callbacks and inline buttons
- Draft stream finalization behavior
- cross-channel payload fallback (`text`, `mediaUrl`, `mediaUrls`)
- poll and action semantics

## Useful Knowledge for Future Refactor

### Contract facts that matter

1. First-match group classification controls metrics.
2. `sendViaMux` requires `sessionKey` when mux enabled.
3. Mux-server expects raw envelopes for Telegram and supports either raw body or simplified send forms for Discord/WhatsApp.
4. Channel adapters should not assume mux-server fallback behavior without explicit payload shape guarantees.

### Common pitfalls

1. Broad globs (`types.*`) accidentally classify mux-new files as upstream.
2. Duplicating mux checks in both core and extension layer causes rebase churn.
3. Mixing feature work with transport work destroys metric signal.
4. Reworking draft-stream without preserving stop/clear ordering can break preview cleanup.

### Refactor sequencing advice

1. Extract shared helpers first (no behavior changes).
2. Move call sites to helpers second.
3. Remove duplicated legacy branches last.
4. Keep each phase small enough that failures can be bisected quickly.

### Suggested commit slicing

1. Metrics-only taxonomy commits.
2. Shared helper introduction.
3. Core adapter migrations.
4. Extension adapter migrations.
5. Telegram transport shim.
6. Draft stream simplification.
7. Cleanup and dead-code removal.

## Open Questions

1. Should extension plugins continue to own full outbound logic, or should core adapters be canonical and extensions delegate?
2. Do we want stricter group definitions that only count modified-existing files in `mux-upstream` by construction?
3. Should `mux-upstream` include test files, or track code-only separately?

## Immediate Next Step Recommendation

Start with Phase 1 (shared outbound mux overlay) because it has the best effort-to-savings ratio and lowest behavioral risk.
