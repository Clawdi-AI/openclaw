# Mux Server (Standalone)

This directory contains a standalone TypeScript mux server for staged rollout and local testing.

## Scope

- Implements `GET /health`
- Implements `GET /v1/pairings`
- Implements `POST /v1/pairings/claim`
- Implements `POST /v1/pairings/unbind`
- Implements `POST /v1/mux/outbound/send`
- Supports Telegram outbound via Bot API:
  - `sendMessage` (text)
  - `sendPhoto` (image with optional caption)
- Supports idempotency via `Idempotency-Key`:
  - Same key + same payload: cached replay
  - Same key + different payload: `409`

## MVP Direction (Simplified)

- Keep one mux process for `1000-2000` users.
- Use one SQLite database for tenant authz, pairing, route bindings, and idempotency.
- Keep mux thin: route/authz checks + platform send/receive mapping only.
- No queue/bus or multi-region architecture in MVP.

## Architecture Placement

This repo now has 3 mux-related pieces:

1. `src/gateway/mux-http.ts`

- OpenClaw inbound adapter (`POST /v1/mux/inbound`)
- Validates mux bearer token from OpenClaw config
- Normalizes inbound payload into OpenClaw message context

2. `src/channels/plugins/outbound/mux.ts`

- OpenClaw outbound client
- Calls external mux server at `/v1/mux/outbound/send`

3. `mux-server/src/server.ts`

- External mux service implementation (this directory)
- Currently Telegram outbound only

In short: OpenClaw inbound/outbound adapters are in `src/`; the standalone mux service is here.

## Run

From repo root:

```bash
pnpm mux:server
```

Direct:

```bash
TELEGRAM_BOT_TOKEN="<bot-token>" \
MUX_API_KEY="outbound-secret" \
node --import tsx mux-server/src/server.ts
```

## Environment

- `TELEGRAM_BOT_TOKEN` (required): Telegram bot token.
- `MUX_API_KEY` (default `outbound-secret`): legacy single-tenant key; seeds default tenant when `MUX_TENANTS_JSON` is unset.
- `MUX_TENANTS_JSON` (optional): JSON array for multi-tenant auth seed.
- `MUX_HOST` (default `127.0.0.1`)
- `MUX_PORT` (default `18891`)
- `MUX_LOG_PATH` (default `./mux-server/logs/mux-server.log`)
- `MUX_DB_PATH` (default `./mux-server/data/mux-server.sqlite`)
- `MUX_IDEMPOTENCY_TTL_MS` (default `600000`)
- `MUX_PAIRING_CODES_JSON` (optional): JSON array to seed pairing codes for testing/bootstrap.

`MUX_TENANTS_JSON` format:

```json
[
  { "id": "tenant-a", "name": "Tenant A", "apiKey": "tenant-a-key" },
  { "id": "tenant-b", "name": "Tenant B", "apiKey": "tenant-b-key" }
]
```

`MUX_PAIRING_CODES_JSON` format:

```json
[
  {
    "code": "PAIR-1",
    "channel": "telegram",
    "routeKey": "telegram:default:chat:-100123",
    "scope": "chat"
  }
]
```

## API Contract

### `GET /health`

- Response: `200 {"ok":true}`

### `POST /v1/mux/outbound/send`

Headers:

- `Authorization: Bearer <tenant_api_key>`
- Optional: `Idempotency-Key: <stable-request-id>`

Body:

```json
{
  "requestId": "uuid",
  "channel": "telegram",
  "sessionKey": "tg:group:-100123:thread:2",
  "to": "-100123",
  "text": "hello",
  "mediaUrl": "https://... or Telegram file_id",
  "replyToId": "123",
  "threadId": 2
}
```

Behavior:

- `to` is required.
- At least one of `text` or `mediaUrl` is required.
- If `mediaUrl` is present, server uses Telegram `sendPhoto` and `text` becomes caption.
- `threadId` maps to Telegram `message_thread_id`.
- `replyToId` maps to Telegram `reply_to_message_id`.

### `POST /v1/pairings/claim`

Headers:

- `Authorization: Bearer <tenant_api_key>`

Body:

```json
{
  "code": "PAIR-1"
}
```

Response `200`:

```json
{
  "bindingId": "bind_...",
  "channel": "telegram",
  "scope": "chat",
  "routeKey": "telegram:default:chat:-100123"
}
```

### `GET /v1/pairings`

Headers:

- `Authorization: Bearer <tenant_api_key>`

Response `200`:

```json
{
  "items": [
    {
      "bindingId": "bind_...",
      "channel": "telegram",
      "scope": "chat",
      "routeKey": "telegram:default:chat:-100123"
    }
  ]
}
```

### `POST /v1/pairings/unbind`

Headers:

- `Authorization: Bearer <tenant_api_key>`

Body:

```json
{
  "bindingId": "bind_..."
}
```

Response `200`:

```json
{ "ok": true }
```

## Reliability Notes

### Idempotency

- Current code stores idempotency entries in SQLite with tenant scope:
- key: `(tenantId, idempotencyKey)`
- compare: request fingerprint
- replay: cached status/body
- Duplicate keys survive process restart.

### Restart Behavior

From local restart drills:

- During restart windows, callers can see transport errors (`code=000`, empty reply, connection reset).
- Some requests may still be processed even if client did not receive a response.

Recommended caller contract:

1. Generate a stable request id per logical send.
2. Reuse it as `Idempotency-Key` on every retry.
3. Retry on network/5xx with backoff.
4. Treat unknown-ack windows as retriable, not hard-fail.

## Telegram-Specific Notes

- `mediaUrl` accepts either an internet URL or Telegram `file_id`.
- Forum topics are preserved when `threadId` is provided.
- Replies can be pinned to parent message with `replyToId`.

## OpenClaw Command Note

In Telegram + OpenClaw flows:

- `/help` is Telegram slash-command style.
- `!help` may be interpreted as command/bang syntax by OpenClaw.

## Tests

From repo root:

```bash
pnpm --dir mux-server typecheck
pnpm --dir mux-server test
```

Current test coverage (`mux-server/test/server.test.ts`):

- health endpoint responds
- outbound endpoint rejects unauthorized requests
- multi-tenant auth via `MUX_TENANTS_JSON`
- pairing claim/list/unbind flow
- duplicate pairing claim conflict handling
- idempotency replay + payload mismatch handling
- idempotency persistence across process restart
