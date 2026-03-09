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

  const server = await gatewayModule.startGatewayServer(port, {
    bind: "loopback",
    auth: { mode: "token", token: process.env.OPENCLAW_GATEWAY_TOKEN ?? "" },
    controlUiEnabled: false,
  });

  const shutdown = async () => {
    await server.close({ reason: "legacy integration gateway shutdown" });
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
