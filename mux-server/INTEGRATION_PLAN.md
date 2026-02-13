# Mux Integration Plan (Control Plane Focus)

## Audience

This doc is for engineers who:

- build the control plane backend + dashboard
- provision OpenClaw instances programmatically
- operate one shared mux server for many tenants

Target scale (MVP): `1000-2000` users on one mux instance.

## What You Need To Build

1. Tenant bootstrap flow
   - Generate one `tenantApiKey` per tenant.
   - Deploy tenant OpenClaw with mux enabled and that key injected.
   - Register tenant in mux with inbound target.

2. Pairing UX in dashboard
   - "Pair" action calls mux to create a one-time pairing token.
   - Show deep link/token to user.
   - Show active bindings list.
   - Support unbind.

3. Tenant-safe messaging path
   - OpenClaw sends outbound via mux.
   - mux forwards inbound to tenant OpenClaw.
   - All auth is tenant-scoped with `tenantApiKey`.

## What You Do Not Need To Care About

- platform bot/session credentials (owned by mux)
- channel polling internals in mux (Telegram/Discord/WhatsApp listeners)
- mux DB internals beyond backup/restore
- transport-level payload conversion details in OpenClaw

If these are needed later, use `mux-server/README.md`.

## Required Contracts

### 1) OpenClaw config per tenant

Set at deploy time:

- mux inbound endpoint auth:
  - `gateway.http.endpoints.mux.enabled=true`
  - `gateway.http.endpoints.mux.baseUrl=<muxUrl>`
  - `gateway.http.endpoints.mux.token=<tenantApiKey>`
- source of truth rule:
  - use only `gateway.http.endpoints.mux.{baseUrl,token}` for mux transport auth/routing
  - do not rely on per-channel mux `apiKey` or `baseUrl` fields
- dual mode account layout (direct + mux) for each channel:
  - `channels.<app>.accounts.default.enabled=true` (direct/non-mux traffic)
  - `channels.<app>.accounts.mux.enabled=false` (do not direct-poll mux account)
  - `channels.<app>.accounts.mux.mux.enabled=true` (allow mux outbound route)
- apply this to `telegram`, `discord`, and `whatsapp`.
- if `channels.<app>.accounts` is present and `default` is missing/disabled, direct channel traffic can stop.

Minimal pattern:

```json
{
  "gateway": {
    "http": {
      "endpoints": {
        "mux": {
          "enabled": true,
          "baseUrl": "https://mux.example.com",
          "token": "<tenantApiKey>"
        }
      }
    }
  },
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "<directBotToken>",
      "accounts": {
        "default": { "enabled": true },
        "mux": { "enabled": false, "mux": { "enabled": true } }
      }
    },
    "discord": {
      "enabled": true,
      "token": "<directBotToken>",
      "accounts": {
        "default": { "enabled": true },
        "mux": { "enabled": false, "mux": { "enabled": true } }
      }
    },
    "whatsapp": {
      "enabled": true,
      "accounts": {
        "default": { "enabled": true },
        "mux": { "enabled": false, "mux": { "enabled": true } }
      }
    }
  }
}
```

### 2) Control plane -> mux APIs

- `POST /v1/admin/tenants/bootstrap`
  - Upsert tenant key + inbound target.
  - Use this as the default provisioning and update path.
- `POST /v1/pairings/token`
  - Create one-time token/deep link.
- `GET /v1/pairings`
  - List active bindings for tenant.
- `POST /v1/pairings/unbind`
  - Remove a binding.

### 3) Runtime APIs (already handled by OpenClaw + mux)

- OpenClaw -> mux: `POST /v1/mux/outbound/send`
- mux -> OpenClaw: `POST /v1/mux/inbound`

### 4) Mux server runtime setting

- Set `MUX_OPENCLAW_ACCOUNT_ID=mux`.
- This makes mux inbound events target OpenClaw account `mux`, so direct channel accounts remain untouched.

## Integration Sequence (Single Tenant)

1. Create tenant key.
2. Deploy OpenClaw instance with mux config and key.
3. Call `POST /v1/admin/tenants/bootstrap` with:
   - `tenantId`
   - `apiKey`
   - `inboundUrl` (`http://<tenant-openclaw>/v1/mux/inbound`)
   - optional `inboundTimeoutMs`
4. Expose "Pair" in dashboard:
   - backend calls `POST /v1/pairings/token`
   - frontend shows token/deep link
5. User pairs in chat.
6. Backend can show active bindings via `GET /v1/pairings`.

## Runtime Behavior You Can Rely On

- Shared-key mode only:
  - same `tenantApiKey` is used for:
    - control plane -> mux auth
    - OpenClaw -> mux auth
    - mux -> OpenClaw inbound auth
- Inbound target is dynamic:
  - updating tenant inbound target via bootstrap takes effect immediately
  - no mux restart required
- OpenClaw outbound mux path is centralized in:
  - `src/channels/plugins/outbound/mux.ts`

## Minimum Acceptance Checks

For each newly provisioned tenant:

1. Outbound check:
   - Send `/help` (or simple text) from tenant OpenClaw.
   - Verify mux receives `POST /v1/mux/outbound/send`.
2. Pairing check:
   - Create token from dashboard/backend.
   - User redeems token in target channel.
   - Verify binding appears in `GET /v1/pairings`.
3. Inbound check:
   - Send message from paired chat.
   - Verify tenant OpenClaw receives `POST /v1/mux/inbound`.
4. Unbind check:
   - Unbind via API.
   - Verify subsequent messages from that route are no longer forwarded.

## Operations (Only What Matters Here)

- Keep mux behind HTTPS and restricted ingress.
- Backup `MUX_DB_PATH`.
- Monitor:
  - auth failures (`401`/`403`)
  - inbound forward failures/retries
  - queue health (especially WhatsApp inbound queue)

## MVP Boundaries

- One shared mux instance.
- One OpenClaw per tenant.
- Telegram + Discord + WhatsApp.
- No multi-region clustering in MVP.

## Future Work: Session-Aware Pairing UX

This is intentionally deferred. Current MVP can stay on fixed session target (`agent:main:main`).

### Goal

Let users choose and switch the OpenClaw session bound to each chat without manual operator intervention.

### Planned Contract

- mux-side API (tenant auth):
  - `GET /v1/mux/sessions`
  - Returns sessions available to the tenant's OpenClaw.
- pairing token request:
  - keep `POST /v1/pairings/token`
  - require explicit `sessionKey` selected by dashboard
- bot control commands:
  - `/bot_sessions` list sessions
  - `/bot_use <session>` switch binding for current chat
  - `/bot_status` show current binding target

### Control Plane Flow

1. Dashboard loads available sessions from control-plane backend.
2. Backend calls mux `/v1/mux/sessions` with tenant key.
3. User picks session in UI.
4. Backend calls `POST /v1/pairings/token` with that session.
5. User redeems token in Telegram/Discord/WhatsApp.
6. User can later switch target session from chat using `/bot_*` commands.

### Design Constraints

- Keep shared-key tenant auth.
- Keep mux as a thin transport/control adapter.
- Avoid introducing per-channel special logic in control plane.
