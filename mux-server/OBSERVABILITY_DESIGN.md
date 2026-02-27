# Mux Server Observability Design (Draft)

Status: draft for review (no implementation in this branch yet)
Target branch for implementation: `phala-2026.2.17`

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

## Current State (from code)

1. Structured JSON-line logging exists via `log(...)`, written to `MUX_LOG_PATH`.
2. `/health` exists, but only surfaces basic service state plus Telegram poll-conflict degradation.
3. Admin WhatsApp health endpoint exists (`/v1/admin/whatsapp/health`).
4. No metrics endpoint today.
5. Event names are rich, but schema fields are not consistently enforced across events.

## Proposal Summary

1. Introduce a stable log event schema and a typed logging wrapper.
2. Add Prometheus-style metrics endpoint (`/metrics`) with bounded label cardinality.
3. Add readiness/liveness split: `/health/live` and `/health/ready`.
4. Add admin debug snapshot endpoint for recent error counters and queue/channel status.
5. Add end-to-end correlation id propagation (inbound -> tenant forward -> outbound).

## Detailed Design

### 1) Structured Logging V1

Add `logEvent()` wrapper (internally still writes JSON lines) with mandatory envelope fields:

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

Compatibility rules:

1. Keep current event `type` values.
2. Preserve existing fields; only add normalized envelope fields.
3. Keep output as line-delimited JSON to avoid changing collectors.

### 2) Metrics Endpoint

Add `GET /metrics` (Prometheus text format), controlled by env:

- `MUX_METRICS_ENABLED` (default `false`)

Initial metric set:

- `mux_inbound_events_total{channel,outcome}`
- `mux_inbound_forward_duration_ms_bucket{channel}`
- `mux_outbound_requests_total{channel,method,outcome}`
- `mux_outbound_duration_ms_bucket{channel,method}`
- `mux_pairing_claims_total{channel,claim_type,outcome}`
- `mux_auth_failures_total{surface}`
- `mux_retry_scheduled_total{channel}`
- `mux_retry_exhausted_total{channel}`
- `mux_queue_depth{channel}` (gauge)

Cardinality guardrails:

1. Never label by `sessionKey`, `routeKey`, `tenantId`, `chatId`, `messageId`, or `traceId`.
2. Only use bounded enums in labels.

### 3) Health Endpoints

Keep `/health` as current-compatible, then add:

1. `GET /health/live`

- process liveness only (`200 { ok: true }`)

2. `GET /health/ready`

- readiness for serving traffic
- includes per-channel readiness blocks:
  - listener/poller active
  - last success timestamp
  - last error summary
  - retry queue depth
  - degraded reasons

Example fields:

- `channels.telegram.status`
- `channels.discord.status`
- `channels.whatsapp.status`
- `degraded[]`

### 4) Admin Observability Snapshot

Add `GET /v1/admin/observability/snapshot` (admin token required):

- per-channel counters (last 1m/5m in-memory windows)
- retry queue depth + oldest queued age
- top error codes by count
- last N recent error events (bounded ring buffer)

Use this for incident triage without parsing full logs.

### 5) Correlation / Trace IDs

Generate/propagate `traceId` at ingress:

1. Telegram/Discord/WhatsApp inbound items get a deterministic trace seed using channel + update/message ids.
2. Include `traceId` in all logs for that message lifecycle.
3. Send `x-mux-trace-id` header to OpenClaw inbound POST.
4. Include `traceId` in outbound request logs.

### 6) Error Taxonomy

Add normalized `errorCode` values for observability aggregation:

- `AUTH_UNAUTHORIZED`
- `ROUTE_NOT_BOUND`
- `PAIRING_TOKEN_INVALID`
- `INBOUND_FORWARD_FAILED`
- `OUTBOUND_PROVIDER_FAILED`
- `QUEUE_RETRY_EXHAUSTED`
- `CHANNEL_POLL_CONFLICT`

Keep raw `error` text for debugging.

## Rollout Plan

### Phase 1 (low risk)

1. Add logging wrapper + envelope fields.
2. Add traceId propagation.
3. Add tests ensuring event shape and redaction behavior.

### Phase 2

1. Add metrics collector + `/metrics`.
2. Add tests for counters/histograms and cardinality guardrails.

### Phase 3

1. Add `/health/live` + `/health/ready`.
2. Add admin snapshot endpoint.
3. Add docs/examples for incident playbook.

## Testing Strategy

1. Unit tests for log schema validation and error-code mapping.
2. Integration tests for:

- metrics increments on happy/error paths
- readiness degradation for simulated channel failures
- traceId continuity from inbound to outbound logs

3. Backward-compat check: existing tests for current endpoints/log-dependent behavior must remain green.

## Non-Goals

1. Distributed tracing backend integration in this pass.
2. Cross-process metric aggregation.
3. Long-term metrics persistence across restarts.

## Open Questions for Review

1. Should `/metrics` require admin auth, or remain network-only unauthenticated?
2. Do you want `/health` to stay minimal forever, or eventually alias to `/health/ready`?
3. Should admin snapshot include tenant-level breakdown, or keep global-only to avoid high cardinality?
4. Do we want a default ring-buffer size of 200 or 1000 for recent error events?
