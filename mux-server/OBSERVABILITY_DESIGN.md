# Mux Server Observability Design + Implementation Notes

Status: implemented in `feat/mux-observability-design` (target base: `phala-2026.2.17`)
Last updated: 2026-02-28

## Goals

1. Make mux failures diagnosable in under 5 minutes from logs + health + metrics.
2. Provide stable, low-cardinality metrics for alerting and SLO tracking.
3. Keep transport behavior unchanged while adding observability surfaces.
4. Keep compatibility with existing log consumers.

## Operator Questions We Should Answer Fast

1. Is inbound polling/listening alive per channel?
2. Are messages being dropped, retried, or delayed?
3. Which stage is failing (ingress, route resolution, tenant forward, outbound send)?
4. Are pairings/auth failures increasing?
5. What changed recently (error spike, queue growth, degraded channel health)?

## Implemented Surfaces

1. Structured JSON-line logs now normalize envelope fields (`ts`, `level`, `component`) and infer `errorCode` when missing.
2. Prometheus metrics endpoint is available at `GET /metrics` when `MUX_METRICS_ENABLED=true`.
3. Liveness/readiness split is implemented:

- `GET /health/live`
- `GET /health/ready`

4. Admin observability snapshot is implemented:

- `GET /v1/admin/observability/snapshot` (requires `MUX_ADMIN_TOKEN`)

5. Trace correlation header is propagated on tenant-forward requests:

- `X-Mux-Trace-Id`

6. Runtime queue backlog and active user signals are exposed without high-cardinality labels.

## Metrics (Implemented)

Environment flag:

- `MUX_METRICS_ENABLED` (default `false`)

Metric families:

- `mux_inbound_events_total{channel,outcome}`
- `mux_inbound_forward_duration_ms_*{channel}`
- `mux_outbound_requests_total{channel,method,outcome}`
- `mux_outbound_duration_ms_*{channel,method}`
- `mux_pairing_claims_total{channel,claim_type,outcome}`
- `mux_auth_failures_total{surface}`
- `mux_retry_scheduled_total{channel}`
- `mux_retry_exhausted_total{channel}`
- `mux_queue_depth{channel}`
- `mux_active_users{channel,window}` where `window` is `5m`, `1h`, or `24h`

Cardinality rules:

1. No per-tenant labels in Prometheus metrics.
2. No dynamic user/session/message labels.
3. Tenant drill-down is done with snapshot query filtering (`tenantId`), not metric labels.

## Health Endpoints (Implemented)

1. `GET /health`

- Backward-compatible lightweight status.

2. `GET /health/live`

- Process-level liveness, always `200` when server loop is alive.

3. `GET /health/ready`

- Channel readiness report and degraded reasons.
- Includes queue depth and oldest queued age per channel.
- Returns `503` when any enabled channel is not ready.

## Admin Snapshot Endpoint (Implemented)

`GET /v1/admin/observability/snapshot`

Auth:

- `Authorization: Bearer <MUX_ADMIN_TOKEN>`

Query parameters:

- `tenantId` (optional): scoped debug view
- `recentErrorsLimit` (optional, bounded): trim error event payload volume

Response includes:

1. Channel health block (status/reason/timestamps).
2. Counters for `last1m` and `last5m` windows.
3. Queue backlog depth + oldest queued age.
4. Top inferred `errorCode` counts.
5. Recent error event list (bounded ring buffer).

Buffer configuration:

- `MUX_OBS_RECENT_ERRORS_MAX` (default `1000`)
- `MUX_OBS_RECENT_EVENTS_MAX` (default `5000`)

## Detailed Design

### 1) Structured Logging V1

`log(...)` now normalizes envelope fields while preserving existing event payload keys:

- `ts`: unix ms
- `type`: event type
- `level`: `info | warn | error`
- `component`: `mux-server`
- `channel`: optional (`telegram|discord|whatsapp`)
- `tenantId`: optional
- `traceId`: optional correlation id

Recommended optional fields (stage-dependent):

- `routeKey`, `sessionKey`, `bindingId`
- `updateId`, `messageId`, `requestId`
- `durationMs`, `attempt`, `statusCode`
- `errorCode`, `error`

Compatibility rules (kept):

1. Keep current event `type` values.
2. Preserve existing fields; only add normalized envelope fields.
3. Keep output as line-delimited JSON to avoid changing collectors.

### 2) Metrics Endpoint

Implemented exactly as above; see "Metrics (Implemented)".

Auth model (unchanged):

1. Keep app-level `/metrics` unauthenticated.
2. Enforce protection at reverse proxy in production (mTLS/OIDC/IP allowlist).

### 3) Health Endpoints

Implemented as designed (`/health`, `/health/live`, `/health/ready`).

### 4) Admin Observability Snapshot

Implemented as designed, with optional `tenantId` filter and bounded `recentErrorsLimit`.

Tenant strategy:

1. Do not emit tenant-cardinality metrics or default tenant breakdown in snapshot.
2. Support explicit tenant-targeted debugging on demand (for example, `?tenantId=<id>` filter on recent events and counters).

### 5) Correlation / Trace IDs

Implemented:

1. Ingress generates trace ids via `createInboundTraceId`.
2. Logs carry `traceId`.
3. Tenant-forward requests include `X-Mux-Trace-Id`.

### 6) Error Taxonomy

Implemented normalized `errorCode` inference for observability aggregation:

- `AUTH_UNAUTHORIZED`
- `ROUTE_NOT_BOUND`
- `PAIRING_TOKEN_INVALID`
- `INBOUND_FORWARD_FAILED`
- `OUTBOUND_PROVIDER_FAILED`
- `QUEUE_RETRY_EXHAUSTED`
- `CHANNEL_POLL_CONFLICT`

Raw `error` text is preserved for debugging.

## Prometheus Integration Checklist

1. Enable metrics on mux:

```bash
MUX_METRICS_ENABLED=true
```

2. Scrape config example:

```yaml
scrape_configs:
  - job_name: mux-server
    metrics_path: /metrics
    static_configs:
      - targets: ["mux-server:18891"]
```

3. Initial panels:

- inbound/outbound error rate
- queue depth by channel
- active users by channel + window
- auth failure counters
- retry scheduled vs exhausted

4. Initial alerts:

- queue depth sustained above threshold
- `mux_retry_exhausted_total` increase
- readiness endpoint non-ready for enabled channels

## Reverse Proxy Best Practices (Production)

1. Bind mux-server to private network/loopback when possible; expose only via proxy.
2. Terminate TLS at proxy and prefer mTLS for machine-to-machine observability access.
3. Protect `/metrics` and `/v1/admin/*` with strong auth (OIDC or mTLS), plus IP allowlist.
4. Apply rate limits and sane body/time limits on admin and observability endpoints.
5. Strip untrusted forwarding headers and set trusted `X-Forwarded-*` consistently.
6. Propagate a proxy request id to mux logs for cross-layer incident tracing.

## Testing Strategy

1. Unit tests for log schema validation and error-code mapping.
2. Integration tests for:

- metrics increments on happy/error paths
- readiness degradation for simulated channel failures
- traceId continuity from inbound to outbound logs

3. Backward-compat check: existing tests for current endpoints/log-dependent behavior must remain green.

Recommended command set used during this rollout:

```bash
pnpm -C mux-server typecheck
pnpm -C mux-server test test/observability.error-codes.test.ts test/observability.error-map.test.ts test/observability.log-event.test.ts test/observability.metrics.test.ts test/observability.snapshot.test.ts test/observability.trace-id.test.ts
pnpm -C mux-server test test/server.test.ts -t "health live endpoint responds|health endpoint reports telegram poll conflict when getUpdates returns 409|admin observability snapshot endpoint requires admin auth and returns snapshot|advances Telegram offset on forward failure and retries in background"
```

## Non-Goals

1. Distributed tracing backend integration in this pass.
2. Cross-process metric aggregation.
3. Long-term metrics persistence across restarts.

## Defaults Chosen

1. `/metrics` remains app-unauthenticated; production auth is enforced at reverse proxy.
2. `/health` stays minimal/backward-compatible; `/health/live` and `/health/ready` are explicit.
3. No tenant-level default breakdown; tenant-scoped debugging is explicit and on-demand.
4. Recent error ring buffer default: `1000` events (`MUX_OBS_RECENT_ERRORS_MAX`).
