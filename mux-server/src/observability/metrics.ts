const CHANNELS = ["telegram", "discord", "whatsapp"] as const;
const ACTIVE_WINDOWS = [
  ["5m", 5 * 60_000],
  ["1h", 60 * 60_000],
  ["24h", 24 * 60 * 60_000],
] as const;
const ACTIVE_MAX_AGE_MS = ACTIVE_WINDOWS[ACTIVE_WINDOWS.length - 1]?.[1] ?? 0;

type MetricsChannel = (typeof CHANNELS)[number];
type Labels = Record<string, string>;
type CounterRow = { labels: Labels; value: number };
type LogLikeEvent = Record<string, unknown> & { type?: unknown; claimType?: unknown };

const OUTCOME_SUCCESS_MIN = 200;
const OUTCOME_SUCCESS_MAX = 299;

function labelsKey(labels: Labels): string {
  return Object.entries(labels)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("|");
}

function labelsText(labels: Labels): string {
  const body = Object.entries(labels)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(
      ([k, v]) =>
        `${k}="${v.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"')}"`,
    )
    .join(",");
  return body ? `{${body}}` : "";
}

function inc(map: Map<string, CounterRow>, labels: Labels, by = 1) {
  const key = labelsKey(labels);
  const row = map.get(key);
  if (row) {
    row.value += by;
    return;
  }
  map.set(key, { labels, value: by });
}

function pushCounter(lines: string[], name: string, help: string, map: Map<string, CounterRow>) {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} counter`);
  for (const row of [...map.values()].toSorted((a, b) =>
    labelsKey(a.labels).localeCompare(labelsKey(b.labels)),
  )) {
    lines.push(`${name}${labelsText(row.labels)} ${row.value}`);
  }
}

function pushGauge(lines: string[], name: string, help: string, rows: CounterRow[]) {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} gauge`);
  for (const row of rows.toSorted((a, b) =>
    labelsKey(a.labels).localeCompare(labelsKey(b.labels)),
  )) {
    lines.push(`${name}${labelsText(row.labels)} ${row.value}`);
  }
}

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

function normalizePairingClaimType(value: unknown): string {
  return value === "fresh" || value === "repaired" || value === "takeover" ? value : "unknown";
}

function normalizeMethod(value: unknown): string {
  return value === "typing" || value === "action" ? value : "send";
}

function normalizeChannel(value: unknown): MetricsChannel | "unknown" {
  return value === "telegram" || value === "discord" || value === "whatsapp" ? value : "unknown";
}

export function createMuxMetrics() {
  const inbound = new Map<string, CounterRow>();
  const outbound = new Map<string, CounterRow>();
  const pairing = new Map<string, CounterRow>();
  const auth = new Map<string, CounterRow>();
  const retryScheduled = new Map<string, CounterRow>();
  const retryExhausted = new Map<string, CounterRow>();
  const activeUsers: Record<MetricsChannel, Map<string, number>> = {
    telegram: new Map(),
    discord: new Map(),
    whatsapp: new Map(),
  };

  return {
    recordActiveUser(channel: MetricsChannel, userId: unknown, nowMs = Date.now()) {
      const id = normalizeUserId(userId);
      if (id) {
        activeUsers[channel].set(id, nowMs);
      }
    },

    recordInboundEvent(
      channel: MetricsChannel,
      outcome: "forwarded" | "deferred" | "dropped" | "error",
    ) {
      inc(inbound, { channel, outcome });
    },

    observeInboundForwardDuration(_channel: MetricsChannel, _durationMs: number) {
      // Compatibility no-op; durations were dropped to keep this patch lean.
    },

    recordOutboundRequest(params: {
      channel: string | null | undefined;
      method: string | null | undefined;
      statusCode: number;
      durationMs: number;
    }) {
      const outcome =
        params.statusCode >= OUTCOME_SUCCESS_MIN && params.statusCode <= OUTCOME_SUCCESS_MAX
          ? "success"
          : "error";
      inc(outbound, {
        channel: normalizeChannel(params.channel),
        method: normalizeMethod(params.method),
        outcome,
      });
    },

    recordPairingClaim(params: {
      channel: MetricsChannel;
      claimType: unknown;
      outcome: "success" | "invalid" | "ignored";
    }) {
      inc(pairing, {
        channel: params.channel,
        claim_type: normalizePairingClaimType(params.claimType),
        outcome: params.outcome,
      });
    },

    recordAuthFailure(surface: "tenant" | "admin" | "register") {
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
      const channel = channelFromEventType(type);
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
      const activeCutoff = nowMs - ACTIVE_MAX_AGE_MS;
      for (const channel of CHANNELS) {
        for (const [id, seenAt] of activeUsers[channel]) {
          if (!Number.isFinite(seenAt) || seenAt < activeCutoff) {
            activeUsers[channel].delete(id);
          }
        }
      }

      const activeRows: CounterRow[] = [];
      for (const channel of CHANNELS) {
        for (const [window, ms] of ACTIVE_WINDOWS) {
          const cutoff = nowMs - ms;
          let value = 0;
          for (const seenAt of activeUsers[channel].values()) {
            if (seenAt >= cutoff) {
              value += 1;
            }
          }
          activeRows.push({ labels: { channel, window }, value });
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
        activeRows,
      );
      return `${lines.join("\n")}\n`;
    },
  };
}
