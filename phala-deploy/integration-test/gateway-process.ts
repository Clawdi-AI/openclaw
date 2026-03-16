import { telegramPlugin } from "../../extensions/telegram/src/channel.js";
import { setTelegramRuntime } from "../../extensions/telegram/src/runtime.js";
import { discordOutbound } from "../../src/channels/plugins/outbound/discord.js";
import { whatsappOutbound } from "../../src/channels/plugins/outbound/whatsapp.js";
import { startGatewayServer } from "../../src/gateway/server.js";
import { setActivePluginRegistry } from "../../src/plugins/runtime.js";
import { createPluginRuntime } from "../../src/plugins/runtime/index.js";
import {
  createOutboundTestPlugin,
  createTestRegistry,
} from "../../src/test-utils/channel-plugins.js";

function resolveIntegrationChannels(): Array<"telegram" | "discord" | "whatsapp"> {
  const raw = process.env.OPENCLAW_INTEGRATION_CHANNELS?.trim();
  if (!raw) {
    return ["telegram"];
  }
  const requested = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(
      (value): value is "telegram" | "discord" | "whatsapp" =>
        value === "telegram" || value === "discord" || value === "whatsapp",
    );
  return requested.length > 0 ? [...new Set(requested)] : ["telegram"];
}

function guardActiveRegistryAgainstEmptyWrites(): void {
  const state = (
    globalThis as typeof globalThis & {
      [key: symbol]: { registry?: unknown } | undefined;
    }
  )[Symbol.for("openclaw.pluginRegistryState")];
  if (!state) {
    return;
  }
  const descriptor = Object.getOwnPropertyDescriptor(state, "registry");
  if (descriptor && typeof descriptor.get === "function" && typeof descriptor.set === "function") {
    return;
  }

  let currentRegistry = state.registry;
  Object.defineProperty(state, "registry", {
    configurable: true,
    enumerable: true,
    get() {
      return currentRegistry;
    },
    set(next) {
      const nextChannels =
        next && typeof next === "object" && "channels" in next && Array.isArray(next.channels)
          ? next.channels
          : null;
      const currentChannels =
        currentRegistry &&
        typeof currentRegistry === "object" &&
        "channels" in currentRegistry &&
        Array.isArray(currentRegistry.channels)
          ? currentRegistry.channels
          : null;
      // The integration harness seeds a non-empty runtime registry up front.
      // Some read-only plugin/provider paths later replace it with an empty
      // registry, which strips channel actions from the message tool schema.
      // Ignore only that downgrade inside the harness process.
      if (
        nextChannels &&
        nextChannels.length === 0 &&
        currentChannels &&
        currentChannels.length > 0
      ) {
        return;
      }
      currentRegistry = next;
    },
  });
}

async function main(): Promise<void> {
  const portRaw = process.argv[2]?.trim();
  const port = Number(portRaw);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`invalid gateway port: ${portRaw ?? "<missing>"}`);
  }

  const channelEntries = resolveIntegrationChannels().map((channelId) => ({
    pluginId: channelId,
    plugin:
      channelId === "discord"
        ? createOutboundTestPlugin({
            id: "discord",
            label: "Discord",
            outbound: discordOutbound,
            capabilities: { chatTypes: ["direct", "channel", "thread"] },
          })
        : channelId === "whatsapp"
          ? createOutboundTestPlugin({
              id: "whatsapp",
              label: "WhatsApp",
              outbound: whatsappOutbound,
              capabilities: { chatTypes: ["direct", "group"] },
            })
          : telegramPlugin,
    source: "integration",
  }));
  const integrationRegistry = createTestRegistry(channelEntries);
  const runtime = createPluginRuntime();
  setActivePluginRegistry(integrationRegistry);
  guardActiveRegistryAgainstEmptyWrites();
  setTelegramRuntime(runtime);

  const server = await startGatewayServer(port, {
    bind: "loopback",
    auth: { mode: "token", token: process.env.OPENCLAW_GATEWAY_TOKEN ?? "" },
    controlUiEnabled: false,
  });
  setActivePluginRegistry(integrationRegistry);
  const registryKeepalive = setInterval(() => {
    setActivePluginRegistry(integrationRegistry);
  }, 50);

  const shutdown = async () => {
    clearInterval(registryKeepalive);
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
