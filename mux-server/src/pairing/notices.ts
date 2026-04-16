import type { NoticeChannel, StyledNotice } from "../domain/types.js";
import { normalizeControlText, readNonEmptyString } from "../domain/values.js";

export type BotControlCommand =
  | {
      kind: "help";
    }
  | {
      kind: "status";
    }
  | {
      kind: "unpair";
    }
  | {
      kind: "switch";
      token?: string;
    };

type NoticeKey = "pairingRepaired" | "pairingTakeover" | "whatsappContactTip" | "postPairingPrompt";

export function createPairingNotices(deps: {
  pairingSuccessTextOverride: string | null;
  pairingInvalidTextOverride: string | null;
  botControlHelpTextOverride: string | null;
  botUnpairSuccessTextOverride: string | null;
  botNotPairedTextOverride: string | null;
  botSwitchUsageTextOverride: string | null;
  configuredUnpairedHintText: string | null;
  getNoticeText: (key: NoticeKey) => string | null;
}) {
  function extractTokenFromStartCommand(input: string): string | null {
    const match = input.match(/^\/start(?:@[A-Za-z0-9_]+)?(?:\s+(.+))?$/i);
    if (!match) {
      return null;
    }
    return readNonEmptyString(match[1]);
  }

  function extractPairingTokenFromText(input: string | null): string | null {
    const normalized = normalizeControlText(input);
    if (!normalized) {
      return null;
    }
    const direct = normalized.match(/\b(mpt_[A-Za-z0-9_-]{20,200})\b/);
    return direct?.[1] ?? null;
  }

  function parseBotControlCommand(input: string | null): BotControlCommand | null {
    const normalized = normalizeControlText(input);
    if (!normalized) {
      return null;
    }
    const match = normalized.match(
      /^[/!](bot_help|bot_status|bot_unpair|bot_switch)(?:@[A-Za-z0-9_]+)?(?:\s+(.*))?$/i,
    );
    if (!match?.[1]) {
      return null;
    }
    const command = match[1].toLowerCase();
    if (command === "bot_help") {
      return { kind: "help" };
    }
    if (command === "bot_status") {
      return { kind: "status" };
    }
    if (command === "bot_unpair") {
      return { kind: "unpair" };
    }
    const arg = normalizeControlText(match[2] ?? null);
    const token = extractPairingTokenFromText(arg);
    return { kind: "switch", ...(token ? { token } : {}) };
  }

  function escapeTelegramHtml(value: string): string {
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  }

  function styleBold(channel: NoticeChannel, text: string): string {
    if (channel === "telegram") {
      return `<b>${escapeTelegramHtml(text)}</b>`;
    }
    return `**${text}**`;
  }

  function styleCode(channel: NoticeChannel, text: string): string {
    if (channel === "telegram") {
      return `<code>${escapeTelegramHtml(text)}</code>`;
    }
    return `\`${text}\``;
  }

  function styleText(channel: NoticeChannel, text: string): string {
    return channel === "telegram" ? escapeTelegramHtml(text) : text;
  }

  function buildStyledNotice(channel: NoticeChannel, lines: string[]): StyledNotice {
    if (channel === "telegram") {
      return { text: lines.join("\n"), parseMode: "HTML" };
    }
    return { text: lines.join("\n") };
  }

  function convertConfigNotice(channel: NoticeChannel, text: string): StyledNotice {
    if (channel === "telegram") {
      const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const converted = escaped
        .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
        .replace(/`(.+?)`/g, "<code>$1</code>");
      return { text: converted, parseMode: "HTML" };
    }
    return { text };
  }

  function renderPairingSuccessNotice(channel: NoticeChannel): StyledNotice {
    if (deps.pairingSuccessTextOverride) {
      return { text: deps.pairingSuccessTextOverride };
    }
    return buildStyledNotice(channel, [
      styleBold(channel, "Paired successfully"),
      "",
      "You can chat now.",
    ]);
  }

  function renderPairingInvalidNotice(channel: NoticeChannel): StyledNotice {
    if (deps.pairingInvalidTextOverride) {
      return { text: deps.pairingInvalidTextOverride };
    }
    return buildStyledNotice(channel, [
      styleBold(channel, "Pairing link is invalid or expired"),
      "",
      "Request a new link from your dashboard.",
    ]);
  }

  function renderBotHelpNotice(channel: NoticeChannel): StyledNotice {
    if (deps.botControlHelpTextOverride) {
      return { text: deps.botControlHelpTextOverride };
    }
    const command = (value: string): string =>
      channel === "telegram" ? styleText(channel, value) : styleCode(channel, value);
    return buildStyledNotice(channel, [
      styleBold(channel, "Bot control commands"),
      "",
      `• ${command("/bot_help")} - Show bot control help.`,
      `• ${command("/bot_status")} - Show current pairing status.`,
      `• ${command("/bot_unpair")} - Unlink this chat from OpenClaw.`,
      `• ${command("/bot_switch <token>")} - Switch this chat to another OpenClaw.`,
      "",
      `After pairing, ${command("/help")} is provided by your OpenClaw instance.`,
    ]);
  }

  function renderBotUnpairSuccessNotice(channel: NoticeChannel): StyledNotice {
    if (deps.botUnpairSuccessTextOverride) {
      return { text: deps.botUnpairSuccessTextOverride };
    }
    return buildStyledNotice(channel, [
      styleBold(channel, "Unpaired successfully"),
      "",
      `Use ${styleCode(channel, "/bot_switch <token>")} to pair again.`,
    ]);
  }

  function renderBotNotPairedNotice(channel: NoticeChannel): StyledNotice {
    if (deps.botNotPairedTextOverride) {
      return { text: deps.botNotPairedTextOverride };
    }
    return buildStyledNotice(channel, [
      styleBold(channel, "This chat is not paired yet"),
      "",
      `Use ${styleCode(channel, "/bot_switch <token>")} to pair this chat.`,
    ]);
  }

  function renderBotSwitchUsageNotice(channel: NoticeChannel): StyledNotice {
    if (deps.botSwitchUsageTextOverride) {
      return { text: deps.botSwitchUsageTextOverride };
    }
    return buildStyledNotice(channel, [
      `Usage: ${styleCode(channel, "/bot_switch <pairing-token>")}`,
    ]);
  }

  function renderUnpairedHintNotice(channel: NoticeChannel): StyledNotice {
    if (deps.configuredUnpairedHintText) {
      return convertConfigNotice(channel, deps.configuredUnpairedHintText);
    }
    return buildStyledNotice(channel, [
      `Hi! I'm ${styleBold(channel, "Clawdi")} — your AI assistant.`,
      "",
      "To get started, pair this chat with your Clawdi account:",
      `Visit ${styleBold(channel, "clawdi.ai")} and connect this messenger from your dashboard.`,
    ]);
  }

  function renderPairingRepairedNotice(channel: NoticeChannel): StyledNotice {
    const override = deps.getNoticeText("pairingRepaired");
    if (override) {
      return convertConfigNotice(channel, override);
    }
    return buildStyledNotice(channel, [
      styleBold(channel, "Reconnected successfully"),
      "",
      "You can chat now.",
    ]);
  }

  function renderPairingTakeoverNotice(channel: NoticeChannel): StyledNotice {
    const override = deps.getNoticeText("pairingTakeover");
    if (override) {
      return convertConfigNotice(channel, override);
    }
    return buildStyledNotice(channel, [
      styleBold(channel, "Paired successfully"),
      "",
      "Your previous connection was closed. You're now connected to a new assistant.",
    ]);
  }

  function renderWhatsAppContactTip(channel: NoticeChannel): StyledNotice {
    const override = deps.getNoticeText("whatsappContactTip");
    if (override) {
      return convertConfigNotice(channel, override);
    }
    return buildStyledNotice(channel, [
      `${styleBold(channel, "Tip:")} Save this number to your contacts and give it a custom name — like your assistant's name or anything you'd like!`,
    ]);
  }

  function renderBotStatusNotice(params: {
    channel: NoticeChannel;
    paired: boolean;
    routeKey?: string;
    sessionKey?: string | null;
  }): StyledNotice {
    const channelLabel =
      params.channel === "telegram"
        ? "telegram"
        : params.channel === "discord"
          ? "discord"
          : "whatsapp";
    const lines = [
      styleBold(params.channel, "Bot status"),
      `Channel: ${styleText(params.channel, channelLabel)}`,
      `Paired: ${params.paired ? "yes" : "no"}`,
    ];
    const sessionKey = readNonEmptyString(params.sessionKey ?? null);
    if (sessionKey) {
      lines.push(`Session key: ${styleCode(params.channel, sessionKey)}`);
    }
    if (params.routeKey) {
      lines.push(`Route: ${styleCode(params.channel, params.routeKey)}`);
    }
    lines.push(
      params.paired
        ? `Use ${styleCode(params.channel, "/bot_unpair")} to unlink this chat.`
        : `Use ${styleCode(params.channel, "/bot_switch <token>")} to pair this chat.`,
    );
    return buildStyledNotice(params.channel, lines);
  }

  function resolvePostPairingPrompt(channel: NoticeChannel): string {
    const template =
      deps.getNoticeText("postPairingPrompt") ||
      "Hey, please introduce yourself in this way:\n- Understand who I am (user). If you don't know (e.g. it's called \"there\"), feel free to ask.\n- Then check what connector you have the access to using composio MCP tool (clawdi-mcp.COMPOSIO_SEARCH_TOOLS). It's ok to have no connection, but if there are some, you can tell me what I can do with the connectors.\n- If there are connectors, suggest me 3-4 compound multi-app automations. Each with one sentence, combining 2-3 apps to complete some potential useful tasks.\n- Otherwise, you can suggest me what the most popular connectors can do if I have them connected (Gmail, notion, drive, slack). Then it's a good opportunity to invite me to set up the connectors.\n- Ask me my background like name and role (occupation) if you don't know. Guide me to find out what I can do with you. You are so powerful. So you can do a lot of awesome things.\nReply me concisely and friendly within 100 words. Don't be verbose. We are in a conversation and feel free to explore it together with me.";
    const channelLabel =
      channel === "telegram" ? "Telegram" : channel === "discord" ? "Discord" : "WhatsApp";
    return template.replace(/\{\{channel\}\}/g, channelLabel);
  }

  return {
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
  };
}
