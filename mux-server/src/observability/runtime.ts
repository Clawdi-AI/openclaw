import fs from "node:fs";
import path from "node:path";
import {
  buildObservabilityQueueSnapshot,
  buildObservabilityReadinessReport,
  buildObservabilitySnapshot,
  readNonNegativeCount,
  readOldestQueuedAgeMs,
} from "./snapshot.js";

export function createObservabilityRuntime(deps: {
  metrics: {
    renderPrometheus: (
      queueDepthByChannel: Record<"telegram" | "discord" | "whatsapp", number>,
      nowMs?: number,
    ) => Promise<string>;
  };
  stmtCountActiveTenantInboundTargets: {
    get: () => { count?: unknown } | undefined;
  };
  stmtCountWhatsAppInboundQueue: {
    get: () => { count?: unknown } | undefined;
  };
  stmtSelectOldestWhatsAppInboundQueue: {
    get: () => { oldest_created_at_ms?: unknown } | undefined;
  };
  telegramBgRetryCount: Map<string, number>;
  telegramBgRetryQueuedAtMs: Map<string, number>;
  discordBgRetryCount: Map<string, number>;
  discordBgRetryQueuedAtMs: Map<string, number>;
  telegramInboundEnabled: boolean;
  getTelegramPollConflictHealth: () => { lastConflictAtMs: number; lastError: string } | null;
  telegramRuntimeHealth: {
    loopStartedAtMs: number | null;
    lastPollSuccessAtMs: number | null;
    lastPollErrorAtMs: number | null;
    lastPollError: string | null;
    lastInboundSeenAtMs: number | null;
  };
  discordInboundEnabled: boolean;
  discordRuntimeHealth: {
    pollLoopStartedAtMs: number | null;
    lastPollSuccessAtMs: number | null;
    lastPollErrorAtMs: number | null;
    lastPollError: string | null;
    gatewayLoopStartedAtMs: number | null;
    gatewayReadyAtMs: number | null;
    gatewayLastCloseAtMs: number | null;
    gatewayLastErrorAtMs: number | null;
    gatewayLastError: string | null;
    lastInboundSeenAtMs: number | null;
  };
  whatsappInboundEnabled: boolean;
  whatsappRuntimeHealth: {
    listenerActive: boolean;
    loopStartedAtMs: number | null;
    lastListenerStartAtMs: number | null;
    lastListenerCloseAtMs: number | null;
    lastListenerCloseStatus: number | null;
    lastListenerClosedLoggedOut: boolean | null;
    lastListenerErrorAtMs: number | null;
    lastListenerError: string | null;
    lastInboundSeenAtMs: number | null;
  };
  whatsappAuthDir: string;
  whatsappAccountId: string;
  openclawMuxAccountId: string;
}): {
  countActiveTenantInboundTargets: () => number;
  renderMetricsPayload: () => Promise<string>;
  buildQueueSnapshot: (nowMs?: number) => {
    depth: Record<"telegram" | "discord" | "whatsapp", number>;
    oldestQueuedAgeMs: Record<"telegram" | "discord" | "whatsapp", number | null>;
  };
  buildReadinessReport: (nowMs?: number) => {
    ready: boolean;
    channels: Record<
      "telegram" | "discord" | "whatsapp",
      {
        status: string;
        ready: boolean;
        reason?: string;
        lastSuccessAtMs?: number | null;
        lastErrorAtMs?: number | null;
        lastError?: string | null;
        lastInboundSeenAtMs?: number | null;
      }
    >;
    queues: {
      depth: Record<"telegram" | "discord" | "whatsapp", number>;
      oldestQueuedAgeMs: Record<"telegram" | "discord" | "whatsapp", number | null>;
    };
    degraded: Array<{ channel: "telegram" | "discord" | "whatsapp"; reason: string }>;
  };
  renderObservabilitySnapshot: (params: {
    nowMs?: number;
    tenantId?: string;
  }) => Record<string, unknown>;
  getWhatsAppCredentialHealth: () => {
    status: string;
    inboundEnabled: boolean;
    accountId: string;
    openclawAccountId: string;
    authDir: string;
    authDirExists: boolean;
    credsPath: string;
    creds: { present: boolean; sizeBytes?: number; mtimeMs?: number };
    credsMeId: string | null;
    fileCounts: {
      session: number;
      senderKey: number;
      preKey: number;
      deviceList: number;
      lidMapping: number;
    };
    runtime: {
      listenerActive: boolean;
      loopStartedAtMs: number | null;
      lastListenerStartAtMs: number | null;
      lastListenerCloseAtMs: number | null;
      lastListenerCloseStatus: number | null;
      lastListenerClosedLoggedOut: boolean | null;
      lastListenerErrorAtMs: number | null;
      lastListenerError: string | null;
      lastInboundSeenAtMs: number | null;
    };
    scanError?: string;
  };
} {
  function countActiveTenantInboundTargets(): number {
    const row = deps.stmtCountActiveTenantInboundTargets.get();
    return readNonNegativeCount(row?.count);
  }

  function countWhatsAppInboundQueueDepth(): number {
    const row = deps.stmtCountWhatsAppInboundQueue.get();
    return readNonNegativeCount(row?.count);
  }

  function resolveWhatsAppOldestQueuedAgeMs(nowMs = Date.now()): number | null {
    const row = deps.stmtSelectOldestWhatsAppInboundQueue.get();
    return readOldestQueuedAgeMs(row?.oldest_created_at_ms, nowMs);
  }

  function getWhatsAppCredentialHealth() {
    const authDir = deps.whatsappAuthDir;
    const credsPath = path.join(authDir, "creds.json");
    const authDirExists = fs.existsSync(authDir);
    const credsPresent = fs.existsSync(credsPath);
    const fileCounts = {
      session: 0,
      senderKey: 0,
      preKey: 0,
      deviceList: 0,
      lidMapping: 0,
    };
    let scanError: string | null = null;

    if (authDirExists) {
      try {
        for (const entry of fs.readdirSync(authDir)) {
          if (entry.startsWith("session-")) {
            fileCounts.session += 1;
            continue;
          }
          if (entry.startsWith("sender-key-")) {
            fileCounts.senderKey += 1;
            continue;
          }
          if (entry.startsWith("pre-key-")) {
            fileCounts.preKey += 1;
            continue;
          }
          if (entry.startsWith("device-list-")) {
            fileCounts.deviceList += 1;
            continue;
          }
          if (entry.startsWith("lid-mapping-")) {
            fileCounts.lidMapping += 1;
          }
        }
      } catch (error) {
        scanError = String(error);
      }
    }

    let credsStat: { present: boolean; sizeBytes?: number; mtimeMs?: number } = {
      present: credsPresent,
    };
    let credsMeId: string | null = null;
    if (credsPresent) {
      try {
        const stat = fs.statSync(credsPath);
        credsStat = {
          present: true,
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs,
        };
        const parsedCreds = JSON.parse(fs.readFileSync(credsPath, "utf8")) as {
          me?: { id?: unknown };
        };
        if (typeof parsedCreds.me?.id === "string" && parsedCreds.me.id.trim() !== "") {
          credsMeId = parsedCreds.me.id.trim();
        }
      } catch {
        credsStat = { present: true };
      }
    }

    let status = "disabled";
    if (deps.whatsappInboundEnabled) {
      if (!authDirExists || !credsPresent) {
        status = "missing_credentials";
      } else if (deps.whatsappRuntimeHealth.listenerActive) {
        status = "listening";
      } else if (deps.whatsappRuntimeHealth.lastListenerErrorAtMs) {
        status = "listener_error";
      } else {
        status = "starting_or_idle";
      }
    }

    return {
      status,
      inboundEnabled: deps.whatsappInboundEnabled,
      accountId: deps.whatsappAccountId,
      openclawAccountId: deps.openclawMuxAccountId,
      authDir,
      authDirExists,
      credsPath,
      creds: credsStat,
      credsMeId,
      fileCounts,
      runtime: {
        listenerActive: deps.whatsappRuntimeHealth.listenerActive,
        loopStartedAtMs: deps.whatsappRuntimeHealth.loopStartedAtMs,
        lastListenerStartAtMs: deps.whatsappRuntimeHealth.lastListenerStartAtMs,
        lastListenerCloseAtMs: deps.whatsappRuntimeHealth.lastListenerCloseAtMs,
        lastListenerCloseStatus: deps.whatsappRuntimeHealth.lastListenerCloseStatus,
        lastListenerClosedLoggedOut: deps.whatsappRuntimeHealth.lastListenerClosedLoggedOut,
        lastListenerErrorAtMs: deps.whatsappRuntimeHealth.lastListenerErrorAtMs,
        lastListenerError: deps.whatsappRuntimeHealth.lastListenerError,
        lastInboundSeenAtMs: deps.whatsappRuntimeHealth.lastInboundSeenAtMs,
      },
      ...(scanError ? { scanError } : {}),
    };
  }

  function buildQueueSnapshot(nowMs = Date.now()) {
    return buildObservabilityQueueSnapshot({
      nowMs,
      telegramBgRetryCount: deps.telegramBgRetryCount,
      telegramBgRetryQueuedAtMs: deps.telegramBgRetryQueuedAtMs,
      discordBgRetryCount: deps.discordBgRetryCount,
      discordBgRetryQueuedAtMs: deps.discordBgRetryQueuedAtMs,
      whatsappQueueDepth: countWhatsAppInboundQueueDepth(),
      whatsappOldestQueuedAgeMs: resolveWhatsAppOldestQueuedAgeMs(nowMs),
    });
  }

  function buildReadinessReport(nowMs = Date.now()) {
    const queues = buildQueueSnapshot(nowMs);
    const whatsAppCredentialHealth = getWhatsAppCredentialHealth();
    return buildObservabilityReadinessReport({
      nowMs,
      queues,
      telegramInboundEnabled: deps.telegramInboundEnabled,
      telegramPollConflictHealth: deps.getTelegramPollConflictHealth(),
      telegramRuntimeHealth: deps.telegramRuntimeHealth,
      discordInboundEnabled: deps.discordInboundEnabled,
      discordRuntimeHealth: deps.discordRuntimeHealth,
      whatsappInboundEnabled: deps.whatsappInboundEnabled,
      whatsappRuntimeHealth: deps.whatsappRuntimeHealth,
      whatsappCredentialStatus: whatsAppCredentialHealth.status,
    });
  }

  function renderObservabilitySnapshot(params: { nowMs?: number; tenantId?: string }) {
    const nowMs = params.nowMs ?? Date.now();
    const readiness = buildReadinessReport(nowMs);
    return buildObservabilitySnapshot({
      nowMs,
      tenantId: params.tenantId,
      readiness,
    });
  }

  async function renderMetricsPayload(): Promise<string> {
    const queues = buildQueueSnapshot(Date.now());
    return await deps.metrics.renderPrometheus(queues.depth);
  }

  return {
    countActiveTenantInboundTargets,
    renderMetricsPayload,
    buildQueueSnapshot,
    buildReadinessReport,
    renderObservabilitySnapshot,
    getWhatsAppCredentialHealth,
  };
}
