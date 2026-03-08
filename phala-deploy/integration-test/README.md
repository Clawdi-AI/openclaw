# Integration Test Harness

This directory contains the fast mocked integration suite for the mux path.

The design goal is:

- keep OpenClaw real
- keep mux-server real
- fake only external dependencies
  - Telegram Bot API
  - OpenAI Responses API

That gives us a repeatable test for:

- `Telegram -> mux-server -> OpenClaw -> mux-server -> Telegram`
- canonical session behavior
- resolver-mode behavior (`session-first` and `target-first`)

## Current status

Implemented today:

- per-scenario subprocess runner so every case gets a fresh OpenClaw process
- real OpenClaw gateway started in-process inside that runner
- real mux-server started as a child process
- fake Telegram Bot API server
- fake OpenAI Responses server
- generic sequential OpenAI script runner for multi-turn tool-call scenarios
- Telegram round-trip coverage in both resolver modes for:
  - plain text reply
  - AI streaming preview -> final edit, with typing before the first preview
  - reaction via `message` tool
  - document send via `message` tool
  - photo send via `message` tool
  - voice send via `message` tool
  - reaction -> document -> final text in one scripted multi-tool exchange
  - group plain-text reply
  - forum-topic plain-text reply
  - forum-topic typing -> streaming preview -> final edit
  - `/reasoning` command menu with inline buttons
  - `/models` callback query -> callback acknowledgement -> `editMessageText`
  - restart recovery after queued Telegram failure for:
    - gateway `send`
    - agent-generated final replies
  - mixed semantics on one mux-server instance:
    - legacy inbound traffic through a legacy transport-session binding
    - canonical outbound `gateway send` traffic to the same paired chat
- assertions on:
  - final Telegram outbound request
  - OpenAI prompt receipt
  - OpenClaw session-store state

Current test files:

- [mux-openclaw-harness.ts](./mux-openclaw-harness.ts)
- [fake-telegram.ts](./fake-telegram.ts)
- [fake-openai.ts](./fake-openai.ts)
- [fixtures.ts](./fixtures.ts)
- [telegram-scenarios.ts](./telegram-scenarios.ts)
- [telegram-scenario-runner.ts](./telegram-scenario-runner.ts)
- [telegram.mux-roundtrip.shared.ts](./telegram.mux-roundtrip.shared.ts)
- [telegram.mux-roundtrip.session-first.e2e.test.ts](./telegram.mux-roundtrip.session-first.e2e.test.ts)
- [telegram.mux-roundtrip.target-first.e2e.test.ts](./telegram.mux-roundtrip.target-first.e2e.test.ts)
- [vitest.config.ts](./vitest.config.ts)

Not covered yet:

- Telegram poll round-trip from the real current-channel prompt/tool surface
- Discord and WhatsApp mocked round-trip

## Architecture

The harness flow is:

1. create an isolated temp `HOME` and OpenClaw state dir
2. write a test OpenClaw config that enables mux
3. start fake Telegram
4. start fake OpenAI
5. start the real OpenClaw gateway
6. start the real mux-server
7. claim a Telegram pairing against mux-server
8. inject Telegram updates into the fake Telegram poll queue
9. wait for:
   - fake Telegram outbound requests
   - fake OpenAI requests
   - OpenClaw session-store writes

Vitest does not run the harness directly anymore. Each test spawns [telegram-scenario-runner.ts](./telegram-scenario-runner.ts), which runs one full scenario in a fresh subprocess. That keeps OpenClaw global state, timers, and cached modules from leaking across scenarios.

The Vitest suite itself is batched by resolver mode. Each resolver-mode test iterates through the Telegram scenario table and spawns a fresh [telegram-scenario-runner.ts](./telegram-scenario-runner.ts) subprocess per scenario. That keeps per-scenario isolation while avoiding the "24 long child-process tests that look frozen" problem in Vitest progress output.

The suite uses a dedicated Vitest config because the repo-wide unit/e2e setup installs stubs that interfere with the real mux outbound path.
Tests should prefer the scoped `withMuxOpenClawHarness(...)` helper over manual `start/close` calls so env and process cleanup always stay tied to the test body.

## How to run

```bash
pnpm exec vitest run --config phala-deploy/integration-test/vitest.config.ts
```

## Fixture policy

OpenAI fixtures:

- synthetic deterministic responses are acceptable
- the important part is protocol compatibility with the Responses API event stream
- prefer generic sequential tool-call scripts over bespoke per-scenario branching logic

Telegram fixtures:

- the long-term source of truth should be sanitized real Bot API payloads
- hand-authored payloads should be treated as temporary or minimal-contract fixtures

The current Telegram integration tests now prefer golden captured fixtures under `fixtures/telegram/golden/**`, with fallback to the older hand-authored templates when a live capture is not available yet.

Current golden coverage:

- DM text
- group text
- forum-topic text
- callback query
- photo
- document
- voice

## Recommended fixture model

Keep two layers of Telegram fixtures:

1. Golden real payloads
   - captured from real Telegram Bot API traffic
   - sanitized before commit
   - one sample per important routing shape

2. Minimal derived fixtures
   - reduced payloads derived from those golden samples
   - used when the test only needs a smaller contract

## Capture Workflow

Use the local Telegram E2E stack to collect real Bot API traffic:

```bash
MUX_TELEGRAM_API_BASE_URL=http://telegram-capture:18990 \
  ./phala-deploy/local-mux-e2e/scripts/up.sh

./phala-deploy/local-mux-e2e/scripts/e2e-telegram.sh

node --import tsx phala-deploy/local-mux-e2e/scripts/export-telegram-fixtures.ts
```

That flow writes:

- raw captures: `phala-deploy/local-mux-e2e/state/telegram-capture/captures.ndjson`
- sanitized golden fixtures: `phala-deploy/integration-test/fixtures/telegram/golden/*.sample.json`

The first golden set should include:

- DM text
- group text
- forum topic text
- callback query
- photo
- document
- voice

## Roadmap

Near term:

1. add table-driven Telegram scenarios that run in both resolver modes
2. extend restart and delayed-send coverage beyond gateway `send`
3. broaden mixed-fleet coverage beyond Telegram DM

Next:

1. add Discord mocked round-trip
2. add WhatsApp mocked round-trip
3. broaden mux-server negative safety matrix

Long term:

1. make mux-server embeddable for tests instead of spawning a child process
2. add a more explicit OpenClaw integration bootstrap/profile to reduce env wiring
3. drive the whole suite from a shared fixture table and differential assertions against vanilla routing behavior
