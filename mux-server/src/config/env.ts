import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OutboundResolutionMode } from "../domain/types.js";
import type { RuntimeConfig } from "./runtime.js";

export type ChannelEnvConfig = ReturnType<typeof resolveChannelEnv>;

export type MuxConfig = RuntimeConfig &
  ChannelEnvConfig & {
    telegramGeneralTopicId: number;
    runtimeTokenTtlSec: number;
    runtimeJwtAudienceMux: string;
    runtimeJwtAudienceOpenClaw: string;
    inboundTokenTtlSec: number;
    tenantSeedCount: number;
    pairingCodeSeedCount: number;
  };

export function resolveChannelEnv(deps: {
  readNonEmptyString: (value: unknown) => string | null;
  resolveOutboundResolutionMode: (value: unknown) => OutboundResolutionMode;
}) {
  const muxAdminToken = deps.readNonEmptyString(process.env.MUX_ADMIN_TOKEN);
  const muxRegisterKey = deps.readNonEmptyString(process.env.MUX_REGISTER_KEY);
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
  const discordBotToken = process.env.DISCORD_BOT_TOKEN;
  const outboundResolutionMode = deps.resolveOutboundResolutionMode(
    process.env.MUX_OUTBOUND_RESOLUTION_MODE,
  );

  // OpenClaw account id for mux-routed inbound events. Keep this separate from
  // platform account ids so direct channel bots can remain unchanged.
  const openclawMuxAccountId =
    deps.readNonEmptyString(process.env.MUX_OPENCLAW_ACCOUNT_ID) || "default";
  const whatsappAccountId =
    deps.readNonEmptyString(process.env.MUX_WHATSAPP_ACCOUNT_ID) || "default";
  const whatsappAuthDir =
    deps.readNonEmptyString(process.env.MUX_WHATSAPP_AUTH_DIR) || resolveDefaultWhatsAppAuthDir();
  const whatsappAllowedFileDirs: string[] = [os.tmpdir(), whatsappAuthDir].map((d) =>
    path.resolve(d),
  );

  const telegramInboundEnabled = Boolean(deps.readNonEmptyString(telegramBotToken));
  const telegramPollTimeoutSec = Number(process.env.MUX_TELEGRAM_POLL_TIMEOUT_SEC || 25);
  const telegramPollRetryMs = Number(process.env.MUX_TELEGRAM_POLL_RETRY_MS || 1_000);
  const telegramBootstrapLatest = process.env.MUX_TELEGRAM_BOOTSTRAP_LATEST !== "false";
  const discordInboundEnabled = Boolean(deps.readNonEmptyString(discordBotToken));
  const discordPollIntervalMs = Number(process.env.MUX_DISCORD_POLL_INTERVAL_MS || 2_000);
  const discordBootstrapLatest = process.env.MUX_DISCORD_BOOTSTRAP_LATEST !== "false";
  const discordPendingGcEnabled = process.env.MUX_DISCORD_PENDING_GC_ENABLED === "true";
  const discordGatewayDmEnabled = process.env.MUX_DISCORD_GATEWAY_DM_ENABLED !== "false";
  const discordGatewayGuildEnabled = process.env.MUX_DISCORD_GATEWAY_GUILD_ENABLED !== "false";
  const discordGatewayDefaultIntents = discordGatewayGuildEnabled
    ? 37_377 // Guilds + GuildMessages + DirectMessages + MessageContent
    : 36_864; // DirectMessages + MessageContent
  const discordGatewayIntents = Number(
    process.env.MUX_DISCORD_GATEWAY_INTENTS ||
      process.env.MUX_DISCORD_GATEWAY_DM_INTENTS ||
      discordGatewayDefaultIntents,
  );
  const discordGatewayReconnectInitialMs = Number(
    process.env.MUX_DISCORD_GATEWAY_RECONNECT_INITIAL_MS || 1_000,
  );
  const discordGatewayReconnectMaxMs = Number(
    process.env.MUX_DISCORD_GATEWAY_RECONNECT_MAX_MS || 30_000,
  );
  const whatsappInboundEnabled = fs.existsSync(path.join(whatsappAuthDir, "creds.json"));
  const whatsappInboundRetryMs = Number(process.env.MUX_WHATSAPP_INBOUND_RETRY_MS || 1_000);
  const whatsappQueuePollMs = Number(process.env.MUX_WHATSAPP_QUEUE_POLL_MS || 500);
  const whatsappQueueRetryInitialMs = Number(
    process.env.MUX_WHATSAPP_QUEUE_RETRY_INITIAL_MS || 1_000,
  );
  const whatsappQueueRetryMaxMs = Number(process.env.MUX_WHATSAPP_QUEUE_RETRY_MAX_MS || 60_000);
  const whatsappQueueBatchSize = Number(process.env.MUX_WHATSAPP_QUEUE_BATCH_SIZE || 20);
  const whatsappQueueMaxAgeMs = Number(
    process.env.MUX_WHATSAPP_QUEUE_MAX_AGE_MS || 24 * 60 * 60_000,
  );
  const pairingTokenTtlSec = Number(process.env.MUX_PAIRING_TOKEN_TTL_SEC || 15 * 60);
  const pairingTokenMaxTtlSec = Number(process.env.MUX_PAIRING_TOKEN_MAX_TTL_SEC || 60 * 60);
  const initialTelegramBotUsername = deps.readNonEmptyString(process.env.MUX_TELEGRAM_BOT_USERNAME);

  return {
    muxAdminToken,
    muxRegisterKey,
    telegramBotToken,
    discordBotToken,
    outboundResolutionMode,
    openclawMuxAccountId,
    whatsappAccountId,
    whatsappAuthDir,
    whatsappAllowedFileDirs,
    telegramInboundEnabled,
    telegramPollTimeoutSec,
    telegramPollRetryMs,
    telegramBootstrapLatest,
    discordInboundEnabled,
    discordPollIntervalMs,
    discordBootstrapLatest,
    discordPendingGcEnabled,
    discordGatewayDmEnabled,
    discordGatewayGuildEnabled,
    discordGatewayIntents,
    discordGatewayDefaultIntents,
    discordGatewayReconnectInitialMs,
    discordGatewayReconnectMaxMs,
    whatsappInboundEnabled,
    whatsappInboundRetryMs,
    whatsappQueuePollMs,
    whatsappQueueRetryInitialMs,
    whatsappQueueRetryMaxMs,
    whatsappQueueBatchSize,
    whatsappQueueMaxAgeMs,
    pairingTokenTtlSec,
    pairingTokenMaxTtlSec,
    initialTelegramBotUsername,
  };
}

function resolveDefaultWhatsAppAuthDir(): string {
  const stateDirRaw =
    process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim();
  const stateDir = stateDirRaw ? path.resolve(stateDirRaw) : path.join(os.homedir(), ".openclaw");
  const oauthDirRaw = process.env.OPENCLAW_OAUTH_DIR?.trim();
  const oauthDir = oauthDirRaw ? path.resolve(oauthDirRaw) : path.join(stateDir, "credentials");
  return path.join(oauthDir, "whatsapp", "default");
}
