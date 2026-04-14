import type { ClaimResult, DiscordBoundRoute, StyledNotice } from "../domain/types.js";
import type { BotControlCommand } from "./notices.js";

type TelegramPairingMessage = {
  text?: string | null;
  caption?: string | null;
};

type WhatsAppPairingMessage = {
  body?: string | null;
};

export function createBotControlService(deps: {
  extractTokenFromStartCommand: (input: string) => string | null;
  normalizeControlText: (input: string | null) => string | null;
  extractPairingTokenFromText: (input: string | null) => string | null;
  renderPairingInvalidNotice: (channel: "telegram" | "discord" | "whatsapp") => StyledNotice;
  renderBotHelpNotice: (channel: "telegram" | "discord" | "whatsapp") => StyledNotice;
  renderBotUnpairSuccessNotice: (channel: "telegram" | "discord" | "whatsapp") => StyledNotice;
  renderBotNotPairedNotice: (channel: "telegram" | "discord" | "whatsapp") => StyledNotice;
  renderBotSwitchUsageNotice: (channel: "telegram" | "discord" | "whatsapp") => StyledNotice;
  renderBotStatusNotice: (params: {
    channel: "telegram" | "discord" | "whatsapp";
    paired: boolean;
    routeKey?: string;
    sessionKey?: string | null;
  }) => StyledNotice;
  resolveBindingSessionKey: (params: {
    tenantId: string;
    channel: "telegram" | "discord" | "whatsapp";
    bindingId: string;
  }) => string | null;
  peekActivePairingToken: (token: string) => unknown;
  claimTelegramPairingToken: (params: {
    token: string;
    chatId: string;
    topicId?: number;
    chatType: "direct" | "group";
  }) => ClaimResult | null;
  claimDiscordPairingToken: (params: {
    token: string;
    route: DiscordBoundRoute;
    channelId: string;
  }) => ClaimResult | null;
  claimWhatsAppPairingToken: (params: {
    token: string;
    chatJid: string;
    accountId: string;
    chatType: "direct" | "group";
    directPeerId?: string;
  }) => ClaimResult | null;
  parseDiscordRouteKey: (routeKey: string) => DiscordBoundRoute | null;
  deactivateLiveBinding: (params: {
    tenantId: string;
    bindingId: string;
    auditEventType: string;
  }) => boolean;
  setBindingPending: (params: {
    tenantId: string;
    bindingId: string;
    auditEventType: string;
  }) => boolean;
  sendPostClaimNotices: (params: {
    channel: "telegram" | "discord" | "whatsapp";
    claimed: ClaimResult;
    send: (notice: StyledNotice) => Promise<void>;
    fromId: string;
    chatId: string;
    chatType: "direct" | "group";
  }) => Promise<void>;
  sendTelegramPairingNotice: (params: {
    chatId: string;
    topicId?: number;
    text: string;
    parseMode?: "HTML";
  }) => Promise<void>;
  sendDiscordPairingNotice: (params: { channelId: string; text: string }) => Promise<void>;
  sendWhatsAppPairingNotice: (params: {
    chatJid: string;
    accountId: string;
    text: string;
  }) => Promise<void>;
}) {
  function extractPairingTokenFromTelegramMessage(message: TelegramPairingMessage): string | null {
    const rawText = typeof message.text === "string" ? message.text : undefined;
    const rawCaption = typeof message.caption === "string" ? message.caption : undefined;
    const text = deps.normalizeControlText(rawText ?? rawCaption ?? null);
    if (text === null) {
      return null;
    }
    const fromStart = deps.extractTokenFromStartCommand(text);
    if (fromStart && /^mpt_[A-Za-z0-9_-]{20,200}$/.test(fromStart)) {
      return fromStart;
    }
    const direct = text.match(/\b(mpt_[A-Za-z0-9_-]{20,200})\b/);
    return direct?.[1] ?? null;
  }

  function extractPairingTokenFromDiscordMessage(message: Record<string, unknown>): string | null {
    const text = typeof message.content === "string" ? message.content : null;
    return deps.extractPairingTokenFromText(text);
  }

  function extractPairingTokenFromWhatsAppMessage(message: WhatsAppPairingMessage): string | null {
    const text = typeof message.body === "string" ? message.body : null;
    return deps.extractPairingTokenFromText(text);
  }

  async function handleTelegramBotControlCommand(params: {
    command: BotControlCommand;
    chatId: string;
    topicId?: number;
    chatType: "direct" | "group";
    fromId: string;
    binding: { tenantId: string; bindingId: string; routeKey: string } | null;
  }) {
    const send = async (notice: StyledNotice) => {
      await deps.sendTelegramPairingNotice({
        chatId: params.chatId,
        topicId: params.topicId,
        text: notice.text,
        parseMode: notice.parseMode,
      });
    };

    if (params.command.kind === "help") {
      await send(deps.renderBotHelpNotice("telegram"));
      return;
    }
    if (params.command.kind === "status") {
      await send(
        deps.renderBotStatusNotice({
          channel: "telegram",
          paired: Boolean(params.binding),
          routeKey: params.binding?.routeKey,
          sessionKey: params.binding
            ? deps.resolveBindingSessionKey({
                tenantId: params.binding.tenantId,
                channel: "telegram",
                bindingId: params.binding.bindingId,
              })
            : null,
        }),
      );
      return;
    }
    if (params.command.kind === "unpair") {
      if (!params.binding) {
        await send(deps.renderBotNotPairedNotice("telegram"));
        return;
      }
      const removed = deps.deactivateLiveBinding({
        tenantId: params.binding.tenantId,
        bindingId: params.binding.bindingId,
        auditEventType: "pairing_unbound_by_bot",
      });
      await send(
        removed
          ? deps.renderBotUnpairSuccessNotice("telegram")
          : deps.renderBotNotPairedNotice("telegram"),
      );
      return;
    }
    if (!params.command.token) {
      await send(deps.renderBotSwitchUsageNotice("telegram"));
      return;
    }
    const tokenRow = deps.peekActivePairingToken(params.command.token);
    if (!tokenRow) {
      await send(deps.renderPairingInvalidNotice("telegram"));
      return;
    }
    if (params.binding) {
      deps.deactivateLiveBinding({
        tenantId: params.binding.tenantId,
        bindingId: params.binding.bindingId,
        auditEventType: "pairing_unbound_by_bot_switch",
      });
    }
    const claimed = deps.claimTelegramPairingToken({
      token: params.command.token,
      chatId: params.chatId,
      topicId: params.topicId,
      chatType: params.chatType,
    });
    if (!claimed) {
      await send(deps.renderPairingInvalidNotice("telegram"));
      return;
    }
    await deps.sendPostClaimNotices({
      channel: "telegram",
      claimed,
      send,
      fromId: params.fromId,
      chatId: params.chatId,
      chatType: params.chatType,
    });
  }

  async function handleDiscordBotControlCommand(params: {
    command: BotControlCommand;
    channelId: string;
    routeKey: string;
    fromId: string;
    tenantId: string;
    bindingId: string;
    status: "active" | "pending";
  }): Promise<{ routeReset: boolean; pending?: boolean }> {
    const send = async (notice: StyledNotice) => {
      await deps.sendDiscordPairingNotice({
        channelId: params.channelId,
        text: notice.text,
      });
    };

    if (params.command.kind === "help") {
      await send(deps.renderBotHelpNotice("discord"));
      return { routeReset: false };
    }
    if (params.command.kind === "status") {
      await send(
        deps.renderBotStatusNotice({
          channel: "discord",
          paired: params.status === "active",
          routeKey: params.routeKey,
          sessionKey:
            params.status === "active"
              ? deps.resolveBindingSessionKey({
                  tenantId: params.tenantId,
                  channel: "discord",
                  bindingId: params.bindingId,
                })
              : null,
        }),
      );
      return { routeReset: false };
    }
    if (params.command.kind === "unpair") {
      const removed = deps.setBindingPending({
        tenantId: params.tenantId,
        bindingId: params.bindingId,
        auditEventType: "pairing_unbound_by_bot",
      });
      await send(
        removed
          ? deps.renderBotUnpairSuccessNotice("discord")
          : deps.renderBotNotPairedNotice("discord"),
      );
      return { routeReset: false, pending: true };
    }
    if (!params.command.token) {
      await send(deps.renderBotSwitchUsageNotice("discord"));
      return { routeReset: false };
    }
    const tokenRow = deps.peekActivePairingToken(params.command.token);
    const route = deps.parseDiscordRouteKey(params.routeKey);
    if (!route || !tokenRow) {
      await send(deps.renderPairingInvalidNotice("discord"));
      return { routeReset: false };
    }
    deps.deactivateLiveBinding({
      tenantId: params.tenantId,
      bindingId: params.bindingId,
      auditEventType: "pairing_unbound_by_bot_switch",
    });
    const claimed = deps.claimDiscordPairingToken({
      token: params.command.token,
      route,
      channelId: params.channelId,
    });
    if (!claimed) {
      await send(deps.renderPairingInvalidNotice("discord"));
      return { routeReset: false };
    }
    await deps.sendPostClaimNotices({
      channel: "discord",
      claimed,
      send,
      fromId: params.fromId,
      chatId: params.channelId,
      chatType: route.kind === "dm" ? "direct" : "group",
    });
    return { routeReset: true, pending: false };
  }

  async function handleDiscordBotControlCommandUnbound(params: {
    command: BotControlCommand;
    channelId: string;
    routeKey: string;
    fromId: string;
  }): Promise<void> {
    const send = async (notice: StyledNotice) => {
      await deps.sendDiscordPairingNotice({
        channelId: params.channelId,
        text: notice.text,
      });
    };

    if (params.command.kind === "help") {
      await send(deps.renderBotHelpNotice("discord"));
      return;
    }
    if (params.command.kind === "status") {
      await send(
        deps.renderBotStatusNotice({
          channel: "discord",
          paired: false,
          routeKey: params.routeKey,
          sessionKey: null,
        }),
      );
      return;
    }
    if (params.command.kind === "unpair") {
      await send(deps.renderBotNotPairedNotice("discord"));
      return;
    }
    if (!params.command.token) {
      await send(deps.renderBotSwitchUsageNotice("discord"));
      return;
    }
    const tokenRow = deps.peekActivePairingToken(params.command.token);
    const route = deps.parseDiscordRouteKey(params.routeKey);
    if (!route || !tokenRow) {
      await send(deps.renderPairingInvalidNotice("discord"));
      return;
    }
    const claimed = deps.claimDiscordPairingToken({
      token: params.command.token,
      route,
      channelId: params.channelId,
    });
    if (!claimed) {
      await send(deps.renderPairingInvalidNotice("discord"));
      return;
    }
    await deps.sendPostClaimNotices({
      channel: "discord",
      claimed,
      send,
      fromId: params.fromId,
      chatId: params.channelId,
      chatType: route.kind === "dm" ? "direct" : "group",
    });
  }

  async function handleWhatsAppBotControlCommand(params: {
    command: BotControlCommand;
    chatJid: string;
    accountId: string;
    chatType: "direct" | "group";
    fromId: string;
    directPeerId?: string;
    binding: { tenantId: string; bindingId: string; routeKey: string } | null;
  }) {
    const send = async (notice: StyledNotice) => {
      await deps.sendWhatsAppPairingNotice({
        chatJid: params.chatJid,
        accountId: params.accountId,
        text: notice.text,
      });
    };

    if (params.command.kind === "help") {
      await send(deps.renderBotHelpNotice("whatsapp"));
      return;
    }
    if (params.command.kind === "status") {
      await send(
        deps.renderBotStatusNotice({
          channel: "whatsapp",
          paired: Boolean(params.binding),
          routeKey: params.binding?.routeKey,
          sessionKey: params.binding
            ? deps.resolveBindingSessionKey({
                tenantId: params.binding.tenantId,
                channel: "whatsapp",
                bindingId: params.binding.bindingId,
              })
            : null,
        }),
      );
      return;
    }
    if (params.command.kind === "unpair") {
      if (!params.binding) {
        await send(deps.renderBotNotPairedNotice("whatsapp"));
        return;
      }
      const removed = deps.deactivateLiveBinding({
        tenantId: params.binding.tenantId,
        bindingId: params.binding.bindingId,
        auditEventType: "pairing_unbound_by_bot",
      });
      await send(
        removed
          ? deps.renderBotUnpairSuccessNotice("whatsapp")
          : deps.renderBotNotPairedNotice("whatsapp"),
      );
      return;
    }
    if (!params.command.token) {
      await send(deps.renderBotSwitchUsageNotice("whatsapp"));
      return;
    }
    const tokenRow = deps.peekActivePairingToken(params.command.token);
    if (!tokenRow) {
      await send(deps.renderPairingInvalidNotice("whatsapp"));
      return;
    }
    if (params.binding) {
      deps.deactivateLiveBinding({
        tenantId: params.binding.tenantId,
        bindingId: params.binding.bindingId,
        auditEventType: "pairing_unbound_by_bot_switch",
      });
    }
    const claimed = deps.claimWhatsAppPairingToken({
      token: params.command.token,
      chatJid: params.chatJid,
      accountId: params.accountId,
      chatType: params.chatType,
      directPeerId: params.directPeerId,
    });
    if (!claimed) {
      await send(deps.renderPairingInvalidNotice("whatsapp"));
      return;
    }
    await deps.sendPostClaimNotices({
      channel: "whatsapp",
      claimed,
      send,
      fromId: params.fromId,
      chatId: params.chatJid,
      chatType: params.chatType,
    });
  }

  return {
    extractPairingTokenFromTelegramMessage,
    extractPairingTokenFromDiscordMessage,
    extractPairingTokenFromWhatsAppMessage,
    handleTelegramBotControlCommand,
    handleDiscordBotControlCommand,
    handleDiscordBotControlCommandUnbound,
    handleWhatsAppBotControlCommand,
  };
}
