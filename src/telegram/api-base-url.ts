const DEFAULT_TELEGRAM_BOT_API_BASE_URL = "https://api.telegram.org";

export const TELEGRAM_BOT_API_BASE_URL_ENV = "TELEGRAM_BOT_API_BASE_URL";

function normalizeTelegramBotApiBaseUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/, "") || null;
}

/**
 * Resolve the Telegram Bot API base URL for an account.
 *
 * Precedence:
 *   1. `account.apiBaseUrl` (per-account override).
 *   2. `TELEGRAM_BOT_API_BASE_URL` env var (process-wide override).
 *   3. `https://api.telegram.org` (default).
 *
 * Matches the Discord resolver's shape so a single OpenClaw process can
 * run one Telegram account against real Telegram and another against a
 * local proxy (e.g. msg-router's egress) — same pattern, same
 * precedence rules.
 */
export function resolveTelegramBotApiBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
  account?: { apiBaseUrl?: string },
): string {
  const perAccount = normalizeTelegramBotApiBaseUrl(account?.apiBaseUrl);
  if (perAccount) {
    return perAccount;
  }
  return (
    normalizeTelegramBotApiBaseUrl(env[TELEGRAM_BOT_API_BASE_URL_ENV]) ??
    DEFAULT_TELEGRAM_BOT_API_BASE_URL
  );
}

export function resolveTelegramBotApiHostname(
  env: NodeJS.ProcessEnv = process.env,
  account?: { apiBaseUrl?: string },
): string {
  try {
    return new URL(resolveTelegramBotApiBaseUrl(env, account)).hostname || "api.telegram.org";
  } catch {
    return "api.telegram.org";
  }
}
