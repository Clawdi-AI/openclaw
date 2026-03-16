# Mux Server Grafana Plan

## Goals

- Detect transport breakage quickly (Telegram, Discord, WhatsApp).
- Keep default dashboards low-cardinality (no tenant labels on hot-path metrics).
- Support targeted tenant debugging when needed.
- Assume Prometheus scrape/evaluation cadence of 30s.

## Data Sources

1. Prometheus scrape

- Target: `GET /metrics`
- Interval: `30s`
- Timeout: `10s`

2. Health probe (recommended)

- Target: `GET /health/ready`
- Interval: `30s`
- Use existing infra (blackbox exporter or equivalent) to expose an `up`-style signal.

3. Admin debug endpoint (on-demand only)

- Target: `GET /v1/admin/observability/snapshot?tenantId=<id>`
- Access control: admin token via reverse proxy or secure header injection.
- Use for tenant triage, not for high-frequency scraping.

## Dashboard Structure

### 1) Service Overview

- Panel: `Mux Up`
  - Query: `up{job="mux-server"}`
  - Type: Stat
- Panel: `Inbound Event Rate (all channels)`
  - Query: `sum(rate(mux_inbound_events_total[5m]))`
  - Type: Time series
- Panel: `Outbound Success Rate`
  - Query:
    - `sum(rate(mux_outbound_requests_total{outcome="success"}[5m]))`
    - `/`
    - `sum(rate(mux_outbound_requests_total[5m]))`
  - Type: Stat / time series
- Panel: `Auth Failures`
  - Query: `sum by (surface) (rate(mux_auth_failures_total[5m]))`
  - Type: Time series

### 2) Channel Health

- Panel: `Inbound Events by Channel/Outcome`
  - Query: `sum by (channel, outcome) (rate(mux_inbound_events_total[5m]))`
- Panel: `Outbound Requests by Channel/Method/Outcome`
  - Query: `sum by (channel, method, outcome) (rate(mux_outbound_requests_total[5m]))`
- Panel: `Queue Depth by Channel`
  - Query: `mux_queue_depth`
- Panel: `Retry Scheduled vs Exhausted`
  - Query:
    - `sum by (channel) (rate(mux_retry_scheduled_total[5m]))`
    - `sum by (channel) (rate(mux_retry_exhausted_total[5m]))`

### 3) Latency SLO

- Panel: `Inbound Forward p50/p95/p99`
  - Query:
    - `histogram_quantile(0.5, sum by (le, channel) (rate(mux_inbound_forward_duration_ms_bucket[5m])))`
    - `histogram_quantile(0.95, sum by (le, channel) (rate(mux_inbound_forward_duration_ms_bucket[5m])))`
    - `histogram_quantile(0.99, sum by (le, channel) (rate(mux_inbound_forward_duration_ms_bucket[5m])))`
- Panel: `Outbound Duration p50/p95/p99`
  - Query:
    - `histogram_quantile(0.5, sum by (le, channel, method) (rate(mux_outbound_duration_ms_bucket[5m])))`
    - `histogram_quantile(0.95, sum by (le, channel, method) (rate(mux_outbound_duration_ms_bucket[5m])))`
    - `histogram_quantile(0.99, sum by (le, channel, method) (rate(mux_outbound_duration_ms_bucket[5m])))`

### 4) Product Usage

- Panel: `Active Users (5m/1h/24h) by Channel`
  - Query: `mux_active_users`
  - Visual: split series by `channel` + `window`
- Panel: `Pairing Claims`
  - Query: `sum by (channel, claim_type, outcome) (rate(mux_pairing_claims_total[5m]))`

### 5) Tenant Debug (Separate Dashboard, Manual)

- Variable: `tenant_id` (textbox/manual input).
- JSON/API panel hitting:
  - `/v1/admin/observability/snapshot?tenantId=${tenant_id}`
- Show:
  - `channels.*.status`
  - `channels.*.reason`
  - `queues.depth.*`
  - `queues.oldestQueuedAgeMs.*`
- Keep this dashboard restricted to ops/admin users.

## Alerting Plan

All alerts evaluate every `30s`.

1. `MuxDown`

- Expr: `up{job="mux-server"} == 0`
- For: `2m`
- Severity: critical

2. `MuxHighOutboundErrorRate`

- Expr:
  - `sum(rate(mux_outbound_requests_total{outcome="error"}[5m]))`
  - `/`
  - `sum(rate(mux_outbound_requests_total[5m])) > 0.05`
- For: `5m`
- Severity: warning

3. `MuxQueueBacklog`

- Expr: `max(mux_queue_depth) > 50`
- For: `5m`
- Severity: warning

4. `MuxRetriesExhausting`

- Expr: `sum(rate(mux_retry_exhausted_total[10m])) > 0`
- For: `10m`
- Severity: warning

5. `MuxNoInboundTrafficUnexpected` (optional, only if traffic is expected 24/7)

- Expr: `sum(rate(mux_inbound_events_total{outcome="forwarded"}[10m])) == 0`
- For: `15m`
- Severity: warning

## Security + Reverse Proxy Notes

- Keep `/metrics` behind private network or proxy auth in production.
- Keep `/v1/admin/*` strictly protected (token + network boundary).
- Prefer TLS termination and IP allowlist at reverse proxy.

## Rollout Steps

1. Add Prometheus scrape job for mux-server `/metrics` (30s).
2. Add readiness probe target for `/health/ready` (30s).
3. Import [`mux-server/grafana/mux-observability-dashboard.json`](./grafana/mux-observability-dashboard.json) into Grafana.
4. Add alert rules, run in warning-only for 24h, then tune thresholds.
5. Create restricted tenant-debug dashboard for `/v1/admin/observability/snapshot`.
