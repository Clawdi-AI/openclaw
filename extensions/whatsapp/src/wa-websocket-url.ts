/**
 * Resolve the WhatsApp Noise WebSocket URL Baileys should connect to.
 *
 * Mirrors the shape of Telegram's `apiRoot` and Discord's `apiBaseUrl`
 * resolvers so the three msg-router-routed channels expose the same
 * operator-facing knob style.
 *
 * Precedence:
 *   1. `account.wsUrl` (per-account config in
 *      `channels.whatsapp.accounts.<id>.wsUrl`). Written by
 *      clawdi's m031/m032 migrations when a tenant is moved onto
 *      msg-router; mirrors the same per-account-override pattern as
 *      Discord `apiBaseUrl` so a single agent process can host
 *      msg-router-routed accounts AND a customer-supplied direct-WA
 *      account at the same time.
 *   2. `WA_WEBSOCKET_URL` env var (process-wide override). Legacy
 *      escape hatch for debug / single-tenant deployments. Applies to
 *      all accounts that don't set `wsUrl` per-account.
 *   3. Undefined → Baileys uses its built-in default
 *      (`wss://web.whatsapp.com/ws/chat`).
 *
 * Trust model: both inputs are operator-set (openclaw.json on the
 * agent's local filesystem; env var in the agent process). Untrusted
 * user input never reaches this resolver. The msg-router-side TLS
 * cert is validated by Baileys' standard TLS chain (the URL must use
 * `wss://` for transport encryption); the WA Noise handshake on top
 * authenticates msg-router via the cert chain it returns in
 * `serverHello.payload` — see `src/channels/whatsapp/noise-server.ts`
 * on the msg-router side and `Utils/noise-handler.ts:processHandshake`
 * in Baileys for the verification path.
 */

export const WA_WEBSOCKET_URL_ENV = "WA_WEBSOCKET_URL";

function normalize(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export interface ResolveWaWebSocketUrlInput {
  /** Per-account override from openclaw.json. Highest priority. */
  accountWsUrl?: string;
  /** Process env. Defaults to `process.env`; explicit param keeps the
   *  resolver pure for tests. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Returns the resolved WS URL or `undefined` (let Baileys use its
 * default). Returning `undefined` rather than the Baileys-default
 * string keeps callers' semantics symmetric: they can spread the
 * value conditionally with `...(url ? { waWebSocketUrl: url } : {})`
 * and avoid passing `undefined` into Baileys (which would override
 * the default with `undefined` and break the real-WA path).
 */
export function resolveWaWebSocketUrl(input: ResolveWaWebSocketUrlInput = {}): string | undefined {
  const fromAccount = normalize(input.accountWsUrl);
  if (fromAccount) {
    return fromAccount;
  }
  const env = input.env ?? process.env;
  return normalize(env[WA_WEBSOCKET_URL_ENV]);
}
