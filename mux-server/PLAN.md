# Mux Path Plan

## Status

This document defines the target behavior for the new mux path on top of `v2026.2.17`.

It supersedes the older "dedicated mux account" model documented in `mux-server/README.md`.
The target model is:

- mux is a transport layer
- mux follows vanilla OpenClaw business routing as closely as possible
- mux is applied only to the channel's default-account path
- mux is singleton; other channel accounts stay out of scope

## Goals

- Match vanilla OpenClaw business behavior for Telegram, Discord, and WhatsApp as closely as possible.
- Eliminate inbound/outbound session asymmetry in the mux path.
- Keep tenant isolation at the instance/auth layer, not in `sessionKey`.
- Preserve safe delivery: no wrong-tenant, wrong-chat, or wrong-thread sends.
- Support mixed OpenClaw fleets during rollout by making mux-server accept both legacy and canonical outbound semantics.
- Keep the patch small relative to upstream by concentrating mux behavior at the transport boundary.
- Support phased migration from legacy mux semantics to vanilla-first semantics without requiring an all-at-once fleet cutover.

## Non-goals

- Full multi-account parity for mux. This plan intentionally treats mux as default-account-only.
- Removing `sessionKey` from the mux wire contract.
- Auto-merging legacy and canonical session history in OpenClaw storage.
- Sticky aliasing of shared canonical session keys inside mux-server.

## Terms

- `business account`: the OpenClaw account used by normal channel routing.
- `default account path`: the same account path vanilla uses when no explicit non-default account is selected.
- `transport sessionKey`: the `sessionKey` carried over the mux wire.
- `canonical sessionKey`: the session key derived by vanilla route/session logic.
- `exact route binding`: the stored mux mapping keyed by `(tenant, channel, sessionKey)`.
- `request-target fallback`: mux-server route recovery using explicit target data from the outbound request (`to`, thread/topic ids, raw target fields).

## Core Rules

### 1. Tenant isolation

- Tenant isolation is enforced by `openclawId` and mux-issued runtime JWTs.
- `sessionKey` and `accountId` are not tenant boundaries.
- mux-server must never route across tenants even if session keys collide.

#### Current trust boundary

- For runtime JWT auth, mux-server authenticates the tenant from the JWT subject and also requires:
  - `X-OpenClaw-Id` header to match that tenant identity
  - `payload.openclawId` to match that tenant identity
- For legacy API-key auth, tenant identity is still derived from the API key.
- Outbound route resolution is tenant-scoped:
  - exact session binding lookup is keyed by `(tenant, channel, sessionKey)`
  - request-target fallback lookup is keyed by `(tenant, channel, routeKey)`
- Raw provider payloads do not get to choose the final destination directly:
  - Telegram `chat_id` is overwritten to the resolved bound route
  - Discord send path posts to the resolved bound channel/thread, not an arbitrary body field
  - WhatsApp always sends to the resolved bound chat JID

#### Important nuance

- Current mux-server does properly isolate tenants from each other.
- Current mux-server does **not** fully treat OpenClaw as untrusted **within** a tenant when a binding is intentionally coarse.
- Examples:
  - a guild-bound Discord route can target different channels in that same bound guild
  - a chat-bound Telegram route can target topics in that same bound chat when the request carries an explicit thread/topic id
- This is still same-tenant only, not cross-tenant. If stricter same-tenant route locking is required, that is a separate hardening step.

### 2. Account model

- mux is a singleton transport for the default account path only.
- The legacy account id `mux` is treated as a backward-compat alias of the default account.
- Explicit non-default account ids are out of scope for mux behavior.
- If OpenClaw explicitly uses a non-default account, that path should use the native channel transport, not mux.
- mux-server should not require non-default account ids to resolve default-path traffic.

### 3. Vanilla business parity

- Inbound mux events should enter OpenClaw with the same business `AccountId` and `SessionKey` that the native channel path would derive.
- Outbound mux sends should use the same resolved channel/account/target/thread that vanilla OpenClaw would send to.
- `sessionKey` is transport context, not business-routing truth.

### 4. Safety over convenience

- If mux-server cannot resolve an outbound route safely, it must fail with `ROUTE_NOT_BOUND`.
- mux-server must not persist a shared canonical alias that could later send to the wrong DM or thread.
- Typing and other non-final actions are best-effort. If they cannot be routed safely, they should fail or no-op rather than guess.

## Target Behavior

### Inbound: mux-server -> OpenClaw

#### Transport contract

- mux-server continues to send the current wire shape:
  - `channel`
  - `sessionKey`
  - `accountId`
  - `to`
  - `threadId`
  - `channelData`
  - `raw`
  - `openclawId`
- This keeps rollout compatibility with legacy OpenClaw nodes.

#### OpenClaw business normalization

- OpenClaw treats inbound mux `sessionKey` as transport input, not authoritative business identity.
- For Telegram, Discord, and WhatsApp mux ingress:
  - `AccountId` is normalized to the channel default account path
  - legacy `accountId: "mux"` is normalized to the default account path
  - explicit non-default account ids are ignored for mux business routing
- OpenClaw derives canonical `SessionKey` using the same native route/session logic as direct channel handling.

#### Expected canonical session outcomes

- Telegram DM:
  - if `dmScope=main`, session collapses to `agent:<agentId>:main`
  - otherwise it follows vanilla peer/channel/account rules
- Telegram group/forum:
  - group identity is preserved
  - forum topic identity is preserved
- Discord DM:
  - follows vanilla DM route logic
- Discord guild/thread:
  - follows vanilla channel/thread route logic
- WhatsApp direct/group:
  - follows vanilla route logic using the default account path

#### Result

- Session persistence, transcript history, `lastAccountId`, and immediate replies all operate on the canonical vanilla business identity.
- Inbound and outbound no longer intentionally use different business accounts.

### Outbound: OpenClaw -> mux-server

#### Transport selection

- mux transport is enabled only for the default account path.
- Explicit non-default accounts must not enter mux transport.
- Telegram, Discord, and WhatsApp outbound adapters must make the same enable/disable decision.

#### Session key selection

- OpenClaw derives outbound mux `sessionKey` from the resolved outbound route.
- It should not preserve the original inbound mux `sessionKey` just to keep transport affinity.
- `mirror.sessionKey` remains transcript/internal-hook context only.

#### When OpenClaw falls back to the caller-provided `sessionKey`

OpenClaw should use the caller-provided `sessionKey` only when it cannot derive a canonical outbound route.

That happens in practice when:

- no `agentId` is available, so route derivation is skipped
- the outbound `target` is blank
- the outbound `target` is malformed for the channel and cannot be parsed into a valid route

Examples:

- malformed Telegram target with no chat id
- malformed Discord target that cannot be parsed
- malformed WhatsApp target that cannot be normalized to a chat JID

This should be rare in normal product flows because most user-facing send paths already resolve a normalized `to` target before delivery.

#### Callsite behavior

All production outbound paths that can hit mux should obey the same rule:

- direct reply
- cron / isolated cron
- heartbeat
- queue replay
- direct agent delivery
- restart sentinel
- maintenance warning
- node/server receipt paths
- poll/message action paths where mux is supported

For each of these:

- default-account path -> mux using the route-derived canonical session
- explicit non-default account -> native transport

### Outbound: mux-server route resolution

#### Resolution order

For each outbound request:

1. Try exact binding lookup by `(tenant, channel, sessionKey)`.
2. If exact lookup misses, try request-target fallback using explicit target information from the request.
3. If fallback still cannot resolve safely, return `403 ROUTE_NOT_BOUND`.

#### Fallback rules

- Fallback is per request only.
- Fallback must not write a sticky alias row for shared canonical sessions.
- Fallback may use:
  - Telegram: `to`, `raw.telegram.body.chat_id`, topic/thread context
  - Discord: `to`, requested thread/channel target
  - WhatsApp: `to`, normalized JID/chat target
- Fallback must still remain tenant-scoped and route-locked.

#### When exact session binding misses

Exact session binding miss is expected when:

- the outbound `sessionKey` is canonical (for example `agent:main:main`) but mux only has an older route bound under a legacy chat-specific session key
- the route was paired before the canonical-session refactor and has not been rebound under the new session key
- the route was unpaired, deactivated, or rebound and the old session mapping is gone

#### When request-target lookup fails

Request-target lookup fails when either:

- mux-server cannot build any safe route candidates from the request
- mux-server does build candidates, but none match an active binding for that same tenant and channel

Examples:

- Telegram request has no usable `to` and no usable `raw.telegram.body.chat_id`
- Discord request has no usable `to`, or thread/channel metadata cannot be resolved into a valid guild route
- WhatsApp request `to` cannot be normalized into a chat JID
- the requested chat/thread/channel exists, but that tenant does not have an active binding for it
- the requested target is outside the bound guild/chat safety rules

#### Non-final actions

- Typing/actions should prefer exact binding resolution.
- If a safe explicit target is available in the request, fallback may be used.
- If no safe target is available, mux-server must not infer a route from a shared canonical session.

#### Current implementation note

- Current mux-server action handling is stricter than the target rule above.
- Today, typing/actions use exact session binding only.
- They do not currently use request-target fallback.

## Compatibility Model

### Supported mixed fleet

The supported rollout target is:

- old OpenClaw -> new mux-server
- new OpenClaw -> new mux-server

Both should work at the same time.

### Resolution policy phases

This should be implemented as a phased resolver policy, not a one-shot switch.

#### Phase 1: mixed fleet / session-first

- Purpose: support old and new OpenClaw nodes at the same time.
- Outbound `send` resolution order:
  1. exact `(tenant, channel, sessionKey)` binding
  2. request-target fallback
  3. fail with `ROUTE_NOT_BOUND`
- This is the required migration mode.

#### Phase 2: migrated fleet / target-first

- Purpose: move behavior closer to vanilla once most or all OpenClaw nodes are migrated.
- Outbound `send` resolution order:
  1. request-target resolution
  2. exact session binding as legacy fallback
  3. fail with `ROUTE_NOT_BOUND`
- In this phase, the resolved outbound target becomes the primary authority, which is closest to vanilla business behavior.

#### Phase 3: cleanup / target-only or simplified target-first

- Purpose: remove legacy compatibility code after the migration is complete and confidence is high.
- Candidate end states:
  - `target-first` with a minimal legacy fallback kept for safety
  - `target-only` if the fleet and stored bindings no longer require session-first compatibility
- This phase should remove stale docs, compatibility branches, and legacy tests.

### Recommended config shape

Use an explicit resolver mode flag rather than a boolean compatibility switch.

Recommended values:

- `session-first`
  - mixed-fleet migration mode
- `target-first`
  - intended steady-state mode
- optional future `target-only`
  - only after full migration and cleanup

The flag should govern `send` resolution policy only. Typing/action behavior may remain stricter until explicit target-bearing action payloads exist.

### Legacy semantics to keep accepting

- legacy mux-specific `sessionKey` values
- legacy `accountId: "mux"`
- existing pairing bindings stored under old session keys

### Canonical semantics to support

- vanilla-style canonical `sessionKey` values such as `agent:main:main`
- default-account business path instead of a dedicated `mux` business account

### Explicitly unsupported rollout shape

- new OpenClaw -> old mux-server

That path can still fail with `ROUTE_NOT_BOUND` because old mux-server does not know request-target fallback.

### OpenClaw fallback observability

- OpenClaw should emit a warning whenever outbound delivery falls back from a derived canonical route to the caller-provided `sessionKey`.
- This warning is a migration diagnostic, not a user-facing error.
- The goal is to drive those warnings toward zero over time before removing the legacy fallback path.

## Migration Notes

- This change should not cause persistent-data read failures.
- Existing queue/session files remain readable.
- Some active chats may move from a legacy mux-specific session bucket to a canonical vanilla session bucket.
- That can look like a one-time context split, not a delivery failure.
- The impact is bounded in environments that already roll sessions daily.
- Memory can reduce the user-visible impact, but it is a mitigation, not a substitute for session continuity.

## Config Direction

### Desired operator model

- mux is enabled or disabled per channel as a transport feature
- operators should not need to create a separate OpenClaw `mux` account
- direct/default account and mux transport should behave like the same business account

### Compatibility knobs

- `MUX_OPENCLAW_ACCOUNT_ID` should default to `default`
- `MUX_OPENCLAW_ACCOUNT_ID=mux` remains compatibility-only and should not be recommended
- legacy OpenClaw account config like `accounts.mux.mux.enabled` may remain temporarily supported, but the target model should not depend on it

## Acceptance Criteria

- mux DM, group, thread/topic behavior matches vanilla business routing for the default-account path
- no known production outbound path silently drops the route-derived mux session context
- non-default account sends do not accidentally go through mux
- new OpenClaw works against new mux-server
- old OpenClaw still works against new mux-server
- canonical session fallback never creates a sticky alias that can later misroute another chat

## Test Plan

The test plan is split into:

- required automated coverage
- required local E2E coverage
- required manual release checks

### Current status (2026-03-08)

Already covered:

- OpenClaw route-derived mux session coverage across the known production outbound paths
- mux-server exact binding and request-target fallback behavior for Telegram, Discord, and WhatsApp
- mux-server resolver-mode behavior for `session-first` and `target-first`
- real local Telegram E2E for pairing, DM round-trip, multi-action reply, file proxy, and forum/topic routing
- mocked Telegram DM/group/forum round-trip integration with real OpenClaw + real mux-server in both resolver modes
- mocked Telegram AI streaming preview/edit round-trip integration in both resolver modes, including typing-before-preview and forum-topic thread targeting
- mocked Telegram command-menu and callback-edit round-trip integration in both resolver modes
- mocked Telegram media sends for photo and voice via the real `message` tool surface in both resolver modes
- mocked Telegram restart recovery for both gateway `send` and agent-generated final replies after queued delivery failure in both resolver modes
- full OpenClaw inbound normalization matrix across Telegram, Discord, and WhatsApp channel shapes
- full non-default-account mux bypass matrix across Telegram, Discord, and WhatsApp adapters
- full old/new queue persistence compatibility matrix
- mux-server negative safety coverage for canonical sessions without safe explicit targets

Still incomplete:

- full mux-server negative safety matrix beyond the no-safe-target canonical cases
- manual release checks for Discord and WhatsApp

### Fixture policy

- Telegram mocked integration fixtures should come from sanitized real Bot API payloads wherever possible.
- Minimal hand-authored Telegram fixtures are acceptable only as temporary coverage or when the test intentionally isolates a smaller contract.
- We should keep a small set of golden real Telegram payloads for DM, group, forum topic, callback, photo, document, and voice flows, then derive smaller fixtures from those samples when possible.
- Fake OpenAI responses may remain synthetic and deterministic as long as they continue to match the Responses API event contract that OpenClaw consumes.
- For mocked round-trip coverage, OpenAI fixtures should be scripted by behavior, not by prose diversity. The purpose is to deterministically trigger the outbound code path under test.
- Basic text replies are sufficient for plain `sendMessage` coverage, but reaction/document/poll/media paths should use scripted OpenAI Responses API turns that emit `function_call` / `function_call_output` items to drive the real OpenClaw tool pipeline.
- The mocked integration harness should therefore support scenario-level OpenAI scripts such as:
  - plain final text
  - tool call -> tool output -> final text
  - tool call sequences that trigger reactions, documents/files, polls, and other message actions
- OpenAI fixture design should prioritize protocol compatibility and path coverage over model realism.
- Current status: plain text, reaction, document, photo, and voice scripted Telegram DM scenarios are covered; plain-text group/forum-topic scenarios are covered in both resolver modes; and callback-driven Telegram command/edit flows are covered for `/reasoning` and `/models`. Poll is still pending because the real current-channel Telegram message-tool schema does not expose `poll` yet, so a mocked poll round-trip should wait for a real prompt-surface path instead of testing an artificial one.
- Current captured-fixture status:
  - golden real payloads are in place for DM text, group text, forum-topic text, callback query, photo, document, and voice
- Current mocked Telegram priority after restart/send recovery: broader safety cases outside Telegram DM. Non-Telegram mux-server parity now has targeted Discord and WhatsApp safety coverage; the next gap is full mocked non-Telegram round-trip.

### A. Required automated coverage: OpenClaw unit/contract tests

#### 1. Account normalization

- `resolveMuxBusinessAccountId`
  - omitted account -> resolves to channel default
  - `mux` -> resolves to channel default
  - `default` -> resolves to channel default
  - explicit non-default -> still resolves to channel default for mux business routing
- `isMuxEnabled`
  - true for omitted / `mux` / `default`
  - false for explicit non-default

#### 2. Inbound normalization by channel

For each case, assert:

- `ctx.AccountId` equals the default account path
- `ctx.SessionKey` equals the native route-derived session
- `Surface` / `OriginatingChannel` behavior stays correct

Cases:

- Telegram DM
- Telegram group
- Telegram forum topic
- Discord DM
- Discord guild channel
- Discord thread
- WhatsApp DM
- WhatsApp group

Also cover input variants:

- no `accountId`
- `accountId: "mux"`
- explicit non-default `accountId`

#### 3. Outbound mux gating

For each channel adapter:

- default-account path uses mux
- explicit non-default account bypasses mux
- direct send path still works for non-default accounts

Channels:

- Telegram
- Discord
- WhatsApp

#### 4. Outbound route-derived session behavior

For each path below, assert the mux `sessionKey` comes from the resolved outbound route, not the original inbound session:

- direct reply routing
- isolated cron delivery
- main-session heartbeat
- queued retry replay
- direct `openclaw agent --deliver`
- restart sentinel
- maintenance warning
- node/server receipt paths
- poll/message-action paths that can reach mux

#### 5. Backward-compatible persistence

- old queue entry with only legacy `sessionKey` still replays
- new queue entry with route inputs / `agentId` replays
- loading old persisted data does not throw or reject

### B. Required automated coverage: mux-server tests

#### 1. Exact binding behavior

Per channel, verify exact `(tenant, channel, sessionKey)` binding still works:

- Telegram DM
- Telegram group
- Telegram forum topic
- Discord DM
- Discord guild channel
- Discord thread
- WhatsApp DM
- WhatsApp group

#### 2. Request-target fallback behavior

Per channel, verify canonical-session outbound can still send when explicit target is present:

- Telegram canonical DM session -> fallback by chat id
- Telegram canonical forum session -> fallback by chat id + topic/thread id
- Discord canonical DM session -> fallback by requested target
- Discord canonical thread/channel session -> fallback by requested target
- WhatsApp canonical direct session -> fallback by chat JID
- WhatsApp canonical group session -> fallback by group JID

For each fallback case, assert:

- send succeeds
- resolved route matches the explicit request target
- mux logs `outbound_route_fallback`
- no alias row is persisted for the canonical shared session

#### 3. Negative safety cases

Per channel, verify `ROUTE_NOT_BOUND` is returned when:

- no exact binding exists
- no safe explicit target exists
- explicit target does not match any bound route
- target would cross guild/thread/chat safety rules

#### 4. Typing/action behavior

Per channel, verify:

- typing works on exact bound routes
- typing never guesses an unsafe route from a shared canonical session
- if typing fallback is supported, it only uses explicit safe target data

#### 5. Legacy and canonical contract compatibility

Verify the same mux-server accepts:

- legacy OpenClaw outbound envelopes
  - legacy sessionKey
  - optional `accountId: "mux"`
- new OpenClaw outbound envelopes
  - canonical sessionKey
  - default-account path

For each channel, test both styles against the same tenant and same bound route.

Also verify both resolver policies when implemented:

- `session-first`
- `target-first`

#### 6. Pairing and control paths

Verify:

- claim pairing with explicit sessionKey
- claim pairing without explicit sessionKey
- admin token mint
- bot control `status`
- `unpair`
- `switch`
- repaired claims after restart where applicable

#### 7. Raw send passthrough and route locking

Per channel, verify raw transport still obeys the bound route:

- Telegram raw methods cannot escape bound `chat_id` / topic lock
- Discord raw body/send cannot escape bound channel/thread lock
- WhatsApp raw send cannot escape bound chat lock

#### 8. Restart / DB persistence

Verify:

- exact bindings survive mux-server restart
- compatibility fallback still works after restart
- no canonical sticky alias is created before or after restart

#### 9. Resolver-mode migration coverage

Verify rollout behavior explicitly:

- mixed old/new OpenClaw fleet works under `session-first`
- migrated OpenClaw fleet works under `target-first`
- legacy-only exact binding behavior remains available during migration
- target-first does not regress vanilla-style routed sends
- any future `target-only` mode is gated on separate rollout verification

### C. Required local E2E coverage

#### 1. Telegram E2E: must pass before merge

Run the local Telegram E2E suite and require all current checks to pass:

- pairing / first-contact intro
- DM text round-trip
- DM photo round-trip
- multi-action reply
  - sendMessage
  - sendDocument
  - setMessageReaction
- args menu command reply
- file proxy
- forum/topic routing

#### 2. Telegram mixed-semantics E2E

Add or keep targeted local coverage for:

- [x] old-style mux session traffic
- [x] new canonical-session outbound traffic
- [x] both against the same mux-server instance

Also keep the mocked integration harness under `phala-deploy/integration-test` as the fast path for repeated mixed-semantics validation without live Telegram dependencies.

The mocked integration harness should expand with scripted OpenAI scenarios so one Telegram fixture can exercise multiple outbound behaviors:

- plain text send
- document/file send
- reaction send
- poll/message-action send
- callback/edit follow-up where applicable

#### 3. Restart E2E

At least once before release, verify:

- pair route
- stop/restart mux-server
- outbound still works
- no wrong-chat send occurs

#### 4. Queue / delayed send E2E

At least once before release, verify:

- a delayed or retried OpenClaw send still reaches the correct mux route after restart

### D. Required manual release checks

These are still required even if automated coverage passes.

#### 1. Telegram manual checks

- callback button tap works end to end
- streaming preview/edit path looks correct
- final reply lands in the same chat/topic as the inbound message
- no visible sender/account mismatch on the default path

#### 2. Discord manual checks

- DM round-trip
- guild channel round-trip
- thread round-trip
- typing behavior is acceptable

#### 3. WhatsApp manual checks

- direct chat round-trip
- group round-trip
- typing/fallback behavior is acceptable

### E. Observability checks during rollout

Monitor:

- `ROUTE_NOT_BOUND` errors
- `outbound_route_fallback` logs
- auth failures
- retry scheduling / exhaustion
- queue depth

Expected rollout signal:

- some `outbound_route_fallback` logs are normal while both legacy and canonical semantics coexist
- wrong-route sends are never acceptable

## Implementation Checklist

- [x] add OpenClaw warning when outbound route derivation falls back to caller-provided `sessionKey`
- [x] introduce explicit mux-server outbound resolver mode (`session-first`, then `target-first`)
- [x] keep mux ingress business normalization aligned with native route logic
- [x] keep mux outbound enabled only on the default-account path
- [x] keep mux-server request-target fallback per request only
- [x] do not persist shared canonical aliases
- [ ] update stale mux-server README sections after behavior lands
- [x] keep automated coverage for both legacy and canonical semantics
- [ ] finish the remaining sanitized real Telegram payload fixtures for the mocked integration harness
- [x] add scripted OpenAI Responses fixtures for outbound behavior coverage (tool calls, tool outputs, final message turns)
- [ ] expand the mocked integration harness beyond Telegram DM round-trip
- [ ] remove migration-only compatibility branches after fleet migration completes
