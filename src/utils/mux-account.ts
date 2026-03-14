import type { OpenClawConfig } from "../config/config.js";
import { resolveDefaultDiscordAccountId } from "../discord/accounts.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { resolveDefaultTelegramAccountId } from "../telegram/accounts.js";
import { resolveDefaultWhatsAppAccountId } from "../web/accounts.js";
import { normalizeAccountId } from "./account-id.js";

export type MuxBusinessChannel = "discord" | "telegram" | "whatsapp";

export const LEGACY_MUX_ACCOUNT_ID = "mux";

export function isMuxBusinessChannel(value: string): value is MuxBusinessChannel {
  return value === "discord" || value === "telegram" || value === "whatsapp";
}

export function isLegacyMuxAccountId(value?: string | null): boolean {
  return normalizeAccountId(value ?? undefined) === LEGACY_MUX_ACCOUNT_ID;
}

export function resolveDefaultMuxBusinessAccountId(params: {
  cfg: OpenClawConfig;
  channel: MuxBusinessChannel;
}): string {
  const defaultAccountId =
    params.channel === "telegram"
      ? resolveDefaultTelegramAccountId(params.cfg)
      : params.channel === "discord"
        ? resolveDefaultDiscordAccountId(params.cfg)
        : resolveDefaultWhatsAppAccountId(params.cfg);
  return defaultAccountId === LEGACY_MUX_ACCOUNT_ID ? DEFAULT_ACCOUNT_ID : defaultAccountId;
}

export function resolveMuxBusinessAccountId(params: {
  cfg: OpenClawConfig;
  channel: MuxBusinessChannel;
  accountId?: string | null;
}): string {
  void params.accountId;
  // Mux is a singleton transport mounted on the channel's default business
  // account. We intentionally ignore non-default account ids here so mux
  // follows the vanilla single-account path.
  return resolveDefaultMuxBusinessAccountId(params);
}
