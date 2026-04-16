import type { MuxConfig } from "../../config/env.js";
import type { PreparedStatements } from "../../db/statements.js";
import type { ClaimResult, StyledNotice, TenantInboundTarget } from "../../domain/types.js";
import { errorString, readNonEmptyString } from "../../domain/values.js";
import {
  buildTelegramCallbackInboundEnvelope,
  buildTelegramInboundEnvelope,
  type MuxInboundAttachment,
} from "../../mux-envelope.js";
import { createInboundTraceId } from "../../observability/tracing.js";
import { buildTelegramRouteKey } from "../../routing/keys.js";

type TelegramIncomingMessage = {
  message_id?: number;
  date?: number;
  text?: string;
  caption?: string;
  message_thread_id?: number;
  from?: { id?: number; username?: string };
  chat?: { id?: number; type?: string; is_forum?: boolean };
  entities?: Array<{ type?: string; offset?: number; length?: number }>;
  reply_to_message?: { from?: { username?: string } };
};

type TelegramUpdate = {
  update_id?: number;
  message?: TelegramIncomingMessage;
  edited_message?: TelegramIncomingMessage;
  callback_query?: TelegramCallbackQuery;
};

type TelegramCallbackQuery = {
  id?: string;
  from?: { id?: number };
  data?: string;
  message?: TelegramIncomingMessage;
};

type TelegramParseMode = "HTML";

type TelegramBotControlCommand =
  | { kind: "help" }
  | { kind: "status" }
  | { kind: "unpair" }
  | { kind: "switch"; token?: string };

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

type Metrics = {
  recordInboundEvent: (channel: "telegram", outcome: "forwarded" | "dropped" | "error") => void;
  observeInboundForwardDuration: (channel: "telegram", durationMs: number) => void;
  recordActiveUser: (channel: "telegram", userId: string) => void;
  recordRetryScheduled: (channel: "telegram") => void;
};

export function createTelegramInboundRuntime(deps: {
  config: Pick<
    MuxConfig,
    | "telegramApiBaseUrl"
    | "telegramInboundEnabled"
    | "telegramPollTimeoutSec"
    | "telegramPollRetryMs"
    | "telegramBootstrapLatest"
    | "openclawMuxAccountId"
  >;
  telegramBotUsername: string | null;
  metrics: Metrics;
  telegramRuntimeHealth: TelegramRuntimeHealth;
  getTelegramPollConflictHealth: () => TelegramPollConflictHealth | null;
  setTelegramPollConflictHealth: (health: TelegramPollConflictHealth | null) => void;
  telegramBgRetryCount: Map<string, number>;
  telegramBgRetryQueuedAtMs: Map<string, number>;
  requireTelegramBotToken: () => string;
  log: (entry: Record<string, unknown>) => void;
  resolveStoredTelegramOffset: () => number;
  storeTelegramOffset: (lastUpdateId: number) => void;
  answerTelegramCallbackQuery: (params: {
    callbackQueryId: string;
    text?: string;
  }) => Promise<void>;
  resolveTelegramIncomingTopicId: (params: {
    isForum: boolean;
    messageThreadId?: unknown;
  }) => number | undefined;
  resolveTelegramBindingForIncoming: (
    chatId: string,
    topicId?: number,
  ) => {
    tenantId: string;
    bindingId: string;
    routeKey: string;
  } | null;
  resolveTenantInboundTarget: (tenantId: string) => TenantInboundTarget | null;
  resolveTelegramInboundSessionKey: (params: {
    tenantId: string;
    bindingId: string;
    chatId: string;
    topicId?: number;
  }) => string;
  db: Pick<PreparedStatements, "stmtUpsertSessionRoute">;
  buildInboundAuthHeaders: (
    target: TenantInboundTarget,
    traceId?: string,
  ) => Promise<Record<string, string>>;
  extractTelegramInboundMedia: (params: {
    message: TelegramIncomingMessage;
    updateId: number;
  }) => Promise<{
    media: unknown;
    attachments: MuxInboundAttachment[];
  }>;
  parseBotControlCommand: (input: string | null) => TelegramBotControlCommand | null;
  handleTelegramBotControlCommand: (params: {
    command: TelegramBotControlCommand;
    chatId: string;
    topicId?: number;
    chatType: "direct" | "group";
    fromId: string;
    binding: { tenantId: string; bindingId: string; routeKey: string } | null;
  }) => Promise<void>;
  isTelegramCommandText: (input: string | null) => boolean;
  hasTelegramMessageContent: (message: TelegramIncomingMessage) => boolean;
  renderUnpairedHintNotice: (channel: "telegram") => StyledNotice;
  sendTelegramPairingNotice: (params: {
    chatId: string;
    topicId?: number;
    text: string;
    parseMode?: TelegramParseMode;
  }) => Promise<void>;
  renderPairingInvalidNotice: (channel: "telegram") => StyledNotice;
  extractPairingTokenFromTelegramMessage: (message: TelegramIncomingMessage) => string | null;
  claimTelegramPairingToken: (params: {
    token: string;
    chatId: string;
    topicId?: number;
    chatType: "direct" | "group";
  }) => ClaimResult | null;
  sendPostClaimNotices: (params: {
    channel: "telegram";
    claimed: ClaimResult;
    send: (notice: StyledNotice) => Promise<void>;
    fromId: string;
    chatId: string;
    chatType: "direct" | "group";
  }) => Promise<void>;
}) {
  function extractTelegramMessage(update: TelegramUpdate): TelegramIncomingMessage | null {
    const candidate = update.message ?? update.edited_message;
    if (!candidate || typeof candidate !== "object") {
      return null;
    }
    return candidate;
  }

  function extractTelegramCallbackQuery(update: TelegramUpdate): TelegramCallbackQuery | null {
    const candidate = update.callback_query;
    if (!candidate || typeof candidate !== "object") {
      return null;
    }
    return candidate;
  }

  async function fetchTelegramUpdates(offset: number): Promise<TelegramUpdate[]> {
    const token = deps.requireTelegramBotToken();
    const response = await fetch(`${deps.config.telegramApiBaseUrl}/bot${token}/getUpdates`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        offset,
        timeout: Math.max(1, Math.trunc(deps.config.telegramPollTimeoutSec)),
        allowed_updates: ["message", "edited_message", "callback_query"],
      }),
    });
    if (!response.ok) {
      throw new Error(`telegram getUpdates failed (${response.status})`);
    }
    const json = (await response.json()) as { ok?: boolean; result?: unknown };
    if (json.ok !== true || !Array.isArray(json.result)) {
      throw new Error("telegram getUpdates returned invalid payload");
    }
    return json.result as TelegramUpdate[];
  }

  function resolveTelegramGetUpdatesStatusCode(errorText: string): number | null {
    const match = errorText.match(/telegram(?: bootstrap)? getUpdates failed \((\d{3})\)/i);
    if (!match) {
      return null;
    }
    const parsed = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }
    return parsed;
  }

  function updateTelegramPollConflictHealth(error: unknown) {
    const errorText = String(error);
    const statusCode = resolveTelegramGetUpdatesStatusCode(errorText);
    if (statusCode === 409) {
      deps.setTelegramPollConflictHealth({
        lastConflictAtMs: Date.now(),
        lastError: errorText,
      });
      return;
    }
    deps.setTelegramPollConflictHealth(null);
  }

  function clearTelegramPollConflictHealth() {
    deps.setTelegramPollConflictHealth(null);
  }

  function resolveTenantIdForTelegramUpdate(update: TelegramUpdate): string | null {
    const message = extractTelegramMessage(update);
    if (!message) {
      return null;
    }
    const chatId =
      typeof message.chat?.id === "number" && Number.isFinite(message.chat.id)
        ? String(Math.trunc(message.chat.id))
        : "";
    if (!chatId) {
      return null;
    }
    const isForum = message.chat?.is_forum === true;
    const topicId = deps.resolveTelegramIncomingTopicId({
      isForum,
      messageThreadId: message.message_thread_id,
    });
    const binding = deps.resolveTelegramBindingForIncoming(chatId, topicId);
    return binding?.tenantId ?? null;
  }

  async function bootstrapTelegramOffsetIfNeeded() {
    if (!deps.config.telegramBootstrapLatest) {
      return;
    }
    const current = deps.resolveStoredTelegramOffset();
    if (current > 0) {
      return;
    }
    const token = deps.requireTelegramBotToken();
    const response = await fetch(`${deps.config.telegramApiBaseUrl}/bot${token}/getUpdates`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        timeout: 0,
        limit: 1,
        allowed_updates: ["message", "edited_message", "callback_query"],
      }),
    });
    if (!response.ok) {
      throw new Error(`telegram bootstrap getUpdates failed (${response.status})`);
    }
    const json = (await response.json()) as { ok?: boolean; result?: unknown };
    if (json.ok !== true || !Array.isArray(json.result) || json.result.length === 0) {
      return;
    }
    const lastUpdate = json.result[json.result.length - 1] as TelegramUpdate;
    const updateId =
      typeof lastUpdate.update_id === "number" && Number.isFinite(lastUpdate.update_id)
        ? Math.trunc(lastUpdate.update_id)
        : 0;
    if (updateId > 0) {
      deps.storeTelegramOffset(updateId);
    }
  }

  async function forwardTelegramCallbackQueryToTenant(params: {
    updateId: number;
    update: TelegramUpdate;
    callbackQuery: TelegramCallbackQuery;
  }) {
    const callbackData = readNonEmptyString(params.callbackQuery.data);
    const callbackMessage =
      params.callbackQuery.message && typeof params.callbackQuery.message === "object"
        ? params.callbackQuery.message
        : null;
    const callbackQueryId = readNonEmptyString(params.callbackQuery.id);
    if (!callbackData || !callbackMessage) {
      if (callbackQueryId) {
        try {
          await deps.answerTelegramCallbackQuery({ callbackQueryId });
        } catch (error) {
          deps.log({
            type: "telegram_callback_answer_error",
            updateId: params.updateId,
            error: String(error),
          });
        }
      }
      return;
    }

    const chatId =
      typeof callbackMessage.chat?.id === "number" && Number.isFinite(callbackMessage.chat.id)
        ? String(Math.trunc(callbackMessage.chat.id))
        : "";
    if (!chatId) {
      return;
    }
    const isForum = callbackMessage.chat?.is_forum === true;
    const topicId = deps.resolveTelegramIncomingTopicId({
      isForum,
      messageThreadId: callbackMessage.message_thread_id,
    });
    const callbackMessageIdSeed =
      typeof callbackMessage.message_id === "number" && Number.isFinite(callbackMessage.message_id)
        ? String(Math.trunc(callbackMessage.message_id))
        : undefined;
    const traceId = createInboundTraceId({
      channel: "telegram",
      updateId: params.updateId,
      messageId: callbackMessageIdSeed,
    });
    const binding = deps.resolveTelegramBindingForIncoming(chatId, topicId);
    if (!binding) {
      if (callbackQueryId) {
        try {
          await deps.answerTelegramCallbackQuery({
            callbackQueryId,
            text: "Pairing link is invalid or expired. Request a new link from your dashboard.",
          });
        } catch (error) {
          deps.log({
            type: "telegram_callback_answer_error",
            updateId: params.updateId,
            error: String(error),
            traceId,
          });
        }
      }
      return;
    }

    const target = deps.resolveTenantInboundTarget(binding.tenantId);
    if (!target) {
      deps.metrics.recordInboundEvent("telegram", "dropped");
      deps.log({
        type: "telegram_inbound_drop_no_target",
        tenantId: binding.tenantId,
        updateId: params.updateId,
        routeKey: binding.routeKey,
        traceId,
      });
      throw new Error(`telegram inbound target missing for tenant ${binding.tenantId}`);
    }

    const callbackMessageId =
      typeof callbackMessage.message_id === "number" && Number.isFinite(callbackMessage.message_id)
        ? String(Math.trunc(callbackMessage.message_id))
        : `tg-callback-msg:${params.updateId}`;
    const fromId =
      typeof params.callbackQuery.from?.id === "number" &&
      Number.isFinite(params.callbackQuery.from.id)
        ? String(Math.trunc(params.callbackQuery.from.id))
        : "unknown";
    deps.metrics.recordActiveUser("telegram", fromId);
    const timestampMs =
      typeof callbackMessage.date === "number" && Number.isFinite(callbackMessage.date)
        ? Math.trunc(callbackMessage.date) * 1_000
        : Date.now();
    const chatType = callbackMessage.chat?.type === "private" ? "direct" : "group";
    const inboundRouteKey = buildTelegramRouteKey(chatId, topicId);
    const sessionKey = deps.resolveTelegramInboundSessionKey({
      tenantId: binding.tenantId,
      bindingId: binding.bindingId,
      chatId,
      topicId,
    });

    deps.db.stmtUpsertSessionRoute.run(
      binding.tenantId,
      "telegram",
      sessionKey,
      binding.bindingId,
      JSON.stringify({ routeKey: inboundRouteKey }),
      Date.now(),
    );

    const payload = buildTelegramCallbackInboundEnvelope({
      updateId: params.updateId,
      sessionKey,
      accountId: deps.config.openclawMuxAccountId,
      rawBody: callbackData,
      fromId,
      chatId,
      topicId,
      chatType,
      messageId: callbackMessageId,
      timestampMs,
      routeKey: inboundRouteKey,
      callbackData,
      callbackQueryId: callbackQueryId ?? undefined,
      rawCallbackQuery: params.callbackQuery,
      rawMessage: callbackMessage,
      rawUpdate: params.update,
    });
    const payloadWithIdentity = {
      ...payload,
      openclawId: binding.tenantId,
    };
    const tenantTraceId = createInboundTraceId({
      channel: "telegram",
      tenantId: binding.tenantId,
      routeKey: inboundRouteKey,
      updateId: params.updateId,
      messageId: callbackMessageId,
    });

    const forwardStartedAtMs = Date.now();
    let response: Response;
    try {
      response = await fetch(target.url, {
        method: "POST",
        headers: {
          ...(await deps.buildInboundAuthHeaders(target, tenantTraceId)),
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify(payloadWithIdentity),
        signal: AbortSignal.timeout(target.timeoutMs),
      });
    } catch (error) {
      deps.metrics.observeInboundForwardDuration("telegram", Date.now() - forwardStartedAtMs);
      deps.metrics.recordInboundEvent("telegram", "error");
      throw error;
    }
    if (!response.ok) {
      deps.metrics.observeInboundForwardDuration("telegram", Date.now() - forwardStartedAtMs);
      deps.metrics.recordInboundEvent("telegram", "error");
      const bodyText = await response.text();
      throw new Error(`openclaw inbound failed (${response.status}): ${bodyText || "no body"}`);
    }
    deps.metrics.observeInboundForwardDuration("telegram", Date.now() - forwardStartedAtMs);
    deps.metrics.recordInboundEvent("telegram", "forwarded");

    if (callbackQueryId) {
      try {
        await deps.answerTelegramCallbackQuery({ callbackQueryId });
      } catch (error) {
        deps.log({
          type: "telegram_callback_answer_error",
          updateId: params.updateId,
          error: String(error),
          traceId: tenantTraceId,
        });
      }
    }

    deps.log({
      type: "telegram_callback_forwarded",
      tenantId: binding.tenantId,
      sessionKey,
      updateId: params.updateId,
      messageId: callbackMessageId,
      callbackData,
      traceId: tenantTraceId,
    });
  }

  async function forwardTelegramUpdateToTenant(update: TelegramUpdate) {
    const updateId =
      typeof update.update_id === "number" && Number.isFinite(update.update_id)
        ? Math.trunc(update.update_id)
        : 0;
    if (updateId <= 0) {
      return;
    }

    const callbackQuery = extractTelegramCallbackQuery(update);
    if (callbackQuery) {
      await forwardTelegramCallbackQueryToTenant({
        updateId,
        update,
        callbackQuery,
      });
      return;
    }

    const message = extractTelegramMessage(update);
    if (!message) {
      return;
    }

    const chatId =
      typeof message.chat?.id === "number" && Number.isFinite(message.chat.id)
        ? String(Math.trunc(message.chat.id))
        : "";
    if (!chatId) {
      return;
    }
    const isForum = message.chat?.is_forum === true;
    const topicId = deps.resolveTelegramIncomingTopicId({
      isForum,
      messageThreadId: message.message_thread_id,
    });
    const bodyText = typeof message.text === "string" ? message.text : null;
    const bodyCaption = typeof message.caption === "string" ? message.caption : null;
    const body = bodyText ?? bodyCaption ?? "";
    const chatType = message.chat?.type === "private" ? "direct" : "group";
    const binding = deps.resolveTelegramBindingForIncoming(chatId, topicId);
    const botControlCommand = deps.parseBotControlCommand(body);
    if (botControlCommand) {
      try {
        const fromId =
          typeof message.from?.id === "number" && Number.isFinite(message.from.id)
            ? String(Math.trunc(message.from.id))
            : chatId;
        await deps.handleTelegramBotControlCommand({
          command: botControlCommand,
          chatId,
          topicId,
          chatType,
          fromId,
          binding,
        });
      } catch (error) {
        deps.log({
          type: "telegram_bot_control_error",
          updateId,
          chatId,
          topicId: topicId ?? null,
          error: String(error),
        });
      }
      return;
    }
    const pairingToken = deps.extractPairingTokenFromTelegramMessage(message);
    if (!binding) {
      if (!pairingToken) {
        const shouldSendUnpairedNotice =
          deps.isTelegramCommandText(body) ||
          (chatType === "direct" && deps.hasTelegramMessageContent(message));
        if (shouldSendUnpairedNotice) {
          try {
            const notice = deps.renderUnpairedHintNotice("telegram");
            await deps.sendTelegramPairingNotice({
              chatId,
              topicId,
              text: notice.text,
              parseMode: notice.parseMode,
            });
          } catch (error) {
            deps.log({
              type: "telegram_unpaired_command_notice_error",
              updateId,
              error: String(error),
            });
          }
        }
        return;
      }
      const claimed = deps.claimTelegramPairingToken({
        token: pairingToken,
        chatId,
        topicId,
        chatType,
      });
      if (!claimed) {
        try {
          const notice = deps.renderPairingInvalidNotice("telegram");
          await deps.sendTelegramPairingNotice({
            chatId,
            topicId,
            text: notice.text,
            parseMode: notice.parseMode,
          });
        } catch (error) {
          deps.log({
            type: "telegram_pairing_invalid_notice_error",
            updateId,
            error: String(error),
          });
        }
        deps.log({
          type: "telegram_pairing_token_invalid",
          updateId,
          chatId,
          topicId: topicId ?? null,
        });
        return;
      }

      try {
        const fromId =
          typeof message.from?.id === "number" && Number.isFinite(message.from.id)
            ? String(Math.trunc(message.from.id))
            : chatId;
        await deps.sendPostClaimNotices({
          channel: "telegram",
          claimed,
          send: async (notice) => {
            await deps.sendTelegramPairingNotice({
              chatId,
              topicId,
              text: notice.text,
              parseMode: notice.parseMode,
            });
          },
          fromId,
          chatId,
          chatType,
        });
      } catch (error) {
        deps.log({
          type: "telegram_pairing_notice_error",
          tenantId: claimed.tenantId,
          updateId,
          error: String(error),
        });
      }
      deps.log({
        type: "telegram_pairing_token_claimed",
        tenantId: claimed.tenantId,
        updateId,
        routeKey: claimed.routeKey,
        sessionKey: claimed.sessionKey,
        claimType: claimed.claimType,
        ...(claimed.previousTenantId ? { previousTenantId: claimed.previousTenantId } : {}),
      });
      return;
    }
    if (pairingToken) {
      const reClaimed = deps.claimTelegramPairingToken({
        token: pairingToken,
        chatId,
        topicId,
        chatType,
      });
      if (reClaimed) {
        try {
          const fromId =
            typeof message.from?.id === "number" && Number.isFinite(message.from.id)
              ? String(Math.trunc(message.from.id))
              : chatId;
          await deps.sendPostClaimNotices({
            channel: "telegram",
            claimed: reClaimed,
            send: async (notice) => {
              await deps.sendTelegramPairingNotice({
                chatId,
                topicId,
                text: notice.text,
                parseMode: notice.parseMode,
              });
            },
            fromId,
            chatId,
            chatType,
          });
        } catch (error) {
          deps.log({
            type: "telegram_pairing_notice_error",
            tenantId: reClaimed.tenantId,
            updateId,
            error: String(error),
          });
        }
        deps.log({
          type: "telegram_pairing_token_claimed",
          tenantId: reClaimed.tenantId,
          updateId,
          routeKey: reClaimed.routeKey,
          sessionKey: reClaimed.sessionKey,
          claimType: reClaimed.claimType,
          ...(reClaimed.previousTenantId ? { previousTenantId: reClaimed.previousTenantId } : {}),
        });
      } else {
        deps.log({
          type: "telegram_pairing_token_ignored_bound_route",
          tenantId: binding.tenantId,
          updateId,
          routeKey: binding.routeKey,
        });
      }
      return;
    }

    const messageId =
      typeof message.message_id === "number" && Number.isFinite(message.message_id)
        ? String(Math.trunc(message.message_id))
        : `tg-msg:${updateId}`;
    const inboundRouteKey = buildTelegramRouteKey(chatId, topicId);
    const traceId = createInboundTraceId({
      channel: "telegram",
      tenantId: binding.tenantId,
      routeKey: inboundRouteKey,
      updateId,
      messageId,
    });

    const target = deps.resolveTenantInboundTarget(binding.tenantId);
    if (!target) {
      deps.metrics.recordInboundEvent("telegram", "dropped");
      deps.log({
        type: "telegram_inbound_drop_no_target",
        tenantId: binding.tenantId,
        updateId,
        routeKey: binding.routeKey,
        traceId,
      });
      throw new Error(`telegram inbound target missing for tenant ${binding.tenantId}`);
    }

    const inboundMedia = await deps.extractTelegramInboundMedia({ message, updateId });
    const forwardedBody = body ?? "";
    if (!forwardedBody && inboundMedia.attachments.length === 0) {
      return;
    }
    const fromId =
      typeof message.from?.id === "number" && Number.isFinite(message.from.id)
        ? String(Math.trunc(message.from.id))
        : "unknown";
    deps.metrics.recordActiveUser("telegram", fromId);
    const timestampMs =
      typeof message.date === "number" && Number.isFinite(message.date)
        ? Math.trunc(message.date) * 1_000
        : Date.now();
    const sessionKey = deps.resolveTelegramInboundSessionKey({
      tenantId: binding.tenantId,
      bindingId: binding.bindingId,
      chatId,
      topicId,
    });

    deps.db.stmtUpsertSessionRoute.run(
      binding.tenantId,
      "telegram",
      sessionKey,
      binding.bindingId,
      JSON.stringify({ routeKey: inboundRouteKey }),
      Date.now(),
    );

    let wasMentioned = false;
    const botUsername = deps.telegramBotUsername;
    if (botUsername) {
      const entities = Array.isArray(message.entities) ? message.entities : [];
      wasMentioned = entities.some(
        (e: { type?: string; offset?: number; length?: number }) =>
          e.type === "mention" &&
          typeof e.offset === "number" &&
          typeof e.length === "number" &&
          forwardedBody.slice(e.offset, e.offset + e.length).toLowerCase() ===
            `@${botUsername.toLowerCase()}`,
      );
      if (!wasMentioned && message.reply_to_message?.from?.username) {
        wasMentioned =
          message.reply_to_message.from.username.toLowerCase() === botUsername.toLowerCase();
      }
    }

    const payload = buildTelegramInboundEnvelope({
      updateId,
      sessionKey,
      accountId: deps.config.openclawMuxAccountId,
      rawBody: forwardedBody,
      fromId,
      chatId,
      topicId,
      chatType,
      messageId,
      timestampMs,
      routeKey: inboundRouteKey,
      rawMessage: message,
      rawUpdate: update,
      media: inboundMedia.media,
      attachments: inboundMedia.attachments,
      wasMentioned,
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
      deps.metrics.observeInboundForwardDuration("telegram", Date.now() - forwardStartedAtMs);
      deps.metrics.recordInboundEvent("telegram", "error");
      throw error;
    }

    if (!response.ok) {
      deps.metrics.observeInboundForwardDuration("telegram", Date.now() - forwardStartedAtMs);
      deps.metrics.recordInboundEvent("telegram", "error");
      const bodyText = await response.text();
      throw new Error(`openclaw inbound failed (${response.status}): ${bodyText || "no body"}`);
    }
    deps.metrics.observeInboundForwardDuration("telegram", Date.now() - forwardStartedAtMs);
    deps.metrics.recordInboundEvent("telegram", "forwarded");

    deps.log({
      type: "telegram_inbound_forwarded",
      tenantId: binding.tenantId,
      sessionKey,
      updateId,
      messageId,
      traceId,
    });
  }

  async function runTelegramInboundLoop() {
    if (!deps.config.telegramInboundEnabled) {
      return;
    }
    deps.telegramRuntimeHealth.loopStartedAtMs = Date.now();

    try {
      await bootstrapTelegramOffsetIfNeeded();
      clearTelegramPollConflictHealth();
    } catch (error) {
      updateTelegramPollConflictHealth(error);
      deps.telegramRuntimeHealth.lastPollErrorAtMs = Date.now();
      deps.telegramRuntimeHealth.lastPollError = errorString(error);
      deps.log({ type: "telegram_inbound_bootstrap_error", error: String(error) });
    }

    const TELEGRAM_BG_RETRY_MAX_PER_TENANT = 3;
    const TELEGRAM_BG_RETRY_ATTEMPTS = 5;
    const TELEGRAM_BG_RETRY_INTERVAL_MS = Math.max(
      100,
      Number(process.env.MUX_TELEGRAM_BG_RETRY_INTERVAL_MS) || 30_000,
    );
    deps.telegramBgRetryCount.clear();
    deps.telegramBgRetryQueuedAtMs.clear();

    let running = true;
    process.on("SIGINT", () => {
      running = false;
    });
    process.on("SIGTERM", () => {
      running = false;
    });

    while (running) {
      try {
        const offset = deps.resolveStoredTelegramOffset() + 1;
        const updates = await fetchTelegramUpdates(offset);
        clearTelegramPollConflictHealth();
        deps.telegramRuntimeHealth.lastPollSuccessAtMs = Date.now();
        deps.telegramRuntimeHealth.lastPollErrorAtMs = null;
        deps.telegramRuntimeHealth.lastPollError = null;
        for (const update of updates) {
          const updateId =
            typeof update.update_id === "number" && Number.isFinite(update.update_id)
              ? Math.trunc(update.update_id)
              : 0;
          if (updateId <= 0) {
            continue;
          }
          deps.telegramRuntimeHealth.lastInboundSeenAtMs = Date.now();
          try {
            await forwardTelegramUpdateToTenant(update);
          } catch (error) {
            deps.log({
              type: "telegram_inbound_forward_failed",
              updateId,
              error: errorString(error),
            });
            const tenantId = resolveTenantIdForTelegramUpdate(update);
            if (tenantId) {
              const pending = deps.telegramBgRetryCount.get(tenantId) ?? 0;
              if (pending < TELEGRAM_BG_RETRY_MAX_PER_TENANT) {
                deps.metrics.recordRetryScheduled("telegram");
                if (pending <= 0) {
                  deps.telegramBgRetryQueuedAtMs.set(tenantId, Date.now());
                }
                deps.telegramBgRetryCount.set(tenantId, pending + 1);
                const capturedUpdate = update;
                const capturedId = updateId;
                void (async () => {
                  try {
                    for (let attempt = 1; attempt <= TELEGRAM_BG_RETRY_ATTEMPTS; attempt++) {
                      await new Promise((resolveSleep) =>
                        setTimeout(resolveSleep, TELEGRAM_BG_RETRY_INTERVAL_MS * attempt),
                      );
                      try {
                        await forwardTelegramUpdateToTenant(capturedUpdate);
                        deps.log({
                          type: "telegram_inbound_bg_retry_ok",
                          updateId: capturedId,
                          attempt,
                          tenantId,
                        });
                        return;
                      } catch {
                        if (attempt === TELEGRAM_BG_RETRY_ATTEMPTS) {
                          deps.log({
                            type: "telegram_inbound_bg_retry_exhausted",
                            updateId: capturedId,
                            tenantId,
                          });
                        }
                      }
                    }
                  } finally {
                    const nextPending = (deps.telegramBgRetryCount.get(tenantId) ?? 1) - 1;
                    if (nextPending <= 0) {
                      deps.telegramBgRetryCount.delete(tenantId);
                      deps.telegramBgRetryQueuedAtMs.delete(tenantId);
                    } else {
                      deps.telegramBgRetryCount.set(tenantId, nextPending);
                    }
                  }
                })();
              } else {
                deps.log({
                  type: "telegram_inbound_bg_retry_skipped_cap",
                  updateId,
                  tenantId,
                  pending,
                });
              }
            }
          }
          deps.storeTelegramOffset(updateId);
          queueMicrotask(() => deps.log({ type: "telegram_inbound_ack_committed", updateId }));
        }
      } catch (error) {
        updateTelegramPollConflictHealth(error);
        deps.telegramRuntimeHealth.lastPollErrorAtMs = Date.now();
        deps.telegramRuntimeHealth.lastPollError = errorString(error);
        deps.log({ type: "telegram_inbound_poll_error", error: String(error) });
        await new Promise((resolveSleep) =>
          setTimeout(resolveSleep, Math.max(100, Math.trunc(deps.config.telegramPollRetryMs))),
        );
      }
    }
  }

  return {
    extractTelegramMessage,
    extractTelegramCallbackQuery,
    runTelegramInboundLoop,
  };
}
