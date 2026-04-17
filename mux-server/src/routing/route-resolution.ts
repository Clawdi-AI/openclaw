import type {
  DiscordBoundRoute,
  ExistingBindingRow,
  OutboundResolutionMode,
  SessionRouteBindingRow,
  SessionRouteByBindingRow,
} from "../domain/types.js";
import { asRecord, readNonEmptyString, readUnsignedNumericString } from "../domain/values.js";
import {
  buildDiscordDmRouteKey,
  buildDiscordGuildRouteKey,
  buildDiscordRouteKey,
  buildDiscordThreadScopedSessionKey,
  buildTelegramRouteKey,
  deriveTelegramSessionKey,
  parseDiscordOutboundTarget,
  uniqueRouteKeys,
} from "./keys.js";

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

export function normalizeChannel(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  return value.trim().toLowerCase();
}

export function readRouteKeyFromSessionContext(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    const record = asRecord(parsed);
    return readNonEmptyString(record?.routeKey) ?? null;
  } catch {
    return null;
  }
}

export function resolveBoundRouteKeyFromSession(row: SessionRouteBindingRow): string {
  return readRouteKeyFromSessionContext(row.channel_context_json) ?? String(row.route_key);
}

export function createRouteResolutionHelpers(deps: {
  stmtListSessionRoutesByBinding: {
    all: (
      tenantId: string,
      channel: "telegram" | "discord" | "whatsapp" | "imessage",
      bindingId: string,
    ) => SessionRouteByBindingRow[];
  };
  stmtSelectSessionKeyByBinding: {
    get: (
      tenantId: string,
      channel: "telegram" | "discord" | "whatsapp" | "imessage",
      bindingId: string,
    ) => { session_key?: unknown } | undefined;
  };
  stmtResolveSessionRouteBinding: {
    get: (
      tenantId: string,
      channel: "telegram" | "discord" | "whatsapp" | "imessage",
      sessionKey: string,
    ) => Record<string, unknown> | undefined;
  };
  stmtSelectActiveBindingByTenantAndRoute: {
    get: (
      tenantId: string,
      channel: "telegram" | "discord" | "whatsapp" | "imessage",
      routeKey: string,
    ) => Record<string, unknown> | undefined;
  };
  resolveDiscordChannelInfo: (channelId: string) => Promise<{
    guildId?: string | null;
    parentId?: string | null;
  }>;
  deriveDiscordSessionKey: (params: {
    route: DiscordBoundRoute;
    channelId: string;
    agentId?: string;
  }) => string;
}) {
  function resolveSessionKeyForBindingRoute(params: {
    tenantId: string;
    channel: "telegram" | "discord" | "whatsapp" | "imessage";
    bindingId: string;
    routeKey: string;
  }): string | null {
    const rows = deps.stmtListSessionRoutesByBinding.all(
      params.tenantId,
      params.channel,
      params.bindingId,
    );
    for (const row of rows) {
      const sessionKey = readNonEmptyString(row.session_key);
      if (!sessionKey) {
        continue;
      }
      const routeKey = readRouteKeyFromSessionContext(row.channel_context_json);
      if (routeKey === params.routeKey) {
        return sessionKey;
      }
    }
    return null;
  }

  function resolveLatestSessionKeyForBinding(params: {
    tenantId: string;
    channel: "telegram" | "discord" | "whatsapp" | "imessage";
    bindingId: string;
  }): string | null {
    const row = deps.stmtSelectSessionKeyByBinding.get(
      params.tenantId,
      params.channel,
      params.bindingId,
    );
    return readNonEmptyString(row?.session_key);
  }

  function resolveTelegramInboundSessionKey(params: {
    tenantId: string;
    bindingId: string;
    chatId: string;
    topicId?: number;
  }): string {
    const incomingRouteKey = buildTelegramRouteKey(params.chatId, params.topicId);
    const exactSessionKey = resolveSessionKeyForBindingRoute({
      tenantId: params.tenantId,
      channel: "telegram",
      bindingId: params.bindingId,
      routeKey: incomingRouteKey,
    });
    if (exactSessionKey) {
      return exactSessionKey;
    }

    if (params.topicId) {
      const chatRouteKey = buildTelegramRouteKey(params.chatId);
      const chatSessionKey =
        resolveSessionKeyForBindingRoute({
          tenantId: params.tenantId,
          channel: "telegram",
          bindingId: params.bindingId,
          routeKey: chatRouteKey,
        }) ??
        resolveLatestSessionKeyForBinding({
          tenantId: params.tenantId,
          channel: "telegram",
          bindingId: params.bindingId,
        }) ??
        deriveTelegramSessionKey(params.chatId);
      return buildThreadScopedSessionKey(chatSessionKey, params.chatId, params.topicId);
    }

    const chatRouteKey = buildTelegramRouteKey(params.chatId);
    return (
      resolveSessionKeyForBindingRoute({
        tenantId: params.tenantId,
        channel: "telegram",
        bindingId: params.bindingId,
        routeKey: chatRouteKey,
      }) ??
      resolveLatestSessionKeyForBinding({
        tenantId: params.tenantId,
        channel: "telegram",
        bindingId: params.bindingId,
      }) ??
      deriveTelegramSessionKey(params.chatId)
    );
  }

  function resolveDiscordInboundSessionKey(params: {
    tenantId: string;
    bindingId: string;
    route: DiscordBoundRoute;
    channelId: string;
  }): string {
    const incomingRouteKey = buildDiscordRouteKey(params.route);
    const exactSessionKey = resolveSessionKeyForBindingRoute({
      tenantId: params.tenantId,
      channel: "discord",
      bindingId: params.bindingId,
      routeKey: incomingRouteKey,
    });
    if (exactSessionKey) {
      return exactSessionKey;
    }

    if (params.route.kind === "guild" && params.route.threadId) {
      const anchorRouteKey = params.route.channelId
        ? buildDiscordGuildRouteKey({
            guildId: params.route.guildId,
            channelId: params.route.channelId,
          })
        : null;
      const anchorSessionKey =
        (anchorRouteKey
          ? resolveSessionKeyForBindingRoute({
              tenantId: params.tenantId,
              channel: "discord",
              bindingId: params.bindingId,
              routeKey: anchorRouteKey,
            })
          : null) ??
        resolveLatestSessionKeyForBinding({
          tenantId: params.tenantId,
          channel: "discord",
          bindingId: params.bindingId,
        }) ??
        deps.deriveDiscordSessionKey({
          route: {
            kind: "guild",
            guildId: params.route.guildId,
            ...(params.route.channelId ? { channelId: params.route.channelId } : {}),
          },
          channelId: params.route.channelId ?? params.channelId,
        });
      return buildDiscordThreadScopedSessionKey(anchorSessionKey, params.route.threadId);
    }

    return deps.deriveDiscordSessionKey({
      route: params.route,
      channelId: params.channelId,
    });
  }

  function resolveRouteKeyBySession(params: {
    tenantId: string;
    channel: "telegram" | "discord" | "whatsapp" | "imessage";
    sessionKey: string;
  }): string | null {
    const exactRow = deps.stmtResolveSessionRouteBinding.get(
      params.tenantId,
      params.channel,
      params.sessionKey,
    );
    return exactRow ? resolveBoundRouteKeyFromSession(exactRow as SessionRouteBindingRow) : null;
  }

  function resolveRouteKeyByTarget(params: {
    tenantId: string;
    channel: "telegram" | "discord" | "whatsapp" | "imessage";
    routeKeys?: string[];
  }): string | null {
    for (const routeKey of uniqueRouteKeys(params.routeKeys ?? [])) {
      const row = deps.stmtSelectActiveBindingByTenantAndRoute.get(
        params.tenantId,
        params.channel,
        routeKey,
      ) as ExistingBindingRow | undefined;
      if (!row?.binding_id || row.status !== "active") {
        continue;
      }
      return routeKey;
    }
    return null;
  }

  function resolveSessionRouteBinding(params: {
    tenantId: string;
    channel: "telegram" | "discord" | "whatsapp" | "imessage";
    sessionKey: string;
    routeKeys?: string[];
    mode?: OutboundResolutionMode;
  }): { routeKey: string; via: "session" | "route" } | null {
    const mode = params.mode ?? "session-first";
    if (mode === "target-first") {
      const routeKey = resolveRouteKeyByTarget(params);
      if (routeKey) {
        return { routeKey, via: "route" };
      }
      const exactRouteKey = resolveRouteKeyBySession(params);
      if (exactRouteKey) {
        return { routeKey: exactRouteKey, via: "session" };
      }
      return null;
    }

    const exactRouteKey = resolveRouteKeyBySession(params);
    if (exactRouteKey) {
      return { routeKey: exactRouteKey, via: "session" };
    }
    const routeKey = resolveRouteKeyByTarget(params);
    if (routeKey) {
      return { routeKey, via: "route" };
    }

    return null;
  }

  async function hasDiscordOutboundTargetConflict(params: {
    requestedTo?: unknown;
    requestedThreadId?: string;
  }): Promise<boolean> {
    const target = parseDiscordOutboundTarget(params.requestedTo);
    const threadId = readUnsignedNumericString(params.requestedThreadId);
    if (!target || !threadId) {
      return false;
    }
    if (target.kind === "user") {
      return true;
    }
    if (target.id === threadId) {
      return false;
    }
    try {
      const threadInfo = await deps.resolveDiscordChannelInfo(threadId);
      return threadInfo.parentId !== target.id;
    } catch {
      return false;
    }
  }

  async function listDiscordOutboundRouteKeys(params: {
    requestedTo?: unknown;
    requestedThreadId?: string;
  }): Promise<string[]> {
    if (await hasDiscordOutboundTargetConflict(params)) {
      return [];
    }
    const threadId = readUnsignedNumericString(params.requestedThreadId);
    if (threadId) {
      try {
        const info = await deps.resolveDiscordChannelInfo(threadId);
        if (info.guildId) {
          return uniqueRouteKeys([
            info.parentId
              ? buildDiscordGuildRouteKey({
                  guildId: info.guildId,
                  channelId: info.parentId,
                  threadId,
                })
              : null,
            buildDiscordGuildRouteKey({ guildId: info.guildId, threadId }),
            info.parentId
              ? buildDiscordGuildRouteKey({
                  guildId: info.guildId,
                  channelId: info.parentId,
                })
              : null,
            buildDiscordGuildRouteKey({ guildId: info.guildId }),
          ]);
        }
      } catch {
        // Fall through to target-based lookup below.
      }
    }

    const target = parseDiscordOutboundTarget(params.requestedTo);
    if (!target) {
      return [];
    }
    if (target.kind === "user") {
      return [buildDiscordDmRouteKey(target.id)];
    }

    try {
      const info = await deps.resolveDiscordChannelInfo(target.id);
      if (!info.guildId) {
        return [];
      }
      if (info.parentId) {
        return uniqueRouteKeys([
          buildDiscordGuildRouteKey({
            guildId: info.guildId,
            channelId: info.parentId,
            threadId: target.id,
          }),
          buildDiscordGuildRouteKey({ guildId: info.guildId, threadId: target.id }),
          buildDiscordGuildRouteKey({ guildId: info.guildId, channelId: info.parentId }),
          buildDiscordGuildRouteKey({ guildId: info.guildId }),
        ]);
      }
      return uniqueRouteKeys([
        buildDiscordGuildRouteKey({ guildId: info.guildId, channelId: target.id }),
        buildDiscordGuildRouteKey({ guildId: info.guildId }),
      ]);
    } catch {
      return [];
    }
  }

  return {
    resolveSessionKeyForBindingRoute,
    resolveLatestSessionKeyForBinding,
    resolveTelegramInboundSessionKey,
    resolveDiscordInboundSessionKey,
    resolveRouteKeyBySession,
    resolveRouteKeyByTarget,
    resolveSessionRouteBinding,
    listDiscordOutboundRouteKeys,
  };
}
