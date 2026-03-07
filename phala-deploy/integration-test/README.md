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
- Telegram DM round-trip coverage in both resolver modes for:
  - plain text reply
  - reaction via `message` tool
  - document send via `message` tool
  - reaction -> document -> final text in one scripted multi-tool exchange
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

- Telegram group and forum-topic mocked round-trip
- Telegram callback/edit round-trip
- Telegram media/voice mocked round-trip
- Telegram poll round-trip from the real current-channel prompt/tool surface
- mixed old/new OpenClaw fleets against one mux-server instance
- restart and retry/queue scenarios
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

The current DM integration tests load a reusable JSON template fixture and then apply scenario-specific overrides. That is a better framework shape than inline payload literals, but it is still only an interim step until we replace the template with sanitized real Bot API captures.

## Recommended fixture model

Keep two layers of Telegram fixtures:

1. Golden real payloads
   - captured from real Telegram Bot API traffic
   - sanitized before commit
   - one sample per important routing shape

2. Minimal derived fixtures
   - reduced payloads derived from those golden samples
   - used when the test only needs a smaller contract

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

1. replace the current DM hand-authored fixture with a sanitized real Telegram sample
2. add table-driven Telegram scenarios that run in both resolver modes
3. replace the DM template fixture with a sanitized real DM payload
4. add mocked media/voice round-trip cases
5. add mocked callback/edit cases
6. add restart and delayed-send coverage

Next:

1. add mixed-semantics coverage against one mux-server instance
2. add Discord mocked round-trip
3. add WhatsApp mocked round-trip

Long term:

1. make mux-server embeddable for tests instead of spawning a child process
2. add a more explicit OpenClaw integration bootstrap/profile to reduce env wiring
3. drive the whole suite from a shared fixture table and differential assertions against vanilla routing behavior
