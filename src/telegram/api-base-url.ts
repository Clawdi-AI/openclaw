const DEFAULT_TELEGRAM_BOT_API_BASE_URL = "https://api.telegram.org";

export const TELEGRAM_BOT_API_BASE_URL_ENV = "TELEGRAM_BOT_API_BASE_URL";

function normalizeTelegramBotApiBaseUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/, "") || null;
}

export function resolveTelegramBotApiBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (
    normalizeTelegramBotApiBaseUrl(env[TELEGRAM_BOT_API_BASE_URL_ENV]) ??
    DEFAULT_TELEGRAM_BOT_API_BASE_URL
  );
}

export function resolveTelegramBotApiMethodBase(
  token: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return `${resolveTelegramBotApiBaseUrl(env)}/bot${token}`;
}

export function resolveTelegramBotFileUrl(
  token: string,
  filePath: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return `${resolveTelegramBotApiBaseUrl(env)}/file/bot${token}/${filePath.replace(/^\/+/, "")}`;
}
