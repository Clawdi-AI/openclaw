/**
 * Resolve the WhatsApp Noise WebSocket URL Baileys should connect to.
 *
 * Default (env unset, no per-account override): Baileys' own default
 * (`wss://web.whatsapp.com/ws/chat`).
 *
 * Precedence:
 *   1. `account.wsUrl` (per-account config override).
 *   2. `WA_WEBSOCKET_URL` env var (process-wide override).
 *   3. undefined → Baileys uses its default.
 *
 * Mirrors the shape of the Telegram / Discord `apiBaseUrl` resolvers so
 * all three channels expose the same operator-facing knob style.
 */
export const WA_WEBSOCKET_URL_ENV = "WA_WEBSOCKET_URL";

function normalizeWaWebSocketUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/, "") || null;
}

export function resolveWaWebSocketUrl(
  env: NodeJS.ProcessEnv = process.env,
  account?: { wsUrl?: string },
): string | undefined {
  const perAccount = normalizeWaWebSocketUrl(account?.wsUrl);
  if (perAccount) {
    return perAccount;
  }
  return normalizeWaWebSocketUrl(env[WA_WEBSOCKET_URL_ENV]) ?? undefined;
}
