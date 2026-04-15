import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { RequestClient } from "@buape/carbon";
import WebSocket from "ws";
import { createRuntimeLauncher } from "./app/runtime-launcher.js";
import { createAuthService, hashApiKey } from "./auth/service.js";
import { createDiscordInboundRuntime } from "./channels/discord/inbound.js";
import { createTelegramInboundRuntime } from "./channels/telegram/inbound.js";
import { createWhatsAppInboundRuntime } from "./channels/whatsapp/inbound.js";
import {
  getNoticeText as lookupNoticeText,
  loadNoticesConfig,
  readConfiguredText,
  readRuntimeConfig,
  type NoticesConfig,
} from "./config/runtime.js";
import { initializeDatabase } from "./db/schema.js";
import {
  type ActiveBindingLookupRow,
  type ClaimResult,
  type ClaimType,
  type DiscordBoundRoute,
  type LiveBindingLookupRow,
  type NoticeChannel,
  type OutboundResolutionMode,
  type ResolvedBoundRoute,
  type StyledNotice,
  type TelegramBoundRoute,
  type TenantInboundTarget,
  type TenantSeed,
  type WhatsAppBoundRoute,
} from "./domain/types.js";
import {
  asRecord,
  readNonEmptyString,
  readPositiveInt,
  readUnsignedNumericString,
} from "./domain/values.js";
import { createOutboundRequestHandler } from "./http/outbound-request.js";
import {
  HttpBodyError,
  readBody as readJsonBody,
  sendJson as writeJson,
} from "./http/primitives.js";
import { createHttpRouteHandler } from "./http/routes.js";
import {
  buildWhatsAppInboundEnvelope,
  buildDiscordInboundEnvelope,
  buildTelegramCallbackInboundEnvelope,
  buildTelegramInboundEnvelope,
  type MuxInboundAttachment,
} from "./mux-envelope.js";
import {
  normalizeObservabilityLogEvent,
  formatObservabilityLogLine,
} from "./observability/logging.js";
import { createMuxMetrics } from "./observability/metrics.js";
import { createObservabilityRuntime } from "./observability/runtime.js";
import { createInboundTraceId } from "./observability/tracing.js";
import { createOutboundService, type SendResult } from "./outbound/service.js";
import { createBotControlService } from "./pairing/bot-control.js";
import { createPairingNotices } from "./pairing/notices.js";
import { createPairingService } from "./pairing/service.js";
import {
  buildDiscordChannelSessionKey,
  buildDiscordDirectSessionKey,
  buildDiscordDmRouteKey,
  buildDiscordGuildRouteKey,
  buildDiscordRouteKey,
  buildDiscordThreadScopedSessionKey,
  buildTelegramRouteKey,
  buildWhatsAppRouteKey,
  deriveTelegramSessionKey,
  deriveWhatsAppSessionKey,
  listTelegramOutboundRouteKeys,
  listWhatsAppOutboundRouteKeys,
  normalizeDiscordSessionAgentId,
  parseDiscordOutboundTarget,
  parseDiscordRouteKey,
  parseTelegramRouteKey,
  parseWhatsAppRouteKey,
  resolveDiscordBindingRouteKeyForClaim,
  resolveDiscordBindingScope,
  resolveOutboundResolutionMode,
} from "./routing/keys.js";
import { createRouteResolutionHelpers, normalizeChannel } from "./routing/route-resolution.js";
import { createRuntimeJwtSigner } from "./runtime-jwt.js";
import {
  classifyWhatsAppInboundDeliveryError,
  isRetryableWhatsAppInboundStatus,
  resolveWhatsAppInboundQueueRetryState,
} from "./whatsapp-inbound-queue.js";

type PairingCodeSeed = {
  code: string;
  channel: string;
  routeKey: string;
  scope: string;
  expiresAtMs: number;
};

type WebInboundMessage = {
  id?: string;
  from: string;
  to: string;
  accountId: string;
  body: string;
  timestamp?: number;
  chatType: "direct" | "group";
  chatId: string;
  senderJid?: string;
  senderE164?: string;
  senderName?: string;
  replyToId?: string;
  replyToBody?: string;
  replyToSender?: string;
  replyToSenderJid?: string;
  replyToSenderE164?: string;
  groupSubject?: string;
  groupParticipants?: string[];
  mentionedJids?: string[];
  mediaPath?: string;
  mediaType?: string;
  mediaUrl?: string;
};

type ActiveWebListener = {
  close?: () => Promise<void>;
};

type WebListenerCloseReason = {
  status?: number;
  isLoggedOut: boolean;
  error?: unknown;
};

type WebMonitorListener = ActiveWebListener & {
  close: () => Promise<void>;
  onClose: Promise<WebListenerCloseReason>;
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

type WebRuntimeModules = {
  monitorWebInbox: (options: {
    verbose: boolean;
    accountId: string;
    authDir: string;
    onMessage: (msg: WebInboundMessage) => Promise<void>;
    resolveAccessControl?: (params: {
      accountId: string;
      from: string;
      selfE164: string | null;
      senderE164: string | null;
      group: boolean;
      pushName?: string;
      isFromMe: boolean;
      messageTimestampMs?: number;
      connectedAtMs?: number;
      sock: {
        sendMessage: (jid: string, content: { text: string }) => Promise<unknown>;
      };
      remoteJid: string;
    }) => Promise<{
      allowed: boolean;
      shouldMarkRead: boolean;
      isSelfChat: boolean;
      resolvedAccountId: string;
    }>;
    mediaMaxMb?: number;
    sendReadReceipts?: boolean;
    debounceMs?: number;
    shouldDebounce?: (msg: WebInboundMessage) => boolean;
  }) => Promise<WebMonitorListener>;
  sendMessageWhatsApp: (
    to: string,
    body: string,
    options: {
      verbose: boolean;
      mediaUrl?: string;
      gifPlayback?: boolean;
      accountId?: string;
    },
  ) => Promise<{ messageId: string; toJid: string }>;
  sendTypingWhatsApp: (to: string, options: { accountId?: string }) => Promise<void>;
  setActiveWebListener: (accountId: string | null | undefined, listener: unknown) => void;
};

type DiscordRuntimeModules = {
  sendMessageDiscord: (
    to: string,
    text: string,
    opts: {
      token?: string;
      rest?: RequestClient;
      mediaUrl?: string;
      verbose?: boolean;
      replyTo?: string;
    },
  ) => Promise<{ messageId: string; channelId: string }>;
};

type TelegramIncomingMessage = {
  message_id?: number;
  date?: number;
  text?: string;
  caption?: string;
  message_thread_id?: number;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  video?: TelegramVideo;
  animation?: TelegramAnimation;
  voice?: TelegramVoice;
  audio?: TelegramAudio;
  video_note?: TelegramVideoNote;
  from?: { id?: number; username?: string };
  chat?: { id?: number; type?: string; is_forum?: boolean };
  entities?: Array<{ type?: string; offset?: number; length?: number }>;
  reply_to_message?: { from?: { username?: string } };
};

type TelegramPhotoSize = {
  file_id?: string;
  file_unique_id?: string;
  width?: number;
  height?: number;
  file_size?: number;
};

type TelegramDocument = {
  file_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

type TelegramVideo = {
  file_id?: string;
  file_name?: string;
  mime_type?: string;
  width?: number;
  height?: number;
  duration?: number;
  file_size?: number;
};

type TelegramAnimation = {
  file_id?: string;
  file_name?: string;
  mime_type?: string;
  width?: number;
  height?: number;
  duration?: number;
  file_size?: number;
};

type TelegramVoice = {
  file_id?: string;
  mime_type?: string;
  duration?: number;
  file_size?: number;
};

type TelegramAudio = {
  file_id?: string;
  file_name?: string;
  mime_type?: string;
  duration?: number;
  file_size?: number;
};

type TelegramVideoNote = {
  file_id?: string;
  length?: number;
  duration?: number;
  file_size?: number;
};

type TelegramInboundAttachment = MuxInboundAttachment;

type TelegramInboundMediaSummary = {
  kind: string;
  fileId: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  width?: number;
  height?: number;
  durationSec?: number;
  filePath?: string;
};

type DiscordInboundAttachment = MuxInboundAttachment;

type DiscordInboundMediaSummary = {
  id?: string;
  fileName?: string;
  mimeType?: string;
  size?: number;
  url?: string;
};

type TelegramParseMode = "HTML";

function resolveDefaultWhatsAppAuthDir(): string {
  const stateDirRaw =
    process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  const stateDir = stateDirRaw ? path.resolve(stateDirRaw) : path.join(os.homedir(), ".openclaw");
  const oauthDirRaw = process.env.OPENCLAW_OAUTH_DIR?.trim();
  const oauthDir = oauthDirRaw ? path.resolve(oauthDirRaw) : path.join(stateDir, "credentials");
  return path.join(oauthDir, "whatsapp", "default");
}

let webRuntimeModulesPromise: Promise<WebRuntimeModules> | null = null;
let discordRuntimeModulesPromise: Promise<DiscordRuntimeModules> | null = null;

async function loadWebRuntimeModules(): Promise<WebRuntimeModules> {
  if (!webRuntimeModulesPromise) {
    webRuntimeModulesPromise = (async () => {
      const runtimeOverridePath = readNonEmptyString(process.env.MUX_WEB_RUNTIME_MODULE_PATH);
      if (runtimeOverridePath) {
        const overrideHref = pathToFileURL(path.resolve(runtimeOverridePath)).href;
        const runtimeModule = (await import(overrideHref)) as {
          monitorWebInbox?: WebRuntimeModules["monitorWebInbox"];
          sendMessageWhatsApp?: WebRuntimeModules["sendMessageWhatsApp"];
          sendTypingWhatsApp?: WebRuntimeModules["sendTypingWhatsApp"];
          setActiveWebListener?: WebRuntimeModules["setActiveWebListener"];
        };
        if (
          typeof runtimeModule.monitorWebInbox !== "function" ||
          typeof runtimeModule.sendMessageWhatsApp !== "function" ||
          typeof runtimeModule.sendTypingWhatsApp !== "function" ||
          typeof runtimeModule.setActiveWebListener !== "function"
        ) {
          throw new Error("failed to load WhatsApp runtime modules from override path");
        }
        return {
          monitorWebInbox: runtimeModule.monitorWebInbox,
          sendMessageWhatsApp: runtimeModule.sendMessageWhatsApp,
          sendTypingWhatsApp: runtimeModule.sendTypingWhatsApp,
          setActiveWebListener: runtimeModule.setActiveWebListener,
        };
      }
      const inboundModulePath = "../../src/web/inbound.js";
      const outboundModulePath = "../../src/web/outbound.js";
      const activeListenerModulePath = "../../src/web/active-listener.js";
      const inboundModule = (await import(inboundModulePath)) as {
        monitorWebInbox?: WebRuntimeModules["monitorWebInbox"];
      };
      const outboundModule = (await import(outboundModulePath)) as {
        sendMessageWhatsApp?: WebRuntimeModules["sendMessageWhatsApp"];
        sendTypingWhatsApp?: WebRuntimeModules["sendTypingWhatsApp"];
      };
      const activeListenerModule = (await import(activeListenerModulePath)) as {
        setActiveWebListener?: WebRuntimeModules["setActiveWebListener"];
      };
      if (
        typeof inboundModule.monitorWebInbox !== "function" ||
        typeof outboundModule.sendMessageWhatsApp !== "function" ||
        typeof outboundModule.sendTypingWhatsApp !== "function" ||
        typeof activeListenerModule.setActiveWebListener !== "function"
      ) {
        throw new Error("failed to load WhatsApp runtime modules");
      }
      return {
        monitorWebInbox: inboundModule.monitorWebInbox,
        sendMessageWhatsApp: outboundModule.sendMessageWhatsApp,
        sendTypingWhatsApp: outboundModule.sendTypingWhatsApp,
        setActiveWebListener: activeListenerModule.setActiveWebListener,
      };
    })();
  }
  return await webRuntimeModulesPromise;
}

async function loadDiscordRuntimeModules(): Promise<DiscordRuntimeModules> {
  if (!discordRuntimeModulesPromise) {
    discordRuntimeModulesPromise = (async () => {
      const outboundModulePath = "../../src/discord/send.outbound.js";
      const outboundModule = (await import(outboundModulePath)) as {
        sendMessageDiscord?: DiscordRuntimeModules["sendMessageDiscord"];
      };
      if (typeof outboundModule.sendMessageDiscord !== "function") {
        throw new Error("failed to load Discord runtime modules");
      }
      return {
        sendMessageDiscord: outboundModule.sendMessageDiscord,
      };
    })();
  }
  return await discordRuntimeModulesPromise;
}

const runtimeConfig = readRuntimeConfig(process.env);
const {
  host,
  port,
  muxPublicUrl,
  logPath,
  dbPath,
  idempotencyTtlMs,
  telegramApiBaseUrl,
  discordApiBaseUrl,
  requestBodyMaxBytes,
} = runtimeConfig;
const TELEGRAM_GENERAL_TOPIC_ID = 1;
const muxAdminToken = readNonEmptyString(process.env.MUX_ADMIN_TOKEN);
const muxRegisterKey = readNonEmptyString(process.env.MUX_REGISTER_KEY);
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
const discordBotToken = process.env.DISCORD_BOT_TOKEN;
const outboundResolutionMode = resolveOutboundResolutionMode(
  process.env.MUX_OUTBOUND_RESOLUTION_MODE,
);
// OpenClaw account id for mux-routed inbound events. Keep this separate from
// platform account ids so direct channel bots can remain unchanged.
const openclawMuxAccountId = readNonEmptyString(process.env.MUX_OPENCLAW_ACCOUNT_ID) || "default";
const whatsappAccountId = readNonEmptyString(process.env.MUX_WHATSAPP_ACCOUNT_ID) || "default";
const whatsappAuthDir =
  readNonEmptyString(process.env.MUX_WHATSAPP_AUTH_DIR) || resolveDefaultWhatsAppAuthDir();
const whatsappAllowedFileDirs: string[] = [os.tmpdir(), whatsappAuthDir].map((d) =>
  path.resolve(d),
);

const telegramInboundEnabled = Boolean(readNonEmptyString(telegramBotToken));
const telegramPollTimeoutSec = Number(process.env.MUX_TELEGRAM_POLL_TIMEOUT_SEC || 25);
const telegramPollRetryMs = Number(process.env.MUX_TELEGRAM_POLL_RETRY_MS || 1_000);
const telegramBootstrapLatest = process.env.MUX_TELEGRAM_BOOTSTRAP_LATEST !== "false";
const discordInboundEnabled = Boolean(readNonEmptyString(discordBotToken));
const discordPollIntervalMs = Number(process.env.MUX_DISCORD_POLL_INTERVAL_MS || 2_000);
const discordBootstrapLatest = process.env.MUX_DISCORD_BOOTSTRAP_LATEST !== "false";
const discordPendingGcEnabled = process.env.MUX_DISCORD_PENDING_GC_ENABLED === "true";
// TODO(phala): simplify to gateway-only Discord DM ingestion and remove
// MUX_DISCORD_GATEWAY_DM_ENABLED plus DM polling fallback.
const discordGatewayDmEnabled = process.env.MUX_DISCORD_GATEWAY_DM_ENABLED !== "false";
const discordGatewayGuildEnabled = process.env.MUX_DISCORD_GATEWAY_GUILD_ENABLED !== "false";
const discordGatewayDefaultIntents = discordGatewayGuildEnabled
  ? 37_377 // Guilds + GuildMessages + DirectMessages + MessageContent
  : 36_864; // DirectMessages + MessageContent
const discordGatewayIntents = Number(
  process.env.MUX_DISCORD_GATEWAY_INTENTS ||
    process.env.MUX_DISCORD_GATEWAY_DM_INTENTS ||
    discordGatewayDefaultIntents,
);
const discordGatewayReconnectInitialMs = Number(
  process.env.MUX_DISCORD_GATEWAY_RECONNECT_INITIAL_MS || 1_000,
);
const discordGatewayReconnectMaxMs = Number(
  process.env.MUX_DISCORD_GATEWAY_RECONNECT_MAX_MS || 30_000,
);
const whatsappInboundEnabled = fs.existsSync(path.join(whatsappAuthDir, "creds.json"));
const whatsappInboundRetryMs = Number(process.env.MUX_WHATSAPP_INBOUND_RETRY_MS || 1_000);
const whatsappQueuePollMs = Number(process.env.MUX_WHATSAPP_QUEUE_POLL_MS || 500);
const whatsappQueueRetryInitialMs = Number(
  process.env.MUX_WHATSAPP_QUEUE_RETRY_INITIAL_MS || 1_000,
);
const whatsappQueueRetryMaxMs = Number(process.env.MUX_WHATSAPP_QUEUE_RETRY_MAX_MS || 60_000);
const whatsappQueueBatchSize = Number(process.env.MUX_WHATSAPP_QUEUE_BATCH_SIZE || 20);
const whatsappQueueMaxAgeMs = Number(process.env.MUX_WHATSAPP_QUEUE_MAX_AGE_MS || 24 * 60 * 60_000);
const pairingTokenTtlSec = Number(process.env.MUX_PAIRING_TOKEN_TTL_SEC || 15 * 60);
const pairingTokenMaxTtlSec = Number(process.env.MUX_PAIRING_TOKEN_MAX_TTL_SEC || 60 * 60);
let telegramBotUsername = readNonEmptyString(process.env.MUX_TELEGRAM_BOT_USERNAME);

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
  normalizeControlText,
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
const runtimeJwtAudienceMux = "mux-server";
const runtimeJwtAudienceOpenClaw = "openclaw-mux-inbound";
const runtimeTokenTtlSec = 86_400; // 1 day
const inboundTokenTtlSec = 5 * 60; // short-lived, per-delivery
const runtimeJwtSigner = createRuntimeJwtSigner();

let tenantSeeds: TenantSeed[] = [];
try {
  tenantSeeds = resolveTenantSeeds();
} catch (error) {
  console.error(`failed to resolve mux tenants: ${String(error)}`);
  process.exit(1);
}

let pairingCodeSeeds: PairingCodeSeed[] = [];
try {
  pairingCodeSeeds = resolvePairingCodeSeeds();
} catch (error) {
  console.error(`failed to resolve pairing code seeds: ${String(error)}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(logPath), { recursive: true });
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
initializeDatabase(db);
seedTenants(db, tenantSeeds);
seedPairingCodes(db, pairingCodeSeeds);

const stmtSelectTenantByHash = db.prepare(`
  SELECT id, name
  FROM tenants
  WHERE api_key_hash = ? AND status = 'active'
  LIMIT 1
`);

const stmtSelectTenantById = db.prepare(`
  SELECT id, name
  FROM tenants
  WHERE id = ? AND status = 'active'
  LIMIT 1
`);

const stmtUpsertTenantByRegister = db.prepare(`
  INSERT INTO tenants (
    id,
    name,
    api_key_hash,
    status,
    inbound_url,
    inbound_token,
    inbound_timeout_ms,
    created_at_ms,
    updated_at_ms
  )
  VALUES (?, ?, ?, 'active', ?, NULL, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    api_key_hash = excluded.api_key_hash,
    status = 'active',
    inbound_url = excluded.inbound_url,
    inbound_token = NULL,
    inbound_timeout_ms = excluded.inbound_timeout_ms,
    updated_at_ms = excluded.updated_at_ms
`);

const stmtUpsertTenantInboundTargetByAdmin = db.prepare(`
  INSERT INTO tenants (
    id,
    name,
    api_key_hash,
    status,
    inbound_url,
    inbound_token,
    inbound_timeout_ms,
    created_at_ms,
    updated_at_ms
  )
  VALUES (?, ?, ?, 'active', ?, NULL, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    status = 'active',
    inbound_url = excluded.inbound_url,
    inbound_token = NULL,
    inbound_timeout_ms = excluded.inbound_timeout_ms,
    updated_at_ms = excluded.updated_at_ms
`);

const stmtSelectTenantInboundTargetById = db.prepare(`
  SELECT inbound_url, inbound_token, inbound_timeout_ms, updated_at_ms
  FROM tenants
  WHERE id = ? AND status = 'active'
  LIMIT 1
`);

const authService = createAuthService({
  runtimeJwtSigner,
  runtimeJwtAudienceMux,
  stmtSelectTenantById,
  stmtSelectTenantByHash,
  stmtSelectTenantInboundTargetById,
  muxAdminToken,
  muxRegisterKey,
});
const {
  resolveTenantIdentity,
  isAdminAuthorized,
  isRegisterAuthorized,
  resolveTenantInboundTarget,
} = authService;

const stmtCountActiveTenantInboundTargets = db.prepare(`
  SELECT COUNT(*) AS count
  FROM tenants
  WHERE status = 'active'
    AND inbound_url IS NOT NULL
    AND TRIM(inbound_url) <> ''
`);

const stmtDeleteExpiredIdempotency = db.prepare(`
  DELETE FROM idempotency_keys
  WHERE expires_at_ms <= ?
`);

const stmtSelectCachedIdempotency = db.prepare(`
  SELECT request_fingerprint, response_status, response_body
  FROM idempotency_keys
  WHERE tenant_id = ? AND key = ? AND expires_at_ms > ?
  LIMIT 1
`);

const stmtUpsertIdempotency = db.prepare(`
  INSERT INTO idempotency_keys (
    tenant_id,
    key,
    request_fingerprint,
    response_status,
    response_body,
    expires_at_ms,
    created_at_ms
  )
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(tenant_id, key) DO UPDATE SET
    request_fingerprint = excluded.request_fingerprint,
    response_status = excluded.response_status,
    response_body = excluded.response_body,
    expires_at_ms = excluded.expires_at_ms
`);

const stmtSelectPairingCodeByCode = db.prepare(`
  SELECT channel, route_key, scope, expires_at_ms, claimed_by_tenant_id
  FROM pairing_codes
  WHERE code = ?
  LIMIT 1
`);

const stmtClaimPairingCode = db.prepare(`
  UPDATE pairing_codes
  SET claimed_by_tenant_id = ?, claimed_at_ms = ?
  WHERE code = ? AND claimed_by_tenant_id IS NULL AND expires_at_ms > ?
`);

const stmtRevertPairingCodeClaim = db.prepare(`
  UPDATE pairing_codes
  SET claimed_by_tenant_id = NULL, claimed_at_ms = NULL
  WHERE code = ? AND claimed_by_tenant_id = ?
`);

const stmtDeleteExpiredPairingTokens = db.prepare(`
  DELETE FROM pairing_tokens
  WHERE expires_at_ms <= ?
`);

const stmtDeactivateStaleDiscordPendingBindings = db.prepare(`
  UPDATE bindings
  SET status = 'inactive', updated_at_ms = ?
  WHERE channel = 'discord'
    AND status = 'pending'
    AND NOT EXISTS (
      SELECT 1
      FROM pairing_tokens pt
      WHERE pt.tenant_id = bindings.tenant_id
        AND pt.consumed_at_ms IS NULL
        AND pt.expires_at_ms > ?
    )
`);

const stmtInsertPairingToken = db.prepare(`
  INSERT INTO pairing_tokens (
    token_hash,
    tenant_id,
    channel,
    session_key,
    created_at_ms,
    expires_at_ms,
    consumed_at_ms,
    consumed_binding_id,
    consumed_route_key
  )
  VALUES (?, ?, NULL, ?, ?, ?, NULL, NULL, NULL)
`);

const stmtSelectActivePairingTokenByHash = db.prepare(`
  SELECT tenant_id, session_key
  FROM pairing_tokens
  WHERE token_hash = ? AND consumed_at_ms IS NULL AND expires_at_ms > ?
  LIMIT 1
`);

const stmtConsumePairingToken = db.prepare(`
  UPDATE pairing_tokens
  SET consumed_at_ms = ?
  WHERE token_hash = ? AND consumed_at_ms IS NULL AND expires_at_ms > ?
`);

const stmtAttachPairingTokenBinding = db.prepare(`
  UPDATE pairing_tokens
  SET consumed_binding_id = ?, consumed_route_key = ?
  WHERE token_hash = ?
`);

const stmtInsertBinding = db.prepare(`
  INSERT INTO bindings (
    binding_id,
    tenant_id,
    channel,
    scope,
    route_key,
    status,
    created_at_ms,
    updated_at_ms
  )
  VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
`);

const stmtInsertPendingBinding = db.prepare(`
  INSERT INTO bindings (
    binding_id,
    tenant_id,
    channel,
    scope,
    route_key,
    status,
    created_at_ms,
    updated_at_ms
  )
  VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
`);

const stmtActivatePendingBinding = db.prepare(`
  UPDATE bindings
  SET status = 'active', updated_at_ms = ?
  WHERE binding_id = ? AND tenant_id = ? AND status = 'pending'
`);

const stmtListActiveBindingsByTenant = db.prepare(`
  SELECT binding_id, channel, scope, route_key
  FROM bindings
  WHERE tenant_id = ? AND status = 'active'
  ORDER BY created_at_ms DESC
`);

const stmtUnbindActiveBinding = db.prepare(`
  UPDATE bindings
  SET status = 'inactive', updated_at_ms = ?
  WHERE binding_id = ? AND tenant_id = ? AND status = 'active'
`);

const stmtDeactivateLiveBinding = db.prepare(`
  UPDATE bindings
  SET status = 'inactive', updated_at_ms = ?
  WHERE binding_id = ? AND tenant_id = ? AND status IN ('active', 'pending')
`);

const stmtSetBindingPending = db.prepare(`
  UPDATE bindings
  SET status = 'pending', updated_at_ms = ?
  WHERE binding_id = ? AND tenant_id = ? AND status IN ('active', 'pending')
`);

const stmtDeleteSessionRoutesByBinding = db.prepare(`
  DELETE FROM session_routes
  WHERE binding_id = ? AND tenant_id = ?
`);

const stmtUpsertSessionRoute = db.prepare(`
  INSERT INTO session_routes (
    tenant_id,
    channel,
    session_key,
    binding_id,
    channel_context_json,
    updated_at_ms
  )
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(tenant_id, channel, session_key) DO UPDATE SET
    binding_id = excluded.binding_id,
    channel_context_json = excluded.channel_context_json,
    updated_at_ms = excluded.updated_at_ms
`);

const stmtResolveSessionRouteBinding = db.prepare(`
  SELECT sr.binding_id, b.route_key, sr.channel_context_json
  FROM session_routes sr
  JOIN bindings b ON b.binding_id = sr.binding_id
  WHERE sr.tenant_id = ?
    AND sr.channel = ?
    AND sr.session_key = ?
    AND b.tenant_id = sr.tenant_id
    AND b.channel = sr.channel
    AND b.status = 'active'
  LIMIT 1
`);

const stmtListSessionRoutesByBinding = db.prepare(`
  SELECT session_key, channel_context_json
  FROM session_routes
  WHERE tenant_id = ? AND channel = ? AND binding_id = ?
  ORDER BY updated_at_ms DESC
`);

const stmtSelectSessionKeyByBinding = db.prepare(`
  SELECT session_key
  FROM session_routes
  WHERE tenant_id = ? AND channel = ? AND binding_id = ?
  ORDER BY updated_at_ms DESC
  LIMIT 1
`);

const stmtSelectActiveBindingByRouteKey = db.prepare(`
  SELECT tenant_id, binding_id
  FROM bindings
  WHERE channel = ? AND route_key = ? AND status = 'active'
  ORDER BY updated_at_ms DESC
  LIMIT 1
`);

const stmtSelectLiveBindingByRouteKey = db.prepare(`
  SELECT tenant_id, binding_id, status
  FROM bindings
  WHERE channel = ? AND route_key = ? AND status IN ('active', 'pending')
  ORDER BY updated_at_ms DESC
  LIMIT 1
`);

const stmtSelectActiveBindingByTenantAndRoute = db.prepare(`
  SELECT binding_id, status
  FROM bindings
  WHERE tenant_id = ? AND channel = ? AND route_key = ? AND status IN ('active', 'pending')
  ORDER BY updated_at_ms DESC
  LIMIT 1
`);

const stmtListActiveDiscordBindings = db.prepare(`
  SELECT tenant_id, binding_id, route_key, status
  FROM bindings
  WHERE channel = 'discord' AND status IN ('active', 'pending')
  ORDER BY updated_at_ms ASC
`);

const stmtSelectTelegramOffset = db.prepare(`
  SELECT last_update_id
  FROM telegram_offsets
  WHERE id = 1
`);

const stmtUpsertTelegramOffset = db.prepare(`
  INSERT INTO telegram_offsets (id, last_update_id, updated_at_ms)
  VALUES (1, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    last_update_id = excluded.last_update_id,
    updated_at_ms = excluded.updated_at_ms
`);

const stmtSelectDiscordOffsetByBinding = db.prepare(`
  SELECT last_message_id
  FROM discord_offsets
  WHERE binding_id = ?
  LIMIT 1
`);

const stmtUpsertDiscordOffsetByBinding = db.prepare(`
  INSERT INTO discord_offsets (binding_id, last_message_id, updated_at_ms)
  VALUES (?, ?, ?)
  ON CONFLICT(binding_id) DO UPDATE SET
    last_message_id = excluded.last_message_id,
    updated_at_ms = excluded.updated_at_ms
`);

const stmtInsertWhatsAppInboundQueue = db.prepare(`
  INSERT INTO whatsapp_inbound_queue (
    dedupe_key,
    payload_json,
    next_attempt_at_ms,
    attempt_count,
    last_error,
    delivery_window_started_at_ms,
    last_target_update_at_ms,
    created_at_ms,
    updated_at_ms
  )
  VALUES (?, ?, ?, 0, NULL, ?, 0, ?, ?)
  ON CONFLICT(dedupe_key) DO NOTHING
`);

const stmtSelectDueWhatsAppInboundQueue = db.prepare(`
  SELECT
    id,
    dedupe_key,
    payload_json,
    attempt_count,
    created_at_ms,
    delivery_window_started_at_ms,
    last_target_update_at_ms
  FROM whatsapp_inbound_queue
  WHERE next_attempt_at_ms <= ?
  ORDER BY id ASC
  LIMIT ?
`);

const stmtDeleteWhatsAppInboundQueueById = db.prepare(`
  DELETE FROM whatsapp_inbound_queue
  WHERE id = ?
`);

const stmtDeferWhatsAppInboundQueueById = db.prepare(`
  UPDATE whatsapp_inbound_queue
  SET
    next_attempt_at_ms = ?,
    attempt_count = ?,
    last_error = ?,
    updated_at_ms = ?,
    delivery_window_started_at_ms = ?,
    last_target_update_at_ms = ?
  WHERE id = ?
`);

const stmtCountWhatsAppInboundQueue = db.prepare(`
  SELECT COUNT(*) AS count
  FROM whatsapp_inbound_queue
`);

const stmtSelectOldestWhatsAppInboundQueue = db.prepare(`
  SELECT MIN(created_at_ms) AS oldest_created_at_ms
  FROM whatsapp_inbound_queue
`);

const stmtInsertAuditLog = db.prepare(`
  INSERT INTO audit_logs (tenant_id, event_type, payload_json, created_at_ms)
  VALUES (?, ?, ?, ?)
`);

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
const discordChannelInfoCache = new Map<
  string,
  {
    guildId: string | null;
    parentId: string | null;
    channelType: number | null;
    expiresAtMs: number;
  }
>();
const discordChannelGuildCacheTtlMs = 30_000;
const discordDmChannelCache = new Map<string, { channelId: string; expiresAtMs: number }>();
const discordDmChannelCacheTtlMs = 10 * 60_000;
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
  const row = stmtSelectLiveBindingByRouteKey.get(channel, routeKey) as
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

async function mintRuntimeJwt(params: {
  openclawId: string;
  scope: string;
  audiences: string[];
  ttlSec?: number;
  nowMs?: number;
}): Promise<string> {
  return await runtimeJwtSigner.mint({
    subject: params.openclawId,
    audiences: params.audiences,
    scope: params.scope,
    ttlSec: Math.max(1, Math.trunc(params.ttlSec ?? runtimeTokenTtlSec)),
    nowMs: params.nowMs,
  });
}

async function buildInboundAuthHeaders(
  target: TenantInboundTarget,
  traceId?: string,
): Promise<Record<string, string>> {
  const runtimeJwt = await mintRuntimeJwt({
    openclawId: target.openclawId,
    scope: "mux:inbound",
    audiences: [runtimeJwtAudienceOpenClaw],
    ttlSec: inboundTokenTtlSec,
  });
  return {
    Authorization: `Bearer ${runtimeJwt}`,
    "X-OpenClaw-Id": target.openclawId,
    ...(typeof traceId === "string" && traceId.trim() ? { "X-Mux-Trace-Id": traceId.trim() } : {}),
  };
}

function resolveTenantSeeds(): TenantSeed[] {
  const raw = process.env.MUX_TENANTS_JSON?.trim();
  if (!raw) {
    const apiKey = readNonEmptyString(process.env.MUX_API_KEY);
    if (apiKey) {
      const inboundUrl = readNonEmptyString(process.env.MUX_OPENCLAW_INBOUND_URL) ?? undefined;
      const inboundTimeoutMs =
        readPositiveInt(process.env.MUX_OPENCLAW_INBOUND_TIMEOUT_MS) ?? 15_000;
      return [
        {
          id: "tenant-default",
          name: "default",
          apiKey,
          inboundUrl,
          inboundTimeoutMs,
        },
      ];
    }

    // Instance-centric mode: tenants are created via POST /v1/instances/register.
    if (muxRegisterKey) {
      return [];
    }

    throw new Error("Set MUX_API_KEY, MUX_TENANTS_JSON, or MUX_REGISTER_KEY");
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("MUX_TENANTS_JSON must be a non-empty JSON array");
  }

  const seeds: TenantSeed[] = [];
  const seenIds = new Set<string>();
  const seenHashes = new Set<string>();

  for (const item of parsed) {
    if (!item || typeof item !== "object") {
      throw new Error("each tenant in MUX_TENANTS_JSON must be an object");
    }
    const candidate = item as Record<string, unknown>;
    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    const apiKey = typeof candidate.apiKey === "string" ? candidate.apiKey.trim() : "";
    const name =
      typeof candidate.name === "string" && candidate.name.trim() ? candidate.name.trim() : id;
    const inboundUrl =
      typeof candidate.inboundUrl === "string" && candidate.inboundUrl.trim()
        ? candidate.inboundUrl.trim()
        : undefined;
    const inboundTimeoutMs =
      typeof candidate.inboundTimeoutMs === "number" &&
      Number.isFinite(candidate.inboundTimeoutMs) &&
      candidate.inboundTimeoutMs > 0
        ? Math.trunc(candidate.inboundTimeoutMs)
        : 15_000;

    if (!id) {
      throw new Error("tenant.id is required");
    }
    if (!apiKey) {
      throw new Error(`tenant.apiKey is required for tenant ${id}`);
    }
    if (seenIds.has(id)) {
      throw new Error(`duplicate tenant.id: ${id}`);
    }
    const keyHash = hashApiKey(apiKey);
    if (seenHashes.has(keyHash)) {
      throw new Error(`duplicate tenant.apiKey detected for tenant ${id}`);
    }

    seenIds.add(id);
    seenHashes.add(keyHash);
    seeds.push({ id, name, apiKey, inboundUrl, inboundTimeoutMs });
  }

  return seeds;
}

function resolvePairingCodeSeeds(): PairingCodeSeed[] {
  const raw = process.env.MUX_PAIRING_CODES_JSON?.trim();
  if (!raw) {
    return [];
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("MUX_PAIRING_CODES_JSON must be a JSON array");
  }

  const now = Date.now();
  const seeds: PairingCodeSeed[] = [];
  const seenCodes = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== "object") {
      throw new Error("each pairing code entry must be an object");
    }
    const candidate = item as Record<string, unknown>;
    const code = typeof candidate.code === "string" ? candidate.code.trim() : "";
    const channel = typeof candidate.channel === "string" ? candidate.channel.trim() : "";
    const routeKey = typeof candidate.routeKey === "string" ? candidate.routeKey.trim() : "";
    const scope = typeof candidate.scope === "string" ? candidate.scope.trim() : "";
    const expiresAtMs =
      typeof candidate.expiresAtMs === "number" &&
      Number.isFinite(candidate.expiresAtMs) &&
      candidate.expiresAtMs > 0
        ? Math.trunc(candidate.expiresAtMs)
        : now + 24 * 60 * 60 * 1000;

    if (!code) {
      throw new Error("pairing code entry requires code");
    }
    if (!channel) {
      throw new Error(`pairing code ${code} requires channel`);
    }
    if (!routeKey) {
      throw new Error(`pairing code ${code} requires routeKey`);
    }
    if (!scope) {
      throw new Error(`pairing code ${code} requires scope`);
    }
    if (seenCodes.has(code)) {
      throw new Error(`duplicate pairing code seed: ${code}`);
    }

    seenCodes.add(code);
    seeds.push({ code, channel, routeKey, scope, expiresAtMs });
  }

  return seeds;
}

function seedTenants(database: DatabaseSync, tenants: TenantSeed[]) {
  const now = Date.now();
  const upsert = database.prepare(`
    INSERT INTO tenants (
      id,
      name,
      api_key_hash,
      status,
      inbound_url,
      inbound_token,
      inbound_timeout_ms,
      created_at_ms,
      updated_at_ms
    )
    VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      api_key_hash = excluded.api_key_hash,
      status = 'active',
      inbound_url = COALESCE(tenants.inbound_url, excluded.inbound_url),
      inbound_token = COALESCE(tenants.inbound_token, excluded.inbound_token),
      inbound_timeout_ms = COALESCE(tenants.inbound_timeout_ms, excluded.inbound_timeout_ms),
      updated_at_ms = excluded.updated_at_ms
  `);
  for (const tenant of tenants) {
    upsert.run(
      tenant.id,
      tenant.name,
      hashApiKey(tenant.apiKey),
      tenant.inboundUrl ?? null,
      tenant.apiKey,
      tenant.inboundTimeoutMs,
      now,
      now,
    );
  }
}

function seedPairingCodes(database: DatabaseSync, codes: PairingCodeSeed[]) {
  if (codes.length === 0) {
    return;
  }
  const insert = database.prepare(`
    INSERT INTO pairing_codes (
      code,
      channel,
      route_key,
      scope,
      expires_at_ms,
      claimed_by_tenant_id,
      claimed_at_ms
    )
    VALUES (?, ?, ?, ?, ?, NULL, NULL)
    ON CONFLICT(code) DO NOTHING
  `);
  for (const code of codes) {
    insert.run(code.code, code.channel, code.routeKey, code.scope, code.expiresAtMs);
  }
}

/** Serialize an unknown error to a readable string (handles plain objects that stringify to [object Object]). */
function errorString(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
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

const ALLOWED_TELEGRAM_METHODS = new Set([
  // Sending
  "sendMessage",
  "sendPhoto",
  "sendDocument",
  "sendAnimation",
  "sendVideo",
  "sendVideoNote",
  "sendVoice",
  "sendAudio",
  "sendSticker",
  "sendPoll",
  "sendChatAction",
  // Editing / deleting
  "editMessageText",
  "deleteMessage",
  // Reactions
  "setMessageReaction",
  // Callbacks
  "answerCallbackQuery",
  // Bot menu
  "setMyCommands",
  "deleteMyCommands",
  // Forum topics
  "createForumTopic",
]);

const TELEGRAM_PARSE_ERR_RE = /can't parse entities|parse entities|find end of the entity/i;

function readTelegramResultDescription(result: Record<string, unknown>): string {
  const description = result.description;
  return typeof description === "string" ? description : "";
}

function isTelegramMessageNotModified(method: string, result: Record<string, unknown>): boolean {
  return (
    method === "editMessageText" &&
    /message is not modified/i.test(readTelegramResultDescription(result))
  );
}

function shouldRetryTelegramWithoutHtmlParseMode(params: {
  method: string;
  body: Record<string, unknown>;
  result: Record<string, unknown>;
}): boolean {
  if (params.method !== "sendMessage" && params.method !== "editMessageText") {
    return false;
  }
  const parseMode = readNonEmptyString(params.body.parse_mode);
  if (!parseMode || parseMode.toLowerCase() !== "html") {
    return false;
  }
  return TELEGRAM_PARSE_ERR_RE.test(readTelegramResultDescription(params.result));
}

function shouldRetryTelegramWithoutThread(params: {
  body: Record<string, unknown>;
  result: Record<string, unknown>;
}): boolean {
  return (
    readPositiveInt(params.body.message_thread_id) !== undefined &&
    /message thread not found/i.test(readTelegramResultDescription(params.result))
  );
}

async function withTelegramThreadFallback(params: {
  body: Record<string, unknown>;
  attempt: (
    effectiveBody: Record<string, unknown>,
  ) => Promise<{ response: Response; result: Record<string, unknown> }>;
}): Promise<{
  response: Response;
  result: Record<string, unknown>;
}> {
  let finalBody: Record<string, unknown> = { ...params.body };
  let attempt = await params.attempt(finalBody);
  if (
    (!attempt.response.ok || attempt.result.ok !== true) &&
    shouldRetryTelegramWithoutThread({
      body: finalBody,
      result: attempt.result,
    })
  ) {
    finalBody = { ...finalBody };
    delete finalBody.message_thread_id;
    attempt = await params.attempt(finalBody);
  }
  return attempt;
}

async function sendTelegram(method: string, body: Record<string, unknown>) {
  const token = requireTelegramBotToken();
  const url = `${telegramApiBaseUrl}/bot${token}/${method}`;

  // When __fileBase64 is present, the openclaw side is sending a local file
  // that needs to be uploaded via multipart form data.
  const fileBase64 = typeof body.__fileBase64 === "string" ? body.__fileBase64 : undefined;
  const fileField = typeof body.__fileField === "string" ? body.__fileField : undefined;
  const fileName = typeof body.__fileName === "string" ? body.__fileName : "file";

  if (fileBase64 && fileField) {
    const cleanBody = { ...body };
    delete cleanBody.__fileBase64;
    delete cleanBody.__fileField;
    delete cleanBody.__fileName;

    const formData = new FormData();
    const fileBuffer = Buffer.from(fileBase64, "base64");
    formData.append(fileField, new Blob([fileBuffer]), fileName);

    for (const [key, value] of Object.entries(cleanBody)) {
      if (value == null) {
        continue;
      }
      formData.append(
        key,
        typeof value === "object"
          ? JSON.stringify(value)
          : String(value as string | number | boolean),
      );
    }

    const response = await fetch(url, { method: "POST", body: formData });
    const result = (await response.json()) as Record<string, unknown>;
    return { response, result };
  }

  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as Record<string, unknown>;
  return { response, result };
}

async function sendTelegramWithFallbacks(params: {
  method: string;
  body: Record<string, unknown>;
}): Promise<{
  response: Response;
  result: Record<string, unknown>;
}> {
  return await withTelegramThreadFallback({
    body: params.body,
    attempt: async (effectiveBody) => {
      let finalBody: Record<string, unknown> = { ...effectiveBody };
      let { response, result } = await sendTelegram(params.method, finalBody);
      if (
        (!response.ok || result.ok !== true) &&
        shouldRetryTelegramWithoutHtmlParseMode({
          method: params.method,
          body: finalBody,
          result,
        })
      ) {
        finalBody = { ...finalBody };
        delete finalBody.parse_mode;
        ({ response, result } = await sendTelegram(params.method, finalBody));
      }
      return { response, result };
    },
  });
}

function parseDiscordJsonBody(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) {
    return {};
  }
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { raw: trimmed };
  }
}

async function discordRequest(params: {
  method: "GET" | "POST";
  path: string;
  body?: Record<string, unknown>;
}): Promise<{ response: Response; result: Record<string, unknown> }> {
  const token = requireDiscordBotToken();
  const response = await fetch(`${discordApiBaseUrl}${params.path}`, {
    method: params.method,
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    ...(params.body ? { body: JSON.stringify(params.body) } : {}),
  });
  const result = parseDiscordJsonBody(await response.text());
  return { response, result };
}

function parseDiscordGatewayPayload(raw: WebSocket.RawData): Record<string, unknown> | null {
  let text: string | null = null;
  if (typeof raw === "string") {
    text = raw;
  } else if (Buffer.isBuffer(raw)) {
    text = raw.toString("utf8");
  } else if (Array.isArray(raw)) {
    text = Buffer.concat(raw).toString("utf8");
  } else if (raw instanceof ArrayBuffer) {
    text = Buffer.from(raw).toString("utf8");
  }
  if (!text) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return asRecord(parsed);
  } catch {
    return null;
  }
}

async function fetchDiscordGatewayUrl(): Promise<string> {
  const { response, result } = await discordRequest({
    method: "GET",
    path: "/gateway/bot",
  });
  if (!response.ok) {
    throw new Error(`discord gateway discovery failed (${response.status})`);
  }
  const rawUrl = readNonEmptyString(result.url) ?? "wss://gateway.discord.gg";
  const base = rawUrl.replace(/\/+$/, "");
  const separator = base.includes("?") ? "&" : "?";
  return `${base}${separator}v=10&encoding=json`;
}

async function resolveDiscordDmChannelId(userId: string): Promise<string> {
  const { response, result } = await discordRequest({
    method: "POST",
    path: "/users/@me/channels",
    body: { recipient_id: userId },
  });
  if (!response.ok) {
    throw new Error(`discord create dm failed (${response.status})`);
  }
  const channelId = readUnsignedNumericString(result.id);
  if (!channelId) {
    throw new Error("discord create dm returned invalid channel id");
  }
  return channelId;
}

async function resolveDiscordDmChannelIdCached(userId: string): Promise<string> {
  const now = Date.now();
  const cached = discordDmChannelCache.get(userId);
  if (cached && cached.expiresAtMs > now) {
    return cached.channelId;
  }
  const channelId = await resolveDiscordDmChannelId(userId);
  discordDmChannelCache.set(userId, {
    channelId,
    expiresAtMs: now + discordDmChannelCacheTtlMs,
  });
  return channelId;
}

async function resolveDiscordChannelInfo(channelId: string): Promise<{
  guildId: string | null;
  parentId: string | null;
  channelType: number | null;
}> {
  const now = Date.now();
  const cached = discordChannelInfoCache.get(channelId);
  if (cached && cached.expiresAtMs > now) {
    return {
      guildId: cached.guildId,
      parentId: cached.parentId,
      channelType: cached.channelType,
    };
  }
  const { response, result } = await discordRequest({
    method: "GET",
    path: `/channels/${channelId}`,
  });
  if (!response.ok) {
    throw new Error(`discord channel lookup failed (${response.status})`);
  }
  const guildId = readUnsignedNumericString(result.guild_id) ?? null;
  const parentId = readUnsignedNumericString(result.parent_id) ?? null;
  const channelType =
    typeof result.type === "number" && Number.isFinite(result.type)
      ? Math.trunc(result.type)
      : null;
  discordChannelInfoCache.set(channelId, {
    guildId,
    parentId,
    channelType,
    expiresAtMs: now + discordChannelGuildCacheTtlMs,
  });
  return { guildId, parentId, channelType };
}

async function resolveDiscordChannelGuildId(channelId: string): Promise<string | null> {
  const info = await resolveDiscordChannelInfo(channelId);
  return info.guildId;
}

async function resolveDiscordIncomingRouteFromMessage(params: {
  message: Record<string, unknown>;
  fromId: string;
  fallbackRoute?: DiscordBoundRoute;
  fallbackChannelId?: string;
}): Promise<{ route: DiscordBoundRoute; channelId: string } | null> {
  const channelId =
    readUnsignedNumericString(params.message.channel_id) ??
    readUnsignedNumericString(params.fallbackChannelId);
  if (!channelId) {
    return null;
  }
  const guildId = readUnsignedNumericString(params.message.guild_id);
  if (!guildId) {
    return {
      route: { kind: "dm", userId: params.fromId },
      channelId,
    };
  }

  if (
    params.fallbackRoute?.kind === "guild" &&
    params.fallbackRoute.threadId &&
    params.fallbackRoute.threadId === channelId
  ) {
    return {
      route: params.fallbackRoute,
      channelId,
    };
  }

  const rawThread = asRecord(params.message.thread);
  const threadIdFromPayload = readUnsignedNumericString(rawThread?.id);
  const threadParentIdFromPayload = readUnsignedNumericString(rawThread?.parent_id);
  if (threadIdFromPayload && threadIdFromPayload === channelId) {
    return {
      route: {
        kind: "guild",
        guildId,
        ...(threadParentIdFromPayload ? { channelId: threadParentIdFromPayload } : {}),
        threadId: threadIdFromPayload,
      },
      channelId,
    };
  }

  const channelInfo = await resolveDiscordChannelInfo(channelId);
  if (channelInfo.parentId) {
    return {
      route: {
        kind: "guild",
        guildId,
        channelId: channelInfo.parentId,
        threadId: channelId,
      },
      channelId,
    };
  }

  return {
    route: {
      kind: "guild",
      guildId,
      channelId,
    },
    channelId,
  };
}

function listDiscordRouteLookupKeys(route: DiscordBoundRoute): string[] {
  const keys: string[] = [];
  if (route.kind === "dm") {
    keys.push(buildDiscordDmRouteKey(route.userId));
    return keys;
  }
  if (route.threadId) {
    keys.push(
      buildDiscordGuildRouteKey({
        guildId: route.guildId,
        ...(route.channelId ? { channelId: route.channelId } : {}),
        threadId: route.threadId,
      }),
    );
    keys.push(
      buildDiscordGuildRouteKey({
        guildId: route.guildId,
        threadId: route.threadId,
      }),
    );
  }
  if (route.channelId) {
    keys.push(
      buildDiscordGuildRouteKey({
        guildId: route.guildId,
        channelId: route.channelId,
      }),
    );
  }
  keys.push(buildDiscordGuildRouteKey({ guildId: route.guildId }));
  return [...new Set(keys)];
}

function resolveDiscordBindingForIncoming(
  route: DiscordBoundRoute,
): { tenantId: string; bindingId: string; status: "active" | "pending"; routeKey: string } | null {
  const routeKeys = listDiscordRouteLookupKeys(route);
  for (const routeKey of routeKeys) {
    const row = resolveLiveBindingByRouteKey("discord", routeKey);
    if (!row) {
      continue;
    }
    return {
      tenantId: row.tenant_id,
      bindingId: row.binding_id,
      status: row.status === "pending" ? "pending" : "active",
      routeKey,
    };
  }
  return null;
}

async function sendDiscordTyping(params: {
  channelId: string;
}): Promise<{ response: Response; result: Record<string, unknown> }> {
  return await discordRequest({
    method: "POST",
    path: `/channels/${params.channelId}/typing`,
  });
}

function parseSnowflake(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    try {
      return BigInt(Math.trunc(value));
    } catch {
      return null;
    }
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  try {
    return BigInt(trimmed);
  } catch {
    return null;
  }
}

function sortDiscordMessagesAsc(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  return messages.toSorted((a, b) => {
    const aId = parseSnowflake(a.id);
    const bId = parseSnowflake(b.id);
    if (aId === null && bId === null) {
      return 0;
    }
    if (aId === null) {
      return -1;
    }
    if (bId === null) {
      return 1;
    }
    if (aId < bId) {
      return -1;
    }
    if (aId > bId) {
      return 1;
    }
    return 0;
  });
}

function listDiscordAttachmentCandidates(
  attachments: unknown,
): Array<{ id?: string; fileName?: string; mimeType?: string; url?: string; size?: number }> {
  if (!Array.isArray(attachments)) {
    return [];
  }
  return attachments
    .map((item) => {
      const entry = item as Record<string, unknown>;
      return {
        id: readUnsignedNumericString(entry.id),
        fileName: readNonEmptyString(entry.filename) ?? undefined,
        mimeType: readNonEmptyString(entry.content_type)?.toLowerCase() ?? undefined,
        url: readNonEmptyString(entry.url) ?? undefined,
        size: readPositiveInt(entry.size),
      };
    })
    .filter((entry) => Boolean(entry.url));
}

async function extractDiscordInboundMedia(params: {
  message: Record<string, unknown>;
  messageId: string;
}): Promise<{ attachments: DiscordInboundAttachment[]; media: DiscordInboundMediaSummary[] }> {
  const summaries: DiscordInboundMediaSummary[] = [];
  const attachments: DiscordInboundAttachment[] = [];
  for (const item of listDiscordAttachmentCandidates(params.message.attachments)) {
    summaries.push({
      id: item.id,
      fileName: item.fileName,
      mimeType: item.mimeType,
      size: item.size,
      url: item.url,
    });
    if (!item.url) {
      continue;
    }
    const resolvedMime =
      item.mimeType ||
      inferMimeTypeFromPath(item.fileName ?? item.url) ||
      "application/octet-stream";
    attachments.push({
      type: resolvedMime.split("/")[0] || "file",
      mimeType: resolvedMime,
      fileName: item.fileName || item.id || `discord-${params.messageId}`,
      url: item.url,
    });
  }
  return { attachments, media: summaries };
}

function isTelegramCommandText(input: string | null): boolean {
  const normalized = normalizeControlText(input);
  if (!normalized) {
    return false;
  }
  return /^\/[A-Za-z0-9_]+/.test(normalized);
}

function hasTelegramMessageContent(message: TelegramIncomingMessage): boolean {
  if (normalizeControlText(message.text ?? message.caption ?? null)) {
    return true;
  }
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    return true;
  }
  return Boolean(
    message.document ||
    message.video ||
    message.animation ||
    message.voice ||
    message.audio ||
    message.video_note,
  );
}

function isDiscordCommandText(input: string): boolean {
  const normalized = normalizeControlText(input);
  if (!normalized) {
    return false;
  }
  return /^\/[A-Za-z0-9_]+/.test(normalized);
}

function hasDiscordMessageContent(message: Record<string, unknown>): boolean {
  const text = typeof message.content === "string" ? message.content : null;
  if (normalizeControlText(text)) {
    return true;
  }
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  if (attachments.some((attachment) => Boolean(attachment && typeof attachment === "object"))) {
    return true;
  }
  const snapshots = Array.isArray(message.message_snapshots) ? message.message_snapshots : [];
  return snapshots.length > 0;
}

function isWhatsAppCommandText(input: string): boolean {
  const normalized = normalizeControlText(input);
  if (!normalized) {
    return false;
  }
  return /^[/!][A-Za-z0-9_]+/.test(normalized);
}

function hasWhatsAppMessageContent(message: WebInboundMessage): boolean {
  if (normalizeControlText(message.body)) {
    return true;
  }
  return Boolean(
    readNonEmptyString(message.mediaPath) ||
    readNonEmptyString(message.mediaType) ||
    readNonEmptyString(message.mediaUrl),
  );
}

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".7z": "application/x-7z-compressed",
  ".rar": "application/vnd.rar",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/opus",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".m4a": "audio/mp4",
  ".weba": "audio/webm",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".mov": "video/quicktime",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".xml": "application/xml",
  ".html": "text/html",
  ".htm": "text/html",
  ".md": "text/markdown",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
};

function inferMimeTypeFromPath(filePath: string | undefined): string | undefined {
  if (!filePath) {
    return undefined;
  }
  const ext = path.extname(filePath).toLowerCase();
  return ext ? MIME_BY_EXT[ext] : undefined;
}

function pickBestTelegramPhotoSize(
  sizes: TelegramPhotoSize[] | undefined,
): TelegramPhotoSize | null {
  if (!Array.isArray(sizes) || sizes.length === 0) {
    return null;
  }
  const candidates = sizes.filter((entry) => readNonEmptyString(entry.file_id));
  if (candidates.length === 0) {
    return null;
  }
  candidates.sort((a, b) => {
    const aSize = readPositiveInt(a.file_size) ?? 0;
    const bSize = readPositiveInt(b.file_size) ?? 0;
    if (aSize !== bSize) {
      return bSize - aSize;
    }
    const aArea = (readPositiveInt(a.width) ?? 0) * (readPositiveInt(a.height) ?? 0);
    const bArea = (readPositiveInt(b.width) ?? 0) * (readPositiveInt(b.height) ?? 0);
    return bArea - aArea;
  });
  return candidates[0] ?? null;
}

async function resolveTelegramFilePath(fileId: string): Promise<string | null> {
  const token = requireTelegramBotToken();
  const response = await fetch(`${telegramApiBaseUrl}/bot${token}/getFile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  if (!response.ok) {
    return null;
  }
  const result = (await response.json()) as {
    ok?: boolean;
    result?: { file_path?: unknown } | null;
  };
  if (result.ok !== true) {
    return null;
  }
  return readNonEmptyString(result.result?.file_path);
}

async function resolveTelegramAttachment(params: {
  updateId: number;
  kind: string;
  fileId: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  width?: number;
  height?: number;
  durationSec?: number;
}): Promise<{ attachment?: TelegramInboundAttachment; summary: TelegramInboundMediaSummary }> {
  const summary: TelegramInboundMediaSummary = {
    kind: params.kind,
    fileId: params.fileId,
    fileName: params.fileName,
    mimeType: params.mimeType,
    fileSize: params.fileSize,
    width: params.width,
    height: params.height,
    durationSec: params.durationSec,
  };
  const inferredMime =
    inferMimeTypeFromPath(params.fileName) ?? inferMimeTypeFromPath(params.fileName);
  const resolvedMime = params.mimeType || inferredMime;
  summary.mimeType = resolvedMime || summary.mimeType;
  summary.fileName =
    summary.fileName || (params.fileId ? `${params.kind}-${params.fileId}` : undefined);
  const proxyUrl = `${muxPublicUrl}/v1/mux/files/telegram?fileId=${encodeURIComponent(params.fileId)}`;
  const attachment: TelegramInboundAttachment = {
    type: resolvedMime?.split("/")[0] || "file",
    mimeType: resolvedMime || "application/octet-stream",
    fileName: summary.fileName,
    url: proxyUrl,
  };
  return { attachment, summary };
}

async function extractTelegramInboundMedia(params: {
  message: TelegramIncomingMessage;
  updateId: number;
}): Promise<{ attachments: TelegramInboundAttachment[]; media: TelegramInboundMediaSummary[] }> {
  const attachments: TelegramInboundAttachment[] = [];
  const media: TelegramInboundMediaSummary[] = [];

  const bestPhoto = pickBestTelegramPhotoSize(params.message.photo);
  const photoFileId = readNonEmptyString(bestPhoto?.file_id);
  if (photoFileId) {
    const result = await resolveTelegramAttachment({
      updateId: params.updateId,
      kind: "photo",
      fileId: photoFileId,
      mimeType: "image/jpeg",
      fileSize: readPositiveInt(bestPhoto?.file_size),
      width: readPositiveInt(bestPhoto?.width),
      height: readPositiveInt(bestPhoto?.height),
    });
    media.push(result.summary);
    if (result.attachment) {
      attachments.push(result.attachment);
    }
  }

  const document = params.message.document;
  const docFileId = readNonEmptyString(document?.file_id);
  const docMimeType = readNonEmptyString(document?.mime_type)?.toLowerCase();
  const docFileName = readNonEmptyString(document?.file_name);
  if (docFileId) {
    const result = await resolveTelegramAttachment({
      updateId: params.updateId,
      kind: "document",
      fileId: docFileId,
      fileName: docFileName ?? undefined,
      mimeType: docMimeType ?? inferMimeTypeFromPath(docFileName ?? undefined),
      fileSize: readPositiveInt(document?.file_size),
    });
    media.push(result.summary);
    if (result.attachment) {
      attachments.push(result.attachment);
    }
  }

  const video = params.message.video;
  const videoFileId = readNonEmptyString(video?.file_id);
  if (videoFileId) {
    const result = await resolveTelegramAttachment({
      updateId: params.updateId,
      kind: "video",
      fileId: videoFileId,
      fileName: readNonEmptyString(video?.file_name) ?? undefined,
      mimeType: readNonEmptyString(video?.mime_type)?.toLowerCase() ?? undefined,
      fileSize: readPositiveInt(video?.file_size),
      width: readPositiveInt(video?.width),
      height: readPositiveInt(video?.height),
      durationSec: readPositiveInt(video?.duration),
    });
    media.push(result.summary);
    if (result.attachment) {
      attachments.push(result.attachment);
    }
  }

  const animation = params.message.animation;
  const animationFileId = readNonEmptyString(animation?.file_id);
  if (animationFileId) {
    const result = await resolveTelegramAttachment({
      updateId: params.updateId,
      kind: "animation",
      fileId: animationFileId,
      fileName: readNonEmptyString(animation?.file_name) ?? undefined,
      mimeType: readNonEmptyString(animation?.mime_type)?.toLowerCase() ?? undefined,
      fileSize: readPositiveInt(animation?.file_size),
      width: readPositiveInt(animation?.width),
      height: readPositiveInt(animation?.height),
      durationSec: readPositiveInt(animation?.duration),
    });
    media.push(result.summary);
    if (result.attachment) {
      attachments.push(result.attachment);
    }
  }

  const voice = params.message.voice;
  const voiceFileId = readNonEmptyString(voice?.file_id);
  if (voiceFileId) {
    const result = await resolveTelegramAttachment({
      updateId: params.updateId,
      kind: "voice",
      fileId: voiceFileId,
      mimeType: readNonEmptyString(voice?.mime_type)?.toLowerCase() ?? "audio/ogg",
      fileSize: readPositiveInt(voice?.file_size),
      durationSec: readPositiveInt(voice?.duration),
    });
    media.push(result.summary);
    if (result.attachment) {
      attachments.push(result.attachment);
    }
  }

  const audio = params.message.audio;
  const audioFileId = readNonEmptyString(audio?.file_id);
  if (audioFileId) {
    const audioFileName = readNonEmptyString(audio?.file_name);
    const result = await resolveTelegramAttachment({
      updateId: params.updateId,
      kind: "audio",
      fileId: audioFileId,
      fileName: audioFileName ?? undefined,
      mimeType:
        readNonEmptyString(audio?.mime_type)?.toLowerCase() ??
        inferMimeTypeFromPath(audioFileName ?? undefined) ??
        "audio/mpeg",
      fileSize: readPositiveInt(audio?.file_size),
      durationSec: readPositiveInt(audio?.duration),
    });
    media.push(result.summary);
    if (result.attachment) {
      attachments.push(result.attachment);
    }
  }

  const videoNote = params.message.video_note;
  const videoNoteFileId = readNonEmptyString(videoNote?.file_id);
  if (videoNoteFileId) {
    const side = readPositiveInt(videoNote?.length);
    const result = await resolveTelegramAttachment({
      updateId: params.updateId,
      kind: "video_note",
      fileId: videoNoteFileId,
      mimeType: "video/mp4",
      fileSize: readPositiveInt(videoNote?.file_size),
      width: side,
      height: side,
      durationSec: readPositiveInt(videoNote?.duration),
    });
    media.push(result.summary);
    if (result.attachment) {
      attachments.push(result.attachment);
    }
  }

  return { attachments, media };
}

async function sendTelegramPairingNotice(params: {
  chatId: string;
  topicId?: number;
  text: string;
  parseMode?: TelegramParseMode;
}) {
  const isGeneralForumTopic =
    params.topicId === TELEGRAM_GENERAL_TOPIC_ID && params.chatId.startsWith("-");
  const canUseThreadId = Boolean(params.topicId) && !isGeneralForumTopic;
  const body: Record<string, unknown> = {
    chat_id: params.chatId,
    text: params.text,
  };
  if (params.parseMode) {
    body.parse_mode = params.parseMode;
  }
  if (canUseThreadId && params.topicId) {
    body.message_thread_id = params.topicId;
  }
  const attempt = await withTelegramThreadFallback({
    body,
    attempt: async (effectiveBody) => await sendTelegram("sendMessage", effectiveBody),
  });
  if (attempt.response.ok && attempt.result.ok === true) {
    return;
  }
  throw new Error(`telegram pairing notice failed (${attempt.response.status})`);
}

async function answerTelegramCallbackQuery(params: {
  callbackQueryId: string;
  text?: string;
}): Promise<void> {
  const body: Record<string, unknown> = {
    callback_query_id: params.callbackQueryId,
  };
  const text = readNonEmptyString(params.text);
  if (text) {
    body.text = text;
  }
  const { response, result } = await sendTelegram("answerCallbackQuery", body);
  if (!response.ok || result.ok !== true) {
    throw new Error(`telegram answerCallbackQuery failed (${response.status})`);
  }
}

async function sendWhatsAppPairingNotice(params: {
  chatJid: string;
  accountId: string;
  text: string;
}) {
  const { sendMessageWhatsApp } = await loadWebRuntimeModules();
  await sendMessageWhatsApp(params.chatJid, params.text, {
    verbose: false,
    accountId: params.accountId,
  });
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

async function resolveDiscordExplicitThreadParentId(
  threadId: string | undefined,
): Promise<string | undefined> {
  const normalizedThreadId = readUnsignedNumericString(threadId);
  if (!normalizedThreadId) {
    return undefined;
  }
  try {
    const info = await resolveDiscordChannelInfo(normalizedThreadId);
    return info.parentId ?? undefined;
  } catch {
    return undefined;
  }
}

function resolveTelegramBoundRoute(params: {
  tenantId: string;
  channel: "telegram";
  sessionKey: string;
  routeKeys?: string[];
  mode?: OutboundResolutionMode;
}): ResolvedBoundRoute<TelegramBoundRoute> | null {
  const resolved = resolveSessionRouteBinding(params);
  if (!resolved) {
    return null;
  }
  const route = parseTelegramRouteKey(resolved.routeKey);
  return route ? { route, routeKey: resolved.routeKey, via: resolved.via } : null;
}

async function resolveDiscordBoundRoute(params: {
  tenantId: string;
  channel: "discord";
  sessionKey: string;
  routeKeys?: string[];
  mode?: OutboundResolutionMode;
}): Promise<ResolvedBoundRoute<DiscordBoundRoute> | null> {
  const resolved = resolveSessionRouteBinding(params);
  if (!resolved) {
    return null;
  }
  const route = parseDiscordRouteKey(resolved.routeKey);
  return route ? { route, routeKey: resolved.routeKey, via: resolved.via } : null;
}

function resolveWhatsAppBoundRoute(params: {
  tenantId: string;
  channel: "whatsapp";
  sessionKey: string;
  routeKeys?: string[];
  mode?: OutboundResolutionMode;
}): ResolvedBoundRoute<WhatsAppBoundRoute> | null {
  const resolved = resolveSessionRouteBinding(params);
  if (!resolved) {
    return null;
  }
  const route = parseWhatsAppRouteKey(resolved.routeKey);
  return route ? { route, routeKey: resolved.routeKey, via: resolved.via } : null;
}

async function resolveDiscordOutboundChannelId(params: {
  boundRoute: DiscordBoundRoute;
  requestedTo: unknown;
  requestedThreadId?: string;
}): Promise<{ ok: true; channelId: string } | { ok: false; statusCode: number; error: string }> {
  if (params.boundRoute.kind === "dm") {
    const channelId = await resolveDiscordDmChannelId(params.boundRoute.userId);
    return { ok: true, channelId };
  }

  let channelId =
    params.boundRoute.threadId ?? params.requestedThreadId ?? params.boundRoute.channelId;
  const explicitThreadParentId = await resolveDiscordExplicitThreadParentId(
    params.requestedThreadId,
  );
  if (
    params.boundRoute.channelId &&
    explicitThreadParentId &&
    explicitThreadParentId !== params.boundRoute.channelId
  ) {
    return {
      ok: false,
      statusCode: 403,
      error: "discord channel not allowed for this bound guild",
    };
  }
  if (!channelId) {
    const target = parseDiscordOutboundTarget(params.requestedTo);
    if (target?.kind === "user") {
      return {
        ok: false,
        statusCode: 403,
        error: "discord route is guild-bound and cannot target DMs",
      };
    }
    channelId = target?.id;
  }
  if (!channelId) {
    return {
      ok: false,
      statusCode: 400,
      error: "discord guild-bound route requires channel target (to or routeKey channel)",
    };
  }

  const guildId = await resolveDiscordChannelGuildId(channelId);
  if (!guildId) {
    return {
      ok: false,
      statusCode: 403,
      error: "discord channel is not in a guild for guild-bound route",
    };
  }
  if (guildId !== params.boundRoute.guildId) {
    return {
      ok: false,
      statusCode: 403,
      error: "discord channel not allowed for this bound guild",
    };
  }
  return { ok: true, channelId };
}

function resolveTelegramIncomingTopicId(params: {
  isForum: boolean;
  messageThreadId: unknown;
}): number | undefined {
  const explicitTopicId = readPositiveInt(params.messageThreadId);
  if (explicitTopicId) {
    return explicitTopicId;
  }
  return params.isForum ? TELEGRAM_GENERAL_TOPIC_ID : undefined;
}

function resolveTelegramBindingForIncoming(
  chatId: string,
  topicId?: number,
): { tenantId: string; bindingId: string; routeKey: string } | null {
  const topicRouteKey = topicId ? buildTelegramRouteKey(chatId, topicId) : null;
  if (topicRouteKey) {
    const topicRow = stmtSelectActiveBindingByRouteKey.get("telegram", topicRouteKey) as
      | ActiveBindingLookupRow
      | undefined;
    if (topicRow?.tenant_id && topicRow?.binding_id) {
      return {
        tenantId: String(topicRow.tenant_id),
        bindingId: String(topicRow.binding_id),
        routeKey: topicRouteKey,
      };
    }
  }

  const chatRouteKey = buildTelegramRouteKey(chatId);
  const chatRow = stmtSelectActiveBindingByRouteKey.get("telegram", chatRouteKey) as
    | ActiveBindingLookupRow
    | undefined;
  if (!chatRow?.tenant_id || !chatRow?.binding_id) {
    return null;
  }
  return {
    tenantId: String(chatRow.tenant_id),
    bindingId: String(chatRow.binding_id),
    routeKey: chatRouteKey,
  };
}

function resolveWhatsAppBindingForIncoming(params: {
  chatJid: string;
  accountId: string;
}): { tenantId: string; bindingId: string; routeKey: string } | null {
  const routeKey = buildWhatsAppRouteKey(params.chatJid, params.accountId);
  const row = stmtSelectActiveBindingByRouteKey.get("whatsapp", routeKey) as
    | ActiveBindingLookupRow
    | undefined;
  if (!row?.tenant_id || !row?.binding_id) {
    return null;
  }
  return {
    tenantId: String(row.tenant_id),
    bindingId: String(row.binding_id),
    routeKey,
  };
}

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
  pairingTokenTtlSec,
  pairingTokenMaxTtlSec,
  discordPendingGcEnabled,
  telegramBotUsername,
  buildTelegramRouteKey,
  buildDiscordRouteKey,
  buildDiscordThreadScopedSessionKey,
  buildThreadScopedSessionKey,
  buildWhatsAppRouteKey,
  deriveTelegramSessionKey,
  deriveDiscordSessionKey,
  deriveWhatsAppSessionKey,
  parseDiscordRouteKey,
  resolveDiscordBindingRouteKeyForClaim,
  resolveDiscordBindingScope,
  resolveLiveBindingByRouteKey,
  stmtDeleteExpiredPairingTokens,
  stmtDeactivateStaleDiscordPendingBindings,
  stmtInsertPairingToken,
  stmtSelectActivePairingTokenByHash,
  stmtSelectPairingCodeByCode,
  stmtClaimPairingCode,
  stmtRevertPairingCodeClaim,
  stmtInsertBinding,
  stmtInsertPendingBinding,
  stmtActivatePendingBinding,
  stmtDeactivateLiveBinding,
  stmtUpsertSessionRoute,
  stmtConsumePairingToken,
  stmtAttachPairingTokenBinding,
  stmtListActiveBindingsByTenant,
  stmtSelectActiveBindingByTenantAndRoute,
  stmtUnbindActiveBinding,
  stmtDeleteSessionRoutesByBinding,
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
  claimPairingForTenant,
  listPairingsForTenant,
  unbindPairingForTenant,
} = pairingService;

function deactivateLiveBinding(params: {
  tenantId: string;
  bindingId: string;
  auditEventType: string;
}): boolean {
  const now = Date.now();
  const update = stmtDeactivateLiveBinding.run(now, params.bindingId, params.tenantId);
  if (update.changes === 0) {
    return false;
  }
  stmtDeleteSessionRoutesByBinding.run(params.bindingId, params.tenantId);
  writeAuditLog(params.tenantId, params.auditEventType, { bindingId: params.bindingId }, now);
  return true;
}

function setBindingPending(params: {
  tenantId: string;
  bindingId: string;
  auditEventType: string;
}): boolean {
  const now = Date.now();
  const update = stmtSetBindingPending.run(now, params.bindingId, params.tenantId);
  if (update.changes === 0) {
    return false;
  }
  stmtDeleteSessionRoutesByBinding.run(params.bindingId, params.tenantId);
  writeAuditLog(params.tenantId, params.auditEventType, { bindingId: params.bindingId }, now);
  return true;
}

function resolveBindingSessionKey(params: {
  tenantId: string;
  channel: "telegram" | "discord" | "whatsapp";
  bindingId: string;
}): string | null {
  const row = stmtSelectSessionKeyByBinding.get(
    params.tenantId,
    params.channel,
    params.bindingId,
  ) as { session_key?: unknown } | undefined;
  return readNonEmptyString(row?.session_key);
}

async function sendPostPairingSyntheticInbound(params: {
  channel: NoticeChannel;
  tenantId: string;
  sessionKey: string;
  routeKey: string;
  fromId: string;
  chatId: string;
  chatType: "direct" | "group";
}): Promise<void> {
  const target = resolveTenantInboundTarget(params.tenantId);
  if (!target) {
    log({
      type: "post_pairing_synthetic_skip_no_target",
      tenantId: params.tenantId,
      channel: params.channel,
    });
    return;
  }
  const prompt = resolvePostPairingPrompt(params.channel);
  const now = Date.now();
  const syntheticId = `synth:pair:${randomUUID()}`;
  const discordRoute = params.channel === "discord" ? parseDiscordRouteKey(params.routeKey) : null;

  let payload: Record<string, unknown>;
  if (params.channel === "telegram") {
    payload = buildTelegramInboundEnvelope({
      updateId: 0,
      sessionKey: params.sessionKey,
      accountId: openclawMuxAccountId,
      rawBody: prompt,
      fromId: params.fromId,
      chatId: params.chatId,
      topicId: undefined,
      chatType: params.chatType,
      messageId: syntheticId,
      timestampMs: now,
      routeKey: params.routeKey,
      rawMessage: {},
      rawUpdate: {},
      media: null,
      attachments: [],
    });
  } else if (params.channel === "discord") {
    payload = buildDiscordInboundEnvelope({
      messageId: syntheticId,
      sessionKey: params.sessionKey,
      accountId: openclawMuxAccountId,
      rawBody: prompt,
      fromId: params.fromId,
      channelId: params.chatId,
      guildId: discordRoute?.kind === "guild" ? discordRoute.guildId : null,
      routeKey: params.routeKey,
      chatType: params.chatType,
      timestampMs: now,
      threadId: discordRoute?.kind === "guild" ? discordRoute.threadId : undefined,
      rawMessage: {},
      media: null,
      attachments: [],
    });
  } else {
    payload = buildWhatsAppInboundEnvelope({
      messageId: syntheticId,
      sessionKey: params.sessionKey,
      openclawAccountId: openclawMuxAccountId,
      rawBody: prompt,
      fromId: params.fromId,
      chatJid: params.chatId,
      routeKey: params.routeKey,
      accountId: params.chatId,
      chatType: params.chatType,
      timestampMs: now,
      rawMessage: {},
      media: null,
      attachments: [],
    });
  }

  const payloadWithIdentity = {
    ...payload,
    openclawId: params.tenantId,
  };

  try {
    const response = await fetch(target.url, {
      method: "POST",
      headers: {
        ...(await buildInboundAuthHeaders(target)),
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payloadWithIdentity),
      signal: AbortSignal.timeout(target.timeoutMs),
    });
    if (!response.ok) {
      const bodyText = await response.text();
      log({
        type: "post_pairing_synthetic_error",
        tenantId: params.tenantId,
        channel: params.channel,
        status: response.status,
        body: bodyText.slice(0, 200),
      });
    } else {
      log({
        type: "post_pairing_synthetic_sent",
        tenantId: params.tenantId,
        channel: params.channel,
        sessionKey: params.sessionKey,
      });
    }
  } catch (error) {
    log({
      type: "post_pairing_synthetic_error",
      tenantId: params.tenantId,
      channel: params.channel,
      error: String(error),
    });
  }
}

function renderNoticeForClaimType(channel: NoticeChannel, claimType: ClaimType): StyledNotice {
  if (claimType === "repaired") {
    return renderPairingRepairedNotice(channel);
  }
  if (claimType === "takeover") {
    return renderPairingTakeoverNotice(channel);
  }
  return renderPairingSuccessNotice(channel);
}

async function sendPostClaimNotices(params: {
  channel: NoticeChannel;
  claimed: ClaimResult;
  send: (notice: StyledNotice) => Promise<void>;
  fromId: string;
  chatId: string;
  chatType: "direct" | "group";
}): Promise<void> {
  const notice = renderNoticeForClaimType(params.channel, params.claimed.claimType);
  await params.send(notice);

  if (params.claimed.claimType === "repaired") {
    return;
  }

  if (params.channel === "whatsapp") {
    try {
      const tip = renderWhatsAppContactTip(params.channel);
      await params.send(tip);
    } catch (error) {
      log({
        type: "whatsapp_contact_tip_error",
        tenantId: params.claimed.tenantId,
        error: String(error),
      });
    }
  }

  try {
    await sendPostPairingSyntheticInbound({
      channel: params.channel,
      tenantId: params.claimed.tenantId,
      sessionKey: params.claimed.sessionKey,
      routeKey: params.claimed.routeKey,
      fromId: params.fromId,
      chatId: params.chatId,
      chatType: params.chatType,
    });
  } catch (error) {
    log({
      type: "post_pairing_synthetic_error",
      tenantId: params.claimed.tenantId,
      channel: params.channel,
      error: String(error),
    });
  }
}

async function sendDiscordPairingNotice(params: { channelId: string; text: string }) {
  const { response } = await discordRequest({
    method: "POST",
    path: `/channels/${params.channelId}/messages`,
    body: {
      content: params.text,
    },
  });
  if (!response.ok) {
    throw new Error(`discord pairing notice failed (${response.status})`);
  }
}

const botControlService = createBotControlService({
  extractTokenFromStartCommand,
  normalizeControlText,
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
  parseDiscordRouteKey,
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

async function forwardDiscordMessageToTenant(params: {
  tenantId: string;
  bindingId: string;
  routeKey: string;
  route: DiscordBoundRoute;
  channelId: string;
  message: Record<string, unknown>;
  messageId: string;
  fromId: string;
  body: string;
}): Promise<"forwarded" | "ignored" | "deferred"> {
  metrics.recordActiveUser("discord", params.fromId);
  discordRuntimeHealth.lastInboundSeenAtMs = Date.now();
  const traceId = createInboundTraceId({
    channel: "discord",
    tenantId: params.tenantId,
    routeKey: params.routeKey,
    messageId: params.messageId,
  });
  const target = resolveTenantInboundTarget(params.tenantId);
  if (!target) {
    metrics.recordInboundEvent("discord", "dropped");
    log({
      type: "discord_inbound_drop_no_target",
      tenantId: params.tenantId,
      bindingId: params.bindingId,
      routeKey: params.routeKey,
      traceId,
    });
    return "deferred";
  }

  const inboundMedia = await extractDiscordInboundMedia({
    message: params.message,
    messageId: params.messageId,
  });

  const sessionKey = resolveDiscordInboundSessionKey({
    tenantId: params.tenantId,
    bindingId: params.bindingId,
    route: params.route,
    channelId: params.channelId,
  });

  stmtUpsertSessionRoute.run(
    params.tenantId,
    "discord",
    sessionKey,
    params.bindingId,
    JSON.stringify({ routeKey: params.routeKey, channelId: params.channelId }),
    Date.now(),
  );

  const timestampMs = (() => {
    const timestampRaw =
      typeof params.message.timestamp === "string" ? Date.parse(params.message.timestamp) : NaN;
    return Number.isFinite(timestampRaw) ? Math.trunc(timestampRaw) : Date.now();
  })();

  // Best-effort wasMentioned for backward compat with old gateways that
  // don't yet compute mentions from raw data.  New gateways ignore this
  // when channelData.discord.botUserId is present.
  let legacyWasMentioned = false;
  if (discordBotSelfId) {
    const mentions = Array.isArray(params.message.mentions) ? params.message.mentions : [];
    legacyWasMentioned = mentions.some(
      (m: unknown) =>
        asRecord(m) != null && readNonEmptyString(asRecord(m)?.id) === discordBotSelfId,
    );
    if (!legacyWasMentioned && params.body) {
      legacyWasMentioned =
        params.body.includes(`<@${discordBotSelfId}>`) ||
        params.body.includes(`<@!${discordBotSelfId}>`);
    }
  }

  const payload = buildDiscordInboundEnvelope({
    messageId: params.messageId,
    sessionKey,
    accountId: openclawMuxAccountId,
    rawBody: params.body,
    fromId: params.fromId,
    channelId: params.channelId,
    guildId: params.route.kind === "guild" ? params.route.guildId : null,
    routeKey: params.routeKey,
    chatType: params.route.kind === "dm" ? "direct" : "group",
    timestampMs,
    threadId: params.route.kind === "guild" ? params.route.threadId : undefined,
    rawMessage: params.message,
    media: inboundMedia.media,
    attachments: inboundMedia.attachments,
    botUserId: discordBotSelfId,
    wasMentioned: legacyWasMentioned,
  });
  const payloadWithIdentity = {
    ...payload,
    openclawId: params.tenantId,
  };

  const forwardStartedAtMs = Date.now();
  let response: Response;
  try {
    response = await fetch(target.url, {
      method: "POST",
      headers: {
        ...(await buildInboundAuthHeaders(target, traceId)),
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(payloadWithIdentity),
      signal: AbortSignal.timeout(target.timeoutMs),
    });
  } catch (error) {
    metrics.observeInboundForwardDuration("discord", Date.now() - forwardStartedAtMs);
    metrics.recordInboundEvent("discord", "deferred");
    log({
      type: "discord_inbound_retry_deferred",
      tenantId: params.tenantId,
      bindingId: params.bindingId,
      messageId: params.messageId,
      error: String(error),
      traceId,
    });
    return "deferred";
  }
  if (!response.ok) {
    metrics.observeInboundForwardDuration("discord", Date.now() - forwardStartedAtMs);
    metrics.recordInboundEvent("discord", "deferred");
    const bodyText = await response.text();
    log({
      type: "discord_inbound_retry_deferred",
      tenantId: params.tenantId,
      bindingId: params.bindingId,
      messageId: params.messageId,
      error: `openclaw inbound failed (${response.status}): ${bodyText || "no body"}`,
      traceId,
    });
    return "deferred";
  }

  metrics.observeInboundForwardDuration("discord", Date.now() - forwardStartedAtMs);
  metrics.recordInboundEvent("discord", "forwarded");
  log({
    type: "discord_inbound_forwarded",
    tenantId: params.tenantId,
    bindingId: params.bindingId,
    channelId: params.channelId,
    sessionKey,
    messageId: params.messageId,
    traceId,
  });
  return "forwarded";
}

async function registerOpenClawInstance(input: {
  openclawId?: unknown;
  inboundUrl?: unknown;
  inboundTimeoutMs?: unknown;
}): Promise<{
  statusCode: number;
  payload: Record<string, unknown>;
}> {
  const openclawId = readNonEmptyString(input.openclawId);
  const inboundUrl = readNonEmptyString(input.inboundUrl);
  if (!openclawId || !inboundUrl) {
    return {
      statusCode: 400,
      payload: { ok: false, error: "openclawId and inboundUrl are required" },
    };
  }
  const inboundTimeoutMs = readPositiveInt(input.inboundTimeoutMs) ?? 15_000;
  const now = Date.now();
  const syntheticApiKey = `instance:${openclawId}`;
  try {
    stmtUpsertTenantByRegister.run(
      openclawId,
      openclawId,
      hashApiKey(syntheticApiKey),
      inboundUrl,
      inboundTimeoutMs,
      now,
      now,
    );
  } catch (error) {
    if (String(error).includes("UNIQUE constraint failed: tenants.api_key_hash")) {
      return {
        statusCode: 409,
        payload: { ok: false, error: "instance id conflict" },
      };
    }
    throw error;
  }
  writeAuditLog(openclawId, "instance_registered", { inboundUrl, inboundTimeoutMs }, now);
  const runtimeToken = await mintRuntimeJwt({
    openclawId,
    scope: "mux:runtime mux:outbound mux:pairings mux:control",
    audiences: [runtimeJwtAudienceMux],
  });
  return {
    statusCode: 200,
    payload: {
      ok: true,
      openclawId,
      runtimeToken,
      tokenType: "Bearer",
      expiresAtMs: now + runtimeTokenTtlSec * 1_000,
    },
  };
}

function upsertTenantInboundTargetByAdmin(params: {
  openclawId: string;
  inboundUrl: string;
  inboundTimeoutMs?: number;
}): { ok: true } | { ok: false; statusCode: number; error: string } {
  const now = Date.now();
  const syntheticApiKey = `instance:${params.openclawId}`;
  try {
    stmtUpsertTenantInboundTargetByAdmin.run(
      params.openclawId,
      params.openclawId,
      hashApiKey(syntheticApiKey),
      params.inboundUrl,
      params.inboundTimeoutMs ?? 15_000,
      now,
      now,
    );
  } catch (error) {
    if (String(error).includes("UNIQUE constraint failed: tenants.api_key_hash")) {
      return {
        ok: false,
        statusCode: 409,
        error: "instance id conflict",
      };
    }
    throw error;
  }
  return { ok: true };
}

function resolveStoredTelegramOffset(): number {
  const row = stmtSelectTelegramOffset.get() as { last_update_id?: unknown } | undefined;
  if (!row || typeof row.last_update_id !== "number" || !Number.isFinite(row.last_update_id)) {
    return 0;
  }
  return Math.trunc(row.last_update_id);
}

function storeTelegramOffset(lastUpdateId: number) {
  stmtUpsertTelegramOffset.run(lastUpdateId, Date.now());
}

function resolveStoredDiscordOffset(bindingId: string): string | null {
  const row = stmtSelectDiscordOffsetByBinding.get(bindingId) as
    | { last_message_id?: unknown }
    | undefined;
  const offset = readUnsignedNumericString(row?.last_message_id);
  return offset ?? null;
}

function storeDiscordOffset(bindingId: string, lastMessageId: string) {
  stmtUpsertDiscordOffsetByBinding.run(bindingId, lastMessageId, Date.now());
}

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

async function resolveDiscordInboundChannelId(route: DiscordBoundRoute): Promise<string | null> {
  if (route.kind === "dm") {
    return await resolveDiscordDmChannelIdCached(route.userId);
  }
  if (route.threadId) {
    return route.threadId;
  }
  if (route.channelId) {
    return route.channelId;
  }
  return null;
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
  telegramInboundEnabled,
  getTelegramPollConflictHealth: () => telegramPollConflictHealth,
  telegramRuntimeHealth,
  discordInboundEnabled,
  discordRuntimeHealth,
  whatsappInboundEnabled,
  whatsappRuntimeHealth,
  whatsappAuthDir,
  whatsappAccountId,
  openclawMuxAccountId,
});

const { runTelegramInboundLoop } = createTelegramInboundRuntime({
  telegramApiBaseUrl,
  telegramInboundEnabled,
  telegramPollTimeoutSec,
  telegramPollRetryMs,
  telegramBootstrapLatest,
  telegramBotUsername,
  openclawMuxAccountId,
  metrics,
  telegramRuntimeHealth,
  getTelegramPollConflictHealth: () => telegramPollConflictHealth,
  setTelegramPollConflictHealth: (health) => {
    telegramPollConflictHealth = health;
  },
  telegramBgRetryCount,
  telegramBgRetryQueuedAtMs,
  requireTelegramBotToken,
  errorString,
  log,
  readNonEmptyString,
  resolveStoredTelegramOffset,
  storeTelegramOffset,
  answerTelegramCallbackQuery,
  resolveTelegramIncomingTopicId: (params) =>
    resolveTelegramIncomingTopicId({
      isForum: params.isForum,
      messageThreadId: params.messageThreadId,
    }),
  createInboundTraceId,
  resolveTelegramBindingForIncoming,
  resolveTenantInboundTarget,
  buildTelegramRouteKey,
  resolveTelegramInboundSessionKey,
  stmtUpsertSessionRoute,
  buildTelegramCallbackInboundEnvelope,
  buildTelegramInboundEnvelope,
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
  discordApiBaseUrl,
  discordInboundEnabled,
  discordPollIntervalMs,
  discordBootstrapLatest,
  discordGatewayDmEnabled,
  discordGatewayGuildEnabled,
  discordGatewayDefaultIntents,
  discordGatewayIntents,
  discordGatewayReconnectInitialMs,
  discordGatewayReconnectMaxMs,
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
  errorString,
  log,
  parseDiscordRouteKey,
  readUnsignedNumericString,
  readPositiveInt,
  readNonEmptyString,
  asRecord,
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
  stmtListActiveDiscordBindings,
  resolveDiscordIncomingRouteFromMessage,
  buildDiscordRouteKey,
  resolveDiscordBindingForIncoming,
  forwardDiscordMessageToTenant,
  parseDiscordGatewayPayload,
  fetchDiscordGatewayUrl,
});

const { runWhatsAppInboundLoop } = createWhatsAppInboundRuntime({
  whatsappInboundEnabled,
  whatsappInboundRetryMs,
  whatsappQueuePollMs,
  whatsappQueueRetryInitialMs,
  whatsappQueueRetryMaxMs,
  whatsappQueueBatchSize,
  whatsappQueueMaxAgeMs,
  whatsappAccountId,
  whatsappAuthDir,
  muxPublicUrl,
  openclawMuxAccountId,
  whatsappRuntimeHealth,
  getActiveWhatsAppListener: () => activeWhatsAppListener,
  setActiveWhatsAppListener: (listener) => {
    activeWhatsAppListener = listener;
  },
  loadWebRuntimeModules,
  errorString,
  log,
  readNonEmptyString,
  inferMimeTypeFromPath: (filePath) => inferMimeTypeFromPath(filePath) ?? null,
  stmtInsertWhatsAppInboundQueue,
  stmtSelectDueWhatsAppInboundQueue,
  stmtDeleteWhatsAppInboundQueueById,
  stmtDeferWhatsAppInboundQueueById,
  stmtSelectSessionKeyByBinding,
  stmtUpsertSessionRoute,
  metrics,
  classifyWhatsAppInboundDeliveryError,
  resolveWhatsAppInboundQueueRetryState,
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
  createInboundTraceId,
  resolveTenantInboundTarget,
  isRetryableWhatsAppInboundStatus,
  deriveWhatsAppSessionKey,
  buildWhatsAppInboundEnvelope,
  buildInboundAuthHeaders,
});

const { runOutboundAction, runOutboundSend } = createOutboundService({
  outboundResolutionMode,
  whatsappAccountId,
  openclawMuxAccountId,
  telegramGeneralTopicId: TELEGRAM_GENERAL_TOPIC_ID,
  allowedTelegramMethods: ALLOWED_TELEGRAM_METHODS,
  discordApiBaseUrl,
  metrics,
  log,
  asRecord,
  readNonEmptyString,
  readPositiveInt,
  readUnsignedNumericString,
  normalizeChannel,
  listTelegramOutboundRouteKeys,
  listDiscordOutboundRouteKeys,
  listWhatsAppOutboundRouteKeys,
  resolveTelegramBoundRoute,
  resolveDiscordBoundRoute,
  resolveWhatsAppBoundRoute,
  resolveDiscordOutboundChannelId,
  sendTelegram,
  sendTelegramWithFallbacks,
  isTelegramMessageNotModified,
  sendDiscordTyping,
  discordRequest,
  requireDiscordBotToken,
  loadDiscordRuntimeModules,
  loadWebRuntimeModules,
});

const { handleRequest } = createHttpRouteHandler({
  muxRegisterKey,
  muxAdminToken,
  telegramApiBaseUrl,
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
  readNonEmptyString,
  readPositiveInt,
  upsertTenantInboundTargetByAdmin,
  issuePairingTokenForTenant,
  listPairingsForTenant,
  claimPairingForTenant,
  unbindPairingForTenant,
  normalizeChannel,
  runOutboundAction,
  resolveTelegramFilePath,
  requireTelegramBotToken,
  whatsappAllowedFileDirs,
  inferMimeTypeFromPath,
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
  server,
  host,
  port,
  dbPath,
  openclawMuxAccountId,
  tenantSeedCount: tenantSeeds.length,
  pairingCodeSeedCount: pairingCodeSeeds.length,
  countActiveTenantInboundTargets,
  log,
  whatsappInboundEnabled,
  whatsappAccountId,
  whatsappAuthDir,
  whatsappInboundRetryMs,
  runWhatsAppInboundLoop,
  telegramInboundEnabled,
  telegramBotToken,
  getTelegramBotUsername: () => telegramBotUsername,
  setTelegramBotUsername: (username) => {
    telegramBotUsername = username;
  },
  telegramPollTimeoutSec,
  telegramPollRetryMs,
  telegramBootstrapLatest,
  runTelegramInboundLoop,
  discordInboundEnabled,
  getDiscordBotSelfId: () => discordBotSelfId,
  setDiscordBotSelfId: (botSelfId) => {
    discordBotSelfId = botSelfId;
  },
  discordPollIntervalMs,
  discordBootstrapLatest,
  discordGatewayDmEnabled,
  discordGatewayGuildEnabled,
  discordGatewayIntents,
  discordGatewayDefaultIntents,
  discordRequest,
  readNonEmptyString,
  runDiscordInboundLoop,
  runDiscordGatewayDmLoop,
});

await startMuxServerRuntime();
