const HISTOGRAM_BUCKETS_MS = [
  10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000,
] as const;
const ACTIVE_USER_WINDOWS = [
  { key: "5m", ms: 5 * 60 * 1000 },
  { key: "1h", ms: 60 * 60 * 1000 },
  { key: "24h", ms: 24 * 60 * 60 * 1000 },
] as const;
const ACTIVE_USER_MAX_WINDOW_MS = ACTIVE_USER_WINDOWS[ACTIVE_USER_WINDOWS.length - 1]?.ms ?? 0;

const METRIC_CHANNELS = ["telegram", "discord", "whatsapp"] as const;

type MetricsChannel = (typeof METRIC_CHANNELS)[number];
type OutboundChannel = MetricsChannel | "unknown";
type InboundOutcome = "forwarded" | "deferred" | "dropped" | "error";
type OutboundOutcome = "success" | "error";
type OutboundMethod = "send" | "typing" | "action" | "unknown";
type PairingOutcome = "success" | "invalid" | "ignored";
type PairingClaimType = "fresh" | "repaired" | "takeover" | "unknown";
type AuthSurface = "tenant" | "admin" | "register";
type HistogramState = {
  sum: number;
  count: number;
  buckets: number[];
};

type LogLikeEvent = Record<string, unknown> & {
  type?: unknown;
  claimType?: unknown;
};

function normalizeOutboundChannel(value: string | null | undefined): OutboundChannel {
  if (value === "telegram" || value === "discord" || value === "whatsapp") {
    return value;
  }
  return "unknown";
}

function normalizeOutboundMethod(value: string | null | undefined): OutboundMethod {
  if (value === "send" || value === "typing" || value === "action") {
    return value;
  }
  return "unknown";
}

function normalizePairingClaimType(value: unknown): PairingClaimType {
  if (value === "fresh" || value === "repaired" || value === "takeover") {
    return value;
  }
  return "unknown";
}

function key(parts: string[]): string {
  return parts.join("|");
}

function escapeLabelValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

function labelsToText(labels: Record<string, string>): string {
  const names = Object.keys(labels).toSorted();
  if (names.length === 0) {
    return "";
  }
  const body = names.map((name) => `${name}="${escapeLabelValue(labels[name] ?? "")}"`).join(",");
  return `{${body}}`;
}

function renderCounterMetric(
  lines: string[],
  name: string,
  help: string,
  values: Map<string, { labels: Record<string, string>; value: number }>,
): void {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} counter`);
  const entries = [...values.values()].toSorted((a, b) => {
    const aKey = JSON.stringify(a.labels);
    const bKey = JSON.stringify(b.labels);
    return aKey.localeCompare(bKey);
  });
  for (const entry of entries) {
    lines.push(`${name}${labelsToText(entry.labels)} ${entry.value}`);
  }
}

function renderGaugeMetric(
  lines: string[],
  name: string,
  help: string,
  values: Array<{ labels: Record<string, string>; value: number }>,
): void {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} gauge`);
  const entries = [...values].toSorted((a, b) => {
    const aKey = JSON.stringify(a.labels);
    const bKey = JSON.stringify(b.labels);
    return aKey.localeCompare(bKey);
  });
  for (const entry of entries) {
    lines.push(`${name}${labelsToText(entry.labels)} ${entry.value}`);
  }
}

function renderHistogramMetric(
  lines: string[],
  name: string,
  help: string,
  entries: Map<string, { labels: Record<string, string>; state: HistogramState }>,
): void {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} histogram`);
  const sorted = [...entries.values()].toSorted((a, b) => {
    const aKey = JSON.stringify(a.labels);
    const bKey = JSON.stringify(b.labels);
    return aKey.localeCompare(bKey);
  });
  for (const entry of sorted) {
    for (let i = 0; i < HISTOGRAM_BUCKETS_MS.length; i += 1) {
      const le = HISTOGRAM_BUCKETS_MS[i];
      const labels = { ...entry.labels, le: String(le) };
      lines.push(`${name}_bucket${labelsToText(labels)} ${entry.state.buckets[i] ?? 0}`);
    }
    lines.push(
      `${name}_bucket${labelsToText({ ...entry.labels, le: "+Inf" })} ${entry.state.count}`,
    );
    lines.push(`${name}_sum${labelsToText(entry.labels)} ${entry.state.sum}`);
    lines.push(`${name}_count${labelsToText(entry.labels)} ${entry.state.count}`);
  }
}

function createHistogramState(): HistogramState {
  return {
    sum: 0,
    count: 0,
    buckets: Array.from({ length: HISTOGRAM_BUCKETS_MS.length }, () => 0),
  };
}

function addToHistogram(state: HistogramState, durationMs: number): void {
  const value = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
  state.sum += value;
  state.count += 1;
  for (let i = 0; i < HISTOGRAM_BUCKETS_MS.length; i += 1) {
    if (value <= HISTOGRAM_BUCKETS_MS[i]) {
      state.buckets[i] += 1;
    }
  }
}

function isStatusSuccess(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 300;
}

function asChannelPrefix(eventType: string): MetricsChannel | null {
  const idx = eventType.indexOf("_");
  if (idx <= 0) {
    return null;
  }
  const prefix = eventType.slice(0, idx);
  if (prefix === "telegram" || prefix === "discord" || prefix === "whatsapp") {
    return prefix;
  }
  return null;
}

export type MuxMetrics = {
  recordActiveUser: (channel: MetricsChannel, userId: unknown, nowMs?: number) => void;
  recordInboundEvent: (channel: MetricsChannel, outcome: InboundOutcome) => void;
  observeInboundForwardDuration: (channel: MetricsChannel, durationMs: number) => void;
  recordOutboundRequest: (params: {
    channel: string | null | undefined;
    method: string | null | undefined;
    statusCode: number;
    durationMs: number;
  }) => void;
  recordPairingClaim: (params: {
    channel: MetricsChannel;
    claimType: unknown;
    outcome: PairingOutcome;
  }) => void;
  recordAuthFailure: (surface: AuthSurface) => void;
  recordRetryScheduled: (channel: MetricsChannel) => void;
  recordRetryExhausted: (channel: MetricsChannel) => void;
  observeLogEvent: (event: LogLikeEvent) => void;
  renderPrometheus: (queueDepthByChannel: Record<MetricsChannel, number>, nowMs?: number) => string;
};

export function createMuxMetrics(): MuxMetrics {
  const inboundEvents = new Map<string, { labels: Record<string, string>; value: number }>();
  const inboundForwardDuration = new Map<
    string,
    { labels: Record<string, string>; state: HistogramState }
  >();
  const outboundRequests = new Map<string, { labels: Record<string, string>; value: number }>();
  const outboundDuration = new Map<
    string,
    { labels: Record<string, string>; state: HistogramState }
  >();
  const pairingClaims = new Map<string, { labels: Record<string, string>; value: number }>();
  const authFailures = new Map<string, { labels: Record<string, string>; value: number }>();
  const retryScheduled = new Map<string, { labels: Record<string, string>; value: number }>();
  const retryExhausted = new Map<string, { labels: Record<string, string>; value: number }>();
  const activeUsers: Record<MetricsChannel, Map<string, number>> = {
    telegram: new Map<string, number>(),
    discord: new Map<string, number>(),
    whatsapp: new Map<string, number>(),
  };

  const incCounter = (
    target: Map<string, { labels: Record<string, string>; value: number }>,
    labels: Record<string, string>,
    step = 1,
  ) => {
    const id = key(
      Object.keys(labels)
        .toSorted()
        .map((name) => `${name}=${labels[name] ?? ""}`),
    );
    const existing = target.get(id);
    if (existing) {
      existing.value += step;
      return;
    }
    target.set(id, { labels, value: step });
  };

  const observeHistogram = (
    target: Map<string, { labels: Record<string, string>; state: HistogramState }>,
    labels: Record<string, string>,
    durationMs: number,
  ) => {
    const id = key(
      Object.keys(labels)
        .toSorted()
        .map((name) => `${name}=${labels[name] ?? ""}`),
    );
    const existing = target.get(id);
    if (existing) {
      addToHistogram(existing.state, durationMs);
      return;
    }
    const state = createHistogramState();
    addToHistogram(state, durationMs);
    target.set(id, { labels, state });
  };

  const recordInboundEvent = (channel: MetricsChannel, outcome: InboundOutcome) => {
    incCounter(inboundEvents, { channel, outcome });
  };

  const recordActiveUser = (channel: MetricsChannel, userId: unknown, nowMs = Date.now()) => {
    const normalizedId =
      typeof userId === "string"
        ? userId.trim()
        : typeof userId === "number" && Number.isFinite(userId)
          ? String(Math.trunc(userId))
          : "";
    if (!normalizedId) {
      return;
    }
    activeUsers[channel].set(normalizedId, nowMs);
  };

  const observeInboundForwardDuration = (channel: MetricsChannel, durationMs: number) => {
    observeHistogram(inboundForwardDuration, { channel }, durationMs);
  };

  const recordOutboundRequest = (params: {
    channel: string | null | undefined;
    method: string | null | undefined;
    statusCode: number;
    durationMs: number;
  }) => {
    const channel = normalizeOutboundChannel(params.channel);
    const method = normalizeOutboundMethod(params.method);
    const outcome: OutboundOutcome = isStatusSuccess(params.statusCode) ? "success" : "error";
    incCounter(outboundRequests, { channel, method, outcome });
    observeHistogram(outboundDuration, { channel, method }, params.durationMs);
  };

  const recordPairingClaim = (params: {
    channel: MetricsChannel;
    claimType: unknown;
    outcome: PairingOutcome;
  }) => {
    const claimType = normalizePairingClaimType(params.claimType);
    incCounter(pairingClaims, {
      channel: params.channel,
      claim_type: claimType,
      outcome: params.outcome,
    });
  };

  const recordAuthFailure = (surface: AuthSurface) => {
    incCounter(authFailures, { surface });
  };

  const recordRetryScheduled = (channel: MetricsChannel) => {
    incCounter(retryScheduled, { channel });
  };

  const recordRetryExhausted = (channel: MetricsChannel) => {
    incCounter(retryExhausted, { channel });
  };

  const observeLogEvent = (event: LogLikeEvent) => {
    const type = typeof event.type === "string" ? event.type : "";
    if (!type) {
      return;
    }
    const channel = asChannelPrefix(type);

    if (channel && type.endsWith("_pairing_token_claimed")) {
      recordPairingClaim({
        channel,
        claimType: event.claimType,
        outcome: "success",
      });
      return;
    }

    if (channel && type.endsWith("_pairing_token_invalid")) {
      recordPairingClaim({
        channel,
        claimType: "unknown",
        outcome: "invalid",
      });
      return;
    }

    if (channel && type.endsWith("_pairing_token_ignored_bound_route")) {
      recordPairingClaim({
        channel,
        claimType: "unknown",
        outcome: "ignored",
      });
      return;
    }

    if (type === "whatsapp_inbound_retry_deferred") {
      recordRetryScheduled("whatsapp");
      return;
    }

    if (channel && type.endsWith("_inbound_bg_retry_exhausted")) {
      recordRetryExhausted(channel);
    }
  };

  const renderPrometheus = (
    queueDepthByChannel: Record<MetricsChannel, number>,
    nowMs = Date.now(),
  ): string => {
    const activeCutoff = nowMs - ACTIVE_USER_MAX_WINDOW_MS;
    for (const channel of METRIC_CHANNELS) {
      for (const [userId, seenAtMs] of activeUsers[channel].entries()) {
        if (!Number.isFinite(seenAtMs) || seenAtMs < activeCutoff) {
          activeUsers[channel].delete(userId);
        }
      }
    }

    const activeUserGaugeValues: Array<{ labels: Record<string, string>; value: number }> = [];
    for (const channel of METRIC_CHANNELS) {
      for (const window of ACTIVE_USER_WINDOWS) {
        const cutoff = nowMs - window.ms;
        let count = 0;
        for (const seenAtMs of activeUsers[channel].values()) {
          if (seenAtMs >= cutoff) {
            count += 1;
          }
        }
        activeUserGaugeValues.push({
          labels: { channel, window: window.key },
          value: count,
        });
      }
    }

    const lines: string[] = [];

    renderCounterMetric(
      lines,
      "mux_inbound_events_total",
      "Inbound events grouped by channel and outcome.",
      inboundEvents,
    );
    renderHistogramMetric(
      lines,
      "mux_inbound_forward_duration_ms",
      "Inbound tenant-forward duration in milliseconds.",
      inboundForwardDuration,
    );
    renderCounterMetric(
      lines,
      "mux_outbound_requests_total",
      "Outbound requests grouped by channel, method and outcome.",
      outboundRequests,
    );
    renderHistogramMetric(
      lines,
      "mux_outbound_duration_ms",
      "Outbound request duration in milliseconds.",
      outboundDuration,
    );
    renderCounterMetric(
      lines,
      "mux_pairing_claims_total",
      "Pairing claim outcomes by channel and claim type.",
      pairingClaims,
    );
    renderCounterMetric(
      lines,
      "mux_auth_failures_total",
      "Authentication failures grouped by surface.",
      authFailures,
    );
    renderCounterMetric(
      lines,
      "mux_retry_scheduled_total",
      "Retries scheduled by channel.",
      retryScheduled,
    );
    renderCounterMetric(
      lines,
      "mux_retry_exhausted_total",
      "Retries exhausted by channel.",
      retryExhausted,
    );
    renderGaugeMetric(
      lines,
      "mux_queue_depth",
      "Current queue depth by channel.",
      METRIC_CHANNELS.map((channel) => ({
        labels: { channel },
        value: Math.max(0, Math.trunc(queueDepthByChannel[channel] ?? 0)),
      })),
    );
    renderGaugeMetric(
      lines,
      "mux_active_users",
      "Estimated active users by channel and rolling window.",
      activeUserGaugeValues,
    );

    return `${lines.join("\n")}\n`;
  };

  return {
    recordActiveUser,
    recordInboundEvent,
    observeInboundForwardDuration,
    recordOutboundRequest,
    recordPairingClaim,
    recordAuthFailure,
    recordRetryScheduled,
    recordRetryExhausted,
    observeLogEvent,
    renderPrometheus,
  };
}
