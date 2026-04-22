/**
 * Discord REST base URL resolver.
 *
 * Mirrors `src/telegram/api-base-url.ts`: production defaults to real
 * Discord, but integration tests and Discord-compatible proxies (like
 * msg-router's egress) can point OpenClaw at a local or custom host by
 * setting `DISCORD_BOT_API_BASE_URL` — or, per-account, by configuring
 * `channels.discord.accounts.<id>.apiBaseUrl`. The per-account value
 * wins so a single process can run one account against real Discord
 * and another against msg-router.
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

/**
 * Resolve the REST base URL for a Discord account.
 *
 * Precedence:
 *   1. `account.apiBaseUrl` (per-account override).
 *   2. `DISCORD_BOT_API_BASE_URL` env var (process-wide override).
 *   3. `https://discord.com` (default).
 */
export function resolveDiscordApiBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
  account?: { apiBaseUrl?: string },
): string {
  const perAccount = normalizeDiscordApiBaseUrl(account?.apiBaseUrl);
  if (perAccount) {
    return perAccount;
  }
  return (
    normalizeDiscordApiBaseUrl(env[DISCORD_BOT_API_BASE_URL_ENV]) ?? DEFAULT_DISCORD_API_BASE_URL
  );
}
