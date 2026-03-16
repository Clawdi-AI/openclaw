import path from "node:path";
import { pathToFileURL } from "node:url";

async function main(): Promise<void> {
  const repoPathRaw = process.argv[2]?.trim();
  const portRaw = process.argv[3]?.trim();
  const port = Number(portRaw);
  if (!repoPathRaw) {
    throw new Error("missing legacy OpenClaw repo path");
  }
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`invalid gateway port: ${portRaw ?? "<missing>"}`);
  }

  const repoPath = path.resolve(repoPathRaw);
  const gatewayModuleUrl = pathToFileURL(path.join(repoPath, "src", "gateway", "server.ts")).href;
  const pluginRuntimeUrl = pathToFileURL(path.join(repoPath, "src", "plugins", "runtime.ts")).href;
  const pluginRuntimeIndexUrl = pathToFileURL(
    path.join(repoPath, "src", "plugins", "runtime", "index.ts"),
  ).href;
  const channelTestUtilsUrl = pathToFileURL(
    path.join(repoPath, "src", "test-utils", "channel-plugins.ts"),
  ).href;
  const gatewayModule = (await import(gatewayModuleUrl)) as {
    startGatewayServer: (
      port: number,
      options?: {
        bind?: "lan" | "loopback";
        auth?: { mode: "token"; token: string };
        controlUiEnabled?: boolean;
      },
    ) => Promise<{ close: (params?: { reason?: string }) => Promise<void> }>;
  };
  const { setActivePluginRegistry } = (await import(pluginRuntimeUrl)) as {
    setActivePluginRegistry: (registry: unknown) => void;
  };
  const { createPluginRuntime } = (await import(pluginRuntimeIndexUrl)) as {
    createPluginRuntime: () => unknown;
  };
  const { createTestRegistry } = (await import(channelTestUtilsUrl)) as {
    createTestRegistry: (
      entries: Array<{ pluginId: string; plugin: unknown; source: string }>,
    ) => unknown;
  };
  const enabledChannels = new Set(
    (process.env.OPENCLAW_INTEGRATION_CHANNELS ?? "telegram")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );

  const runtime = createPluginRuntime();
  const registryEntries: Array<{ pluginId: string; plugin: unknown; source: string }> = [];

  if (enabledChannels.has("telegram")) {
    const telegramChannelUrl = pathToFileURL(
      path.join(repoPath, "extensions", "telegram", "src", "channel.ts"),
    ).href;
    const telegramRuntimeUrl = pathToFileURL(
      path.join(repoPath, "extensions", "telegram", "src", "runtime.ts"),
    ).href;
    const { telegramPlugin } = (await import(telegramChannelUrl)) as {
      telegramPlugin: unknown;
    };
    const { setTelegramRuntime } = (await import(telegramRuntimeUrl)) as {
      setTelegramRuntime: (runtime: unknown) => void;
    };
    setTelegramRuntime(runtime);
    registryEntries.push({ pluginId: "telegram", plugin: telegramPlugin, source: "integration" });
  }

  if (enabledChannels.has("discord")) {
    const discordChannelUrl = pathToFileURL(
      path.join(repoPath, "extensions", "discord", "src", "channel.ts"),
    ).href;
    const discordRuntimeUrl = pathToFileURL(
      path.join(repoPath, "extensions", "discord", "src", "runtime.ts"),
    ).href;
    const { discordPlugin } = (await import(discordChannelUrl)) as {
      discordPlugin: unknown;
    };
    const { setDiscordRuntime } = (await import(discordRuntimeUrl)) as {
      setDiscordRuntime: (runtime: unknown) => void;
    };
    setDiscordRuntime(runtime);
    registryEntries.push({ pluginId: "discord", plugin: discordPlugin, source: "integration" });
  }

  if (enabledChannels.has("whatsapp")) {
    const whatsAppChannelUrl = pathToFileURL(
      path.join(repoPath, "extensions", "whatsapp", "src", "channel.ts"),
    ).href;
    const whatsAppRuntimeUrl = pathToFileURL(
      path.join(repoPath, "extensions", "whatsapp", "src", "runtime.ts"),
    ).href;
    const { whatsappPlugin } = (await import(whatsAppChannelUrl)) as {
      whatsappPlugin: unknown;
    };
    const { setWhatsAppRuntime } = (await import(whatsAppRuntimeUrl)) as {
      setWhatsAppRuntime: (runtime: unknown) => void;
    };
    setWhatsAppRuntime(runtime);
    registryEntries.push({ pluginId: "whatsapp", plugin: whatsappPlugin, source: "integration" });
  }

  // Legacy mux HTTP normalizes channels through the plugin registry.
  setActivePluginRegistry(createTestRegistry(registryEntries));

  const gatewayServer = await gatewayModule.startGatewayServer(port, {
    bind: "loopback",
    auth: { mode: "token", token: process.env.OPENCLAW_GATEWAY_TOKEN ?? "" },
    controlUiEnabled: false,
  });
  setActivePluginRegistry(createTestRegistry(registryEntries));

  const shutdown = async () => {
    await gatewayServer.close({ reason: "legacy integration gateway shutdown" });
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  process.stdout.write(`__INTEGRATION_GATEWAY_READY__:${port}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
