import { RequestClient } from "@buape/carbon";
import type { MuxConfig } from "../config/env.js";
import type {
  DiscordBoundRoute,
  IMessageBoundRoute,
  OutboundResolutionMode,
  ResolvedBoundRoute,
  TelegramBoundRoute,
  TenantIdentity,
  WhatsAppBoundRoute,
} from "../domain/types.js";
import {
  asRecord,
  errorString,
  readNonEmptyString,
  readPositiveInt,
  readUnsignedNumericString,
} from "../domain/values.js";
import {
  collectOutboundMediaUrls,
  readOutboundOperation,
  readOutboundRaw,
  readOutboundText,
  type MuxPayload,
} from "../mux-envelope.js";

export type SendResult = {
  statusCode: number;
  bodyText: string;
};

// Extracts the upstream Photon HTTP status from an IMessagePhotonError without
// importing the class (avoids a circular type dep through api.ts). A duck-type
// check is sufficient because this module is the only consumer.
function readIMessagePhotonStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const httpStatus = (error as { httpStatus?: unknown }).httpStatus;
  if (typeof httpStatus === "number" && Number.isFinite(httpStatus)) {
    return httpStatus;
  }
  return null;
}

export function createOutboundService(deps: {
  config: Pick<
    MuxConfig,
    | "outboundResolutionMode"
    | "whatsappAccountId"
    | "openclawMuxAccountId"
    | "telegramGeneralTopicId"
    | "discordApiBaseUrl"
  >;
  allowedTelegramMethods: ReadonlySet<string>;
  metrics: {
    recordAuthFailure: (surface: "tenant") => void;
    recordOutboundRouteResolution: (params: {
      channel: "telegram" | "discord" | "whatsapp" | "imessage";
      mode: OutboundResolutionMode;
      via: "session" | "route";
    }) => void;
  };
  log: (entry: Record<string, unknown>) => void;
  normalizeChannel: (value: unknown) => string | null;
  listTelegramOutboundRouteKeys: (params: {
    requestedTo: unknown;
    rawBody?: Record<string, unknown>;
    requestedThreadId?: number;
  }) => string[];
  listDiscordOutboundRouteKeys: (params: {
    requestedTo: unknown;
    requestedThreadId?: string;
  }) => Promise<string[]>;
  listWhatsAppOutboundRouteKeys: (params: {
    requestedTo: unknown;
    accountIds: Array<string | null | undefined>;
    rawSend?: Record<string, unknown>;
  }) => string[];
  listIMessageOutboundRouteKeys: (params: {
    requestedTo: unknown;
    rawSend?: Record<string, unknown>;
  }) => string[];
  resolveTelegramBoundRoute: (params: {
    tenantId: string;
    channel: "telegram";
    sessionKey: string;
    routeKeys?: string[];
    mode?: OutboundResolutionMode;
  }) => ResolvedBoundRoute<TelegramBoundRoute> | null;
  resolveDiscordBoundRoute: (params: {
    tenantId: string;
    channel: "discord";
    sessionKey: string;
    routeKeys?: string[];
    mode?: OutboundResolutionMode;
  }) => Promise<ResolvedBoundRoute<DiscordBoundRoute> | null>;
  resolveWhatsAppBoundRoute: (params: {
    tenantId: string;
    channel: "whatsapp";
    sessionKey: string;
    routeKeys?: string[];
    mode?: OutboundResolutionMode;
  }) => ResolvedBoundRoute<WhatsAppBoundRoute> | null;
  resolveIMessageBoundRoute: (params: {
    tenantId: string;
    channel: "imessage";
    sessionKey: string;
    routeKeys?: string[];
    mode?: OutboundResolutionMode;
  }) => ResolvedBoundRoute<IMessageBoundRoute> | null;
  resolveDiscordOutboundChannelId: (params: {
    boundRoute: DiscordBoundRoute;
    requestedTo: unknown;
    requestedThreadId?: string;
  }) => Promise<{ ok: true; channelId: string } | { ok: false; statusCode: number; error: string }>;
  sendTelegram: (
    method: string,
    body: Record<string, unknown>,
  ) => Promise<{ response: Response; result: Record<string, unknown> }>;
  sendTelegramWithFallbacks: (params: {
    method: string;
    body: Record<string, unknown>;
  }) => Promise<{ response: Response; result: Record<string, unknown> }>;
  isTelegramMessageNotModified: (method: string, result: Record<string, unknown>) => boolean;
  sendDiscordTyping: (params: {
    channelId: string;
  }) => Promise<{ response: Response; result: Record<string, unknown> }>;
  discordRequest: (params: {
    method: "GET" | "POST";
    path: string;
    body?: Record<string, unknown>;
  }) => Promise<{ response: Response; result: Record<string, unknown> }>;
  requireDiscordBotToken: () => string;
  loadDiscordRuntimeModules: () => Promise<{
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
  }>;
  loadWebRuntimeModules: () => Promise<{
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
  }>;
  imessageApiService: {
    getSdk: () => unknown;
    sendMessage: (params: {
      chatGuid: string;
      message: string;
      selectedMessageGuid?: string;
    }) => Promise<{ guid: string | null }>;
    sendAttachment: (params: {
      chatGuid: string;
      attachmentUrl: string;
      selectedMessageGuid?: string;
    }) => Promise<{ guid: string | null }>;
  };
}): {
  runOutboundAction: (params: {
    tenant: TenantIdentity;
    channel: string;
    sessionKey: string;
    action?: string;
    requestedTo?: unknown;
    requestedThreadId?: number;
    requestedDiscordThreadId?: string;
    accountId?: string | null;
    mode?: OutboundResolutionMode;
  }) => Promise<SendResult>;
  runOutboundSend: (params: { tenant: TenantIdentity; payload: MuxPayload }) => Promise<SendResult>;
} {
  async function runOutboundAction(params: {
    tenant: TenantIdentity;
    channel: string;
    sessionKey: string;
    action?: string;
    requestedTo?: unknown;
    requestedThreadId?: number;
    requestedDiscordThreadId?: string;
    accountId?: string | null;
    mode?: OutboundResolutionMode;
  }): Promise<SendResult> {
    if (params.action !== "typing") {
      return {
        statusCode: 400,
        bodyText: JSON.stringify({
          ok: false,
          error: "unsupported action",
          action: params.action ?? null,
        }),
      };
    }

    if (params.channel === "telegram") {
      const resolvedRoute = deps.resolveTelegramBoundRoute({
        tenantId: params.tenant.id,
        channel: params.channel,
        sessionKey: params.sessionKey,
        mode: params.mode,
        routeKeys: deps.listTelegramOutboundRouteKeys({
          requestedTo: params.requestedTo,
          requestedThreadId: params.requestedThreadId,
        }),
      });
      if (!resolvedRoute) {
        return {
          statusCode: 403,
          bodyText: JSON.stringify({
            ok: false,
            error: "route not bound",
            code: "ROUTE_NOT_BOUND",
          }),
        };
      }
      deps.metrics.recordOutboundRouteResolution({
        channel: "telegram",
        mode: params.mode ?? "session-first",
        via: resolvedRoute.via,
      });
      const boundRoute = resolvedRoute.route;
      const body: Record<string, unknown> = {
        chat_id: boundRoute.chatId,
        action: "typing",
      };
      if (boundRoute.topicId) {
        body.message_thread_id = boundRoute.topicId;
      }
      const { response, result } = await deps.sendTelegram("sendChatAction", body);
      if (!response.ok || result.ok !== true) {
        return {
          statusCode: 502,
          bodyText: JSON.stringify({ ok: false, error: "telegram typing failed", details: result }),
        };
      }
      return {
        statusCode: 200,
        bodyText: JSON.stringify({ ok: true }),
      };
    }

    if (params.channel === "discord") {
      const resolvedRoute = await deps.resolveDiscordBoundRoute({
        tenantId: params.tenant.id,
        channel: params.channel,
        sessionKey: params.sessionKey,
        mode: params.mode,
        routeKeys: await deps.listDiscordOutboundRouteKeys({
          requestedTo: params.requestedTo,
          requestedThreadId: params.requestedDiscordThreadId,
        }),
      });
      if (!resolvedRoute) {
        return {
          statusCode: 403,
          bodyText: JSON.stringify({
            ok: false,
            error: "route not bound",
            code: "ROUTE_NOT_BOUND",
          }),
        };
      }
      deps.metrics.recordOutboundRouteResolution({
        channel: "discord",
        mode: params.mode ?? "session-first",
        via: resolvedRoute.via,
      });
      const resolvedTarget = await deps.resolveDiscordOutboundChannelId({
        boundRoute: resolvedRoute.route,
        requestedTo: params.requestedTo,
        requestedThreadId: params.requestedDiscordThreadId,
      });
      if (!resolvedTarget.ok) {
        return {
          statusCode: resolvedTarget.statusCode,
          bodyText: JSON.stringify({ ok: false, error: resolvedTarget.error }),
        };
      }
      const { response, result } = await deps.sendDiscordTyping({
        channelId: resolvedTarget.channelId,
      });
      if (!response.ok) {
        return {
          statusCode: 502,
          bodyText: JSON.stringify({ ok: false, error: "discord typing failed", details: result }),
        };
      }
      return {
        statusCode: 200,
        bodyText: JSON.stringify({ ok: true }),
      };
    }

    if (params.channel === "whatsapp") {
      const resolvedRoute = deps.resolveWhatsAppBoundRoute({
        tenantId: params.tenant.id,
        channel: params.channel,
        sessionKey: params.sessionKey,
        mode: params.mode,
        routeKeys: deps.listWhatsAppOutboundRouteKeys({
          requestedTo: params.requestedTo,
          accountIds: [
            params.accountId,
            deps.config.whatsappAccountId,
            deps.config.openclawMuxAccountId,
          ],
        }),
      });
      if (!resolvedRoute) {
        return {
          statusCode: 403,
          bodyText: JSON.stringify({
            ok: false,
            error: "route not bound",
            code: "ROUTE_NOT_BOUND",
          }),
        };
      }
      deps.metrics.recordOutboundRouteResolution({
        channel: "whatsapp",
        mode: params.mode ?? "session-first",
        via: resolvedRoute.via,
      });
      try {
        const { sendTypingWhatsApp } = await deps.loadWebRuntimeModules();
        await sendTypingWhatsApp(resolvedRoute.route.chatJid, {
          accountId: resolvedRoute.route.accountId,
        });
      } catch (error) {
        return {
          statusCode: 502,
          bodyText: JSON.stringify({
            ok: false,
            error: "whatsapp typing failed",
            details: String(error),
          }),
        };
      }
      return {
        statusCode: 200,
        bodyText: JSON.stringify({ ok: true }),
      };
    }

    return {
      statusCode: 400,
      bodyText: JSON.stringify({ ok: false, error: "unsupported channel" }),
    };
  }

  async function runOutboundSend(params: {
    tenant: TenantIdentity;
    payload: MuxPayload;
  }): Promise<SendResult> {
    const { tenant, payload } = params;
    deps.log({
      type: "outbound_request",
      tenantId: tenant.id,
      tenantName: tenant.name,
      payload,
    });

    const channel = deps.normalizeChannel(payload.channel);
    const sessionKey = readNonEmptyString(payload.sessionKey);
    const operation = readOutboundOperation(payload);
    const rawOutbound = readOutboundRaw(payload);
    const { text, hasText } = readOutboundText(payload);
    const mediaUrls = collectOutboundMediaUrls(payload);
    const requestedThreadId = readPositiveInt(payload.threadId);
    const requestedDiscordThreadId = readUnsignedNumericString(payload.threadId);
    const payloadOpenClawId = readNonEmptyString(payload.openclawId);

    if (tenant.authKind === "runtime-jwt") {
      if (!payloadOpenClawId || payloadOpenClawId !== tenant.id) {
        deps.metrics.recordAuthFailure("tenant");
        deps.log({ type: "auth_unauthorized", surface: "tenant", reason: "openclaw_id_mismatch" });
        return {
          statusCode: 401,
          bodyText: JSON.stringify({
            ok: false,
            error: "openclawId mismatch",
          }),
        };
      }
    }

    if (!channel) {
      return {
        statusCode: 400,
        bodyText: JSON.stringify({ ok: false, error: "channel required" }),
      };
    }
    if (!sessionKey) {
      return {
        statusCode: 400,
        bodyText: JSON.stringify({ ok: false, error: "sessionKey required" }),
      };
    }
    if (operation.op === "action") {
      return await runOutboundAction({
        tenant,
        channel,
        sessionKey,
        action: operation.action,
        requestedTo: payload.to,
        requestedThreadId,
        requestedDiscordThreadId: requestedDiscordThreadId ?? undefined,
        accountId: readNonEmptyString(payload.accountId) ?? undefined,
        mode: deps.config.outboundResolutionMode,
      });
    }
    if (!hasText && mediaUrls.length === 0 && !rawOutbound) {
      return {
        statusCode: 400,
        bodyText: JSON.stringify({ ok: false, error: "text or mediaUrl(s) required" }),
      };
    }

    if (channel === "telegram") {
      const telegramRaw = asRecord(rawOutbound?.telegram);
      const telegramRawMethod = readNonEmptyString(telegramRaw?.method);
      const telegramRawBody = asRecord(telegramRaw?.body);
      const resolvedRoute = deps.resolveTelegramBoundRoute({
        tenantId: tenant.id,
        channel,
        sessionKey,
        mode: deps.config.outboundResolutionMode,
        routeKeys: deps.listTelegramOutboundRouteKeys({
          requestedTo: payload.to,
          rawBody: telegramRawBody ?? undefined,
          requestedThreadId,
        }),
      });
      if (!resolvedRoute) {
        return {
          statusCode: 403,
          bodyText: JSON.stringify({
            ok: false,
            error: "route not bound",
            code: "ROUTE_NOT_BOUND",
          }),
        };
      }
      deps.metrics.recordOutboundRouteResolution({
        channel: "telegram",
        mode: deps.config.outboundResolutionMode,
        via: resolvedRoute.via,
      });
      if (resolvedRoute.via === "route" && deps.config.outboundResolutionMode === "session-first") {
        deps.log({
          type: "outbound_route_fallback",
          tenantId: tenant.id,
          channel,
          sessionKey,
          routeKey: resolvedRoute.routeKey,
        });
      }

      const boundRoute = resolvedRoute.route;
      const to = boundRoute.chatId;
      const messageThreadId = boundRoute.topicId ?? requestedThreadId;
      const isGeneralForumTopic =
        boundRoute.topicId === deps.config.telegramGeneralTopicId && to.startsWith("-");
      if (telegramRawMethod && telegramRawBody) {
        const telegramMethod = deps.allowedTelegramMethods.has(telegramRawMethod)
          ? telegramRawMethod
          : null;
        if (!telegramMethod) {
          return {
            statusCode: 400,
            bodyText: JSON.stringify({
              ok: false,
              error: "unsupported telegram raw method",
            }),
          };
        }
        const noChatIdMethods = new Set([
          "answerCallbackQuery",
          "setMyCommands",
          "deleteMyCommands",
        ]);
        const threadIdMethods = new Set([
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
          "createForumTopic",
        ]);

        const finalBody: Record<string, unknown> = { ...telegramRawBody };
        if (!noChatIdMethods.has(telegramMethod)) {
          finalBody.chat_id = to;
          if (threadIdMethods.has(telegramMethod)) {
            if (boundRoute.topicId) {
              if (isGeneralForumTopic && telegramMethod !== "sendChatAction") {
                delete finalBody.message_thread_id;
              } else {
                finalBody.message_thread_id = boundRoute.topicId;
              }
            } else if (messageThreadId && !readPositiveInt(finalBody.message_thread_id)) {
              finalBody.message_thread_id = messageThreadId;
            }
          }
        }
        const { response, result } = await deps.sendTelegramWithFallbacks({
          method: telegramMethod,
          body: finalBody,
        });
        if (!response.ok || result.ok !== true) {
          if (!deps.isTelegramMessageNotModified(telegramMethod, result)) {
            return {
              statusCode: 502,
              bodyText: JSON.stringify({
                ok: false,
                error: "telegram raw send failed",
                details: result,
              }),
            };
          }
        }
        const resultData =
          typeof result.result === "object" && result.result
            ? (result.result as Record<string, unknown>)
            : {};
        const messageId =
          typeof resultData.message_id === "number" || typeof resultData.message_id === "string"
            ? String(resultData.message_id)
            : typeof finalBody.message_id === "number" || typeof finalBody.message_id === "string"
              ? String(finalBody.message_id)
              : "unknown";
        return {
          statusCode: 200,
          bodyText: JSON.stringify({
            ok: true,
            messageId,
            providerMessageIds: [messageId],
            rawPassthrough: true,
            ...(telegramRawMethod === "createForumTopic" &&
            typeof resultData.message_thread_id === "number"
              ? {
                  topicId: resultData.message_thread_id,
                  name:
                    typeof resultData.name === "string" && resultData.name.trim()
                      ? resultData.name.trim()
                      : undefined,
                }
              : {}),
          }),
        };
      }
      return {
        statusCode: 400,
        bodyText: JSON.stringify({
          ok: false,
          error: "telegram outbound requires raw.telegram.method and raw.telegram.body",
        }),
      };
    }

    if (channel === "discord") {
      const discordRaw = asRecord(rawOutbound?.discord);
      const discordRawBody = asRecord(discordRaw?.body);
      const discordRawSend = asRecord(discordRaw?.send);
      const resolvedRoute = await deps.resolveDiscordBoundRoute({
        tenantId: tenant.id,
        channel,
        sessionKey,
        mode: deps.config.outboundResolutionMode,
        routeKeys: await deps.listDiscordOutboundRouteKeys({
          requestedTo: payload.to,
          requestedThreadId: requestedDiscordThreadId ?? undefined,
        }),
      });
      if (!resolvedRoute) {
        return {
          statusCode: 403,
          bodyText: JSON.stringify({
            ok: false,
            error: "route not bound",
            code: "ROUTE_NOT_BOUND",
          }),
        };
      }
      deps.metrics.recordOutboundRouteResolution({
        channel: "discord",
        mode: deps.config.outboundResolutionMode,
        via: resolvedRoute.via,
      });
      if (resolvedRoute.via === "route" && deps.config.outboundResolutionMode === "session-first") {
        deps.log({
          type: "outbound_route_fallback",
          tenantId: tenant.id,
          channel,
          sessionKey,
          routeKey: resolvedRoute.routeKey,
        });
      }

      if (!discordRawBody && !discordRawSend) {
        return {
          statusCode: 400,
          bodyText: JSON.stringify({
            ok: false,
            error: "discord outbound requires raw.discord.body or raw.discord.send",
          }),
        };
      }

      const resolvedTarget = await deps.resolveDiscordOutboundChannelId({
        boundRoute: resolvedRoute.route,
        requestedTo: payload.to,
        requestedThreadId: requestedDiscordThreadId ?? undefined,
      });
      if (!resolvedTarget.ok) {
        return {
          statusCode: resolvedTarget.statusCode,
          bodyText: JSON.stringify({ ok: false, error: resolvedTarget.error }),
        };
      }
      if (discordRawBody) {
        const { response, result } = await deps.discordRequest({
          method: "POST",
          path: `/channels/${resolvedTarget.channelId}/messages`,
          body: discordRawBody,
        });
        if (!response.ok) {
          return {
            statusCode: 502,
            bodyText: JSON.stringify({
              ok: false,
              error: "discord raw send failed",
              details: result,
            }),
          };
        }
        const messageId = readUnsignedNumericString(result.id) ?? "unknown";
        const channelId = readUnsignedNumericString(result.channel_id) ?? resolvedTarget.channelId;
        return {
          statusCode: 200,
          bodyText: JSON.stringify({
            ok: true,
            messageId,
            channelId,
            providerMessageIds: [messageId],
            rawPassthrough: true,
          }),
        };
      }

      const { sendMessageDiscord } = await deps.loadDiscordRuntimeModules();
      const outboundTarget = `channel:${resolvedTarget.channelId}`;
      const sendText =
        typeof discordRawSend?.text === "string"
          ? discordRawSend.text
          : typeof text === "string"
            ? text
            : "";
      const sendMediaUrl =
        readNonEmptyString(discordRawSend?.mediaUrl) ??
        (mediaUrls.length > 0 ? mediaUrls[0] : undefined);
      const sendReplyTo = readUnsignedNumericString(discordRawSend?.replyTo);
      const discordToken = deps.requireDiscordBotToken();
      const discordRest = new RequestClient(discordToken, {
        baseUrl: deps.config.discordApiBaseUrl,
        apiVersion: 10,
      });
      try {
        const sent = await sendMessageDiscord(outboundTarget, sendText, {
          token: discordToken,
          rest: discordRest,
          verbose: false,
          ...(sendMediaUrl ? { mediaUrl: sendMediaUrl } : {}),
          ...(sendReplyTo ? { replyTo: sendReplyTo } : {}),
        });
        const messageId = sent.messageId || "unknown";
        const channelId = sent.channelId || resolvedTarget.channelId;
        return {
          statusCode: 200,
          bodyText: JSON.stringify({
            ok: true,
            messageId,
            channelId,
            providerMessageIds: [messageId],
            rawPassthrough: true,
          }),
        };
      } catch (error) {
        return {
          statusCode: 502,
          bodyText: JSON.stringify({
            ok: false,
            error: "discord send failed",
            details: String(error),
          }),
        };
      }
    }

    if (channel === "whatsapp") {
      const whatsappRaw = asRecord(rawOutbound?.whatsapp);
      const whatsappRawSend = asRecord(whatsappRaw?.send);
      const resolvedRoute = deps.resolveWhatsAppBoundRoute({
        tenantId: tenant.id,
        channel,
        sessionKey,
        mode: deps.config.outboundResolutionMode,
        routeKeys: deps.listWhatsAppOutboundRouteKeys({
          requestedTo: payload.to,
          accountIds: [
            readNonEmptyString(payload.accountId),
            deps.config.whatsappAccountId,
            deps.config.openclawMuxAccountId,
          ],
          rawSend: whatsappRawSend ?? undefined,
        }),
      });
      if (!resolvedRoute) {
        return {
          statusCode: 403,
          bodyText: JSON.stringify({
            ok: false,
            error: "route not bound",
            code: "ROUTE_NOT_BOUND",
          }),
        };
      }
      deps.metrics.recordOutboundRouteResolution({
        channel: "whatsapp",
        mode: deps.config.outboundResolutionMode,
        via: resolvedRoute.via,
      });
      if (resolvedRoute.via === "route" && deps.config.outboundResolutionMode === "session-first") {
        deps.log({
          type: "outbound_route_fallback",
          tenantId: tenant.id,
          channel,
          sessionKey,
          routeKey: resolvedRoute.routeKey,
        });
      }
      const boundRoute = resolvedRoute.route;
      const whatsappText =
        typeof whatsappRawSend?.text === "string"
          ? whatsappRawSend.text
          : typeof text === "string"
            ? text
            : "";
      const whatsappRawSingleMedia = readNonEmptyString(whatsappRawSend?.mediaUrl);
      const whatsappRawMediaList =
        Array.isArray(whatsappRawSend?.mediaUrls) && whatsappRawSend
          ? (whatsappRawSend.mediaUrls as unknown[])
              .filter((item) => typeof item === "string")
              .map((item) => item.trim())
              .filter((item) => item.length > 0)
          : mediaUrls;
      const whatsappMediaUrls = (() => {
        const ordered = [
          ...(whatsappRawSingleMedia ? [whatsappRawSingleMedia] : []),
          ...whatsappRawMediaList,
        ];
        const seen = new Set<string>();
        const deduped: string[] = [];
        for (const media of ordered) {
          if (seen.has(media)) {
            continue;
          }
          seen.add(media);
          deduped.push(media);
        }
        return deduped;
      })();
      if (!whatsappText.trim() && whatsappMediaUrls.length === 0) {
        return {
          statusCode: 400,
          bodyText: JSON.stringify({
            ok: false,
            error: "whatsapp outbound requires text/media or raw.whatsapp.send",
          }),
        };
      }
      const whatsappGifPlayback = whatsappRawSend?.gifPlayback === true;

      const providerMessageIds: string[] = [];
      let firstMessageId = "unknown";
      let firstToJid = boundRoute.chatJid;
      try {
        const { sendMessageWhatsApp } = await deps.loadWebRuntimeModules();
        if (whatsappMediaUrls.length === 0) {
          const sent = await sendMessageWhatsApp(boundRoute.chatJid, whatsappText, {
            verbose: false,
            accountId: boundRoute.accountId,
          });
          firstMessageId = sent.messageId || "unknown";
          firstToJid = sent.toJid || boundRoute.chatJid;
          providerMessageIds.push(firstMessageId);
        } else {
          const first = await sendMessageWhatsApp(boundRoute.chatJid, whatsappText, {
            verbose: false,
            mediaUrl: whatsappMediaUrls[0],
            ...(whatsappGifPlayback ? { gifPlayback: true } : {}),
            accountId: boundRoute.accountId,
          });
          firstMessageId = first.messageId || "unknown";
          firstToJid = first.toJid || boundRoute.chatJid;
          providerMessageIds.push(firstMessageId);
          for (const extraMediaUrl of whatsappMediaUrls.slice(1)) {
            const extra = await sendMessageWhatsApp(boundRoute.chatJid, "", {
              verbose: false,
              mediaUrl: extraMediaUrl,
              ...(whatsappGifPlayback ? { gifPlayback: true } : {}),
              accountId: boundRoute.accountId,
            });
            providerMessageIds.push(extra.messageId || "unknown");
          }
        }
      } catch (error) {
        return {
          statusCode: 502,
          bodyText: JSON.stringify({
            ok: false,
            error: "whatsapp send failed",
            details: String(error),
          }),
        };
      }

      return {
        statusCode: 200,
        bodyText: JSON.stringify({
          ok: true,
          messageId: firstMessageId,
          toJid: firstToJid,
          providerMessageIds,
          rawPassthrough: Boolean(whatsappRawSend),
        }),
      };
    }

    if (channel === "imessage") {
      if (!deps.imessageApiService.getSdk()) {
        return {
          statusCode: 503,
          bodyText: JSON.stringify({ ok: false, error: "iMessage transport not connected" }),
        };
      }

      const imessageRaw = asRecord(rawOutbound?.imessage);
      const imessageRawSend = asRecord(imessageRaw?.send);
      const resolvedRoute = deps.resolveIMessageBoundRoute({
        tenantId: tenant.id,
        channel,
        sessionKey,
        mode: deps.config.outboundResolutionMode,
        routeKeys: deps.listIMessageOutboundRouteKeys({
          requestedTo: payload.to,
          rawSend: imessageRawSend ?? undefined,
        }),
      });
      if (!resolvedRoute) {
        return {
          statusCode: 403,
          bodyText: JSON.stringify({
            ok: false,
            error: "route not bound",
            code: "ROUTE_NOT_BOUND",
          }),
        };
      }
      deps.metrics.recordOutboundRouteResolution({
        channel: "imessage",
        mode: deps.config.outboundResolutionMode,
        via: resolvedRoute.via,
      });
      if (resolvedRoute.via === "route" && deps.config.outboundResolutionMode === "session-first") {
        deps.log({
          type: "outbound_route_fallback",
          tenantId: tenant.id,
          channel,
          sessionKey,
          routeKey: resolvedRoute.routeKey,
        });
      }

      const { chatGuid } = resolvedRoute.route;
      const replyToId = readNonEmptyString(payload.replyToId);
      const imessageText =
        typeof imessageRawSend?.text === "string"
          ? imessageRawSend.text
          : typeof text === "string"
            ? text
            : "";
      const imessageRawSingleMedia = readNonEmptyString(imessageRawSend?.mediaUrl);
      const imessageRawMediaList =
        Array.isArray(imessageRawSend?.mediaUrls) && imessageRawSend
          ? (imessageRawSend.mediaUrls as unknown[])
              .filter((item): item is string => typeof item === "string")
              .map((item) => item.trim())
              .filter((item) => item.length > 0)
          : mediaUrls;
      const imessageMediaUrls = (() => {
        const ordered = [
          ...(imessageRawSingleMedia ? [imessageRawSingleMedia] : []),
          ...imessageRawMediaList,
        ];
        const seen = new Set<string>();
        const deduped: string[] = [];
        for (const media of ordered) {
          if (seen.has(media)) {
            continue;
          }
          seen.add(media);
          deduped.push(media);
        }
        return deduped;
      })();

      if (!imessageText.trim() && imessageMediaUrls.length === 0) {
        return {
          statusCode: 400,
          bodyText: JSON.stringify({
            ok: false,
            error: "imessage outbound requires text/media or raw.imessage.send",
          }),
        };
      }

      // iMessage outbound is NOT a single atomic transaction: attachments and
      // text are separate SDK calls. If any earlier call succeeds and a later
      // one fails, a naive 502 would cause the caller to retry the entire
      // request — duplicating the media that already went through.
      //
      // Retry semantics:
      //   - If nothing succeeded -> return 502 (safe to retry).
      //   - If ANY send succeeded -> return 200 with partial=true. The
      //     providerMessageIds array surfaces exactly which sends landed so
      //     the caller can dedupe or skip the already-delivered parts on a
      //     follow-up request.
      //   - The caller is expected to treat partial=true responses as a
      //     terminal delivery for the listed providerMessageIds and decide at
      //     the application layer whether to resend the missing text.
      //
      // This matches the pragmatic choice other channels make when a single
      // logical send spans multiple provider RPCs (WhatsApp multi-media, etc.)
      // and the protocol doesn't offer batch atomicity.
      const providerMessageIds: string[] = [];
      let sendError: unknown = null;
      let failedStage: "media" | "text" | null = null;

      try {
        for (const [index, url] of imessageMediaUrls.entries()) {
          // Photon supports reply threading via selectedMessageGuid, which we
          // only apply to the FIRST send in a batch. A reply with multiple
          // attachments should thread the first send; subsequent sends are
          // continuation of the same reply and must not re-thread, or iOS
          // renders a separate quoted reply for each attachment.
          const sent = await deps.imessageApiService.sendAttachment({
            chatGuid,
            attachmentUrl: url,
            ...(replyToId && index === 0 ? { selectedMessageGuid: replyToId } : {}),
          });
          // The SDK may return guid=null even on success; record as "unknown" so
          // the successful send still counts toward providerMessageIds (prevents
          // caller retry duplication) — matches the text-send path below.
          providerMessageIds.push(sent.guid ?? "unknown");
        }
      } catch (error) {
        sendError = error;
        failedStage = "media";
      }

      if (!sendError && imessageText.trim()) {
        try {
          const sent = await deps.imessageApiService.sendMessage({
            chatGuid,
            message: imessageText,
            // Only thread the text send if no media preceded it — otherwise
            // the first attachment already carried the reply context and we
            // do not want a second quoted-reply bubble on iOS.
            ...(replyToId && imessageMediaUrls.length === 0
              ? { selectedMessageGuid: replyToId }
              : {}),
          });
          if (sent.guid) {
            providerMessageIds.push(sent.guid);
          } else {
            providerMessageIds.push("unknown");
          }
        } catch (error) {
          sendError = error;
          failedStage = "text";
        }
      }

      if (sendError && providerMessageIds.length === 0) {
        // Nothing landed — safe to fail; caller retry will not duplicate.
        // Pass through Photon's HTTP status when available: permanent 4xx
        // client errors (invalid chat, unauthorized, attachment too large)
        // must not be misreported as retryable 502s or the caller will
        // duplicate the failed send on its retry timer.
        const photonStatus = readIMessagePhotonStatus(sendError);
        const isClientError = photonStatus !== null && photonStatus >= 400 && photonStatus < 500;
        return {
          statusCode: isClientError ? photonStatus : 502,
          bodyText: JSON.stringify({
            ok: false,
            error: "imessage send failed",
            details: errorString(sendError),
            ...(failedStage ? { failedStage } : {}),
            ...(photonStatus !== null ? { photonStatus } : {}),
            ...(isClientError ? { retryable: false } : {}),
          }),
        };
      }

      if (providerMessageIds.length === 0) {
        return {
          statusCode: 502,
          bodyText: JSON.stringify({ ok: false, error: "imessage send returned no messageId" }),
        };
      }

      const partial = Boolean(sendError);
      if (partial) {
        deps.log({
          type: "imessage_outbound_partial_success",
          chatGuid,
          providerMessageIds,
          failedStage,
          error: errorString(sendError),
        });
      }

      const messageId = providerMessageIds[0] ?? "unknown";
      return {
        statusCode: 200,
        bodyText: JSON.stringify({
          ok: true,
          messageId,
          chatId: chatGuid,
          providerMessageIds,
          rawPassthrough: Boolean(imessageRawSend),
          ...(partial
            ? {
                partial: true,
                failedStage,
                partialError: errorString(sendError),
              }
            : {}),
        }),
      };
    }

    return {
      statusCode: 400,
      bodyText: JSON.stringify({ ok: false, error: "unsupported channel" }),
    };
  }

  return {
    runOutboundAction,
    runOutboundSend,
  };
}
