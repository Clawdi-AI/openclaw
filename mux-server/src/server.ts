import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRuntimeLauncher } from "./app/runtime-launcher.js";
import { createAuthService } from "./auth/service.js";
import { createDiscordApiService } from "./channels/discord/api.js";
import { createDiscordInboundRuntime } from "./channels/discord/inbound.js";
import {
  createIMessageApiService,
  IMESSAGE_ATTACHMENT_MAX_BYTES_EXPORT,
} from "./channels/imessage/api.js";
import { createIMessageInboundRuntime } from "./channels/imessage/inbound.js";
import {
  loadIMessageRuntimeModules,
  loadWebRuntimeModules as loadWebRuntimeModulesBase,
  loadDiscordRuntimeModules,
} from "./channels/runtime-modules.js";
import { createTelegramApiService } from "./channels/telegram/api.js";
import { createTelegramInboundRuntime } from "./channels/telegram/inbound.js";
import { createTelegramMediaService } from "./channels/telegram/media.js";
import { createWhatsAppInboundRuntime } from "./channels/whatsapp/inbound.js";
import { resolveChannelEnv, type MuxConfig } from "./config/env.js";
import {
  getNoticeText as lookupNoticeText,
  loadNoticesConfig,
  readConfiguredText,
  readRuntimeConfig,
  type NoticesConfig,
} from "./config/runtime.js";
import { initializeDatabase } from "./db/schema.js";
import { createPreparedStatements } from "./db/statements.js";
import { createBindingHelpers } from "./domain/binding-helpers.js";
import { createTenantSeedingService } from "./domain/tenant-seeding.js";
import {
  type DiscordBoundRoute,
  type LiveBindingLookupRow,
  type TenantSeed,
} from "./domain/types.js";
import { readNonEmptyString } from "./domain/values.js";
import { createOutboundRequestHandler } from "./http/outbound-request.js";
import {
  HttpBodyError,
  readBody as readJsonBody,
  sendJson as writeJson,
} from "./http/primitives.js";
import { createHttpRouteHandler } from "./http/routes.js";
import {
  normalizeObservabilityLogEvent,
  formatObservabilityLogLine,
} from "./observability/logging.js";
import { createMuxMetrics } from "./observability/metrics.js";
import { createObservabilityRuntime } from "./observability/runtime.js";
import { createOutboundService, type SendResult } from "./outbound/service.js";
import { createBotControlService } from "./pairing/bot-control.js";
import { createPairingNotices } from "./pairing/notices.js";
import { createPairingService } from "./pairing/service.js";
import {
  buildDiscordChannelSessionKey,
  buildDiscordDirectSessionKey,
  listIMessageOutboundRouteKeys,
  listTelegramOutboundRouteKeys,
  listWhatsAppOutboundRouteKeys,
  normalizeDiscordSessionAgentId,
  resolveOutboundResolutionMode,
} from "./routing/keys.js";
import { createRouteResolutionHelpers, normalizeChannel } from "./routing/route-resolution.js";
import { createRuntimeJwtSigner } from "./runtime-jwt.js";
import { isRetryableWhatsAppInboundStatus } from "./whatsapp-inbound-queue.js";

type ActiveWebListener = {
  close?: () => Promise<void>;
};

type WhatsAppRuntimeHealth = {
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

type TelegramPollConflictHealth = {
  lastConflictAtMs: number;
  lastError: string;
};

type TelegramRuntimeHealth = {
  loopStartedAtMs: number | null;
  lastPollSuccessAtMs: number | null;
  lastPollErrorAtMs: number | null;
  lastPollError: string | null;
  lastInboundSeenAtMs: number | null;
};

type DiscordRuntimeHealth = {
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

function loadWebRuntimeModules() {
  return loadWebRuntimeModulesBase(readNonEmptyString);
}

const runtimeConfig = readRuntimeConfig(process.env);
const {
  logPath,
  dbPath,
  idempotencyTtlMs,
  requestBodyMaxBytes,
  telegramApiBaseUrl,
  discordApiBaseUrl,
  muxPublicUrl,
} = runtimeConfig;
const channelEnv = resolveChannelEnv({ readNonEmptyString, resolveOutboundResolutionMode });
const { telegramBotToken, discordBotToken, muxRegisterKey } = channelEnv;
let telegramBotUsername = channelEnv.initialTelegramBotUsername;

const TELEGRAM_GENERAL_TOPIC_ID = 1;
const runtimeJwtAudienceMux = "mux-server";
const runtimeJwtAudienceOpenClaw = "openclaw-mux-inbound";
const runtimeTokenTtlSec = 86_400; // 1 day
const inboundTokenTtlSec = 5 * 60; // short-lived, per-delivery

const noticesConfig = loadNoticesConfig(process.env);

function getNoticeText(key: keyof NoticesConfig): string | null {
  return lookupNoticeText(noticesConfig, key);
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): string {
  return writeJson(res, statusCode, payload);
}

async function readBody<T extends object>(req: IncomingMessage): Promise<T> {
  return await readJsonBody<T>(req, requestBodyMaxBytes);
}

// Env var overrides take priority over config file
const pairingSuccessTextOverride =
  readConfiguredText(process.env.MUX_PAIRING_SUCCESS_TEXT) || getNoticeText("pairingSuccess");
const pairingInvalidTextOverride =
  readConfiguredText(process.env.MUX_PAIRING_INVALID_TEXT) || getNoticeText("pairingInvalid");
const botControlHelpTextOverride =
  readConfiguredText(process.env.MUX_BOT_HELP_TEXT) || getNoticeText("botHelp");
const botUnpairSuccessTextOverride =
  readConfiguredText(process.env.MUX_BOT_UNPAIR_SUCCESS_TEXT) || getNoticeText("botUnpairSuccess");
const botNotPairedTextOverride =
  readConfiguredText(process.env.MUX_BOT_NOT_PAIRED_TEXT) || getNoticeText("botNotPaired");
const botSwitchUsageTextOverride =
  readConfiguredText(process.env.MUX_BOT_SWITCH_USAGE_TEXT) || getNoticeText("botSwitchUsage");
const configuredUnpairedHintText =
  readConfiguredText(process.env.MUX_UNPAIRED_HINT_TEXT) || getNoticeText("clawdiIntro");
const pairingNotices = createPairingNotices({
  pairingSuccessTextOverride,
  pairingInvalidTextOverride,
  botControlHelpTextOverride,
  botUnpairSuccessTextOverride,
  botNotPairedTextOverride,
  botSwitchUsageTextOverride,
  configuredUnpairedHintText,
  getNoticeText,
});
const {
  extractTokenFromStartCommand,
  extractPairingTokenFromText,
  parseBotControlCommand,
  renderPairingSuccessNotice,
  renderPairingInvalidNotice,
  renderBotHelpNotice,
  renderBotUnpairSuccessNotice,
  renderBotNotPairedNotice,
  renderBotSwitchUsageNotice,
  renderUnpairedHintNotice,
  renderPairingRepairedNotice,
  renderPairingTakeoverNotice,
  renderWhatsAppContactTip,
  renderBotStatusNotice,
  resolvePostPairingPrompt,
} = pairingNotices;
const telegramApiService = createTelegramApiService({
  telegramApiBaseUrl,
  telegramGeneralTopicId: TELEGRAM_GENERAL_TOPIC_ID,
  requireTelegramBotToken,
});
const {
  ALLOWED_TELEGRAM_METHODS,
  sendTelegram,
  sendTelegramWithFallbacks,
  isTelegramMessageNotModified,
  isTelegramCommandText,
  hasTelegramMessageContent,
  sendTelegramPairingNotice,
  answerTelegramCallbackQuery,
} = telegramApiService;
const telegramMediaService = createTelegramMediaService({
  muxPublicUrl,
  requireTelegramBotToken,
  telegramApiBaseUrl,
});
const { resolveTelegramFilePath, extractTelegramInboundMedia } = telegramMediaService;
const discordApiService = createDiscordApiService({
  discordApiBaseUrl,
  requireDiscordBotToken,
  resolveLiveBindingByRouteKey,
});
const {
  discordRequest,
  parseDiscordGatewayPayload,
  fetchDiscordGatewayUrl,
  resolveDiscordDmChannelId,
  resolveDiscordDmChannelIdCached,
  resolveDiscordChannelInfo,
  resolveDiscordChannelGuildId,
  resolveDiscordIncomingRouteFromMessage,
  resolveDiscordBindingForIncoming,
  sendDiscordTyping,
  sortDiscordMessagesAsc,
  extractDiscordInboundMedia,
  isDiscordCommandText,
  hasDiscordMessageContent,
  sendDiscordPairingNotice,
} = discordApiService;
const runtimeJwtSigner = createRuntimeJwtSigner();

const { resolveTenantSeeds, resolvePairingCodeSeeds, seedTenants, seedPairingCodes } =
  createTenantSeedingService({
    muxRegisterKey,
  });

let tenantSeeds: TenantSeed[] = [];
try {
  tenantSeeds = resolveTenantSeeds();
} catch (error) {
  console.error(`failed to resolve mux tenants: ${String(error)}`);
  process.exit(1);
}

let pairingCodeSeeds: ReturnType<typeof resolvePairingCodeSeeds> = [];
try {
  pairingCodeSeeds = resolvePairingCodeSeeds();
} catch (error) {
  console.error(`failed to resolve pairing code seeds: ${String(error)}`);
  process.exit(1);
}

const config: MuxConfig = {
  ...runtimeConfig,
  ...channelEnv,
  telegramGeneralTopicId: 1,
  runtimeTokenTtlSec,
  runtimeJwtAudienceMux,
  runtimeJwtAudienceOpenClaw,
  inboundTokenTtlSec,
  tenantSeedCount: tenantSeeds.length,
  pairingCodeSeedCount: pairingCodeSeeds.length,
};

fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
initializeDatabase(db);
seedTenants(db, tenantSeeds);
seedPairingCodes(db, pairingCodeSeeds);

const stmts = createPreparedStatements(db);
const {
  stmtSelectTenantByHash,
  stmtSelectTenantById,
  stmtSelectTenantInboundTargetById,
  stmtCountActiveTenantInboundTargets,
  stmtDeleteExpiredIdempotency,
  stmtSelectCachedIdempotency,
  stmtUpsertIdempotency,
  stmtResolveSessionRouteBinding,
  stmtListSessionRoutesByBinding,
  stmtSelectSessionKeyByBinding,
  stmtSelectActiveBindingByTenantAndRoute,
  stmtSelectLiveBindingByRouteKey,
  stmtCountWhatsAppInboundQueue,
  stmtSelectOldestWhatsAppInboundQueue,
  stmtInsertAuditLog,
} = stmts;

const authService = createAuthService({
  runtimeJwtSigner,
  config,
  stmtSelectTenantById,
  stmtSelectTenantByHash,
  stmtSelectTenantInboundTargetById,
});
const {
  resolveTenantIdentity,
  isAdminAuthorized,
  isRegisterAuthorized,
  resolveTenantInboundTarget,
} = authService;

const idempotencyInflight = new Map<
  string,
  {
    fingerprint: string;
    promise: Promise<SendResult>;
  }
>();
let discordGatewayReady = false;
// Bot's own user ID, extracted from the Discord gateway READY event.
// Used to compute wasMentioned for inbound messages.
let discordBotSelfId: string | null = null;
let activeWhatsAppListener: ActiveWebListener | null = null;
const metrics = createMuxMetrics();
const telegramRuntimeHealth: TelegramRuntimeHealth = {
  loopStartedAtMs: null,
  lastPollSuccessAtMs: null,
  lastPollErrorAtMs: null,
  lastPollError: null,
  lastInboundSeenAtMs: null,
};
const discordRuntimeHealth: DiscordRuntimeHealth = {
  pollLoopStartedAtMs: null,
  lastPollSuccessAtMs: null,
  lastPollErrorAtMs: null,
  lastPollError: null,
  gatewayLoopStartedAtMs: null,
  gatewayReadyAtMs: null,
  gatewayLastCloseAtMs: null,
  gatewayLastErrorAtMs: null,
  gatewayLastError: null,
  lastInboundSeenAtMs: null,
};
const whatsappRuntimeHealth: WhatsAppRuntimeHealth = {
  listenerActive: false,
  loopStartedAtMs: null,
  lastListenerStartAtMs: null,
  lastListenerCloseAtMs: null,
  lastListenerCloseStatus: null,
  lastListenerClosedLoggedOut: null,
  lastListenerErrorAtMs: null,
  lastListenerError: null,
  lastInboundSeenAtMs: null,
};
let telegramPollConflictHealth: TelegramPollConflictHealth | null = null;

function resolveLiveBindingByRouteKey(
  channel: string,
  routeKey: string,
): LiveBindingLookupRow | null {
  const row = stmtSelectLiveBindingByRouteKey.get(channel, routeKey, routeKey) as
    | LiveBindingLookupRow
    | undefined;
  if (!row?.tenant_id || !row?.binding_id || !row?.status) {
    return null;
  }
  return {
    tenant_id: String(row.tenant_id),
    binding_id: String(row.binding_id),
    status: String(row.status),
  };
}

function isRouteBoundByAnotherTenant(params: {
  channel: string;
  routeKey: string;
  tenantId: string;
}): boolean {
  const row = resolveLiveBindingByRouteKey(params.channel, params.routeKey);
  return Boolean(row && row.tenant_id !== params.tenantId);
}

function isSqliteUniqueConstraintError(error: unknown): boolean {
  const text = String(error);
  return text.includes("SQLITE_CONSTRAINT") && text.includes("UNIQUE");
}

function log(entry: Record<string, unknown>) {
  const normalized = normalizeObservabilityLogEvent(entry);
  metrics.observeLogEvent(normalized);
  fs.appendFileSync(logPath, formatObservabilityLogLine(normalized));
}

function requireTelegramBotToken(): string {
  const token = telegramBotToken?.trim();
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required for telegram transport");
  }
  return token;
}

function requireDiscordBotToken(): string {
  const token = discordBotToken?.trim();
  if (!token) {
    throw new Error("DISCORD_BOT_TOKEN is required for discord transport");
  }
  return token;
}

const {
  resolveTelegramInboundSessionKey,
  resolveDiscordInboundSessionKey,
  resolveSessionRouteBinding,
  listDiscordOutboundRouteKeys,
} = createRouteResolutionHelpers({
  stmtListSessionRoutesByBinding,
  stmtSelectSessionKeyByBinding,
  stmtResolveSessionRouteBinding,
  stmtSelectActiveBindingByTenantAndRoute,
  resolveDiscordChannelInfo,
  deriveDiscordSessionKey,
});

const imessageApiService = createIMessageApiService({
  serverUrl: config.imessageServerUrl ?? "",
  apiKey: config.imessageApiKey ?? null,
  pairingContactVcardUrl: config.imessagePairingContactVcardUrl ?? undefined,
  log,
  loadSdkFactory: async () => {
    const runtime = await loadIMessageRuntimeModules();
    return runtime.createSdk;
  },
});

const {
  buildInboundAuthHeaders,
  isWhatsAppCommandText,
  hasWhatsAppMessageContent,
  sendWhatsAppPairingNotice,
  resolveTelegramBoundRoute,
  resolveDiscordBoundRoute,
  resolveWhatsAppBoundRoute,
  resolveIMessageBoundRoute,
  resolveDiscordOutboundChannelId,
  resolveTelegramIncomingTopicId,
  resolveTelegramBindingForIncoming,
  resolveWhatsAppBindingForIncoming,
  resolveIMessageBindingForIncoming,
  deactivateLiveBinding,
  setBindingPending,
  resolveBindingSessionKey,
  sendPostClaimNotices,
  forwardDiscordMessageToTenant,
  registerOpenClawInstance,
  upsertTenantInboundTargetByAdmin,
  resolveStoredTelegramOffset,
  storeTelegramOffset,
  resolveStoredDiscordOffset,
  storeDiscordOffset,
  resolveDiscordInboundChannelId,
} = createBindingHelpers({
  db: stmts,
  config,
  getDiscordBotSelfId: () => discordBotSelfId,
  getDiscordRuntimeHealth: () => discordRuntimeHealth,
  runtimeJwtSigner,
  resolveDiscordChannelInfo,
  resolveDiscordChannelGuildId,
  resolveDiscordDmChannelId,
  resolveDiscordDmChannelIdCached,
  resolveDiscordInboundSessionKey,
  resolveSessionRouteBinding,
  extractDiscordInboundMedia,
  resolveTenantInboundTarget,
  resolvePostPairingPrompt,
  metrics,
  renderPairingRepairedNotice,
  renderPairingTakeoverNotice,
  renderPairingSuccessNotice,
  renderWhatsAppContactTip,
  loadWebRuntimeModules,
  log,
  writeAuditLog,
});

function writeAuditLog(
  tenantId: string,
  eventType: string,
  payload: Record<string, unknown>,
  timestampMs = Date.now(),
) {
  stmtInsertAuditLog.run(tenantId, eventType, JSON.stringify(payload), timestampMs);
}

const pairingService = createPairingService({
  dbExec: (sql) => db.exec(sql),
  config,
  telegramBotUsername,
  buildThreadScopedSessionKey,
  deriveDiscordSessionKey,
  resolveLiveBindingByRouteKey,
  db: stmts,
  isRouteBoundByAnotherTenant,
  isSqliteUniqueConstraintError,
  writeAuditLog,
});
const {
  issuePairingTokenForTenant,
  peekActivePairingToken,
  claimTelegramPairingToken,
  claimDiscordPairingToken,
  claimWhatsAppPairingToken,
  claimIMessagePairingToken,
  claimPairingForTenant,
  listPairingsForTenant,
  unbindPairingForTenant,
} = pairingService;

const botControlService = createBotControlService({
  extractTokenFromStartCommand,
  extractPairingTokenFromText,
  renderPairingInvalidNotice,
  renderBotHelpNotice,
  renderBotUnpairSuccessNotice,
  renderBotNotPairedNotice,
  renderBotSwitchUsageNotice,
  renderBotStatusNotice,
  resolveBindingSessionKey,
  peekActivePairingToken,
  claimTelegramPairingToken,
  claimDiscordPairingToken,
  claimWhatsAppPairingToken,
  deactivateLiveBinding,
  setBindingPending,
  sendPostClaimNotices,
  sendTelegramPairingNotice,
  sendDiscordPairingNotice,
  sendWhatsAppPairingNotice,
});
const {
  extractPairingTokenFromTelegramMessage,
  extractPairingTokenFromDiscordMessage,
  extractPairingTokenFromWhatsAppMessage,
  handleTelegramBotControlCommand,
  handleDiscordBotControlCommand,
  handleDiscordBotControlCommandUnbound,
  handleWhatsAppBotControlCommand,
} = botControlService;

function deriveDiscordSessionKey(params: {
  route: DiscordBoundRoute;
  channelId: string;
  agentId?: string;
}): string {
  const agentId = normalizeDiscordSessionAgentId(params.agentId ?? null);
  if (params.route.kind === "dm") {
    return buildDiscordDirectSessionKey(params.route.userId, agentId);
  }
  return buildDiscordChannelSessionKey(
    params.route.threadId ?? params.route.channelId ?? params.channelId,
    agentId,
  );
}

function buildThreadScopedSessionKey(
  baseSessionKey: string,
  chatId: string,
  topicId: number,
): string {
  const normalizedBase = baseSessionKey.trim().replace(/:(thread|topic):[^:]+$/i, "");
  return chatId.startsWith("-")
    ? `${normalizedBase}:topic:${topicId}`
    : `${normalizedBase}:thread:${topicId}`;
}

const discordBgRetryCount = new Map<string, number>();
const discordBgRetryQueuedAtMs = new Map<string, number>();
const telegramBgRetryCount = new Map<string, number>();
const telegramBgRetryQueuedAtMs = new Map<string, number>();

const {
  countActiveTenantInboundTargets,
  renderMetricsPayload,
  buildReadinessReport,
  renderObservabilitySnapshot,
  getWhatsAppCredentialHealth,
} = createObservabilityRuntime({
  metrics,
  stmtCountActiveTenantInboundTargets: {
    get: () => stmtCountActiveTenantInboundTargets.get() as { count?: unknown } | undefined,
  },
  stmtCountWhatsAppInboundQueue: {
    get: () => stmtCountWhatsAppInboundQueue.get() as { count?: unknown } | undefined,
  },
  stmtSelectOldestWhatsAppInboundQueue: {
    get: () =>
      stmtSelectOldestWhatsAppInboundQueue.get() as { oldest_created_at_ms?: unknown } | undefined,
  },
  telegramBgRetryCount,
  telegramBgRetryQueuedAtMs,
  discordBgRetryCount,
  discordBgRetryQueuedAtMs,
  telegramInboundEnabled: config.telegramInboundEnabled,
  getTelegramPollConflictHealth: () => telegramPollConflictHealth,
  telegramRuntimeHealth,
  discordInboundEnabled: config.discordInboundEnabled,
  discordRuntimeHealth,
  whatsappInboundEnabled: config.whatsappInboundEnabled,
  whatsappRuntimeHealth,
  whatsappAuthDir: config.whatsappAuthDir,
  whatsappAccountId: config.whatsappAccountId,
  openclawMuxAccountId: config.openclawMuxAccountId,
  imessageInboundEnabled: config.imessageInboundEnabled,
  imessageRuntimeHealth: imessageApiService.getHealth(),
});

const { runTelegramInboundLoop } = createTelegramInboundRuntime({
  config,
  telegramBotUsername,
  metrics,
  telegramRuntimeHealth,
  getTelegramPollConflictHealth: () => telegramPollConflictHealth,
  setTelegramPollConflictHealth: (health) => {
    telegramPollConflictHealth = health;
  },
  telegramBgRetryCount,
  telegramBgRetryQueuedAtMs,
  requireTelegramBotToken,
  log,
  resolveStoredTelegramOffset,
  storeTelegramOffset,
  answerTelegramCallbackQuery,
  resolveTelegramIncomingTopicId: (params) =>
    resolveTelegramIncomingTopicId({
      isForum: params.isForum,
      messageThreadId: params.messageThreadId,
    }),
  resolveTelegramBindingForIncoming,
  resolveTenantInboundTarget,
  resolveTelegramInboundSessionKey,
  db: stmts,
  buildInboundAuthHeaders,
  extractTelegramInboundMedia,
  parseBotControlCommand,
  handleTelegramBotControlCommand,
  isTelegramCommandText,
  hasTelegramMessageContent,
  renderUnpairedHintNotice,
  sendTelegramPairingNotice,
  renderPairingInvalidNotice,
  extractPairingTokenFromTelegramMessage,
  claimTelegramPairingToken,
  sendPostClaimNotices,
});

const { runDiscordInboundLoop, runDiscordGatewayDmLoop } = createDiscordInboundRuntime({
  config,
  metrics,
  discordRuntimeHealth,
  discordBgRetryCount,
  discordBgRetryQueuedAtMs,
  getDiscordGatewayReady: () => discordGatewayReady,
  setDiscordGatewayReady: (ready) => {
    discordGatewayReady = ready;
  },
  getDiscordBotSelfId: () => discordBotSelfId,
  setDiscordBotSelfId: (botSelfId) => {
    discordBotSelfId = botSelfId;
  },
  requireDiscordBotToken,
  log,
  resolveDiscordInboundChannelId,
  resolveStoredDiscordOffset,
  storeDiscordOffset,
  sortDiscordMessagesAsc,
  parseBotControlCommand,
  handleDiscordBotControlCommand,
  handleDiscordBotControlCommandUnbound,
  extractPairingTokenFromDiscordMessage,
  peekActivePairingToken,
  claimDiscordPairingToken,
  sendPostClaimNotices,
  isDiscordCommandText,
  hasDiscordMessageContent,
  renderUnpairedHintNotice,
  sendDiscordPairingNotice,
  renderPairingInvalidNotice,
  db: stmts,
  resolveDiscordIncomingRouteFromMessage,
  resolveDiscordBindingForIncoming,
  forwardDiscordMessageToTenant,
  parseDiscordGatewayPayload,
  fetchDiscordGatewayUrl,
});

const { start: startIMessageInbound, stop: stopIMessageInbound } = createIMessageInboundRuntime({
  config,
  apiService: imessageApiService,
  metrics,
  log,
  db: stmts,
  selectActiveBindingByRouteKey: (channel, routeKey) => {
    if (channel !== "imessage") {
      return null;
    }
    return resolveIMessageBindingForIncoming(routeKey);
  },
  resolveTenantInboundTarget,
  buildInboundAuthHeaders,
  claimIMessagePairingToken,
  renderUnpairedHintNotice,
  sendPostClaimNotices,
});
// Reference stopIMessageInbound so typecheck does not drop the export; reserved for future
// graceful-shutdown wiring (mirrors discord/whatsapp pattern where close is per-listener).
void stopIMessageInbound;

const { runWhatsAppInboundLoop } = createWhatsAppInboundRuntime({
  config,
  whatsappRuntimeHealth,
  getActiveWhatsAppListener: () => activeWhatsAppListener,
  setActiveWhatsAppListener: (listener) => {
    activeWhatsAppListener = listener;
  },
  loadWebRuntimeModules,
  log,
  db: stmts,
  writeAuditLog,
  metrics,
  parseBotControlCommand,
  handleWhatsAppBotControlCommand,
  extractPairingTokenFromWhatsAppMessage,
  isWhatsAppCommandText,
  hasWhatsAppMessageContent,
  renderUnpairedHintNotice,
  sendWhatsAppPairingNotice,
  claimWhatsAppPairingToken,
  renderPairingInvalidNotice,
  sendPostClaimNotices,
  resolveWhatsAppBindingForIncoming,
  resolveTenantInboundTarget,
  isRetryableWhatsAppInboundStatus,
  buildInboundAuthHeaders,
});

const { runOutboundAction, runOutboundSend } = createOutboundService({
  config,
  allowedTelegramMethods: ALLOWED_TELEGRAM_METHODS,
  metrics,
  log,
  normalizeChannel,
  listTelegramOutboundRouteKeys,
  listDiscordOutboundRouteKeys,
  listWhatsAppOutboundRouteKeys,
  listIMessageOutboundRouteKeys,
  resolveTelegramBoundRoute,
  resolveDiscordBoundRoute,
  resolveWhatsAppBoundRoute,
  resolveIMessageBoundRoute,
  resolveDiscordOutboundChannelId,
  sendTelegram,
  sendTelegramWithFallbacks,
  isTelegramMessageNotModified,
  sendDiscordTyping,
  discordRequest,
  requireDiscordBotToken,
  loadDiscordRuntimeModules,
  loadWebRuntimeModules,
  imessageApiService: {
    getSdk: () => imessageApiService.getSdk(),
    sendMessage: imessageApiService.sendMessage,
    sendAttachment: imessageApiService.sendAttachment,
    sendAttachmentBytes: imessageApiService.sendAttachmentBytes,
  },
  imessageAttachmentMaxBytes: IMESSAGE_ATTACHMENT_MAX_BYTES_EXPORT,
});

/**
 * Build the migration-export dump for a tenant: tenant metadata + active
 * bindings, shaped for the flat mux → msg-router migration plan (see
 * docs/plans/2026-04-20-flat-mux-tenant-migration.md). Emits the raw
 * mux-server shape (channel / scope / routeKey); the importer on msg-router
 * translates to msg-router's binding schema.
 */
function exportTenantMigration(tenantId: string) {
  const tenant = stmts.stmtSelectTenantById.get(tenantId) as
    | { id: string; name: string }
    | undefined;
  if (!tenant) {
    return null;
  }
  const rows = stmts.stmtListActiveBindingsByTenant.all(tenantId) as Array<{
    binding_id: string;
    channel: string;
    scope: string;
    route_key: string;
  }>;
  return {
    schemaVersion: 1 as const,
    dumpedAtMs: Date.now(),
    tenant: { id: String(tenant.id), name: String(tenant.name) },
    bindings: rows.map((row) => ({
      channel: String(row.channel),
      scope: String(row.scope),
      routeKey: String(row.route_key),
    })),
  };
}

const { handleRequest } = createHttpRouteHandler({
  config,
  getTelegramBotUsername: () => telegramBotUsername,
  getTelegramPollConflictHealth: () => telegramPollConflictHealth,
  runtimeJwtSigner,
  sendJson,
  readBody,
  metrics,
  log,
  isRegisterAuthorized,
  isAdminAuthorized,
  resolveTenantIdentity,
  buildReadinessReport,
  renderMetricsPayload,
  registerOpenClawInstance,
  getWhatsAppCredentialHealth,
  renderObservabilitySnapshot,
  upsertTenantInboundTargetByAdmin,
  issuePairingTokenForTenant,
  listPairingsForTenant,
  claimPairingForTenant,
  unbindPairingForTenant,
  normalizeChannel,
  runOutboundAction,
  resolveTelegramFilePath,
  requireTelegramBotToken,
  exportTenantMigration,
});

const { handleOutboundSendRequest } = createOutboundRequestHandler({
  idempotencyTtlMs,
  idempotencyInflight,
  stmtDeleteExpiredIdempotency,
  stmtSelectCachedIdempotency: {
    get: (tenantId, idempotencyKey, now) =>
      stmtSelectCachedIdempotency.get(tenantId, idempotencyKey, now) as
        | {
            request_fingerprint: string;
            response_status: number;
            response_body: string;
          }
        | undefined,
  },
  stmtUpsertIdempotency: {
    run: (
      tenantId,
      idempotencyKey,
      fingerprint,
      statusCode,
      bodyText,
      expiresAtMs,
      createdAtMs,
    ) => {
      stmtUpsertIdempotency.run(
        tenantId,
        idempotencyKey,
        fingerprint,
        statusCode,
        bodyText,
        expiresAtMs,
        createdAtMs,
      );
    },
  },
  readBody,
  sendJson,
  normalizeChannel,
  metrics,
  log,
  runOutboundSend,
});

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const handled = await handleRequest({ req, res, requestUrl });
    if (handled.handled) {
      return;
    }
    await handleOutboundSendRequest({
      req,
      res,
      tenant: handled.tenant,
    });
  } catch (error) {
    if (error instanceof HttpBodyError) {
      sendJson(res, error.statusCode, { ok: false, error: error.message });
      return;
    }
    log({ type: "relay_error", error: String(error) });
    sendJson(res, 500, { ok: false, error: String(error) });
  }
});

export const { startMuxServerRuntime } = createRuntimeLauncher({
  config: { ...config, telegramBotToken: telegramBotToken ?? undefined },
  server,
  countActiveTenantInboundTargets,
  log,
  runWhatsAppInboundLoop,
  getTelegramBotUsername: () => telegramBotUsername,
  setTelegramBotUsername: (username) => {
    telegramBotUsername = username;
  },
  runTelegramInboundLoop,
  getDiscordBotSelfId: () => discordBotSelfId,
  setDiscordBotSelfId: (botSelfId) => {
    discordBotSelfId = botSelfId;
  },
  discordRequest,
  runDiscordInboundLoop,
  runDiscordGatewayDmLoop,
  runIMessageInboundLoop: startIMessageInbound,
});

await startMuxServerRuntime();
