import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { __resetMuxRuntimeAuthCacheForTest } from "../../src/channels/plugins/outbound/mux.js";
import type { OpenClawConfig } from "../../src/config/config.js";
import {
  clearSessionStoreCacheForTest,
  loadSessionStore,
  resolveStorePath,
} from "../../src/config/sessions.js";
import { __resetMuxJwksCacheForTest } from "../../src/gateway/mux-jwt.js";
import { buildOpenAiResponsesProviderConfig } from "../../src/gateway/test-openai-responses-model.js";
import { loadOrCreateDeviceIdentity } from "../../src/infra/device-identity.js";
import { captureEnv } from "../../src/test-utils/env.js";
import { FakeDiscordApi } from "./fake-discord.js";
import { FakeOpenAiResponsesServer } from "./fake-openai.js";
import type { FakeOpenAiRequest, FakeOpenAiResponsePlan } from "./fake-openai.js";
import { FakeTelegramApi } from "./fake-telegram.js";
import { FakeWhatsAppApi } from "./fake-whatsapp.js";
import {
  AsyncCleanupStack,
  getFreePort,
  startNodeTsxProcess,
  stopChildProcess,
  waitForCondition,
  waitForHttpOk,
  type StartedNodeProcess,
} from "./test-utils.js";

const muxDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "mux-server");
const TELEGRAM_BOT_TOKEN = "dummy-token";
const GATEWAY_TOKEN = "integration-gateway-token";
const MUX_REGISTER_KEY = "integration-register-key";
const TENANT_API_KEY = "integration-tenant-key";
const CLAIM_CODE = "PAIR-TG-INTEGRATION-1";
const INTEGRATION_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "VITEST",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_DISABLE_CONFIG_CACHE",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_TEST_MINIMAL_GATEWAY",
  "OPENCLAW_GATEWAY_TOKEN",
] as const;
const KEEP_TEMP = process.env.OPENCLAW_INTEGRATION_KEEP_TEMP === "1";

type StartedMuxServer = StartedNodeProcess & {
  port: number;
};

type HarnessPaths = {
  tempDir: string;
  stateDir: string;
  workspaceDir: string;
  configPath: string;
};

type StartHarnessParams = {
  channel?: "telegram" | "discord" | "whatsapp";
  chatId: string;
  claimedSessionKey: string;
  pairingRouteKey?: string;
  llmReplyText: string;
  resolutionMode: "session-first" | "target-first";
  minimalGateway?: boolean;
  telegramStreamMode?: "off" | "partial" | "block";
  discordGatewayDmEnabled?: boolean;
  discordGatewayGuildEnabled?: boolean;
  openAiResponder?: (request: FakeOpenAiRequest) => FakeOpenAiResponsePlan;
  workspaceFiles?: Record<string, string | Uint8Array>;
  gatewayRuntime?: "current" | "legacy";
  legacyRepoPath?: string;
  configTransform?: (cfg: OpenClawConfig) => OpenClawConfig;
};

function buildHarnessPaths(tempDir: string): HarnessPaths {
  const stateDir = path.join(tempDir, ".openclaw");
  return {
    tempDir,
    stateDir,
    workspaceDir: path.join(stateDir, "workspace"),
    configPath: path.join(stateDir, "openclaw.json"),
  };
}

function buildHarnessEnv(
  paths: HarnessPaths,
  params?: {
    channel?: "telegram" | "discord" | "whatsapp";
    minimalGateway?: boolean;
  },
): Record<string, string | undefined> {
  const isMinimalGateway = params?.minimalGateway !== false;
  const integrationChannels =
    params?.channel === "discord"
      ? "discord"
      : params?.channel === "whatsapp"
        ? "whatsapp"
        : "telegram";
  return {
    HOME: paths.tempDir,
    USERPROFILE: paths.tempDir,
    VITEST: "1",
    OPENCLAW_STATE_DIR: paths.stateDir,
    OPENCLAW_CONFIG_PATH: paths.configPath,
    OPENCLAW_DISABLE_CONFIG_CACHE: "1",
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
    OPENCLAW_SKIP_CRON: "1",
    OPENCLAW_GATEWAY_TOKEN: GATEWAY_TOKEN,
    OPENCLAW_INTEGRATION_CHANNELS: integrationChannels,
    OPENCLAW_SKIP_CHANNELS: isMinimalGateway ? "1" : undefined,
    OPENCLAW_SKIP_PROVIDERS: isMinimalGateway ? "1" : undefined,
    OPENCLAW_TEST_MINIMAL_GATEWAY: isMinimalGateway ? "1" : undefined,
  };
}

function buildHarnessConfig(params: {
  channel: "telegram" | "discord" | "whatsapp";
  workspaceDir: string;
  openAiBaseUrl: string;
  muxPort: number;
  gatewayPort: number;
  telegramStreamMode?: "off" | "partial" | "block";
}): OpenClawConfig {
  return {
    gateway: {
      mode: "local",
      auth: { token: GATEWAY_TOKEN },
      controlUi: { enabled: false },
      http: {
        endpoints: {
          mux: {
            enabled: true,
            baseUrl: `http://127.0.0.1:${params.muxPort}`,
            registerKey: MUX_REGISTER_KEY,
            inboundUrl: `http://127.0.0.1:${params.gatewayPort}/v1/mux/inbound`,
          },
        },
      },
    },
    update: { checkOnStart: false },
    agents: {
      defaults: {
        workspace: params.workspaceDir,
        maxConcurrent: 2,
        model: { primary: "openai/gpt-5.2" },
      },
    },
    models: {
      mode: "replace",
      providers: {
        openai: buildOpenAiResponsesProviderConfig(params.openAiBaseUrl),
      },
    },
    plugins: {
      enabled: false,
      slots: {
        memory: "none",
      },
    },
    channels:
      params.channel === "telegram"
        ? {
            telegram: {
              dmPolicy: "open",
              allowFrom: ["*"],
              groupPolicy: "open",
              streamMode: params.telegramStreamMode,
              reactionLevel: "minimal",
              actions: { reactions: true },
              mux: { enabled: true, timeoutMs: 10_000 },
              accounts: {
                default: { enabled: true, groupPolicy: "open" },
              },
            },
          }
        : params.channel === "discord"
          ? {
              discord: {
                dmPolicy: "open",
                allowFrom: ["*"],
                groupPolicy: "open",
                mux: { enabled: true, timeoutMs: 10_000 },
                guilds: {
                  "*": { requireMention: false },
                },
              },
            }
          : {
              whatsapp: {
                dmPolicy: "open",
                allowFrom: ["*"],
                groupPolicy: "open",
                mux: { enabled: true, timeoutMs: 10_000 },
              },
            },
  };
}

async function startMuxServer(params: {
  channel: "telegram" | "discord" | "whatsapp";
  port: number;
  tempDir: string;
  gatewayPort: number;
  openclawId: string;
  pairingRouteKey: string;
  openclawAccountId?: string;
  telegramBaseUrl?: string;
  discordBaseUrl?: string;
  discordGatewayDmEnabled?: boolean;
  discordGatewayGuildEnabled?: boolean;
  whatsappControlUrl?: string;
  resolutionMode: "session-first" | "target-first";
}): Promise<StartedMuxServer> {
  const started = startNodeTsxProcess({
    cwd: muxDir,
    entrypoint: "src/server.ts",
    env: {
      NODE_ENV: "test",
      ...(params.discordBaseUrl ? { DISCORD_BOT_TOKEN: "dummy-discord-token" } : {}),
      MUX_ADMIN_TOKEN: "integration-admin-token",
      MUX_REGISTER_KEY,
      MUX_PORT: String(params.port),
      MUX_LOG_PATH: path.join(params.tempDir, "mux-server.log"),
      MUX_DB_PATH: path.join(params.tempDir, "mux-server.sqlite"),
      MUX_OUTBOUND_RESOLUTION_MODE: params.resolutionMode,
      ...(params.openclawAccountId ? { MUX_OPENCLAW_ACCOUNT_ID: params.openclawAccountId } : {}),
      ...(params.telegramBaseUrl
        ? {
            TELEGRAM_BOT_TOKEN,
            MUX_TELEGRAM_BOT_USERNAME: "integration_bot",
            MUX_TELEGRAM_API_BASE_URL: params.telegramBaseUrl,
            MUX_TELEGRAM_POLL_TIMEOUT_SEC: "1",
            MUX_TELEGRAM_POLL_RETRY_MS: "50",
            MUX_TELEGRAM_BOOTSTRAP_LATEST: "false",
          }
        : {}),
      ...(params.discordBaseUrl
        ? {
            MUX_DISCORD_API_BASE_URL: params.discordBaseUrl,
            MUX_DISCORD_POLL_INTERVAL_MS: "50",
            MUX_DISCORD_BOOTSTRAP_LATEST: "false",
            MUX_DISCORD_GATEWAY_DM_ENABLED: params.discordGatewayDmEnabled ? "true" : "false",
            MUX_DISCORD_GATEWAY_GUILD_ENABLED: params.discordGatewayGuildEnabled ? "true" : "false",
          }
        : {}),
      ...(params.whatsappControlUrl
        ? {
            MUX_WEB_RUNTIME_MODULE_PATH: path.resolve(
              path.dirname(fileURLToPath(import.meta.url)),
              "fake-whatsapp-runtime.ts",
            ),
            MUX_FAKE_WHATSAPP_CONTROL_URL: params.whatsappControlUrl,
            MUX_FAKE_WHATSAPP_POLL_INTERVAL_MS: "50",
            MUX_WHATSAPP_AUTH_DIR: path.join(params.tempDir, "fake-whatsapp-auth"),
          }
        : {}),
      MUX_TENANTS_JSON: JSON.stringify([
        {
          id: params.openclawId,
          name: "Integration Tenant",
          apiKey: TENANT_API_KEY,
          inboundUrl: `http://127.0.0.1:${params.gatewayPort}/v1/mux/inbound`,
          inboundTimeoutMs: 4_000,
        },
      ]),
      MUX_PAIRING_CODES_JSON: JSON.stringify([
        {
          code: CLAIM_CODE,
          channel: params.channel,
          routeKey: params.pairingRouteKey,
          scope:
            params.channel === "telegram" ? "chat" : params.channel === "discord" ? "dm" : "chat",
        },
      ]),
    },
  });

  const server = { ...started, port: params.port };
  await waitForHttpOk({
    url: `http://127.0.0.1:${params.port}/health`,
    timeoutMs: 10_000,
    onTick: () => {
      if (server.process.exitCode !== null) {
        throw new Error(
          `mux-server exited early (${server.process.exitCode})\n${server.logs.join("").slice(-6_000)}`,
        );
      }
    },
    errorMessage: () => `mux-server did not become healthy\n${server.logs.join("").slice(-6_000)}`,
  });
  return server;
}

async function startGatewayProcess(params: {
  port: number;
  env: Record<string, string>;
  runtime?: "current" | "legacy";
  legacyRepoPath?: string;
  skipHealthzCheck?: boolean;
}): Promise<StartedNodeProcess> {
  const integrationRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const started =
    params.runtime === "legacy"
      ? startNodeTsxProcess({
          cwd: integrationRoot,
          entrypoint: "phala-deploy/integration-test/legacy-gateway-process.ts",
          args: [params.legacyRepoPath ?? "", String(params.port)],
          env: params.env,
        })
      : startNodeTsxProcess({
          cwd: integrationRoot,
          entrypoint: "phala-deploy/integration-test/gateway-process.ts",
          args: [String(params.port)],
          env: params.env,
        });

  const ensureProcessAlive = () => {
    if (started.process.exitCode !== null) {
      throw new Error(
        `gateway process exited early (${started.process.exitCode})\n${started.logs.join("").slice(-8_000)}`,
      );
    }
  };

  if (params.skipHealthzCheck) {
    await waitForCondition(
      () => {
        ensureProcessAlive();
        return started.logs.join("").includes(`__INTEGRATION_GATEWAY_READY__:${params.port}`);
      },
      20_000,
      `gateway process did not become ready\n${started.logs.join("").slice(-8_000)}`,
    );
    return started;
  }

  await waitForHttpOk({
    url: `http://127.0.0.1:${params.port}/healthz`,
    timeoutMs: 20_000,
    onTick: ensureProcessAlive,
    errorMessage: () =>
      `gateway process did not become ready\n${started.logs.join("").slice(-8_000)}`,
  });
  return started;
}

async function claimMuxPairing(params: {
  muxPort: number;
  claimedSessionKey: string;
}): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${params.muxPort}/v1/pairings/claim`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TENANT_API_KEY}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    signal: AbortSignal.timeout(5_000),
    body: JSON.stringify({
      code: CLAIM_CODE,
      sessionKey: params.claimedSessionKey,
    }),
  });
  if (!response.ok) {
    throw new Error(`failed to claim mux pairing (${response.status}): ${await response.text()}`);
  }
}

function resetIntegrationRuntimeState(): void {
  __resetMuxRuntimeAuthCacheForTest();
  __resetMuxJwksCacheForTest();
  clearSessionStoreCacheForTest();
}

export type MuxOpenClawHarness = {
  telegram?: FakeTelegramApi;
  discord?: FakeDiscordApi;
  whatsapp?: FakeWhatsAppApi;
  openai: FakeOpenAiResponsesServer;
  muxPort: number;
  gatewayPort: number;
  gatewayUrl: string;
  gatewayToken: string;
  configPath: string;
  stateDir: string;
  workspaceDir: string;
  openclawId: string;
  readSessionStore: (agentId?: string) => Record<string, unknown>;
  waitForSessionStoreEntry: (key: string, agentId?: string) => Promise<Record<string, unknown>>;
  readRecentLogs: () => { gateway: string; muxServer: string };
  restartGateway: () => Promise<void>;
  close: () => Promise<void>;
};

export async function startMuxOpenClawHarness(
  params: StartHarnessParams,
): Promise<MuxOpenClawHarness> {
  const cleanup = new AsyncCleanupStack();
  const envSnapshot = captureEnv([...INTEGRATION_ENV_KEYS]);
  cleanup.defer(() => {
    envSnapshot.restore();
  });
  cleanup.defer(() => {
    resetIntegrationRuntimeState();
  });

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-mux-integration-"));
  const paths = buildHarnessPaths(tempDir);
  cleanup.defer(async () => {
    if (!KEEP_TEMP) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  try {
    const channel = params.channel ?? "telegram";
    const runtime = params.gatewayRuntime ?? "current";
    const harnessEnv = buildHarnessEnv(paths, {
      channel,
      minimalGateway: params.minimalGateway,
    });
    for (const [key, value] of Object.entries(harnessEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await mkdir(paths.workspaceDir, { recursive: true });
    if (params.workspaceFiles) {
      for (const [relativePath, content] of Object.entries(params.workspaceFiles)) {
        const filePath = path.join(paths.workspaceDir, relativePath);
        await mkdir(path.dirname(filePath), { recursive: true });
        await writeFile(filePath, content);
      }
    }
    if (channel === "whatsapp") {
      const fakeWhatsAppAuthDir = path.join(tempDir, "fake-whatsapp-auth");
      await mkdir(fakeWhatsAppAuthDir, { recursive: true });
      await writeFile(
        path.join(fakeWhatsAppAuthDir, "creds.json"),
        JSON.stringify({ integration: true }, null, 2),
      );
    }

    const gatewayPort = await getFreePort();
    const muxPort = await getFreePort();
    const openclawId = loadOrCreateDeviceIdentity().deviceId;

    const telegram =
      channel === "telegram"
        ? cleanup.use(await FakeTelegramApi.start({ token: TELEGRAM_BOT_TOKEN }))
        : undefined;
    const discord = channel === "discord" ? cleanup.use(await FakeDiscordApi.start()) : undefined;
    const whatsapp =
      channel === "whatsapp" ? cleanup.use(await FakeWhatsAppApi.start()) : undefined;
    const openai = cleanup.use(
      await FakeOpenAiResponsesServer.start({
        responder: params.openAiResponder ?? (() => params.llmReplyText),
      }),
    );
    const baseConfig = buildHarnessConfig({
      channel,
      workspaceDir: paths.workspaceDir,
      openAiBaseUrl: openai.baseUrl,
      muxPort,
      gatewayPort,
      telegramStreamMode: params.telegramStreamMode,
    });
    const cfg = params.configTransform ? params.configTransform(baseConfig) : baseConfig;
    await writeFile(paths.configPath, `${JSON.stringify(cfg, null, 2)}\n`);

    let gateway = await startGatewayProcess({
      port: gatewayPort,
      env: harnessEnv,
      runtime,
      legacyRepoPath: params.legacyRepoPath,
      skipHealthzCheck: runtime === "legacy",
    });
    cleanup.defer(async () => {
      await stopChildProcess(gateway.process);
    });

    const muxServer = await startMuxServer({
      channel,
      port: muxPort,
      tempDir,
      gatewayPort,
      openclawId,
      pairingRouteKey:
        params.pairingRouteKey ??
        (channel === "telegram"
          ? `telegram:default:chat:${params.chatId}`
          : channel === "discord"
            ? `discord:default:dm:user:${params.chatId}`
            : `whatsapp:default:chat:${params.chatId}`),
      ...(telegram ? { telegramBaseUrl: telegram.url } : {}),
      ...(discord ? { discordBaseUrl: discord.url } : {}),
      ...(discord
        ? {
            discordGatewayDmEnabled: params.discordGatewayDmEnabled,
            discordGatewayGuildEnabled: params.discordGatewayGuildEnabled,
          }
        : {}),
      ...(whatsapp ? { whatsappControlUrl: whatsapp.url } : {}),
      openclawAccountId: runtime === "legacy" ? "mux" : undefined,
      resolutionMode: params.resolutionMode,
    });
    cleanup.defer(async () => {
      await stopChildProcess(muxServer.process);
    });

    await claimMuxPairing({
      muxPort,
      claimedSessionKey: params.claimedSessionKey,
    });

    const readSessionStore = (agentId = "main") => {
      clearSessionStoreCacheForTest();
      return loadSessionStore(resolveStorePath(undefined, { agentId }), {
        skipCache: true,
      });
    };

    return {
      ...(telegram ? { telegram } : {}),
      ...(discord ? { discord } : {}),
      ...(whatsapp ? { whatsapp } : {}),
      openai,
      muxPort,
      gatewayPort,
      gatewayUrl: `ws://127.0.0.1:${gatewayPort}`,
      gatewayToken: GATEWAY_TOKEN,
      configPath: paths.configPath,
      stateDir: paths.stateDir,
      workspaceDir: paths.workspaceDir,
      openclawId,
      readSessionStore,
      waitForSessionStoreEntry: async (key: string, agentId = "main") => {
        return await waitForCondition(
          () => readSessionStore(agentId)[key] as Record<string, unknown> | undefined,
          10_000,
          `timed out waiting for session store entry ${key} (agent ${agentId})`,
        );
      },
      readRecentLogs: () => ({
        gateway: gateway.logs.join("").slice(-12_000),
        muxServer: (() => {
          const processLogs = muxServer.logs.join("").slice(-6_000);
          const logFilePath = path.join(tempDir, "mux-server.log");
          const fileLogs = existsSync(logFilePath)
            ? readFileSync(logFilePath, "utf8").slice(-6_000)
            : "";
          return fileLogs ? `${processLogs}\n${fileLogs}` : processLogs;
        })(),
      }),
      restartGateway: async () => {
        await stopChildProcess(gateway.process);
        resetIntegrationRuntimeState();
        gateway = await startGatewayProcess({
          port: gatewayPort,
          env: harnessEnv,
          runtime,
          legacyRepoPath: params.legacyRepoPath,
          skipHealthzCheck: runtime === "legacy",
        });
      },
      close: async () => {
        await cleanup.close();
      },
    };
  } catch (error) {
    await cleanup.close().catch(() => {});
    throw error;
  }
}

export async function withMuxOpenClawHarness<T>(
  params: StartHarnessParams,
  run: (harness: MuxOpenClawHarness) => Promise<T>,
): Promise<T> {
  const harness = await startMuxOpenClawHarness(params);
  try {
    return await run(harness);
  } finally {
    await harness.close();
  }
}
