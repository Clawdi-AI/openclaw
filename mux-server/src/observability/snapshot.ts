type ChannelName = "telegram" | "discord" | "whatsapp";

type ChannelHealthState = {
  status: string;
  ready: boolean;
  reason?: string;
  lastSuccessAtMs?: number | null;
  lastErrorAtMs?: number | null;
  lastError?: string | null;
  lastInboundSeenAtMs?: number | null;
};

export type QueueSnapshot = {
  depth: Record<ChannelName, number>;
  oldestQueuedAgeMs: Record<ChannelName, number | null>;
};

export type TelegramPollConflictSnapshot = {
  lastConflictAtMs: number;
  lastError: string;
} | null;

export type TelegramRuntimeSnapshot = {
  loopStartedAtMs: number | null;
  lastPollSuccessAtMs: number | null;
  lastPollErrorAtMs: number | null;
  lastPollError: string | null;
  lastInboundSeenAtMs: number | null;
};

export type DiscordRuntimeSnapshot = {
  pollLoopStartedAtMs: number | null;
  lastPollSuccessAtMs: number | null;
  lastPollErrorAtMs: number | null;
  lastPollError: string | null;
  lastInboundSeenAtMs: number | null;
};

export type WhatsAppRuntimeSnapshot = {
  listenerActive: boolean;
  lastListenerStartAtMs: number | null;
  lastListenerErrorAtMs: number | null;
  lastListenerError: string | null;
  lastInboundSeenAtMs: number | null;
};

export function readNonNegativeCount(value: unknown): number {
  const count = Number(value);
  if (!Number.isFinite(count) || count < 0) {
    return 0;
  }
  return Math.trunc(count);
}

export function readOldestQueuedAgeMs(value: unknown, nowMs: number): number | null {
  const oldestCreatedAtMs = Number(value);
  if (!Number.isFinite(oldestCreatedAtMs) || oldestCreatedAtMs <= 0) {
    return null;
  }
  return Math.max(0, Math.trunc(nowMs - oldestCreatedAtMs));
}

function countPendingRetries(map: Map<string, number>): number {
  let total = 0;
  for (const value of map.values()) {
    if (Number.isFinite(value) && value > 0) {
      total += Math.trunc(value);
    }
  }
  return total;
}

function resolveOldestRetryAgeMs(
  queuedAtByTenant: Map<string, number>,
  nowMs: number,
): number | null {
  let oldest: number | null = null;
  for (const queuedAtMs of queuedAtByTenant.values()) {
    if (!Number.isFinite(queuedAtMs) || queuedAtMs <= 0) {
      continue;
    }
    oldest = oldest == null ? queuedAtMs : Math.min(oldest, queuedAtMs);
  }
  if (oldest == null) {
    return null;
  }
  return Math.max(0, Math.trunc(nowMs - oldest));
}

export function buildObservabilityQueueSnapshot(params: {
  nowMs: number;
  telegramBgRetryCount: Map<string, number>;
  telegramBgRetryQueuedAtMs: Map<string, number>;
  discordBgRetryCount: Map<string, number>;
  discordBgRetryQueuedAtMs: Map<string, number>;
  whatsappQueueDepth: number;
  whatsappOldestQueuedAgeMs: number | null;
}): QueueSnapshot {
  return {
    depth: {
      telegram: countPendingRetries(params.telegramBgRetryCount),
      discord: countPendingRetries(params.discordBgRetryCount),
      whatsapp: params.whatsappQueueDepth,
    },
    oldestQueuedAgeMs: {
      telegram: resolveOldestRetryAgeMs(params.telegramBgRetryQueuedAtMs, params.nowMs),
      discord: resolveOldestRetryAgeMs(params.discordBgRetryQueuedAtMs, params.nowMs),
      whatsapp: params.whatsappOldestQueuedAgeMs,
    },
  };
}

export function buildObservabilityReadinessReport(params: {
  nowMs: number;
  queues: QueueSnapshot;
  telegramInboundEnabled: boolean;
  telegramPollConflictHealth: TelegramPollConflictSnapshot;
  telegramRuntimeHealth: TelegramRuntimeSnapshot;
  discordInboundEnabled: boolean;
  discordRuntimeHealth: DiscordRuntimeSnapshot;
  whatsappInboundEnabled: boolean;
  whatsappRuntimeHealth: WhatsAppRuntimeSnapshot;
  whatsappCredentialStatus: string;
}): {
  ready: boolean;
  channels: Record<ChannelName, ChannelHealthState>;
  queues: QueueSnapshot;
  degraded: Array<{ channel: ChannelName; reason: string }>;
} {
  const telegram = (() => {
    if (!params.telegramInboundEnabled) {
      return { status: "disabled", ready: true } as const;
    }
    if (params.telegramPollConflictHealth) {
      return {
        status: "degraded",
        ready: false,
        reason: "poll_conflict",
        lastErrorAtMs: params.telegramPollConflictHealth.lastConflictAtMs,
        lastError: params.telegramPollConflictHealth.lastError,
        lastSuccessAtMs: params.telegramRuntimeHealth.lastPollSuccessAtMs,
        lastInboundSeenAtMs: params.telegramRuntimeHealth.lastInboundSeenAtMs,
      } as const;
    }
    if (!params.telegramRuntimeHealth.loopStartedAtMs) {
      return { status: "starting", ready: false, reason: "loop_not_started" } as const;
    }
    if (!params.telegramRuntimeHealth.lastPollSuccessAtMs) {
      if (params.telegramRuntimeHealth.lastPollErrorAtMs) {
        return {
          status: "degraded",
          ready: false,
          reason: "poll_error",
          lastErrorAtMs: params.telegramRuntimeHealth.lastPollErrorAtMs,
          lastError: params.telegramRuntimeHealth.lastPollError,
          lastInboundSeenAtMs: params.telegramRuntimeHealth.lastInboundSeenAtMs,
        } as const;
      }
      return { status: "starting", ready: false, reason: "waiting_first_poll" } as const;
    }
    return {
      status: "ready",
      ready: true,
      lastSuccessAtMs: params.telegramRuntimeHealth.lastPollSuccessAtMs,
      lastErrorAtMs: params.telegramRuntimeHealth.lastPollErrorAtMs,
      lastError: params.telegramRuntimeHealth.lastPollError,
      lastInboundSeenAtMs: params.telegramRuntimeHealth.lastInboundSeenAtMs,
    } as const;
  })();

  const discord = (() => {
    if (!params.discordInboundEnabled) {
      return { status: "disabled", ready: true } as const;
    }
    if (!params.discordRuntimeHealth.pollLoopStartedAtMs) {
      return { status: "starting", ready: false, reason: "poll_loop_not_started" } as const;
    }
    if (!params.discordRuntimeHealth.lastPollSuccessAtMs) {
      if (params.discordRuntimeHealth.lastPollErrorAtMs) {
        return {
          status: "degraded",
          ready: false,
          reason: "poll_error",
          lastErrorAtMs: params.discordRuntimeHealth.lastPollErrorAtMs,
          lastError: params.discordRuntimeHealth.lastPollError,
          lastInboundSeenAtMs: params.discordRuntimeHealth.lastInboundSeenAtMs,
        } as const;
      }
      return { status: "starting", ready: false, reason: "waiting_first_poll" } as const;
    }
    return {
      status: "ready",
      ready: true,
      lastSuccessAtMs: params.discordRuntimeHealth.lastPollSuccessAtMs,
      lastErrorAtMs: params.discordRuntimeHealth.lastPollErrorAtMs,
      lastError: params.discordRuntimeHealth.lastPollError,
      lastInboundSeenAtMs: params.discordRuntimeHealth.lastInboundSeenAtMs,
    } as const;
  })();

  const whatsapp = (() => {
    if (!params.whatsappInboundEnabled) {
      return { status: "disabled", ready: true } as const;
    }
    if (params.whatsappRuntimeHealth.listenerActive) {
      return {
        status: "ready",
        ready: true,
        lastSuccessAtMs: params.whatsappRuntimeHealth.lastListenerStartAtMs,
        lastErrorAtMs: params.whatsappRuntimeHealth.lastListenerErrorAtMs,
        lastError: params.whatsappRuntimeHealth.lastListenerError,
        lastInboundSeenAtMs: params.whatsappRuntimeHealth.lastInboundSeenAtMs,
      } as const;
    }
    const reason =
      params.whatsappCredentialStatus === "missing_credentials"
        ? "missing_credentials"
        : "listener_not_active";
    return {
      status: "degraded",
      ready: false,
      reason,
      lastErrorAtMs: params.whatsappRuntimeHealth.lastListenerErrorAtMs,
      lastError: params.whatsappRuntimeHealth.lastListenerError,
      lastInboundSeenAtMs: params.whatsappRuntimeHealth.lastInboundSeenAtMs,
    } as const;
  })();

  const channels = { telegram, discord, whatsapp };
  const degraded = (
    Object.entries(channels) as Array<[ChannelName, { ready: boolean; reason?: string }]>
  )
    .filter(([, value]) => !value.ready)
    .map(([channel, value]) => ({
      channel,
      reason: value.reason ?? "not_ready",
    }));

  return {
    ready: degraded.length === 0,
    channels,
    queues: params.queues,
    degraded,
  };
}

export function buildObservabilitySnapshot(params: {
  nowMs: number;
  tenantId?: string;
  readiness: ReturnType<typeof buildObservabilityReadinessReport>;
}) {
  const zeroCounters = {
    telegram: { events: 0, errors: 0, forwarded: 0, deferred: 0, dropped: 0 },
    discord: { events: 0, errors: 0, forwarded: 0, deferred: 0, dropped: 0 },
    whatsapp: { events: 0, errors: 0, forwarded: 0, deferred: 0, dropped: 0 },
  };
  return {
    generatedAtMs: params.nowMs,
    ...(params.tenantId ? { tenantId: params.tenantId } : {}),
    channels: params.readiness.channels,
    counters: {
      last1m: zeroCounters,
      last5m: zeroCounters,
    },
    queues: params.readiness.queues,
    topErrorCodes: [],
    recentErrors: [],
  };
}
