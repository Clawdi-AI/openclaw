/**
 * Discord REST base URL resolver.
 *
 * Mirrors `extensions/telegram/src/fetch.ts:resolveTelegramApiBase` —
 * production defaults to real Discord; integration tests and
 * Discord-compatible proxies (msg-router's egress, etc.) can redirect
 * OpenClaw at a custom host.
 *
 * Resolution priority:
 *   1. `account.apiBaseUrl` — per-account override read from
 *      `channels.discord.accounts.<id>.apiBaseUrl`. Lets a single
 *      agent run a platform-routed default account (msg-router) AND
 *      a customer-supplied custom account (real discord.com) at the
 *      same time, mirroring Telegram's per-account `apiRoot`.
 *   2. `DISCORD_BOT_API_BASE_URL` env var — process-wide override
 *      (legacy + integration test use). Applies to all Discord
 *      accounts in the agent process; no per-account differentiation.
 *   3. Default `https://discord.com`.
 *
 * Downstream, the resolved URL is:
 *   - passed to Carbon's `RequestClient` as `{ baseUrl }`
 *   - used by the gateway plugin to build the `/api/v10/gateway/bot`
 *     metadata URL; the returned `url` field becomes the WebSocket
 *     gateway URL, so a custom REST host that answers `/gateway/bot`
 *     also controls where the gateway connects.
 */

const DEFAULT_DISCORD_API_BASE_URL = "https://discord.com";

export const DISCORD_BOT_API_BASE_URL_ENV = "DISCORD_BOT_API_BASE_URL";

function normalizeDiscordApiBaseUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/, "") || null;
}

export type DiscordApiBaseUrlSource = {
  /** Per-account override; read from `accounts.<id>.apiBaseUrl`. */
  account?: { apiBaseUrl?: string | null } | null;
  /** Env source. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
};

export function resolveDiscordApiBaseUrl(source: DiscordApiBaseUrlSource = {}): string {
  const env = source.env ?? process.env;
  const accountOverride = normalizeDiscordApiBaseUrl(source.account?.apiBaseUrl ?? null);
  if (accountOverride) {
    return accountOverride;
  }
  return (
    normalizeDiscordApiBaseUrl(env[DISCORD_BOT_API_BASE_URL_ENV]) ?? DEFAULT_DISCORD_API_BASE_URL
  );
}

export function resolveDiscordApiHostname(source: DiscordApiBaseUrlSource = {}): string {
  try {
    return new URL(resolveDiscordApiBaseUrl(source)).hostname || "discord.com";
  } catch {
    return "discord.com";
  }
}
