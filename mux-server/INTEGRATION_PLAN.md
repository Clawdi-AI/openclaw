# Mux Integration Plan

This document defines how to run the mux server in production with:

- multiple OpenClaw instances (one per tenant/user)
- one shared control plane (dashboard backend)
- one shared mux-server process

Target scale for MVP: `1000-2000` users on a single mux instance.

## Goals

- Keep OpenClaw instances untrusted with respect to other tenants.
- Keep channel credentials centralized in mux-server.
- Keep pairing simple for end users.
- Keep patch surface on OpenClaw minimal.

## Components

1. Control plane backend

- Owns tenant records and user sessions.
- Calls mux API using tenant API keys.
- Writes tenant OpenClaw config.

2. Shared mux-server

- Holds platform sessions and channel credentials.
- Enforces tenant auth with tenant API keys.
- Stores route bindings and session mappings in SQLite.
- Forwards inbound messages to tenant OpenClaw endpoints.

3. OpenClaw instance per tenant

- Exposes `POST /v1/mux/inbound` with tenant-specific bearer token.
- Sends outbound through mux (`/v1/mux/outbound/send`).

## Trust Model

- Tenant API key authorizes calls from control plane/OpenClaw to mux.
- The same tenant API key authorizes mux calls to tenant OpenClaw inbound endpoint.
- Shared-key mode is the only supported model.
- Route binding checks in mux prevent cross-tenant outbound routing.
- OpenClaw does not receive platform-level bot credentials.

## Data Ownership

- mux SQLite (`MUX_DB_PATH`) stores:
- `tenants` (api key hash + inbound target config)
- `bindings` (channel route binding per tenant)
- `session_routes` (session key to binding)
- `pairing_tokens`, `pairing_codes`, offsets, idempotency, audit logs

## Required API Paths

Control plane to mux:

- `POST /v1/admin/tenants/bootstrap`
- `POST /v1/pairings/token`
- `GET /v1/pairings`
- `POST /v1/pairings/unbind`
- `GET /v1/tenant/inbound-target`
- `POST /v1/tenant/inbound-target`

OpenClaw to mux:

- `POST /v1/mux/outbound/send`

mux to OpenClaw:

- `POST /v1/mux/inbound`

## Provisioning Flow (Per Tenant)

1. Generate secrets

- `tenantApiKey` (for OpenClaw/control-plane to mux)
- Shared-key mode only: mux uses `tenantApiKey` as inbound auth token to OpenClaw.

2. Configure OpenClaw instance

- Enable `gateway.http.endpoints.mux.enabled=true`
- Set `gateway.http.endpoints.mux.token=<tenantApiKey>`
- Enable channel mux transport:
- `channels.telegram.mux`
- `channels.discord.mux`
- `channels.whatsapp.mux`
- Set each channel mux config to:
- `enabled=true`
- `baseUrl=<mux-url>`
- `apiKey=<tenantApiKey>`

3. Register inbound target in mux

- Preferred:
  - `POST /v1/admin/tenants/bootstrap` from control plane backend:
    - `tenantId`
    - `apiKey`
    - `inboundUrl`
    - optional `inboundTimeoutMs`
- Alternative:
  - tenant-scoped `POST /v1/tenant/inbound-target` with tenant API key.

4. Verify

- `GET /v1/tenant/inbound-target` returns `configured=true`.

## Pairing UX Flow

1. User asks dashboard chat to connect channel.
2. Control plane calls `POST /v1/pairings/token` with tenant API key.
3. Control plane shows deeplink/token to user.
4. User sends token in Telegram/Discord DM/WhatsApp chat.
5. mux validates token, creates binding + session route.
6. Subsequent messages forward to tenant OpenClaw.

## Runtime Message Flow

Inbound:

- Platform -> mux ingress (poll/listener) -> binding lookup
- mux -> OpenClaw `POST /v1/mux/inbound` (tenant api key auth token)

Outbound:

- OpenClaw route-reply -> channel outbound adapter
- adapter uses `sendViaMux` -> mux `/v1/mux/outbound/send`
- mux resolves `(tenant, channel, sessionKey)` -> platform route

## Rotation and Updates

- Rotate OpenClaw inbound target/token without mux restart:
- Update OpenClaw config
- Call `POST /v1/tenant/inbound-target` with new values
- New inbound forwards use updated target immediately
- For bootstrap-style control plane workflows:
  - call `POST /v1/admin/tenants/bootstrap` with updated `inboundUrl`

- Rotate tenant API key:
- Call `POST /v1/admin/tenants/bootstrap` with new `apiKey`
- Roll OpenClaw/control-plane to new key
- Revoke old key

## Operational Baseline

- Keep mux behind an internal network or gateway.
- Use HTTPS + restricted ingress at edge.
- Back up SQLite (`MUX_DB_PATH`) regularly.
- Monitor:
- inbound retry logs (`*_retry_deferred`)
- queue depth (`whatsapp_inbound_queue`)
- auth failures (`401`)

## MVP Rollout Plan

1. Deploy shared mux-server with Telegram + Discord + WhatsApp enabled.
2. Integrate control plane backend with pairing + inbound-target APIs.
3. Migrate one tenant slice and verify end-to-end.
4. Roll out tenant-by-tenant.
5. Keep direct channel fallback disabled for mux-enabled tenants.

## Non-Goals (MVP)

- Multi-region mux clustering.
- Cross-node distributed queue.
- Exactly-once delivery guarantees across all hops.
