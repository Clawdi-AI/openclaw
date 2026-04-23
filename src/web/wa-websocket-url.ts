/**
 * Resolve the WhatsApp Noise WebSocket URL Baileys should connect to.
 *
 * Default (env unset): Baileys' own default (`wss://web.whatsapp.com/ws/chat`).
 * Override via `WA_WEBSOCKET_URL` env to point Baileys at an msg-router
 * Noise WS face — the mechanism by which a nested mux-server deployment
 * (see `docs/MIGRATION-FROM-MUX.md`) or a direct openclaw deployment can
 * route WhatsApp traffic through msg-router rather than real WA.
 *
 * Mirrors the shape of the Telegram / Discord base-URL resolvers so the
 * three channels expose the same operator-facing knob style.
 */
export const WA_WEBSOCKET_URL_ENV = "WA_WEBSOCKET_URL";

function normalizeWaWebSocketUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  // Strip trailing slashes to avoid double-slash URLs when Baileys appends
  // paths internally. Preserve a leading `ws://` / `wss://`; anything else
  // is passed through unchanged so callers can use URL objects too.
  return trimmed.replace(/\/+$/, "") || null;
}

export function resolveWaWebSocketUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return normalizeWaWebSocketUrl(env[WA_WEBSOCKET_URL_ENV]) ?? undefined;
}
