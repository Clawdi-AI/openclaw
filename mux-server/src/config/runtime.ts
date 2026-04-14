import fs from "node:fs";
import path from "node:path";

function readEnvString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export type NoticesConfigEntry = { text: string | null };
export type NoticesConfig = Partial<{
  clawdiIntro: NoticesConfigEntry;
  pairingSuccess: NoticesConfigEntry;
  pairingRepaired: NoticesConfigEntry;
  pairingTakeover: NoticesConfigEntry;
  pairingInvalid: NoticesConfigEntry;
  whatsappContactTip: NoticesConfigEntry;
  postPairingPrompt: NoticesConfigEntry;
  botHelp: NoticesConfigEntry;
  botStatus: NoticesConfigEntry;
  botUnpairSuccess: NoticesConfigEntry;
  botNotPaired: NoticesConfigEntry;
  botSwitchUsage: NoticesConfigEntry;
}>;

export type RuntimeConfig = Readonly<{
  host: string;
  port: number;
  muxPublicUrl: string;
  logPath: string;
  dbPath: string;
  idempotencyTtlMs: number;
  telegramApiBaseUrl: string;
  discordApiBaseUrl: string;
  requestBodyMaxBytes: number;
}>;

export const DEFAULT_REQUEST_BODY_MAX_BYTES = 50 * 1024 * 1024;

export function readRuntimeConfig(env: NodeJS.ProcessEnv, cwd = process.cwd()): RuntimeConfig {
  const host = env.MUX_HOST || "127.0.0.1";
  const port = Number(env.MUX_PORT || 18891);
  const parsedRequestBodyMaxBytes = Number(
    env.MUX_MAX_BODY_BYTES || DEFAULT_REQUEST_BODY_MAX_BYTES,
  );

  return {
    host,
    port,
    muxPublicUrl: (env.MUX_PUBLIC_URL || `http://${host}:${port}`).replace(/\/+$/, ""),
    logPath: env.MUX_LOG_PATH || path.resolve(cwd, "mux-server", "logs", "mux-server.log"),
    dbPath: env.MUX_DB_PATH || path.resolve(cwd, "mux-server", "data", "mux-server.sqlite"),
    idempotencyTtlMs: Number(env.MUX_IDEMPOTENCY_TTL_MS || 10 * 60 * 1000),
    telegramApiBaseUrl: (env.MUX_TELEGRAM_API_BASE_URL || "https://api.telegram.org").replace(
      /\/+$/,
      "",
    ),
    discordApiBaseUrl: (env.MUX_DISCORD_API_BASE_URL || "https://discord.com/api/v10").replace(
      /\/+$/,
      "",
    ),
    requestBodyMaxBytes:
      Number.isFinite(parsedRequestBodyMaxBytes) && parsedRequestBodyMaxBytes > 0
        ? Math.trunc(parsedRequestBodyMaxBytes)
        : DEFAULT_REQUEST_BODY_MAX_BYTES,
  };
}

export function loadNoticesConfig(env: NodeJS.ProcessEnv): NoticesConfig {
  const configPath = env.MUX_NOTICES_CONFIG_PATH || "./config/notices.json";
  try {
    const raw = fs.readFileSync(path.resolve(configPath), "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function getNoticeText(config: NoticesConfig, key: keyof NoticesConfig): string | null {
  const entry = config[key];
  if (entry && typeof entry.text === "string") {
    return entry.text;
  }
  return null;
}

export function readConfiguredText(value: unknown): string | null {
  return readEnvString(value) || null;
}
