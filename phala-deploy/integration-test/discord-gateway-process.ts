/**
 * Headless entrypoint that boots the OpenClaw gateway with the real
 * Discord channel plugin registered, so a msg-router integration harness
 * can exercise the Discord monitor (Carbon gateway + inbound worker)
 * end-to-end against a Discord-compatible server.
 *
 * Lives in the openclaw submodule — like gateway-process.ts — so
 * `import "openclaw/..."` specifiers resolve against openclaw's own
 * node_modules.
 */
import { discordPlugin } from "../../extensions/discord/src/channel.js";
import { setDiscordRuntime } from "../../extensions/discord/src/runtime.js";
import { startGatewayServer } from "../../src/gateway/server.js";
import { setActivePluginRegistry } from "../../src/plugins/runtime.js";
import { createPluginRuntime } from "../../src/plugins/runtime/index.js";
import { createTestRegistry } from "../../src/test-utils/channel-plugins.js";

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

  const integrationRegistry = createTestRegistry([
    {
      pluginId: "discord",
      plugin: discordPlugin as unknown as Parameters<typeof createTestRegistry>[0][0]["plugin"],
      source: "integration",
    },
  ]);
  const runtime = createPluginRuntime();
  setActivePluginRegistry(integrationRegistry);
  guardActiveRegistryAgainstEmptyWrites();
  setDiscordRuntime(runtime);

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
    await server.close({ reason: "discord integration gateway shutdown" });
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
