import { inferErrorCodeFromLogEvent } from "./error-map.js";

const CHANNELS = ["telegram", "discord", "whatsapp"] as const;

type Channel = (typeof CHANNELS)[number];
type EventLevel = "info" | "warn" | "error";

type SnapshotEvent = {
  ts: number;
  type: string;
  level: EventLevel;
  channel: Channel | null;
  tenantId: string | null;
  errorCode: string | null;
  error: string | null;
  traceId: string | null;
};

type WindowStats = {
  events: number;
  errors: number;
  forwarded: number;
  deferred: number;
  dropped: number;
};

type ChannelSnapshotStats = Record<Channel, WindowStats>;

type SnapshotChannelHealth = {
  status: string;
  ready: boolean;
  reason?: string;
  lastSuccessAtMs?: number | null;
  lastErrorAtMs?: number | null;
  lastError?: string | null;
  lastInboundSeenAtMs?: number | null;
};

type SnapshotResult = {
  generatedAtMs: number;
  tenantId?: string;
  channels: Record<Channel, SnapshotChannelHealth>;
  counters: {
    last1m: ChannelSnapshotStats;
    last5m: ChannelSnapshotStats;
  };
  queues: {
    depth: Record<Channel, number>;
    oldestQueuedAgeMs: Record<Channel, number | null>;
  };
  topErrorCodes: Array<{ code: string; count: number }>;
  recentErrors: Array<{
    ts: number;
    type: string;
    channel?: Channel;
    tenantId?: string;
    errorCode?: string;
    error?: string;
    traceId?: string;
  }>;
};

type SnapshotStore = {
  observe: (event: Record<string, unknown>) => void;
  snapshot: (params: {
    nowMs?: number;
    tenantId?: string;
    recentErrorsLimit?: number;
    channels: Record<Channel, SnapshotChannelHealth>;
    queueDepth: Record<Channel, number>;
    oldestQueuedAgeMs: Record<Channel, number | null>;
  }) => SnapshotResult;
};

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readTs(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  return fallback;
}

function toChannel(value: unknown): Channel | null {
  if (value === "telegram" || value === "discord" || value === "whatsapp") {
    return value;
  }
  const text = readString(value);
  if (!text) {
    return null;
  }
  if (text.startsWith("telegram_")) {
    return "telegram";
  }
  if (text.startsWith("discord_")) {
    return "discord";
  }
  if (text.startsWith("whatsapp_")) {
    return "whatsapp";
  }
  return null;
}

function toLevel(value: unknown): EventLevel {
  if (value === "warn") {
    return "warn";
  }
  if (value === "error") {
    return "error";
  }
  return "info";
}

function createEmptyStats(): ChannelSnapshotStats {
  return {
    telegram: { events: 0, errors: 0, forwarded: 0, deferred: 0, dropped: 0 },
    discord: { events: 0, errors: 0, forwarded: 0, deferred: 0, dropped: 0 },
    whatsapp: { events: 0, errors: 0, forwarded: 0, deferred: 0, dropped: 0 },
  };
}

function bump(stats: ChannelSnapshotStats, event: SnapshotEvent): void {
  if (!event.channel) {
    return;
  }
  const bucket = stats[event.channel];
  bucket.events += 1;
  if (event.level === "error" || event.errorCode) {
    bucket.errors += 1;
  }
  if (event.type.endsWith("_forwarded")) {
    bucket.forwarded += 1;
  }
  if (event.type.endsWith("_retry_deferred")) {
    bucket.deferred += 1;
  }
  if (event.type.includes("_drop_")) {
    bucket.dropped += 1;
  }
}

export function createObservabilitySnapshotStore(params?: {
  maxEvents?: number;
  maxRecentErrors?: number;
}): SnapshotStore {
  const maxEvents = Math.max(200, Math.trunc(params?.maxEvents ?? 5_000));
  const maxRecentErrors = Math.max(100, Math.trunc(params?.maxRecentErrors ?? 1_000));
  const events: SnapshotEvent[] = [];
  const recentErrors: SnapshotEvent[] = [];

  const pushBounded = (arr: SnapshotEvent[], item: SnapshotEvent, max: number) => {
    arr.push(item);
    if (arr.length > max) {
      arr.splice(0, arr.length - max);
    }
  };

  const observe = (event: Record<string, unknown>) => {
    const nowMs = Date.now();
    const type = readString(event.type) ?? "event";
    const normalized: SnapshotEvent = {
      ts: readTs(event.ts, nowMs),
      type,
      level: toLevel(event.level),
      channel: toChannel(event.channel) ?? toChannel(type),
      tenantId: readString(event.tenantId),
      errorCode: readString(event.errorCode) ?? inferErrorCodeFromLogEvent(event) ?? null,
      error: readString(event.error),
      traceId: readString(event.traceId),
    };
    pushBounded(events, normalized, maxEvents);
    if (normalized.level === "error" || normalized.errorCode || normalized.error) {
      pushBounded(recentErrors, normalized, maxRecentErrors);
    }
  };

  const snapshot: SnapshotStore["snapshot"] = (params) => {
    const nowMs = params.nowMs ?? Date.now();
    const tenantId = readString(params.tenantId);
    const oneMinuteCutoff = nowMs - 60_000;
    const fiveMinuteCutoff = nowMs - 5 * 60_000;

    const filtered = events.filter((event) => {
      if (event.ts < fiveMinuteCutoff) {
        return false;
      }
      if (tenantId && event.tenantId !== tenantId) {
        return false;
      }
      return true;
    });

    const last5m = createEmptyStats();
    const last1m = createEmptyStats();
    const errorCodeCounts = new Map<string, number>();

    for (const event of filtered) {
      bump(last5m, event);
      if (event.ts >= oneMinuteCutoff) {
        bump(last1m, event);
      }
      if (event.errorCode) {
        errorCodeCounts.set(event.errorCode, (errorCodeCounts.get(event.errorCode) ?? 0) + 1);
      }
    }

    const topErrorCodes = [...errorCodeCounts.entries()]
      .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([code, count]) => ({ code, count }));

    const recentErrorsLimit = Math.max(
      1,
      Math.min(200, Math.trunc(params.recentErrorsLimit ?? 50)),
    );
    const filteredRecentErrors = recentErrors
      .filter((event) => {
        if (tenantId && event.tenantId !== tenantId) {
          return false;
        }
        return true;
      })
      .slice(-recentErrorsLimit)
      .map((event) => ({
        ts: event.ts,
        type: event.type,
        ...(event.channel ? { channel: event.channel } : {}),
        ...(event.tenantId ? { tenantId: event.tenantId } : {}),
        ...(event.errorCode ? { errorCode: event.errorCode } : {}),
        ...(event.error ? { error: event.error } : {}),
        ...(event.traceId ? { traceId: event.traceId } : {}),
      }));

    return {
      generatedAtMs: nowMs,
      ...(tenantId ? { tenantId } : {}),
      channels: params.channels,
      counters: {
        last1m,
        last5m,
      },
      queues: {
        depth: params.queueDepth,
        oldestQueuedAgeMs: params.oldestQueuedAgeMs,
      },
      topErrorCodes,
      recentErrors: filteredRecentErrors,
    };
  };

  return {
    observe,
    snapshot,
  };
}
