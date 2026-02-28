const CHANNELS = ["telegram", "discord", "whatsapp"] as const;
const ACTIVE_WINDOWS = [
  ["5m", 5 * 60_000],
  ["1h", 60 * 60_000],
  ["24h", 24 * 60 * 60_000],
] as const;
const ACTIVE_MAX_AGE_MS = ACTIVE_WINDOWS[ACTIVE_WINDOWS.length - 1]?.[1] ?? 0;

type MetricsChannel = (typeof CHANNELS)[number];
type InboundOutcome = "forwarded" | "deferred" | "dropped" | "error";
type PairingOutcome = "success" | "invalid" | "ignored";
type AuthSurface = "tenant" | "admin" | "register";
type LabelValues = Record<string, string>;
type LogLikeEvent = Record<string, unknown> & { type?: unknown; claimType?: unknown };

function toMethod(value: unknown): string {
  if (value === "typing" || value === "action") {
    return value;
  }
  return "send";
}

function toChannel(value: unknown): MetricsChannel | "unknown" {
  if (value === "telegram" || value === "discord" || value === "whatsapp") {
    return value;
  }
  return "unknown";
}

function normalizeClaimType(value: unknown): string {
  if (value === "fresh" || value === "repaired" || value === "takeover") {
    return value;
  }
  return "unknown";
}

function eventChannelPrefix(type: string): MetricsChannel | null {
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

function escapeLabel(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function labelsKey(labels: LabelValues): string {
  return Object.entries(labels)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("|");
}

function labelsText(labels: LabelValues): string {
  const parts = Object.entries(labels)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${escapeLabel(v)}"`);
  return parts.length === 0 ? "" : `{${parts.join(",")}}`;
}

function pushCounter(
  lines: string[],
  name: string,
  help: string,
  map: Map<string, { labels: LabelValues; value: number }>,
) {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} counter`);
  for (const { labels, value } of [...map.values()].toSorted((a, b) =>
    labelsKey(a.labels).localeCompare(labelsKey(b.labels)),
  )) {
    lines.push(`${name}${labelsText(labels)} ${value}`);
  }
}

function pushGauge(
  lines: string[],
  name: string,
  help: string,
  rows: Array<{ labels: LabelValues; value: number }>,
) {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} gauge`);
  for (const row of rows.toSorted((a, b) =>
    labelsKey(a.labels).localeCompare(labelsKey(b.labels)),
  )) {
    lines.push(`${name}${labelsText(row.labels)} ${row.value}`);
  }
}

function inc(
  map: Map<string, { labels: LabelValues; value: number }>,
  labels: LabelValues,
  by = 1,
) {
  const key = labelsKey(labels);
  const prev = map.get(key);
  if (prev) {
    prev.value += by;
    return;
  }
  map.set(key, { labels, value: by });
}

function normalizeUserId(value: unknown): string | null {
  if (typeof value === "string") {
    const v = value.trim();
    return v ? v : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return null;
}

export function createMuxMetrics() {
  const inbound = new Map<string, { labels: LabelValues; value: number }>();
  const outbound = new Map<string, { labels: LabelValues; value: number }>();
  const pairing = new Map<string, { labels: LabelValues; value: number }>();
  const auth = new Map<string, { labels: LabelValues; value: number }>();
  const retryScheduled = new Map<string, { labels: LabelValues; value: number }>();
  const retryExhausted = new Map<string, { labels: LabelValues; value: number }>();
  const active: Record<MetricsChannel, Map<string, number>> = {
    telegram: new Map(),
    discord: new Map(),
    whatsapp: new Map(),
  };

  return {
    recordActiveUser(channel: MetricsChannel, userId: unknown, nowMs = Date.now()) {
      const id = normalizeUserId(userId);
      if (id) {
        active[channel].set(id, nowMs);
      }
    },

    recordInboundEvent(channel: MetricsChannel, outcome: InboundOutcome) {
      inc(inbound, { channel, outcome });
    },

    observeInboundForwardDuration(_channel: MetricsChannel, _durationMs: number) {
      // Kept for API compatibility; currently not exported as histogram metrics.
    },

    recordOutboundRequest(params: {
      channel: string | null | undefined;
      method: string | null | undefined;
      statusCode: number;
      durationMs: number;
    }) {
      const channel = toChannel(params.channel);
      const method = toMethod(params.method);
      const outcome = params.statusCode >= 200 && params.statusCode < 300 ? "success" : "error";
      inc(outbound, { channel, method, outcome });
    },

    recordPairingClaim(params: {
      channel: MetricsChannel;
      claimType: unknown;
      outcome: PairingOutcome;
    }) {
      inc(pairing, {
        channel: params.channel,
        claim_type: normalizeClaimType(params.claimType),
        outcome: params.outcome,
      });
    },

    recordAuthFailure(surface: AuthSurface) {
      inc(auth, { surface });
    },

    recordRetryScheduled(channel: MetricsChannel) {
      inc(retryScheduled, { channel });
    },

    recordRetryExhausted(channel: MetricsChannel) {
      inc(retryExhausted, { channel });
    },

    observeLogEvent(event: LogLikeEvent) {
      const type = typeof event.type === "string" ? event.type : "";
      if (!type) {
        return;
      }
      const channel = eventChannelPrefix(type);
      if (channel && type.endsWith("_pairing_token_claimed")) {
        this.recordPairingClaim({ channel, claimType: event.claimType, outcome: "success" });
        return;
      }
      if (channel && type.endsWith("_pairing_token_invalid")) {
        this.recordPairingClaim({ channel, claimType: "unknown", outcome: "invalid" });
        return;
      }
      if (channel && type.endsWith("_pairing_token_ignored_bound_route")) {
        this.recordPairingClaim({ channel, claimType: "unknown", outcome: "ignored" });
        return;
      }
      if (type === "whatsapp_inbound_retry_deferred") {
        this.recordRetryScheduled("whatsapp");
        return;
      }
      if (channel && type.endsWith("_inbound_bg_retry_exhausted")) {
        this.recordRetryExhausted(channel);
      }
    },

    renderPrometheus(queueDepthByChannel: Record<MetricsChannel, number>, nowMs = Date.now()) {
      const cutoff = nowMs - ACTIVE_MAX_AGE_MS;
      for (const channel of CHANNELS) {
        for (const [id, seenAt] of active[channel]) {
          if (!Number.isFinite(seenAt) || seenAt < cutoff) {
            active[channel].delete(id);
          }
        }
      }

      const activeGauge: Array<{ labels: LabelValues; value: number }> = [];
      for (const channel of CHANNELS) {
        for (const [window, ms] of ACTIVE_WINDOWS) {
          const minTs = nowMs - ms;
          let value = 0;
          for (const seenAt of active[channel].values()) {
            if (seenAt >= minTs) {
              value += 1;
            }
          }
          activeGauge.push({ labels: { channel, window }, value });
        }
      }

      const lines: string[] = [];
      pushCounter(
        lines,
        "mux_inbound_events_total",
        "Inbound events grouped by channel and outcome.",
        inbound,
      );
      pushCounter(
        lines,
        "mux_outbound_requests_total",
        "Outbound requests grouped by channel, method and outcome.",
        outbound,
      );
      pushCounter(
        lines,
        "mux_pairing_claims_total",
        "Pairing claim outcomes by channel and claim type.",
        pairing,
      );
      pushCounter(
        lines,
        "mux_auth_failures_total",
        "Authentication failures grouped by surface.",
        auth,
      );
      pushCounter(
        lines,
        "mux_retry_scheduled_total",
        "Retries scheduled by channel.",
        retryScheduled,
      );
      pushCounter(
        lines,
        "mux_retry_exhausted_total",
        "Retries exhausted by channel.",
        retryExhausted,
      );
      pushGauge(
        lines,
        "mux_queue_depth",
        "Current queue depth by channel.",
        CHANNELS.map((channel) => ({
          labels: { channel },
          value: Math.max(0, Math.trunc(queueDepthByChannel[channel] ?? 0)),
        })),
      );
      pushGauge(
        lines,
        "mux_active_users",
        "Estimated active users by channel and rolling window.",
        activeGauge,
      );
      return `${lines.join("\n")}\n`;
    },
  };
}
