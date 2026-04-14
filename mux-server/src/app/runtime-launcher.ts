import type http from "node:http";

export function createRuntimeLauncher(deps: {
  server: http.Server;
  host: string;
  port: number;
  dbPath: string;
  openclawMuxAccountId: string;
  tenantSeedCount: number;
  pairingCodeSeedCount: number;
  countActiveTenantInboundTargets: () => number;
  log: (entry: Record<string, unknown>) => void;
  whatsappInboundEnabled: boolean;
  whatsappAccountId: string;
  whatsappAuthDir: string;
  whatsappInboundRetryMs: number;
  runWhatsAppInboundLoop: () => Promise<void>;
  telegramInboundEnabled: boolean;
  telegramBotToken?: string;
  getTelegramBotUsername: () => string | null;
  setTelegramBotUsername: (username: string) => void;
  telegramPollTimeoutSec: number;
  telegramPollRetryMs: number;
  telegramBootstrapLatest: boolean;
  runTelegramInboundLoop: () => Promise<void>;
  discordInboundEnabled: boolean;
  getDiscordBotSelfId: () => string | null;
  setDiscordBotSelfId: (botSelfId: string) => void;
  discordPollIntervalMs: number;
  discordBootstrapLatest: boolean;
  discordGatewayDmEnabled: boolean;
  discordGatewayGuildEnabled: boolean;
  discordGatewayIntents: number;
  discordGatewayDefaultIntents: number;
  discordRequest: (params: {
    method: "GET" | "POST";
    path: string;
    body?: Record<string, unknown>;
  }) => Promise<{ response: Response; result: Record<string, unknown> }>;
  readNonEmptyString: (value: unknown) => string | null;
  runDiscordInboundLoop: () => Promise<void>;
  runDiscordGatewayDmLoop: () => Promise<void>;
}): {
  startMuxServerRuntime: () => Promise<void>;
} {
  async function ensureTelegramBotUsername(): Promise<void> {
    if (deps.getTelegramBotUsername() || !deps.telegramBotToken) {
      return;
    }
    try {
      const getMeRes = await fetch(`https://api.telegram.org/bot${deps.telegramBotToken}/getMe`, {
        signal: AbortSignal.timeout(10_000),
      });
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
      const selfId = deps.readNonEmptyString(result.id);
      if (selfId) {
        deps.setDiscordBotSelfId(selfId);
      }
    } catch {
      // Best-effort — wasMentioned will stay false without it.
    }
  }

  async function startMuxServerRuntime(): Promise<void> {
    deps.server.listen(deps.port, deps.host, async () => {
      const tenantTargetCount = deps.countActiveTenantInboundTargets();
      deps.log({
        type: "relay_started",
        host: deps.host,
        port: deps.port,
        dbPath: deps.dbPath,
        openclawMuxAccountId: deps.openclawMuxAccountId,
        tenantCount: deps.tenantSeedCount,
        pairingCodeSeedCount: deps.pairingCodeSeedCount,
      });
      console.log(`mux server listening on http://${deps.host}:${deps.port}`);
      if (deps.whatsappInboundEnabled) {
        deps.log({
          type: "whatsapp_inbound_started",
          tenantTargetCount,
          openclawAccountId: deps.openclawMuxAccountId,
          accountId: deps.whatsappAccountId,
          authDir: deps.whatsappAuthDir,
          retryMs: Math.max(100, Math.trunc(deps.whatsappInboundRetryMs)),
        });
        void deps.runWhatsAppInboundLoop().catch((error) => {
          deps.log({ type: "whatsapp_inbound_loop_fatal", error: String(error) });
        });
      }
      if (deps.telegramInboundEnabled) {
        await ensureTelegramBotUsername();
        deps.log({
          type: "telegram_inbound_started",
          tenantTargetCount,
          openclawAccountId: deps.openclawMuxAccountId,
          pollTimeoutSec: Math.max(1, Math.trunc(deps.telegramPollTimeoutSec)),
          pollRetryMs: Math.max(100, Math.trunc(deps.telegramPollRetryMs)),
          bootstrapLatest: deps.telegramBootstrapLatest,
          botUsername: deps.getTelegramBotUsername() ?? null,
        });
        void deps.runTelegramInboundLoop().catch((error) => {
          deps.log({ type: "telegram_inbound_loop_fatal", error: String(error) });
        });
      }
      if (deps.discordInboundEnabled) {
        await ensureDiscordBotSelfId();
        deps.log({
          type: "discord_inbound_started",
          tenantTargetCount,
          openclawAccountId: deps.openclawMuxAccountId,
          pollIntervalMs: Math.max(200, Math.trunc(deps.discordPollIntervalMs)),
          bootstrapLatest: deps.discordBootstrapLatest,
          gatewayDmEnabled: deps.discordGatewayDmEnabled,
          gatewayGuildEnabled: deps.discordGatewayGuildEnabled,
          botSelfId: deps.getDiscordBotSelfId(),
          gatewayIntents:
            Number.isFinite(deps.discordGatewayIntents) && deps.discordGatewayIntents > 0
              ? Math.trunc(deps.discordGatewayIntents)
              : deps.discordGatewayDefaultIntents,
        });
        void deps.runDiscordInboundLoop().catch((error) => {
          deps.log({ type: "discord_inbound_loop_fatal", error: String(error) });
        });
        if (deps.discordGatewayDmEnabled || deps.discordGatewayGuildEnabled) {
          void deps.runDiscordGatewayDmLoop().catch((error) => {
            deps.log({ type: "discord_gateway_dm_loop_fatal", error: String(error) });
          });
        }
      }
    });
  }

  return {
    startMuxServerRuntime,
  };
}
