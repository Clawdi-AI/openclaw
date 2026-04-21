import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { MuxConfig } from "../../config/env.js";
import type { PreparedStatements } from "../../db/statements.js";
import type { ClaimResult, StyledNotice, TenantInboundTarget } from "../../domain/types.js";
import { errorString, readNonEmptyString } from "../../domain/values.js";
import { buildWhatsAppInboundEnvelope } from "../../mux-envelope.js";
import { createInboundTraceId } from "../../observability/tracing.js";
import { buildWhatsAppRouteKey, deriveWhatsAppSessionKey } from "../../routing/keys.js";
import {
  classifyWhatsAppInboundDeliveryError,
  resolveWhatsAppInboundQueueRetryState,
  WhatsAppInboundDeliveryError,
} from "../../whatsapp-inbound-queue.js";
import { inferMimeTypeFromPath } from "../telegram/media.js";

type WhatsAppInboundQueueRow = {
  id: number;
  dedupe_key: string;
  payload_json: string;
  attempt_count: number;
  created_at_ms: number;
  delivery_window_started_at_ms: number;
  last_target_update_at_ms: number;
};

type WebInboundMessage = {
  id?: string;
  from: string;
  to: string;
  accountId: string;
  body: string;
  timestamp?: number;
  chatType: "direct" | "group";
  // The canonical chatId emitted by the bridge -- `<digits>@s.whatsapp.net`
  // for DMs (resolved via lidMapping when the WhatsApp side used a LID),
  // `<jid>@g.us` for groups.
  chatId: string;
  // The raw `remoteJid` from Baileys before LID resolution. Equals `chatId`
  // for non-LID peers; for LID peers this is the `<lid>@lid` form. Used
  // for the one-time binding heal that rewrites legacy LID-keyed bindings
  // to their canonical form while keeping the LID as an alias so frozen
  // `delivery.to` targets on existing crons still resolve.
  remoteJidRaw?: string;
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
  isLoggedOut?: boolean;
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

type WhatsAppInboundAttachment = {
  type: string;
  mimeType: string;
  fileName?: string;
  url: string;
};

type WhatsAppInboundMediaSummary = {
  mediaPath: string;
  mediaType?: string;
  sizeBytes?: number;
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
  setActiveWebListener: (accountId: string | null | undefined, listener: unknown) => void;
};

type Metrics = {
  recordInboundEvent: (channel: "whatsapp", outcome: "forwarded" | "dropped" | "error") => void;
  observeInboundForwardDuration: (channel: "whatsapp", durationMs: number) => void;
  recordActiveUser: (channel: "whatsapp", userId: string) => void;
};

type BotControlCommand =
  | { kind: "help" }
  | { kind: "status" }
  | { kind: "unpair" }
  | { kind: "switch"; token?: string };

export function createWhatsAppInboundRuntime(deps: {
  config: Pick<
    MuxConfig,
    | "whatsappInboundEnabled"
    | "whatsappInboundRetryMs"
    | "whatsappQueuePollMs"
    | "whatsappQueueRetryInitialMs"
    | "whatsappQueueRetryMaxMs"
    | "whatsappQueueBatchSize"
    | "whatsappQueueMaxAgeMs"
    | "whatsappAccountId"
    | "whatsappAuthDir"
    | "muxPublicUrl"
    | "openclawMuxAccountId"
  >;
  whatsappRuntimeHealth: WhatsAppRuntimeHealth;
  getActiveWhatsAppListener: () => ActiveWebListener | null;
  setActiveWhatsAppListener: (listener: ActiveWebListener | null) => void;
  loadWebRuntimeModules: () => Promise<WebRuntimeModules>;
  log: (entry: Record<string, unknown>) => void;
  db: Pick<
    PreparedStatements,
    | "stmtInsertWhatsAppInboundQueue"
    | "stmtSelectDueWhatsAppInboundQueue"
    | "stmtDeleteWhatsAppInboundQueueById"
    | "stmtDeferWhatsAppInboundQueueById"
    | "stmtSelectSessionKeyByBinding"
    | "stmtUpsertSessionRoute"
    | "stmtMigrateBindingRouteKeyWithAlias"
  >;
  writeAuditLog: (
    tenantId: string,
    eventType: string,
    payload: Record<string, unknown>,
    createdAtMs: number,
  ) => void;
  metrics: Metrics;
  parseBotControlCommand: (input: string) => BotControlCommand | null;
  handleWhatsAppBotControlCommand: (params: {
    command: BotControlCommand;
    chatJid: string;
    accountId: string;
    chatType: "direct" | "group";
    fromId: string;
    directPeerId?: string;
    binding: { tenantId: string; bindingId: string; routeKey: string } | null;
  }) => Promise<void>;
  extractPairingTokenFromWhatsAppMessage: (message: WebInboundMessage) => string | null;
  isWhatsAppCommandText: (input: string) => boolean;
  hasWhatsAppMessageContent: (message: WebInboundMessage) => boolean;
  renderUnpairedHintNotice: (channel: "whatsapp") => StyledNotice;
  sendWhatsAppPairingNotice: (params: {
    chatJid: string;
    accountId: string;
    text: string;
  }) => Promise<void>;
  claimWhatsAppPairingToken: (params: {
    token: string;
    chatJid: string;
    accountId: string;
    chatType: "direct" | "group";
    directPeerId?: string;
  }) => ClaimResult | null;
  renderPairingInvalidNotice: (channel: "whatsapp") => StyledNotice;
  sendPostClaimNotices: (params: {
    channel: "whatsapp";
    claimed: ClaimResult;
    send: (notice: StyledNotice) => Promise<void>;
    fromId: string;
    chatId: string;
    chatType: "direct" | "group";
  }) => Promise<void>;
  resolveWhatsAppBindingForIncoming: (params: {
    chatJid: string;
    accountId: string;
  }) => { tenantId: string; bindingId: string; routeKey: string } | null;
  resolveTenantInboundTarget: (tenantId: string) => TenantInboundTarget | null;
  isRetryableWhatsAppInboundStatus: (statusCode: number) => boolean;
  buildInboundAuthHeaders: (
    target: TenantInboundTarget,
    traceId?: string,
  ) => Promise<Record<string, string>>;
}) {
  function computeWhatsAppQueueRetryDelayMs(attemptCount: number): number {
    const base = Math.max(100, Math.trunc(deps.config.whatsappQueueRetryInitialMs));
    const maxDelay = Math.max(base, Math.trunc(deps.config.whatsappQueueRetryMaxMs));
    const exp = Math.max(0, Math.min(10, Math.trunc(attemptCount)));
    const delay = base * 2 ** exp;
    return Math.min(maxDelay, delay);
  }

  function snapshotWhatsAppInboundMessage(message: WebInboundMessage): WebInboundMessage {
    return {
      id: readNonEmptyString(message.id) ?? undefined,
      from: typeof message.from === "string" ? message.from : "",
      to: typeof message.to === "string" ? message.to : "",
      accountId: readNonEmptyString(message.accountId) ?? deps.config.whatsappAccountId,
      body: typeof message.body === "string" ? message.body : "",
      timestamp:
        typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
          ? Math.trunc(message.timestamp)
          : undefined,
      chatType: message.chatType === "group" ? "group" : "direct",
      chatId: readNonEmptyString(message.chatId) ?? readNonEmptyString(message.from) ?? "",
      remoteJidRaw: readNonEmptyString(message.remoteJidRaw) ?? undefined,
      senderJid: readNonEmptyString(message.senderJid) ?? undefined,
      senderE164: readNonEmptyString(message.senderE164) ?? undefined,
      senderName: readNonEmptyString(message.senderName) ?? undefined,
      replyToId: readNonEmptyString(message.replyToId) ?? undefined,
      replyToBody: readNonEmptyString(message.replyToBody) ?? undefined,
      replyToSender: readNonEmptyString(message.replyToSender) ?? undefined,
      replyToSenderJid: readNonEmptyString(message.replyToSenderJid) ?? undefined,
      replyToSenderE164: readNonEmptyString(message.replyToSenderE164) ?? undefined,
      groupSubject: readNonEmptyString(message.groupSubject) ?? undefined,
      groupParticipants: Array.isArray(message.groupParticipants)
        ? message.groupParticipants.filter((entry): entry is string => typeof entry === "string")
        : undefined,
      mentionedJids: Array.isArray(message.mentionedJids)
        ? message.mentionedJids.filter((entry): entry is string => typeof entry === "string")
        : undefined,
      mediaPath: readNonEmptyString(message.mediaPath) ?? undefined,
      mediaType: readNonEmptyString(message.mediaType) ?? undefined,
      mediaUrl: readNonEmptyString(message.mediaUrl) ?? undefined,
    };
  }

  function enqueueWhatsAppInboundMessage(message: WebInboundMessage): void {
    const snapshot = snapshotWhatsAppInboundMessage(message);
    if (!snapshot.chatId) {
      return;
    }
    const now = Date.now();
    const messageId = readNonEmptyString(snapshot.id);
    const dedupeKey = messageId
      ? `${snapshot.accountId}:${snapshot.chatId}:${messageId}`
      : `${snapshot.accountId}:${snapshot.chatId}:noid:${now}:${randomUUID()}`;
    const insertResult = deps.db.stmtInsertWhatsAppInboundQueue.run(
      dedupeKey,
      JSON.stringify(snapshot),
      now,
      now,
      now,
      now,
    );
    if (insertResult.changes > 0) {
      deps.log({
        type: "whatsapp_inbound_queue_enqueued",
        dedupeKey,
        messageId: snapshot.id ?? null,
        chatJid: snapshot.chatId,
        accountId: snapshot.accountId,
      });
    }
  }

  function parseQueuedWhatsAppInboundMessage(
    row: WhatsAppInboundQueueRow,
  ): WebInboundMessage | null {
    try {
      const parsed = JSON.parse(row.payload_json) as unknown;
      if (!parsed || typeof parsed !== "object") {
        return null;
      }
      return snapshotWhatsAppInboundMessage(parsed as WebInboundMessage);
    } catch {
      return null;
    }
  }

  async function extractWhatsAppInboundMedia(params: { message: WebInboundMessage }): Promise<{
    attachments: WhatsAppInboundAttachment[];
    media: WhatsAppInboundMediaSummary[];
  }> {
    const attachments: WhatsAppInboundAttachment[] = [];
    const media: WhatsAppInboundMediaSummary[] = [];
    const mediaPath = readNonEmptyString(params.message.mediaPath) ?? undefined;
    const mediaType = readNonEmptyString(params.message.mediaType)?.toLowerCase() ?? undefined;
    if (!mediaPath) {
      return { attachments, media };
    }

    const summary: WhatsAppInboundMediaSummary = {
      mediaPath,
      mediaType,
    };
    let sizeBytes: number | undefined;
    try {
      const stat = fs.statSync(mediaPath);
      if (stat.isFile() && Number.isFinite(stat.size) && stat.size > 0) {
        sizeBytes = Math.trunc(stat.size);
        summary.sizeBytes = sizeBytes;
      }
    } catch (error) {
      deps.log({
        type: "whatsapp_media_stat_error",
        mediaPath,
        error: String(error),
      });
    }
    media.push(summary);

    const resolvedMime =
      mediaType || inferMimeTypeFromPath(mediaPath) || "application/octet-stream";
    const proxyUrl = `${deps.config.muxPublicUrl}/v1/mux/files/whatsapp?path=${encodeURIComponent(mediaPath)}`;
    attachments.push({
      type: resolvedMime.split("/")[0] || "file",
      mimeType: resolvedMime,
      fileName: path.basename(mediaPath),
      url: proxyUrl,
    });
    return { attachments, media };
  }

  async function forwardWhatsAppInboundMessage(message: WebInboundMessage) {
    const chatJid = readNonEmptyString(message.chatId) ?? readNonEmptyString(message.from);
    if (!chatJid) {
      return;
    }
    const remoteJidRaw = readNonEmptyString(message.remoteJidRaw);
    const accountId = readNonEmptyString(message.accountId) ?? deps.config.whatsappAccountId;
    const chatType = message.chatType === "group" ? "group" : "direct";
    const directPeerId =
      chatType === "direct"
        ? (readNonEmptyString(message.senderE164) ?? readNonEmptyString(message.from) ?? undefined)
        : undefined;
    const body = typeof message.body === "string" ? message.body : "";
    // Canonical lookup first. Covers new users and previously-healed
    // LID bindings (where the LID now lives in `previous_route_keys`).
    let binding = deps.resolveWhatsAppBindingForIncoming({
      chatJid,
      accountId,
    });
    // Legacy LID fallback: if the canonical chatJid missed AND the bridge
    // gave us a raw LID that differs from the canonical form, try looking
    // the binding up under its original LID routeKey. On a hit, heal the
    // binding -- rewrite `route_key` to the canonical form and push the
    // LID into `previous_route_keys` so it keeps resolving for anyone
    // still holding the LID (e.g. cron `delivery.to`).
    if (
      !binding &&
      remoteJidRaw &&
      remoteJidRaw !== chatJid &&
      /@(?:lid|hosted\.lid)$/i.test(remoteJidRaw)
    ) {
      const legacyBinding = deps.resolveWhatsAppBindingForIncoming({
        chatJid: remoteJidRaw,
        accountId,
      });
      if (legacyBinding) {
        const canonicalRouteKey = buildWhatsAppRouteKey(chatJid, accountId);
        const legacyRouteKey = buildWhatsAppRouteKey(remoteJidRaw, accountId);
        try {
          deps.db.stmtMigrateBindingRouteKeyWithAlias.run(
            canonicalRouteKey,
            legacyRouteKey,
            Date.now(),
            legacyBinding.bindingId,
            legacyBinding.tenantId,
          );
          deps.writeAuditLog(
            legacyBinding.tenantId,
            "whatsapp_binding_healed_from_lid",
            {
              bindingId: legacyBinding.bindingId,
              legacyRouteKey,
              canonicalRouteKey,
            },
            Date.now(),
          );
        } catch (error) {
          deps.log({
            type: "whatsapp_binding_heal_error",
            bindingId: legacyBinding.bindingId,
            error: String(error),
          });
        }
        binding = {
          tenantId: legacyBinding.tenantId,
          bindingId: legacyBinding.bindingId,
          routeKey: canonicalRouteKey,
        };
      }
    }
    const botControlCommand = deps.parseBotControlCommand(body);
    if (botControlCommand) {
      try {
        const fromId =
          readNonEmptyString(message.senderE164) ?? readNonEmptyString(message.from) ?? chatJid;
        await deps.handleWhatsAppBotControlCommand({
          command: botControlCommand,
          chatJid,
          accountId,
          chatType,
          fromId,
          directPeerId,
          binding,
        });
      } catch (error) {
        deps.log({
          type: "whatsapp_bot_control_error",
          chatJid,
          accountId,
          error: String(error),
        });
      }
      return;
    }

    const pairingToken = deps.extractPairingTokenFromWhatsAppMessage(message);
    if (!binding) {
      if (!pairingToken) {
        const shouldSendUnpairedNotice =
          deps.isWhatsAppCommandText(body) ||
          (chatType === "direct" && deps.hasWhatsAppMessageContent(message));
        if (shouldSendUnpairedNotice) {
          try {
            const notice = deps.renderUnpairedHintNotice("whatsapp");
            await deps.sendWhatsAppPairingNotice({
              chatJid,
              accountId,
              text: notice.text,
            });
          } catch (error) {
            deps.log({
              type: "whatsapp_unpaired_command_notice_error",
              chatJid,
              error: String(error),
            });
          }
        }
        return;
      }

      const claimed = deps.claimWhatsAppPairingToken({
        token: pairingToken,
        chatJid,
        accountId,
        chatType,
        directPeerId,
      });
      if (!claimed) {
        try {
          const notice = deps.renderPairingInvalidNotice("whatsapp");
          await deps.sendWhatsAppPairingNotice({
            chatJid,
            accountId,
            text: notice.text,
          });
        } catch (error) {
          deps.log({
            type: "whatsapp_pairing_invalid_notice_error",
            chatJid,
            error: String(error),
          });
        }
        deps.log({
          type: "whatsapp_pairing_token_invalid",
          chatJid,
          accountId,
        });
        return;
      }

      try {
        await deps.sendPostClaimNotices({
          channel: "whatsapp",
          claimed,
          send: async (notice) => {
            await deps.sendWhatsAppPairingNotice({
              chatJid,
              accountId,
              text: notice.text,
            });
          },
          fromId: message.from || chatJid,
          chatId: chatJid,
          chatType,
        });
      } catch (error) {
        deps.log({
          type: "whatsapp_pairing_notice_error",
          tenantId: claimed.tenantId,
          chatJid,
          error: String(error),
        });
      }
      deps.log({
        type: "whatsapp_pairing_token_claimed",
        tenantId: claimed.tenantId,
        routeKey: claimed.routeKey,
        sessionKey: claimed.sessionKey,
        claimType: claimed.claimType,
        ...(claimed.previousTenantId ? { previousTenantId: claimed.previousTenantId } : {}),
        accountId,
        chatJid,
      });
      return;
    }

    if (pairingToken) {
      const reClaimed = deps.claimWhatsAppPairingToken({
        token: pairingToken,
        chatJid,
        accountId,
        chatType,
        directPeerId,
      });
      if (reClaimed) {
        try {
          await deps.sendPostClaimNotices({
            channel: "whatsapp",
            claimed: reClaimed,
            send: async (notice) => {
              await deps.sendWhatsAppPairingNotice({
                chatJid,
                accountId,
                text: notice.text,
              });
            },
            fromId: message.from || chatJid,
            chatId: chatJid,
            chatType,
          });
        } catch (error) {
          deps.log({
            type: "whatsapp_pairing_notice_error",
            tenantId: reClaimed.tenantId,
            chatJid,
            error: String(error),
          });
        }
        deps.log({
          type: "whatsapp_pairing_token_claimed",
          tenantId: reClaimed.tenantId,
          routeKey: reClaimed.routeKey,
          sessionKey: reClaimed.sessionKey,
          claimType: reClaimed.claimType,
          ...(reClaimed.previousTenantId ? { previousTenantId: reClaimed.previousTenantId } : {}),
          accountId,
          chatJid,
        });
      } else {
        deps.log({
          type: "whatsapp_pairing_token_ignored_bound_route",
          tenantId: binding.tenantId,
          routeKey: binding.routeKey,
          accountId,
          chatJid,
        });
      }
      return;
    }

    const messageId = readNonEmptyString(message.id) ?? `wa:${Date.now()}:${randomUUID()}`;
    const traceId = createInboundTraceId({
      channel: "whatsapp",
      tenantId: binding.tenantId,
      routeKey: binding.routeKey,
      messageId,
    });
    const target = deps.resolveTenantInboundTarget(binding.tenantId);
    if (!target) {
      deps.metrics.recordInboundEvent("whatsapp", "error");
      deps.log({
        type: "whatsapp_inbound_deferred_no_target",
        tenantId: binding.tenantId,
        routeKey: binding.routeKey,
        accountId,
        chatJid,
        traceId,
      });
      throw new WhatsAppInboundDeliveryError(
        `whatsapp inbound target missing for tenant ${binding.tenantId}`,
        {
          retryable: true,
          targetUpdatedAtMs: null,
        },
      );
    }

    const inboundMedia = await extractWhatsAppInboundMedia({ message });
    if (!body && inboundMedia.attachments.length === 0) {
      return;
    }

    const fromId =
      readNonEmptyString(message.senderE164) ??
      readNonEmptyString(message.senderJid) ??
      readNonEmptyString(message.from) ??
      "unknown";
    deps.metrics.recordActiveUser("whatsapp", fromId);
    const timestampMs =
      typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
        ? Math.trunc(message.timestamp)
        : Date.now();
    const existingRoute = deps.db.stmtSelectSessionKeyByBinding.get(
      binding.tenantId,
      "whatsapp",
      binding.bindingId,
    ) as { session_key?: unknown } | undefined;
    const sessionKey =
      (typeof existingRoute?.session_key === "string" && existingRoute.session_key.trim()) ||
      deriveWhatsAppSessionKey({
        chatJid,
        chatType,
        directPeerId,
      });
    deps.db.stmtUpsertSessionRoute.run(
      binding.tenantId,
      "whatsapp",
      sessionKey,
      binding.bindingId,
      JSON.stringify({ routeKey: binding.routeKey, accountId, chatJid }),
      Date.now(),
    );

    const payload = buildWhatsAppInboundEnvelope({
      messageId,
      sessionKey,
      openclawAccountId: deps.config.openclawMuxAccountId,
      rawBody: body,
      fromId,
      chatJid,
      routeKey: binding.routeKey,
      accountId,
      chatType,
      timestampMs,
      rawMessage: {
        id: message.id,
        from: message.from,
        to: message.to,
        body: message.body,
        accountId: message.accountId,
        timestamp: message.timestamp,
        chatType: message.chatType,
        chatId: message.chatId,
        senderJid: message.senderJid,
        senderE164: message.senderE164,
        senderName: message.senderName,
        replyToId: message.replyToId,
        replyToBody: message.replyToBody,
        replyToSender: message.replyToSender,
        replyToSenderJid: message.replyToSenderJid,
        replyToSenderE164: message.replyToSenderE164,
        groupSubject: message.groupSubject,
        groupParticipants: message.groupParticipants,
        mentionedJids: message.mentionedJids,
        mediaPath: message.mediaPath,
        mediaType: message.mediaType,
        mediaUrl: message.mediaUrl,
      },
      media: inboundMedia.media,
      attachments: inboundMedia.attachments,
    });
    const payloadWithIdentity = {
      ...payload,
      openclawId: binding.tenantId,
    };

    const forwardStartedAtMs = Date.now();
    let response: Response;
    try {
      response = await fetch(target.url, {
        method: "POST",
        headers: {
          ...(await deps.buildInboundAuthHeaders(target, traceId)),
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(payloadWithIdentity),
        signal: AbortSignal.timeout(target.timeoutMs),
      });
    } catch (error) {
      deps.metrics.observeInboundForwardDuration("whatsapp", Date.now() - forwardStartedAtMs);
      deps.metrics.recordInboundEvent("whatsapp", "error");
      throw new WhatsAppInboundDeliveryError(errorString(error), {
        retryable: true,
        targetUpdatedAtMs: target.updatedAtMs,
        cause: error,
      });
    }
    if (!response.ok) {
      deps.metrics.observeInboundForwardDuration("whatsapp", Date.now() - forwardStartedAtMs);
      deps.metrics.recordInboundEvent("whatsapp", "error");
      const bodyText = await response.text();
      throw new WhatsAppInboundDeliveryError(
        `openclaw inbound failed (${response.status}): ${bodyText || "no body"}`,
        {
          retryable: deps.isRetryableWhatsAppInboundStatus(response.status),
          statusCode: response.status,
          targetUpdatedAtMs: target.updatedAtMs,
        },
      );
    }
    deps.metrics.observeInboundForwardDuration("whatsapp", Date.now() - forwardStartedAtMs);
    deps.metrics.recordInboundEvent("whatsapp", "forwarded");
    deps.log({
      type: "whatsapp_inbound_forwarded",
      tenantId: binding.tenantId,
      sessionKey,
      messageId,
      accountId,
      chatJid,
      traceId,
    });
  }

  async function processWhatsAppInboundQueuePass(): Promise<void> {
    const now = Date.now();
    const batchSize = Math.max(1, Math.min(100, Math.trunc(deps.config.whatsappQueueBatchSize)));
    const rows = deps.db.stmtSelectDueWhatsAppInboundQueue.all(
      now,
      batchSize,
    ) as WhatsAppInboundQueueRow[];
    for (const row of rows) {
      const message = parseQueuedWhatsAppInboundMessage(row);
      if (!message) {
        deps.db.stmtDeleteWhatsAppInboundQueueById.run(row.id);
        deps.log({
          type: "whatsapp_inbound_queue_drop_invalid_payload",
          queueId: row.id,
          dedupeKey: row.dedupe_key,
        });
        continue;
      }

      try {
        await forwardWhatsAppInboundMessage(message);
        deps.db.stmtDeleteWhatsAppInboundQueueById.run(row.id);
        deps.log({
          type: "whatsapp_inbound_ack_committed",
          queueId: row.id,
          dedupeKey: row.dedupe_key,
          messageId: message.id ?? null,
        });
      } catch (error) {
        const failure = classifyWhatsAppInboundDeliveryError(error, errorString);
        const maxAgeMs = Math.max(1_000, Math.trunc(deps.config.whatsappQueueMaxAgeMs));
        const retryState = resolveWhatsAppInboundQueueRetryState({
          row,
          now,
          maxAgeMs,
          failure,
        });
        if (retryState.exhausted) {
          deps.db.stmtDeleteWhatsAppInboundQueueById.run(row.id);
          deps.metrics.recordInboundEvent("whatsapp", "dropped");
          deps.log({
            type: "whatsapp_inbound_bg_retry_exhausted",
            queueId: row.id,
            dedupeKey: row.dedupe_key,
            messageId: message.id ?? null,
            attemptCount: retryState.attemptCount,
            ageMs: retryState.ageMs,
            maxAgeMs,
            retryable: failure.retryable,
            statusCode: failure.statusCode,
            error: failure.errorMessage,
          });
          continue;
        }

        const retryDelayMs = computeWhatsAppQueueRetryDelayMs(retryState.attemptCount);
        const nextAttemptAtMs = Date.now() + retryDelayMs;
        deps.db.stmtDeferWhatsAppInboundQueueById.run(
          nextAttemptAtMs,
          retryState.attemptCount,
          failure.errorMessage.slice(0, 2_000),
          Date.now(),
          retryState.deliveryWindowStartedAtMs,
          retryState.lastTargetUpdateAtMs,
          row.id,
        );
        deps.log({
          type: "whatsapp_inbound_retry_deferred",
          queueId: row.id,
          dedupeKey: row.dedupe_key,
          messageId: message.id ?? null,
          attemptCount: retryState.attemptCount,
          retryDelayMs,
          nextAttemptAtMs,
          error: failure.errorMessage,
        });
      }
    }
  }

  async function runWhatsAppInboundQueueLoop(shouldContinue: () => boolean): Promise<void> {
    const pollMs = Math.max(100, Math.trunc(deps.config.whatsappQueuePollMs));
    while (shouldContinue()) {
      try {
        await processWhatsAppInboundQueuePass();
      } catch (error) {
        deps.log({
          type: "whatsapp_inbound_queue_poll_error",
          error: String(error),
        });
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, pollMs));
    }
  }

  async function runWhatsAppInboundLoop() {
    if (!deps.config.whatsappInboundEnabled) {
      return;
    }

    const { monitorWebInbox, setActiveWebListener } = await deps.loadWebRuntimeModules();
    deps.whatsappRuntimeHealth.loopStartedAtMs = Date.now();
    let running = true;
    process.on("SIGINT", () => {
      running = false;
      deps.whatsappRuntimeHealth.listenerActive = false;
      void deps.getActiveWhatsAppListener()?.close?.();
    });
    process.on("SIGTERM", () => {
      running = false;
      deps.whatsappRuntimeHealth.listenerActive = false;
      void deps.getActiveWhatsAppListener()?.close?.();
    });

    const queueLoopPromise = runWhatsAppInboundQueueLoop(() => running);

    while (running) {
      let listener: WebMonitorListener | null = null;
      try {
        deps.whatsappRuntimeHealth.lastListenerStartAtMs = Date.now();
        const monitored = await monitorWebInbox({
          verbose: false,
          accountId: deps.config.whatsappAccountId,
          authDir: deps.config.whatsappAuthDir,
          resolveAccessControl: async (params) => {
            const isSamePhone = params.from === params.selfE164;
            const isOutboundEcho = params.isFromMe && !isSamePhone;
            return {
              allowed: !isOutboundEcho,
              shouldMarkRead: true,
              isSelfChat: false,
              resolvedAccountId: params.accountId,
            };
          },
          onMessage: async (message) => {
            deps.whatsappRuntimeHealth.lastInboundSeenAtMs = Date.now();
            enqueueWhatsAppInboundMessage(message);
          },
        });
        listener = monitored;
        deps.setActiveWhatsAppListener(monitored);
        deps.whatsappRuntimeHealth.listenerActive = true;
        deps.whatsappRuntimeHealth.lastListenerError = null;
        deps.whatsappRuntimeHealth.lastListenerErrorAtMs = null;
        setActiveWebListener(deps.config.whatsappAccountId, monitored);
        const closeReason = await monitored.onClose;
        deps.whatsappRuntimeHealth.lastListenerCloseAtMs = Date.now();
        deps.whatsappRuntimeHealth.lastListenerCloseStatus =
          typeof closeReason.status === "number" && Number.isFinite(closeReason.status)
            ? Math.trunc(closeReason.status)
            : null;
        deps.whatsappRuntimeHealth.lastListenerClosedLoggedOut = Boolean(closeReason.isLoggedOut);
        const listenerError =
          closeReason.error instanceof Error
            ? closeReason.error.message
            : typeof closeReason.error === "string"
              ? closeReason.error
              : undefined;
        if (closeReason.error != null) {
          deps.whatsappRuntimeHealth.lastListenerErrorAtMs = Date.now();
          deps.whatsappRuntimeHealth.lastListenerError = listenerError ?? "unknown listener error";
        }
        deps.log({
          type: "whatsapp_inbound_listener_closed",
          status: closeReason.status,
          isLoggedOut: closeReason.isLoggedOut,
          error: listenerError,
        });
        if (closeReason.isLoggedOut) {
          running = false;
        }
      } catch (error) {
        deps.whatsappRuntimeHealth.lastListenerErrorAtMs = Date.now();
        deps.whatsappRuntimeHealth.lastListenerError = errorString(error);
        deps.whatsappRuntimeHealth.listenerActive = false;
        deps.log({
          type: "whatsapp_inbound_listener_error",
          error: errorString(error),
        });
      } finally {
        if (listener) {
          try {
            await listener.close();
          } catch (error) {
            deps.log({
              type: "whatsapp_inbound_listener_close_error",
              error: String(error),
            });
          }
        }
        deps.setActiveWhatsAppListener(null);
        deps.whatsappRuntimeHealth.listenerActive = false;
        setActiveWebListener(deps.config.whatsappAccountId, null);
      }

      if (!running) {
        break;
      }
      await new Promise((resolveSleep) =>
        setTimeout(resolveSleep, Math.max(100, Math.trunc(deps.config.whatsappInboundRetryMs))),
      );
    }

    await queueLoopPromise;
  }

  return {
    runWhatsAppInboundLoop,
  };
}
