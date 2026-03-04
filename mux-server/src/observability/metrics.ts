import { Counter, Gauge, Histogram, Registry } from "prom-client";

const CHANNELS = ["telegram", "discord", "whatsapp"] as const;
const ACTIVE_WINDOWS = [
  ["5m", 5 * 60_000],
  ["1h", 60 * 60_000],
  ["24h", 24 * 60 * 60_000],
] as const;
const ACTIVE_MAX_AGE_MS = ACTIVE_WINDOWS[ACTIVE_WINDOWS.length - 1]?.[1] ?? 0;
const HISTOGRAM_BUCKETS_MS = [10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000];

type MetricsChannel = (typeof CHANNELS)[number];
type InboundOutcome = "forwarded" | "deferred" | "dropped" | "error";
type PairingOutcome = "success" | "invalid" | "ignored";
type PairingClaimType = "fresh" | "repaired" | "takeover" | "unknown";
type AuthSurface = "tenant" | "admin" | "register";
type LogLikeEvent = Record<string, unknown> & { type?: unknown; claimType?: unknown };

function normalizeUserId(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return null;
}

function normalizeMethod(value: unknown): "send" | "typing" | "action" {
  return value === "typing" || value === "action" ? value : "send";
}

function normalizeChannel(value: unknown): MetricsChannel | "unknown" {
  return value === "telegram" || value === "discord" || value === "whatsapp" ? value : "unknown";
}

function normalizePairingClaimType(value: unknown): PairingClaimType {
  return value === "fresh" || value === "repaired" || value === "takeover" ? value : "unknown";
}

function channelFromEventType(type: string): MetricsChannel | null {
  if (type.startsWith("telegram_")) {
    return "telegram";
  }
  if (type.startsWith("discord_")) {
    return "discord";
  }
  if (type.startsWith("whatsapp_")) {
    return "whatsapp";
  }
  return null;
}

export function createMuxMetrics() {
  const registry = new Registry();

  const inbound = new Counter({
    name: "mux_inbound_events_total",
    help: "Inbound events grouped by channel and outcome.",
    labelNames: ["channel", "outcome"] as const,
    registers: [registry],
  });
  const inboundDuration = new Histogram({
    name: "mux_inbound_forward_duration_ms",
    help: "Inbound tenant-forward duration in milliseconds.",
    labelNames: ["channel"] as const,
    buckets: HISTOGRAM_BUCKETS_MS,
    registers: [registry],
  });
  const outbound = new Counter({
    name: "mux_outbound_requests_total",
    help: "Outbound requests grouped by channel, method and outcome.",
    labelNames: ["channel", "method", "outcome"] as const,
    registers: [registry],
  });
  const outboundDuration = new Histogram({
    name: "mux_outbound_duration_ms",
    help: "Outbound request duration in milliseconds.",
    labelNames: ["channel", "method"] as const,
    buckets: HISTOGRAM_BUCKETS_MS,
    registers: [registry],
  });
  const pairing = new Counter({
    name: "mux_pairing_claims_total",
    help: "Pairing claim outcomes by channel and claim type.",
    labelNames: ["channel", "claim_type", "outcome"] as const,
    registers: [registry],
  });
  const auth = new Counter({
    name: "mux_auth_failures_total",
    help: "Authentication failures grouped by surface.",
    labelNames: ["surface"] as const,
    registers: [registry],
  });
  const retryScheduled = new Counter({
    name: "mux_retry_scheduled_total",
    help: "Retries scheduled by channel.",
    labelNames: ["channel"] as const,
    registers: [registry],
  });
  const retryExhausted = new Counter({
    name: "mux_retry_exhausted_total",
    help: "Retries exhausted by channel.",
    labelNames: ["channel"] as const,
    registers: [registry],
  });
  const queueDepth = new Gauge({
    name: "mux_queue_depth",
    help: "Current queue depth by channel.",
    labelNames: ["channel"] as const,
    registers: [registry],
  });
  const activeUsersGauge = new Gauge({
    name: "mux_active_users",
    help: "Estimated active users by channel and rolling window.",
    labelNames: ["channel", "window"] as const,
    registers: [registry],
  });

  const activeUsers: Record<MetricsChannel, Map<string, number>> = {
    telegram: new Map(),
    discord: new Map(),
    whatsapp: new Map(),
  };

  const recordPairingClaim = (params: {
    channel: MetricsChannel;
    claimType: unknown;
    outcome: PairingOutcome;
  }) => {
    pairing.inc({
      channel: params.channel,
      claim_type: normalizePairingClaimType(params.claimType),
      outcome: params.outcome,
    });
  };

  const recordRetryScheduled = (channel: MetricsChannel) => {
    retryScheduled.inc({ channel });
  };

  const recordRetryExhausted = (channel: MetricsChannel) => {
    retryExhausted.inc({ channel });
  };

  return {
    recordActiveUser(channel: MetricsChannel, userId: unknown, nowMs = Date.now()) {
      const id = normalizeUserId(userId);
      if (id) {
        activeUsers[channel].set(id, nowMs);
      }
    },

    recordInboundEvent(channel: MetricsChannel, outcome: InboundOutcome) {
      inbound.inc({ channel, outcome });
    },

    observeInboundForwardDuration(channel: MetricsChannel, durationMs: number) {
      inboundDuration.observe(
        { channel },
        Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0,
      );
    },

    recordOutboundRequest(params: {
      channel: string | null | undefined;
      method: string | null | undefined;
      statusCode: number;
      durationMs: number;
    }) {
      const channel = normalizeChannel(params.channel);
      const method = normalizeMethod(params.method);
      const outcome = params.statusCode >= 200 && params.statusCode < 300 ? "success" : "error";
      outbound.inc({ channel, method, outcome });
      outboundDuration.observe(
        { channel, method },
        Number.isFinite(params.durationMs) && params.durationMs >= 0 ? params.durationMs : 0,
      );
    },

    recordPairingClaim,

    recordAuthFailure(surface: AuthSurface) {
      auth.inc({ surface });
    },

    recordRetryScheduled,
    recordRetryExhausted,

    observeLogEvent(event: LogLikeEvent) {
      const type = typeof event.type === "string" ? event.type : "";
      if (!type) {
        return;
      }
      const channel = channelFromEventType(type);
      if (channel && type.endsWith("_pairing_token_claimed")) {
        recordPairingClaim({ channel, claimType: event.claimType, outcome: "success" });
        return;
      }
      if (channel && type.endsWith("_pairing_token_invalid")) {
        recordPairingClaim({ channel, claimType: "unknown", outcome: "invalid" });
        return;
      }
      if (channel && type.endsWith("_pairing_token_ignored_bound_route")) {
        recordPairingClaim({ channel, claimType: "unknown", outcome: "ignored" });
        return;
      }
      if (type === "whatsapp_inbound_retry_deferred") {
        recordRetryScheduled("whatsapp");
        return;
      }
      if (channel && type.endsWith("_inbound_bg_retry_exhausted")) {
        recordRetryExhausted(channel);
      }
    },

    async renderPrometheus(
      queueDepthByChannel: Record<MetricsChannel, number>,
      nowMs = Date.now(),
    ) {
      const activeCutoff = nowMs - ACTIVE_MAX_AGE_MS;
      for (const channel of CHANNELS) {
        for (const [id, seenAt] of activeUsers[channel]) {
          if (!Number.isFinite(seenAt) || seenAt < activeCutoff) {
            activeUsers[channel].delete(id);
          }
        }
      }

      for (const channel of CHANNELS) {
        queueDepth.set({ channel }, Math.max(0, Math.trunc(queueDepthByChannel[channel] ?? 0)));
        for (const [window, ms] of ACTIVE_WINDOWS) {
          const cutoff = nowMs - ms;
          let value = 0;
          for (const seenAt of activeUsers[channel].values()) {
            if (seenAt >= cutoff) {
              value += 1;
            }
          }
          activeUsersGauge.set({ channel, window }, value);
        }
      }

      return await registry.metrics();
    },
  };
}
