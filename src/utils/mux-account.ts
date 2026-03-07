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
  return normalizeAccountId(value ?? undefined)?.toLowerCase() === LEGACY_MUX_ACCOUNT_ID;
}

export function normalizeLegacyMuxAccountId(value?: string | null): string | undefined {
  const normalized = normalizeAccountId(value ?? undefined);
  if (!normalized || normalized.toLowerCase() === LEGACY_MUX_ACCOUNT_ID) {
    return undefined;
  }
  return normalized;
}

function normalizeResolvedDefaultAccountId(value: string): string {
  return isLegacyMuxAccountId(value) ? DEFAULT_ACCOUNT_ID : value;
}

function resolveMuxDefaultAccountId(params: {
  cfg: OpenClawConfig;
  channel: MuxBusinessChannel;
}): string {
  if (params.channel === "telegram") {
    return normalizeResolvedDefaultAccountId(resolveDefaultTelegramAccountId(params.cfg));
  }
  if (params.channel === "discord") {
    return normalizeResolvedDefaultAccountId(resolveDefaultDiscordAccountId(params.cfg));
  }
  return normalizeResolvedDefaultAccountId(resolveDefaultWhatsAppAccountId(params.cfg));
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
  return resolveMuxDefaultAccountId(params);
}

export function isMuxDefaultBusinessAccount(params: {
  cfg: OpenClawConfig;
  channel: MuxBusinessChannel;
  accountId?: string | null;
}): boolean {
  const normalized = normalizeLegacyMuxAccountId(params.accountId);
  if (!normalized) {
    return true;
  }
  return normalized === resolveMuxDefaultAccountId(params);
}
