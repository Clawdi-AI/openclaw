import type http from "node:http";
import type { MuxConfig } from "../config/env.js";
import { readNonEmptyString } from "../domain/values.js";

export function createRuntimeLauncher(deps: {
  config: Pick<
    MuxConfig,
    | "host"
    | "port"
    | "dbPath"
    | "openclawMuxAccountId"
    | "tenantSeedCount"
    | "pairingCodeSeedCount"
    | "whatsappInboundEnabled"
    | "whatsappAccountId"
    | "whatsappAuthDir"
    | "whatsappInboundRetryMs"
    | "telegramInboundEnabled"
    | "telegramPollTimeoutSec"
    | "telegramPollRetryMs"
    | "telegramBootstrapLatest"
    | "discordInboundEnabled"
    | "discordPollIntervalMs"
    | "discordBootstrapLatest"
    | "discordGatewayDmEnabled"
    | "discordGatewayGuildEnabled"
    | "discordGatewayIntents"
    | "discordGatewayDefaultIntents"
    | "imessageInboundEnabled"
    | "imessageServerUrl"
  > & { telegramBotToken?: string };
  server: http.Server;
  countActiveTenantInboundTargets: () => number;
  log: (entry: Record<string, unknown>) => void;
  runWhatsAppInboundLoop: () => Promise<void>;
  getTelegramBotUsername: () => string | null;
  setTelegramBotUsername: (username: string) => void;
  runTelegramInboundLoop: () => Promise<void>;
  getDiscordBotSelfId: () => string | null;
  setDiscordBotSelfId: (botSelfId: string) => void;
  discordRequest: (params: {
    method: "GET" | "POST";
    path: string;
    body?: Record<string, unknown>;
  }) => Promise<{ response: Response; result: Record<string, unknown> }>;
  runDiscordInboundLoop: () => Promise<void>;
  runDiscordGatewayDmLoop: () => Promise<void>;
  runIMessageInboundLoop: () => Promise<void>;
}): {
  startMuxServerRuntime: () => Promise<void>;
} {
  async function ensureTelegramBotUsername(): Promise<void> {
    if (deps.getTelegramBotUsername() || !deps.config.telegramBotToken) {
      return;
    }
    try {
      const getMeRes = await fetch(
        `https://api.telegram.org/bot${deps.config.telegramBotToken}/getMe`,
        {
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!getMeRes.ok) {
        return;
      }
      const getMeData = (await getMeRes.json()) as {
        result?: { username?: string };
      };
      const resolved = getMeData?.result?.username;
      if (resolved) {
        deps.setTelegramBotUsername(resolved);
      }
    } catch {
      // Best-effort — wasMentioned will stay false without it.
    }
  }

  async function ensureDiscordBotSelfId(): Promise<void> {
    if (deps.getDiscordBotSelfId()) {
      return;
    }
    try {
      const { response, result } = await deps.discordRequest({
        method: "GET",
        path: "/users/@me",
      });
      if (!response.ok) {
        return;
      }
      const selfId = readNonEmptyString(result.id);
      if (selfId) {
        deps.setDiscordBotSelfId(selfId);
      }
    } catch {
      // Best-effort — wasMentioned will stay false without it.
    }
  }

  async function startMuxServerRuntime(): Promise<void> {
    deps.server.listen(deps.config.port, deps.config.host, async () => {
      const tenantTargetCount = deps.countActiveTenantInboundTargets();
      deps.log({
        type: "relay_started",
        host: deps.config.host,
        port: deps.config.port,
        dbPath: deps.config.dbPath,
        openclawMuxAccountId: deps.config.openclawMuxAccountId,
        tenantCount: deps.config.tenantSeedCount,
        pairingCodeSeedCount: deps.config.pairingCodeSeedCount,
      });
      console.log(`mux server listening on http://${deps.config.host}:${deps.config.port}`);
      if (deps.config.whatsappInboundEnabled) {
        deps.log({
          type: "whatsapp_inbound_started",
          tenantTargetCount,
          openclawAccountId: deps.config.openclawMuxAccountId,
          accountId: deps.config.whatsappAccountId,
          authDir: deps.config.whatsappAuthDir,
          retryMs: Math.max(100, Math.trunc(deps.config.whatsappInboundRetryMs)),
        });
        void deps.runWhatsAppInboundLoop().catch((error) => {
          deps.log({ type: "whatsapp_inbound_loop_fatal", error: String(error) });
        });
      }
      if (deps.config.telegramInboundEnabled) {
        await ensureTelegramBotUsername();
        deps.log({
          type: "telegram_inbound_started",
          tenantTargetCount,
          openclawAccountId: deps.config.openclawMuxAccountId,
          pollTimeoutSec: Math.max(1, Math.trunc(deps.config.telegramPollTimeoutSec)),
          pollRetryMs: Math.max(100, Math.trunc(deps.config.telegramPollRetryMs)),
          bootstrapLatest: deps.config.telegramBootstrapLatest,
          botUsername: deps.getTelegramBotUsername() ?? null,
        });
        void deps.runTelegramInboundLoop().catch((error) => {
          deps.log({ type: "telegram_inbound_loop_fatal", error: String(error) });
        });
      }
      if (deps.config.discordInboundEnabled) {
        await ensureDiscordBotSelfId();
        deps.log({
          type: "discord_inbound_started",
          tenantTargetCount,
          openclawAccountId: deps.config.openclawMuxAccountId,
          pollIntervalMs: Math.max(200, Math.trunc(deps.config.discordPollIntervalMs)),
          bootstrapLatest: deps.config.discordBootstrapLatest,
          gatewayDmEnabled: deps.config.discordGatewayDmEnabled,
          gatewayGuildEnabled: deps.config.discordGatewayGuildEnabled,
          botSelfId: deps.getDiscordBotSelfId(),
          gatewayIntents:
            Number.isFinite(deps.config.discordGatewayIntents) &&
            deps.config.discordGatewayIntents > 0
              ? Math.trunc(deps.config.discordGatewayIntents)
              : deps.config.discordGatewayDefaultIntents,
        });
        void deps.runDiscordInboundLoop().catch((error) => {
          deps.log({ type: "discord_inbound_loop_fatal", error: String(error) });
        });
        if (deps.config.discordGatewayDmEnabled || deps.config.discordGatewayGuildEnabled) {
          void deps.runDiscordGatewayDmLoop().catch((error) => {
            deps.log({ type: "discord_gateway_dm_loop_fatal", error: String(error) });
          });
        }
      }
      if (deps.config.imessageInboundEnabled && deps.config.imessageServerUrl) {
        deps.log({
          type: "imessage_inbound_started",
          tenantTargetCount,
          openclawAccountId: deps.config.openclawMuxAccountId,
          serverUrl: deps.config.imessageServerUrl,
        });
        void deps.runIMessageInboundLoop().catch((error) => {
          deps.log({ type: "imessage_inbound_loop_fatal", error: String(error) });
        });
      }
    });
  }

  return {
    startMuxServerRuntime,
  };
}
