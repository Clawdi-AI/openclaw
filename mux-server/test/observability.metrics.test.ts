import { describe, expect, test } from "vitest";
import { createMuxMetrics } from "../src/observability/metrics.js";

describe("observability metrics", () => {
  test("renders prom text with bounded labels and histograms", () => {
    const metrics = createMuxMetrics();
    const now = Date.now();

    metrics.recordInboundEvent("telegram", "forwarded");
    metrics.observeInboundForwardDuration("telegram", 42);
    metrics.recordOutboundRequest({
      channel: "telegram",
      method: "send",
      statusCode: 200,
      durationMs: 17,
    });
    metrics.recordPairingClaim({ channel: "telegram", claimType: "fresh", outcome: "success" });
    metrics.recordAuthFailure("tenant");
    metrics.recordRetryScheduled("telegram");
    metrics.recordRetryExhausted("telegram");
    metrics.recordActiveUser("telegram", "user-1", now);
    metrics.recordActiveUser("telegram", "user-2", now - 10 * 60 * 1000);
    metrics.recordActiveUser("discord", "user-3", now - 90 * 60 * 1000);
    metrics.recordActiveUser("whatsapp", "user-4", now - 26 * 60 * 60 * 1000);

    const text = metrics.renderPrometheus({ telegram: 0, discord: 1, whatsapp: 2 }, now);

    expect(text).toContain("# TYPE mux_inbound_events_total counter");
    expect(text).toContain('mux_inbound_events_total{channel="telegram",outcome="forwarded"} 1');
    expect(text).toContain('mux_inbound_forward_duration_ms_bucket{channel="telegram",le="50"} 1');
    expect(text).toContain('mux_inbound_forward_duration_ms_count{channel="telegram"} 1');
    expect(text).toContain(
      'mux_outbound_requests_total{channel="telegram",method="send",outcome="success"} 1',
    );
    expect(text).toContain(
      'mux_pairing_claims_total{channel="telegram",claim_type="fresh",outcome="success"} 1',
    );
    expect(text).toContain('mux_auth_failures_total{surface="tenant"} 1');
    expect(text).toContain('mux_retry_scheduled_total{channel="telegram"} 1');
    expect(text).toContain('mux_retry_exhausted_total{channel="telegram"} 1');
    expect(text).toContain('mux_queue_depth{channel="discord"} 1');
    expect(text).toContain('mux_queue_depth{channel="whatsapp"} 2');
    expect(text).toContain('mux_active_users{channel="telegram",window="5m"} 1');
    expect(text).toContain('mux_active_users{channel="telegram",window="1h"} 2');
    expect(text).toContain('mux_active_users{channel="telegram",window="24h"} 2');
    expect(text).toContain('mux_active_users{channel="discord",window="1h"} 0');
    expect(text).toContain('mux_active_users{channel="discord",window="24h"} 1');
    expect(text).toContain('mux_active_users{channel="whatsapp",window="24h"} 0');
  });

  test("maps known log events into pairing and retry metrics", () => {
    const metrics = createMuxMetrics();

    metrics.observeLogEvent({
      type: "telegram_pairing_token_claimed",
      claimType: "repaired",
    });
    metrics.observeLogEvent({ type: "discord_pairing_token_invalid" });
    metrics.observeLogEvent({ type: "whatsapp_pairing_token_ignored_bound_route" });
    metrics.observeLogEvent({ type: "whatsapp_inbound_retry_deferred" });
    metrics.observeLogEvent({ type: "telegram_inbound_bg_retry_exhausted" });

    const text = metrics.renderPrometheus({ telegram: 0, discord: 0, whatsapp: 0 });

    expect(text).toContain(
      'mux_pairing_claims_total{channel="telegram",claim_type="repaired",outcome="success"} 1',
    );
    expect(text).toContain(
      'mux_pairing_claims_total{channel="discord",claim_type="unknown",outcome="invalid"} 1',
    );
    expect(text).toContain(
      'mux_pairing_claims_total{channel="whatsapp",claim_type="unknown",outcome="ignored"} 1',
    );
    expect(text).toContain('mux_retry_scheduled_total{channel="whatsapp"} 1');
    expect(text).toContain('mux_retry_exhausted_total{channel="telegram"} 1');
  });
});
