import { telegramPlugin } from "../../extensions/telegram/src/channel.js";
import { setTelegramRuntime } from "../../extensions/telegram/src/runtime.js";
import { startGatewayServer } from "../../src/gateway/server.js";
import { setActivePluginRegistry } from "../../src/plugins/runtime.js";
import { createPluginRuntime } from "../../src/plugins/runtime/index.js";
import { createTestRegistry } from "../../src/test-utils/channel-plugins.js";

async function main(): Promise<void> {
  const portRaw = process.argv[2]?.trim();
  const port = Number(portRaw);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`invalid gateway port: ${portRaw ?? "<missing>"}`);
  }

  // Minimal integration mode skips channel startup, but the agent-side message tool
  // still needs Telegram target normalization and action metadata from the registry.
  const integrationRegistry = createTestRegistry([
    { pluginId: "telegram", plugin: telegramPlugin, source: "integration" },
  ]);
  setActivePluginRegistry(integrationRegistry);
  setTelegramRuntime(createPluginRuntime());

  const server = await startGatewayServer(port, {
    bind: "loopback",
    auth: { mode: "token", token: process.env.OPENCLAW_GATEWAY_TOKEN ?? "" },
    controlUiEnabled: false,
  });
  setActivePluginRegistry(integrationRegistry);

  const shutdown = async () => {
    await server.close({ reason: "integration gateway shutdown" });
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
