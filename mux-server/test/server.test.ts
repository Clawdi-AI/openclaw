import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const muxDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type RunningServer = {
  process: ChildProcessWithoutNullStreams;
  port: number;
  tempDir: string;
  cleanupTempDir: boolean;
};

type RunningHttpServer = {
  server: http.Server;
};

const runningServers: RunningServer[] = [];
const runningHttpServers: RunningHttpServer[] = [];

async function getFreePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to reserve test port"));
        return;
      }
      const port = address.port;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolvePort(port);
      });
    });
    server.on("error", reject);
  });
}

async function waitForHealth(port: number, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // Server is still starting.
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
  }
  throw new Error(`mux server did not become healthy on port ${port}`);
}

async function startServer(options?: {
  tempDir?: string;
  cleanupTempDir?: boolean;
  dbPath?: string;
  apiKey?: string;
  tenantsJson?: string;
  pairingCodesJson?: string;
  extraEnv?: Record<string, string>;
}): Promise<RunningServer> {
  const port = await getFreePort();
  const tempDir = options?.tempDir ?? mkdtempSync(resolve(tmpdir(), "mux-server-test-"));
  const cleanupTempDir = options?.cleanupTempDir ?? !options?.tempDir;
  const dbPath = options?.dbPath ?? resolve(tempDir, "mux-server.sqlite");
  const child = spawn("node", ["--import", "tsx", "src/server.ts"], {
    cwd: muxDir,
    env: {
      ...globalThis.process.env,
      TELEGRAM_BOT_TOKEN: "dummy-token",
      DISCORD_BOT_TOKEN: "dummy-discord-token",
      MUX_API_KEY: options?.apiKey ?? "test-key",
      ...(options?.tenantsJson ? { MUX_TENANTS_JSON: options.tenantsJson } : {}),
      ...(options?.pairingCodesJson ? { MUX_PAIRING_CODES_JSON: options.pairingCodesJson } : {}),
      ...(options?.extraEnv ?? {}),
      MUX_PORT: String(port),
      MUX_LOG_PATH: resolve(tempDir, "mux-server.log"),
      MUX_DB_PATH: dbPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const running = { process: child, port, tempDir, cleanupTempDir };
  runningServers.push(running);
  await waitForHealth(port);
  return running;
}

async function stopServer(server: RunningServer): Promise<void> {
  if (server.process.exitCode === null && !server.process.killed) {
    server.process.kill("SIGINT");
    await new Promise<void>((resolveExit) => {
      const timer = setTimeout(() => {
        if (server.process.exitCode === null && !server.process.killed) {
          server.process.kill("SIGKILL");
        }
        resolveExit();
      }, 3_000);
      server.process.once("exit", () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
  }

  if (server.cleanupTempDir) {
    rmSync(server.tempDir, { recursive: true, force: true });
  }
}

function removeRunningServer(server: RunningServer) {
  const index = runningServers.indexOf(server);
  if (index >= 0) {
    runningServers.splice(index, 1);
  }
}

async function startHttpServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>,
): Promise<{ url: string; server: RunningHttpServer }> {
  const port = await getFreePort();
  const server = http.createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolveServer();
    });
  });
  const running = { server };
  runningHttpServers.push(running);
  return { url: `http://127.0.0.1:${port}`, server: running };
}

async function stopHttpServer(running: RunningHttpServer): Promise<void> {
  await new Promise<void>((resolveServer) => {
    running.server.close(() => resolveServer());
  });
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs: number,
  errorMessage: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
  }
  throw new Error(errorMessage);
}

afterEach(async () => {
  while (runningServers.length > 0) {
    const server = runningServers.pop();
    if (server) {
      await stopServer(server);
    }
  }
  while (runningHttpServers.length > 0) {
    const server = runningHttpServers.pop();
    if (server) {
      await stopHttpServer(server);
    }
  }
});

function requestPayload(text: string) {
  return {
    channel: "telegram",
    sessionKey: "tg:group:-100123:thread:2",
    text,
  };
}

async function sendWithIdempotency(params: {
  port: number;
  apiKey: string;
  idempotencyKey: string;
  text: string;
}) {
  return await fetch(`http://127.0.0.1:${params.port}/v1/mux/outbound/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": params.idempotencyKey,
    },
    body: JSON.stringify(requestPayload(params.text)),
  });
}

async function claimPairing(params: {
  port: number;
  apiKey: string;
  code: string;
  sessionKey?: string;
}) {
  return await fetch(`http://127.0.0.1:${params.port}/v1/pairings/claim`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      code: params.code,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    }),
  });
}

async function listPairings(params: { port: number; apiKey: string }) {
  return await fetch(`http://127.0.0.1:${params.port}/v1/pairings`, {
    headers: { Authorization: `Bearer ${params.apiKey}` },
  });
}

async function unbindPairing(params: { port: number; apiKey: string; bindingId: string }) {
  return await fetch(`http://127.0.0.1:${params.port}/v1/pairings/unbind`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ bindingId: params.bindingId }),
  });
}

async function createPairingToken(params: {
  port: number;
  apiKey: string;
  channel: string;
  sessionKey?: string;
  routeKey?: string;
  ttlSec?: number;
}) {
  return await fetch(`http://127.0.0.1:${params.port}/v1/pairings/token`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel: params.channel,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      ...(params.routeKey ? { routeKey: params.routeKey } : {}),
      ...(params.ttlSec ? { ttlSec: params.ttlSec } : {}),
    }),
  });
}

async function getInboundTarget(params: { port: number; apiKey: string }) {
  return await fetch(`http://127.0.0.1:${params.port}/v1/tenant/inbound-target`, {
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
    },
  });
}

async function setInboundTarget(params: {
  port: number;
  apiKey: string;
  inboundUrl: string;
  inboundTimeoutMs?: number;
}) {
  return await fetch(`http://127.0.0.1:${params.port}/v1/tenant/inbound-target`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      inboundUrl: params.inboundUrl,
      ...(params.inboundTimeoutMs ? { inboundTimeoutMs: params.inboundTimeoutMs } : {}),
    }),
  });
}

async function bootstrapTenant(params: {
  port: number;
  adminToken: string;
  tenantId: string;
  name?: string;
  apiKey: string;
  inboundUrl: string;
  inboundTimeoutMs?: number;
}) {
  return await fetch(`http://127.0.0.1:${params.port}/v1/admin/tenants/bootstrap`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.adminToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tenantId: params.tenantId,
      ...(params.name ? { name: params.name } : {}),
      apiKey: params.apiKey,
      inboundUrl: params.inboundUrl,
      ...(params.inboundTimeoutMs ? { inboundTimeoutMs: params.inboundTimeoutMs } : {}),
    }),
  });
}

describe("mux server", () => {
  test("health endpoint responds", async () => {
    const server = await startServer();
    const response = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("outbound endpoint rejects unauthorized requests", async () => {
    const server = await startServer();
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer wrong-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestPayload("hello")),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: "unauthorized" });
  });

  test("supports per-tenant auth from MUX_TENANTS_JSON", async () => {
    const server = await startServer({
      apiKey: "fallback-key",
      tenantsJson: JSON.stringify([
        { id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" },
        { id: "tenant-b", name: "Tenant B", apiKey: "tenant-b-key" },
      ]),
    });

    const valid = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestPayload("message without binding")),
    });
    expect(valid.status).toBe(403);
    expect(await valid.json()).toEqual({
      ok: false,
      error: "route not bound",
      code: "ROUTE_NOT_BOUND",
    });

    const fallback = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer fallback-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestPayload("missing to should return 400")),
    });
    expect(fallback.status).toBe(401);
    expect(await fallback.json()).toEqual({ ok: false, error: "unauthorized" });
  });

  test("admin bootstrap registers tenant with shared-key inbound auth", async () => {
    const server = await startServer({
      extraEnv: {
        MUX_ADMIN_TOKEN: "admin-secret",
      },
      tenantsJson: JSON.stringify([{ id: "seed", name: "Seed", apiKey: "seed-key" }]),
    });

    const bootstrap = await bootstrapTenant({
      port: server.port,
      adminToken: "admin-secret",
      tenantId: "tenant-cp-1",
      name: "Tenant CP 1",
      apiKey: "tenant-cp-key",
      inboundUrl: "http://127.0.0.1:18789/v1/mux/inbound",
      inboundTimeoutMs: 12_000,
    });
    expect(bootstrap.status).toBe(200);
    await expect(bootstrap.json()).resolves.toMatchObject({
      ok: true,
      tenantId: "tenant-cp-1",
      inboundUrl: "http://127.0.0.1:18789/v1/mux/inbound",
      inboundTimeoutMs: 12_000,
      sharedTenantKey: true,
    });

    const tenantProbe = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-cp-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestPayload("probe")),
    });
    expect(tenantProbe.status).toBe(403);
    await expect(tenantProbe.json()).resolves.toMatchObject({
      ok: false,
      error: "route not bound",
      code: "ROUTE_NOT_BOUND",
    });

    const inboundTarget = await getInboundTarget({
      port: server.port,
      apiKey: "tenant-cp-key",
    });
    expect(inboundTarget.status).toBe(200);
    await expect(inboundTarget.json()).resolves.toMatchObject({
      ok: true,
      configured: true,
      inboundUrl: "http://127.0.0.1:18789/v1/mux/inbound",
      inboundTimeoutMs: 12_000,
    });
  });

  test("tenant inbound target update uses tenant api key for inbound auth", async () => {
    const inboundRequests: Array<Record<string, unknown>> = [];
    const inbound = await startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      inboundRequests.push({
        auth: req.headers.authorization,
        payload: await readJsonBody(req),
      });
      if (req.headers.authorization !== "Bearer tenant-a-key") {
        res.writeHead(401, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "bad auth" }));
        return;
      }
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });

    let releaseUpdate = false;
    const telegramApi = await startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/botdummy-token/getUpdates") {
        res.writeHead(404);
        res.end();
        return;
      }
      const body = await readJsonBody(req);
      const offset = typeof body.offset === "number" ? Number(body.offset) : 0;
      const result =
        releaseUpdate && offset <= 700
          ? [
              {
                update_id: 700,
                message: {
                  message_id: 701,
                  date: 1_700_000_111,
                  text: "default shared key target",
                  from: { id: 1234 },
                  chat: { id: -100558, type: "supergroup" },
                },
              },
            ]
          : [];
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, result }));
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-SHARED-TARGET-1",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100558",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_INBOUND_ENABLED: "true",
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
        MUX_TELEGRAM_POLL_TIMEOUT_SEC: "1",
        MUX_TELEGRAM_POLL_RETRY_MS: "50",
        MUX_TELEGRAM_BOOTSTRAP_LATEST: "false",
      },
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-SHARED-TARGET-1",
      sessionKey: "tg:group:-100558",
    });
    expect(claim.status).toBe(200);

    const updateTarget = await setInboundTarget({
      port: server.port,
      apiKey: "tenant-a-key",
      inboundUrl: `${inbound.url}/v1/mux/inbound`,
      inboundTimeoutMs: 2_000,
    });
    expect(updateTarget.status).toBe(200);
    await expect(updateTarget.json()).resolves.toMatchObject({
      ok: true,
      inboundUrl: `${inbound.url}/v1/mux/inbound`,
    });

    releaseUpdate = true;
    await waitForCondition(
      () => inboundRequests.length >= 1,
      8_000,
      "timed out waiting for shared-key inbound target forward",
    );
    expect(inboundRequests[0]?.auth).toBe("Bearer tenant-a-key");
    expect((inboundRequests[0]?.payload as Record<string, unknown>)?.body).toBe(
      "default shared key target",
    );
  }, 15_000);

  test("updates tenant inbound target at runtime and forwards new inbound traffic to updated target", async () => {
    const inboundARequests: Array<Record<string, unknown>> = [];
    const inboundBRequests: Array<Record<string, unknown>> = [];
    const inboundA = await startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.headers.authorization !== "Bearer tenant-a-key") {
        res.writeHead(401);
        res.end();
        return;
      }
      inboundARequests.push(await readJsonBody(req));
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });
    const inboundB = await startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.headers.authorization !== "Bearer tenant-a-key") {
        res.writeHead(401);
        res.end();
        return;
      }
      inboundBRequests.push(await readJsonBody(req));
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });

    let releaseFirst = false;
    let releaseSecond = false;
    const telegramApi = await startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/botdummy-token/getUpdates") {
        res.writeHead(404);
        res.end();
        return;
      }
      const body = await readJsonBody(req);
      const offset = typeof body.offset === "number" ? Number(body.offset) : 0;
      let result: unknown[] = [];
      if (releaseFirst && offset <= 461) {
        result = [
          {
            update_id: 461,
            message: {
              message_id: 470,
              date: 1_700_000_000,
              text: "first target",
              from: { id: 1234 },
              chat: { id: -100557, type: "supergroup" },
            },
          },
        ];
      } else if (releaseSecond && offset <= 462) {
        result = [
          {
            update_id: 462,
            message: {
              message_id: 471,
              date: 1_700_000_001,
              text: "second target",
              from: { id: 1234 },
              chat: { id: -100557, type: "supergroup" },
            },
          },
        ];
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, result }));
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([
        {
          id: "tenant-a",
          name: "Tenant A",
          apiKey: "tenant-a-key",
          inboundUrl: `${inboundA.url}/v1/mux/inbound`,
          inboundTimeoutMs: 2_000,
        },
      ]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-ROTATE-TARGET-1",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100557",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_INBOUND_ENABLED: "true",
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
        MUX_TELEGRAM_POLL_TIMEOUT_SEC: "1",
        MUX_TELEGRAM_POLL_RETRY_MS: "50",
        MUX_TELEGRAM_BOOTSTRAP_LATEST: "false",
      },
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-ROTATE-TARGET-1",
      sessionKey: "tg:group:-100557",
    });
    expect(claim.status).toBe(200);

    const getBefore = await getInboundTarget({ port: server.port, apiKey: "tenant-a-key" });
    expect(getBefore.status).toBe(200);
    await expect(getBefore.json()).resolves.toMatchObject({
      ok: true,
      configured: true,
      inboundUrl: `${inboundA.url}/v1/mux/inbound`,
    });

    releaseFirst = true;
    await waitForCondition(
      () => inboundARequests.length >= 1,
      8_000,
      "timed out waiting for first inbound target",
    );
    expect(inboundARequests[0]?.body).toBe("first target");

    const updateTarget = await setInboundTarget({
      port: server.port,
      apiKey: "tenant-a-key",
      inboundUrl: `${inboundB.url}/v1/mux/inbound`,
      inboundTimeoutMs: 2_000,
    });
    expect(updateTarget.status).toBe(200);
    await expect(updateTarget.json()).resolves.toMatchObject({
      ok: true,
      inboundUrl: `${inboundB.url}/v1/mux/inbound`,
    });

    const getAfter = await getInboundTarget({ port: server.port, apiKey: "tenant-a-key" });
    expect(getAfter.status).toBe(200);
    await expect(getAfter.json()).resolves.toMatchObject({
      ok: true,
      configured: true,
      inboundUrl: `${inboundB.url}/v1/mux/inbound`,
    });

    releaseSecond = true;
    await waitForCondition(
      () => inboundBRequests.length >= 1,
      8_000,
      "timed out waiting for rotated inbound target",
    );
    expect(inboundBRequests[0]?.body).toBe("second target");
    expect(inboundARequests.length).toBe(1);
  }, 20_000);

  test("supports pairing claim/list/unbind", async () => {
    const server = await startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-1",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100123",
          scope: "chat",
        },
      ]),
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-1",
      sessionKey: "tg:group:-100123:thread:2",
    });
    expect(claim.status).toBe(200);
    const claimBody = (await claim.json()) as {
      bindingId: string;
      channel: string;
      scope: string;
      routeKey: string;
    };
    expect(claimBody.channel).toBe("telegram");
    expect(claimBody.scope).toBe("chat");
    expect(claimBody.routeKey).toBe("telegram:default:chat:-100123");
    expect(claimBody.bindingId).toContain("bind_");
    expect((claimBody as Record<string, unknown>).sessionKey).toBe("tg:group:-100123:thread:2");

    const listedBeforeUnbind = await listPairings({ port: server.port, apiKey: "tenant-a-key" });
    expect(listedBeforeUnbind.status).toBe(200);
    expect(await listedBeforeUnbind.json()).toEqual({
      items: [
        {
          bindingId: claimBody.bindingId,
          channel: "telegram",
          scope: "chat",
          routeKey: "telegram:default:chat:-100123",
        },
      ],
    });

    const unbind = await unbindPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      bindingId: claimBody.bindingId,
    });
    expect(unbind.status).toBe(200);
    expect(await unbind.json()).toEqual({ ok: true });

    const listedAfterUnbind = await listPairings({ port: server.port, apiKey: "tenant-a-key" });
    expect(listedAfterUnbind.status).toBe(200);
    expect(await listedAfterUnbind.json()).toEqual({ items: [] });
  });

  test("rejects duplicate pairing claim", async () => {
    const server = await startServer({
      tenantsJson: JSON.stringify([
        { id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" },
        { id: "tenant-b", name: "Tenant B", apiKey: "tenant-b-key" },
      ]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-2",
          channel: "discord",
          routeKey: "discord:default:guild:123456",
          scope: "guild",
        },
      ]),
    });

    const firstClaim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-2",
    });
    expect(firstClaim.status).toBe(200);

    const secondClaim = await claimPairing({
      port: server.port,
      apiKey: "tenant-b-key",
      code: "PAIR-2",
    });
    expect(secondClaim.status).toBe(409);
    expect(await secondClaim.json()).toEqual({
      ok: false,
      error: "pairing code already claimed",
    });
  });

  test("outbound resolves route from (tenant, channel, sessionKey) mapping", async () => {
    const server = await startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-3",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100123:topic:2",
          scope: "chat",
        },
      ]),
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-3",
      sessionKey: "tg:group:-100123:thread:2",
    });
    expect(claim.status).toBe(200);

    const outbound = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "telegram",
        sessionKey: "tg:group:-100123:thread:2",
        to: "this-is-ignored-on-purpose",
        text: "",
      }),
    });
    expect(outbound.status).toBe(400);
    expect(await outbound.json()).toEqual({
      ok: false,
      error: "text or mediaUrl(s) required",
    });
  });

  test("telegram outbound forwards inline keyboard from channelData", async () => {
    const telegramRequests: Array<Record<string, unknown>> = [];
    const telegramApi = await startHttpServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/botdummy-token/sendMessage") {
        telegramRequests.push(await readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: true,
            result: { message_id: 901, chat: { id: -100123 } },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-TG-BTN",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100123:topic:2",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
      },
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-TG-BTN",
      sessionKey: "tg:group:-100123:thread:2",
    });
    expect(claim.status).toBe(200);

    const outbound = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "telegram",
        sessionKey: "tg:group:-100123:thread:2",
        text: "paged commands",
        channelData: {
          telegram: {
            buttons: [[{ text: "Next ▶", callback_data: "commands_page_2:main" }]],
          },
        },
      }),
    });

    expect(outbound.status).toBe(200);
    expect(await outbound.json()).toMatchObject({
      ok: true,
      messageId: "901",
      chatId: "-100123",
    });
    expect(telegramRequests).toHaveLength(1);
    expect(telegramRequests[0]).toMatchObject({
      chat_id: "-100123",
      text: "paged commands",
      message_thread_id: 2,
      reply_markup: {
        inline_keyboard: [[{ text: "Next ▶", callback_data: "commands_page_2:main" }]],
      },
    });
  });

  test("telegram outbound raw envelope preserves body and enforces route lock", async () => {
    const telegramRequests: Array<Record<string, unknown>> = [];
    const telegramApi = await startHttpServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/botdummy-token/sendMessage") {
        telegramRequests.push(await readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: true,
            result: { message_id: 9901, chat: { id: -100123 } },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-TG-RAW",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100123:topic:2",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
      },
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-TG-RAW",
      sessionKey: "tg:group:-100123:thread:2",
    });
    expect(claim.status).toBe(200);

    const outbound = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "telegram",
        sessionKey: "tg:group:-100123:thread:2",
        raw: {
          telegram: {
            method: "sendMessage",
            body: {
              chat_id: "999999",
              text: "<b>raw payload</b>",
              parse_mode: "HTML",
            },
          },
        },
      }),
    });

    expect(outbound.status).toBe(200);
    expect(await outbound.json()).toMatchObject({
      ok: true,
      messageId: "9901",
      rawPassthrough: true,
    });
    expect(telegramRequests).toHaveLength(1);
    expect(telegramRequests[0]).toMatchObject({
      chat_id: "-100123",
      message_thread_id: 2,
      text: "<b>raw payload</b>",
      parse_mode: "HTML",
    });
  });

  test("telegram outbound raw editMessageText keeps route lock and skips thread id injection", async () => {
    const telegramRequests: Array<Record<string, unknown>> = [];
    const telegramApi = await startHttpServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/botdummy-token/editMessageText") {
        telegramRequests.push(await readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: true,
            result: { message_id: 9902, chat: { id: -100123 } },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-TG-RAW-EDIT",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100123:topic:2",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
      },
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-TG-RAW-EDIT",
      sessionKey: "tg:group:-100123:thread:2",
    });
    expect(claim.status).toBe(200);

    const outbound = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "telegram",
        sessionKey: "tg:group:-100123:thread:2",
        raw: {
          telegram: {
            method: "editMessageText",
            body: {
              message_id: 321,
              text: "page 2",
            },
          },
        },
      }),
    });

    expect(outbound.status).toBe(200);
    expect(await outbound.json()).toMatchObject({
      ok: true,
      messageId: "9902",
      rawPassthrough: true,
    });
    expect(telegramRequests).toHaveLength(1);
    expect(telegramRequests[0]).toMatchObject({
      chat_id: "-100123",
      message_id: 321,
      text: "page 2",
    });
    expect(telegramRequests[0]?.message_thread_id).toBeUndefined();
  });

  test("telegram typing action via /send sends chat action for bound route", async () => {
    const telegramRequests: Array<Record<string, unknown>> = [];
    const telegramApi = await startHttpServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/botdummy-token/sendChatAction") {
        telegramRequests.push(await readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, result: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-TG-TYPING",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100123:topic:2",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
      },
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-TG-TYPING",
      sessionKey: "tg:group:-100123:thread:2",
    });
    expect(claim.status).toBe(200);

    const typing = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        op: "action",
        action: "typing",
        channel: "telegram",
        sessionKey: "tg:group:-100123:thread:2",
      }),
    });

    expect(typing.status).toBe(200);
    expect(await typing.json()).toEqual({ ok: true });
    expect(telegramRequests).toHaveLength(1);
    expect(telegramRequests[0]).toMatchObject({
      chat_id: "-100123",
      action: "typing",
      message_thread_id: 2,
    });
  });

  test("discord typing action via /send triggers typing on bound DM route", async () => {
    const discordRequests: Array<{
      method: string;
      url: string;
      body?: Record<string, unknown>;
    }> = [];

    const discordApi = await startHttpServer(async (req, res) => {
      const method = req.method ?? "GET";
      const url = req.url ?? "/";
      if (method === "POST" && url === "/users/@me/channels") {
        const body = await readJsonBody(req);
        discordRequests.push({ method, url, body });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ id: "6001" }));
        return;
      }
      if (method === "POST" && url === "/channels/6001/typing") {
        discordRequests.push({ method, url });
        res.writeHead(204);
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-DISCORD-TYPING",
          channel: "discord",
          routeKey: "discord:default:dm:user:42",
          scope: "dm",
        },
      ]),
      extraEnv: {
        MUX_DISCORD_API_BASE_URL: discordApi.url,
      },
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-DISCORD-TYPING",
      sessionKey: "dc:dm:42",
    });
    expect(claim.status).toBe(200);

    const typing = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        op: "action",
        action: "typing",
        channel: "discord",
        sessionKey: "dc:dm:42",
      }),
    });

    expect(typing.status).toBe(200);
    expect(await typing.json()).toEqual({ ok: true });
    expect(discordRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "POST",
          url: "/users/@me/channels",
          body: { recipient_id: "42" },
        }),
        expect.objectContaining({
          method: "POST",
          url: "/channels/6001/typing",
        }),
      ]),
    );
  });

  test("discord outbound raw envelope forwards body unchanged", async () => {
    const discordRequests: Array<{
      method: string;
      url: string;
      body?: Record<string, unknown>;
    }> = [];

    const discordApi = await startHttpServer(async (req, res) => {
      const method = req.method ?? "GET";
      const url = req.url ?? "/";
      if (method === "POST" && url === "/users/@me/channels") {
        const body = await readJsonBody(req);
        discordRequests.push({ method, url, body });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ id: "2001" }));
        return;
      }
      if (method === "POST" && url === "/channels/2001/messages") {
        const body = await readJsonBody(req);
        discordRequests.push({ method, url, body });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ id: "7007", channel_id: "2001" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-DISCORD-RAW",
          channel: "discord",
          routeKey: "discord:default:dm:user:42",
          scope: "dm",
        },
      ]),
      extraEnv: {
        MUX_DISCORD_API_BASE_URL: discordApi.url,
      },
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-DISCORD-RAW",
      sessionKey: "dc:dm:42",
    });
    expect(claim.status).toBe(200);

    const rawBody = {
      content: "raw body",
      components: [{ type: 1, components: [{ type: 2, style: 1, label: "OK", custom_id: "ok" }] }],
    };

    const outbound = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "discord",
        sessionKey: "dc:dm:42",
        raw: {
          discord: {
            body: rawBody,
          },
        },
      }),
    });

    expect(outbound.status).toBe(200);
    expect(await outbound.json()).toMatchObject({
      ok: true,
      messageId: "7007",
      channelId: "2001",
      rawPassthrough: true,
    });
    expect(discordRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "POST",
          url: "/channels/2001/messages",
          body: rawBody,
        }),
      ]),
    );
  });

  test("sends discord outbound through guild-bound route and enforces guild lock", async () => {
    const discordRequests: Array<{
      method: string;
      url: string;
      authorization?: string;
      body?: Record<string, unknown>;
    }> = [];

    const discordApi = await startHttpServer(async (req, res) => {
      const authorization =
        typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
      const method = req.method ?? "GET";
      const url = req.url ?? "/";

      if (method === "GET" && url === "/channels/2001") {
        discordRequests.push({ method, url, authorization });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ id: "2001", guild_id: "9001" }));
        return;
      }
      if (method === "GET" && url === "/channels/2999") {
        discordRequests.push({ method, url, authorization });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ id: "2999", guild_id: "9002" }));
        return;
      }
      if (method === "POST" && url === "/channels/2001/messages") {
        const body = await readJsonBody(req);
        discordRequests.push({ method, url, authorization, body });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ id: "7001", channel_id: "2001" }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-DISCORD-GUILD",
          channel: "discord",
          routeKey: "discord:default:guild:9001",
          scope: "guild",
        },
      ]),
      extraEnv: {
        MUX_DISCORD_API_BASE_URL: discordApi.url,
      },
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-DISCORD-GUILD",
      sessionKey: "dc:guild:9001",
    });
    expect(claim.status).toBe(200);

    const allowed = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "discord",
        sessionKey: "dc:guild:9001",
        to: "channel:2001",
        text: "hello discord",
      }),
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({
      ok: true,
      messageId: "7001",
      channelId: "2001",
      providerMessageIds: ["7001"],
    });

    const denied = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "discord",
        sessionKey: "dc:guild:9001",
        to: "channel:2999",
        text: "should fail",
      }),
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      ok: false,
      error: "discord channel not allowed for this bound guild",
    });

    expect(
      discordRequests.some(
        (entry) => entry.method === "POST" && entry.url === "/channels/2001/messages",
      ),
    ).toBe(true);
    expect(
      discordRequests.every((entry) => entry.authorization === "Bot dummy-discord-token"),
    ).toBe(true);
  });

  test("sends discord outbound through dm-bound route", async () => {
    const discordRequests: Array<{
      method: string;
      url: string;
      body?: Record<string, unknown>;
    }> = [];
    const discordApi = await startHttpServer(async (req, res) => {
      const method = req.method ?? "GET";
      const url = req.url ?? "/";
      if (method === "POST" && url === "/users/@me/channels") {
        const body = await readJsonBody(req);
        discordRequests.push({ method, url, body });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ id: "3001" }));
        return;
      }
      if (method === "POST" && url === "/channels/3001/messages") {
        const body = await readJsonBody(req);
        discordRequests.push({ method, url, body });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ id: "8001", channel_id: "3001" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-DISCORD-DM",
          channel: "discord",
          routeKey: "discord:default:dm:user:4242",
          scope: "dm",
        },
      ]),
      extraEnv: {
        MUX_DISCORD_API_BASE_URL: discordApi.url,
      },
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-DISCORD-DM",
      sessionKey: "dc:dm:4242",
    });
    expect(claim.status).toBe(200);

    const response = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "discord",
        sessionKey: "dc:dm:4242",
        to: "user:9999",
        text: "hello dm",
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      messageId: "8001",
      channelId: "3001",
      providerMessageIds: ["8001"],
    });

    const dmCreate = discordRequests.find(
      (entry) => entry.method === "POST" && entry.url === "/users/@me/channels",
    );
    expect(dmCreate?.body).toEqual({ recipient_id: "4242" });
    const sent = discordRequests.find(
      (entry) => entry.method === "POST" && entry.url === "/channels/3001/messages",
    );
    expect(sent?.body).toMatchObject({
      content: "hello dm",
    });
  });

  test("forwards inbound Telegram updates to tenant inbound endpoint", async () => {
    const inboundRequests: Array<{
      authorization: string | undefined;
      payload: Record<string, unknown>;
    }> = [];
    const inbound = await startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      const payload = await readJsonBody(req);
      const authorization =
        typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
      inboundRequests.push({ authorization, payload });
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });

    const telegramRequests: Array<Record<string, unknown>> = [];
    let releaseUpdates = false;
    let hasSentUpdate = false;
    const telegramApi = await startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/botdummy-token/getUpdates") {
        res.writeHead(404);
        res.end();
        return;
      }
      const body = await readJsonBody(req);
      telegramRequests.push(body);
      const hasOffset = typeof body.offset === "number";
      const shouldSend = hasOffset && releaseUpdates && !hasSentUpdate;
      if (shouldSend) {
        hasSentUpdate = true;
      }
      const result = shouldSend
        ? [
            {
              update_id: 461,
              message: {
                message_id: 462,
                date: 1_700_000_000,
                text: "  hello from mux inbound  ",
                from: { id: 1234 },
                chat: { id: -100555, type: "supergroup" },
              },
            },
          ]
        : [];
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, result }));
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([
        {
          id: "tenant-a",
          name: "Tenant A",
          apiKey: "tenant-a-key",
          inboundUrl: `${inbound.url}/v1/mux/inbound`,
          inboundTimeoutMs: 2_000,
        },
      ]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-IN-1",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100555",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_INBOUND_ENABLED: "true",
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
        MUX_TELEGRAM_POLL_TIMEOUT_SEC: "1",
        MUX_TELEGRAM_POLL_RETRY_MS: "50",
        MUX_TELEGRAM_BOOTSTRAP_LATEST: "false",
      },
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-IN-1",
      sessionKey: "tg:group:-100555",
    });
    expect(claim.status).toBe(200);
    releaseUpdates = true;

    await waitForCondition(
      () => inboundRequests.length > 0,
      5_000,
      "timed out waiting for inbound forward",
    );

    expect(inboundRequests).toHaveLength(1);
    expect(inboundRequests[0]?.authorization).toBe("Bearer tenant-a-key");
    expect(inboundRequests[0]?.payload).toMatchObject({
      eventId: "tg:461",
      channel: "telegram",
      sessionKey: "tg:group:-100555",
      body: "  hello from mux inbound  ",
      from: "telegram:1234",
      to: "telegram:-100555",
      accountId: "default",
      chatType: "group",
      messageId: "462",
      channelData: {
        accountId: "default",
        messageId: "462",
        chatId: "-100555",
        topicId: null,
        routeKey: "telegram:default:chat:-100555",
        updateId: 461,
      },
    });
    expect(
      telegramRequests.some(
        (request) => typeof request.offset === "number" && Number(request.offset) >= 1,
      ),
    ).toBe(true);
  });

  test("forwards Telegram callback queries without transport rewriting", async () => {
    const inboundRequests: Array<Record<string, unknown>> = [];
    const inbound = await startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      inboundRequests.push(await readJsonBody(req));
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });

    const callbackAnswers: Array<Record<string, unknown>> = [];
    let releaseUpdates = false;
    let hasSentUpdate = false;
    const telegramApi = await startHttpServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/botdummy-token/getUpdates") {
        const body = await readJsonBody(req);
        const hasOffset = typeof body.offset === "number";
        const shouldSend = hasOffset && releaseUpdates && !hasSentUpdate;
        if (shouldSend) {
          hasSentUpdate = true;
        }
        const result = shouldSend
          ? [
              {
                update_id: 470,
                callback_query: {
                  id: "cbq-1",
                  from: { id: 1234 },
                  data: "commands_page_2:main",
                  message: {
                    message_id: 777,
                    date: 1_700_000_001,
                    text: "ℹ️ Slash commands",
                    from: { id: 9999 },
                    chat: { id: -100555, type: "supergroup" },
                  },
                },
              },
            ]
          : [];
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, result }));
        return;
      }
      if (req.method === "POST" && req.url === "/botdummy-token/answerCallbackQuery") {
        callbackAnswers.push(await readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, result: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([
        {
          id: "tenant-a",
          name: "Tenant A",
          apiKey: "tenant-a-key",
          inboundUrl: `${inbound.url}/v1/mux/inbound`,
          inboundTimeoutMs: 2_000,
        },
      ]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-CB-TG-1",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100555",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_INBOUND_ENABLED: "true",
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
        MUX_TELEGRAM_POLL_TIMEOUT_SEC: "1",
        MUX_TELEGRAM_POLL_RETRY_MS: "50",
        MUX_TELEGRAM_BOOTSTRAP_LATEST: "false",
      },
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-CB-TG-1",
      sessionKey: "tg:group:-100555",
    });
    expect(claim.status).toBe(200);
    releaseUpdates = true;

    await waitForCondition(
      () => inboundRequests.length > 0 && callbackAnswers.length > 0,
      5_000,
      "timed out waiting for callback forwarding",
    );

    expect(inboundRequests[0]).toMatchObject({
      eventId: "tgcb:470",
      channel: "telegram",
      event: {
        kind: "callback",
      },
      raw: {
        callbackQuery: {
          id: "cbq-1",
        },
      },
      sessionKey: "tg:group:-100555",
      body: "commands_page_2:main",
      from: "telegram:1234",
      to: "telegram:-100555",
      accountId: "default",
      messageId: "777",
      channelData: {
        routeKey: "telegram:default:chat:-100555",
        telegram: {
          callbackData: "commands_page_2:main",
          callbackQueryId: "cbq-1",
          callbackMessageId: "777",
        },
      },
    });
    expect(callbackAnswers[0]).toMatchObject({
      callback_query_id: "cbq-1",
    });
  });

  test("retries Telegram inbound without advancing offset when forward fails", async () => {
    const inboundAttempts: Array<Record<string, unknown>> = [];
    let failFirstForward = true;
    const inbound = await startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      inboundAttempts.push(await readJsonBody(req));
      if (failFirstForward) {
        failFirstForward = false;
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "retry me" }));
        return;
      }
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });

    const telegramRequests: Array<Record<string, unknown>> = [];
    let releaseUpdates = false;
    const telegramApi = await startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/botdummy-token/getUpdates") {
        res.writeHead(404);
        res.end();
        return;
      }
      const body = await readJsonBody(req);
      telegramRequests.push(body);
      const offset = typeof body.offset === "number" ? Number(body.offset) : 0;
      const result =
        releaseUpdates && offset <= 461
          ? [
              {
                update_id: 461,
                message: {
                  message_id: 462,
                  date: 1_700_000_000,
                  text: "retry telegram message",
                  from: { id: 1234 },
                  chat: { id: -100556, type: "supergroup" },
                },
              },
            ]
          : [];
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, result }));
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([
        {
          id: "tenant-a",
          name: "Tenant A",
          apiKey: "tenant-a-key",
          inboundUrl: `${inbound.url}/v1/mux/inbound`,
          inboundTimeoutMs: 2_000,
        },
      ]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-IN-RETRY-TG-1",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100556",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_INBOUND_ENABLED: "true",
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
        MUX_TELEGRAM_POLL_TIMEOUT_SEC: "1",
        MUX_TELEGRAM_POLL_RETRY_MS: "50",
        MUX_TELEGRAM_BOOTSTRAP_LATEST: "false",
      },
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-IN-RETRY-TG-1",
      sessionKey: "tg:group:-100556",
    });
    expect(claim.status).toBe(200);
    releaseUpdates = true;

    await waitForCondition(
      () => inboundAttempts.length >= 2,
      6_000,
      "timed out waiting for telegram retry forward",
    );

    expect(inboundAttempts[0]?.body).toBe("retry telegram message");
    expect(inboundAttempts[1]?.body).toBe("retry telegram message");

    const seenOffsets = telegramRequests
      .map((request) => (typeof request.offset === "number" ? Number(request.offset) : null))
      .filter((offset): offset is number => offset !== null);
    expect(seenOffsets.filter((offset) => offset === 1).length).toBeGreaterThanOrEqual(2);
    expect(seenOffsets.some((offset) => offset === 462)).toBe(true);
  }, 15_000);

  test("forwards media-only Telegram photo updates with attachment payload", async () => {
    const inboundRequests: Array<Record<string, unknown>> = [];
    const inbound = await startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      inboundRequests.push(await readJsonBody(req));
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });

    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5ZfXkAAAAASUVORK5CYII=";
    const pngBuffer = Buffer.from(pngBase64, "base64");
    let releaseUpdates = false;
    let hasSentUpdate = false;
    const telegramApi = await startHttpServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/botdummy-token/getUpdates") {
        const body = await readJsonBody(req);
        const hasOffset = typeof body.offset === "number";
        const shouldSend = hasOffset && releaseUpdates && !hasSentUpdate;
        if (shouldSend) {
          hasSentUpdate = true;
        }
        const result = shouldSend
          ? [
              {
                update_id: 4901,
                message: {
                  message_id: 9001,
                  date: 1_700_000_100,
                  from: { id: 1234 },
                  chat: { id: 999, type: "private" },
                  photo: [
                    { file_id: "small-photo-id", width: 16, height: 16, file_size: 100 },
                    { file_id: "best-photo-id", width: 1024, height: 1024, file_size: 4096 },
                  ],
                },
              },
            ]
          : [];
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, result }));
        return;
      }

      if (req.method === "POST" && req.url === "/botdummy-token/getFile") {
        const body = await readJsonBody(req);
        if (body.file_id !== "best-photo-id") {
          res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, result: { file_path: "photos/cat.png" } }));
        return;
      }

      if (req.method === "GET" && req.url === "/file/botdummy-token/photos/cat.png") {
        res.writeHead(200, {
          "content-type": "image/png",
          "content-length": String(pngBuffer.byteLength),
        });
        res.end(pngBuffer);
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([
        {
          id: "tenant-a",
          name: "Tenant A",
          apiKey: "tenant-a-key",
          inboundUrl: `${inbound.url}/v1/mux/inbound`,
          inboundTimeoutMs: 2_000,
        },
      ]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-IN-MEDIA-1",
          channel: "telegram",
          routeKey: "telegram:default:chat:999",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_INBOUND_ENABLED: "true",
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
        MUX_TELEGRAM_POLL_TIMEOUT_SEC: "1",
        MUX_TELEGRAM_POLL_RETRY_MS: "50",
        MUX_TELEGRAM_BOOTSTRAP_LATEST: "false",
      },
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-IN-MEDIA-1",
      sessionKey: "tg:chat:999",
    });
    expect(claim.status).toBe(200);

    releaseUpdates = true;
    await waitForCondition(
      () => inboundRequests.length > 0,
      5_000,
      "timed out waiting for media-only inbound forward",
    );

    expect(inboundRequests).toHaveLength(1);
    const payload = inboundRequests[0] as Record<string, unknown>;
    expect(payload.channel).toBe("telegram");
    expect(payload.sessionKey).toBe("tg:chat:999");
    expect(payload.body).toBe("");
    expect(payload.messageId).toBe("9001");

    const attachments = Array.isArray(payload.attachments)
      ? (payload.attachments as Array<Record<string, unknown>>)
      : [];
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.mimeType).toBe("image/png");
    expect(typeof attachments[0]?.content).toBe("string");
    expect(String(attachments[0]?.content)).toBe(pngBase64);

    const channelData =
      payload.channelData && typeof payload.channelData === "object"
        ? (payload.channelData as Record<string, unknown>)
        : {};
    const telegramData =
      channelData.telegram && typeof channelData.telegram === "object"
        ? (channelData.telegram as Record<string, unknown>)
        : {};
    const media = Array.isArray(telegramData.media)
      ? (telegramData.media as Array<Record<string, unknown>>)
      : [];
    expect(media).toHaveLength(1);
    expect(media[0]?.kind).toBe("photo");
    expect(media[0]?.fileId).toBe("best-photo-id");
    expect(media[0]?.filePath).toBe("photos/cat.png");
    expect(channelData.telegram).toBeDefined();
    const rawTelegram =
      channelData.telegram && typeof channelData.telegram === "object"
        ? (channelData.telegram as Record<string, unknown>)
        : {};
    const rawMessage =
      rawTelegram.rawMessage && typeof rawTelegram.rawMessage === "object"
        ? (rawTelegram.rawMessage as Record<string, unknown>)
        : {};
    expect(rawMessage.message_id).toBe(9001);
    const rawUpdate =
      rawTelegram.rawUpdate && typeof rawTelegram.rawUpdate === "object"
        ? (rawTelegram.rawUpdate as Record<string, unknown>)
        : {};
    expect(rawUpdate.update_id).toBe(4901);
  });

  test("forwards inbound Discord DM messages with raw payload and media attachment", async () => {
    const inboundRequests: Array<Record<string, unknown>> = [];
    const inbound = await startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      inboundRequests.push(await readJsonBody(req));
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });

    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5ZfXkAAAAASUVORK5CYII=";
    const pngBuffer = Buffer.from(pngBase64, "base64");
    let deliveredMessage = false;

    const discordApi = await startHttpServer(async (req, res) => {
      const method = req.method ?? "GET";
      const url = req.url ?? "/";
      if (method === "POST" && url === "/users/@me/channels") {
        const body = await readJsonBody(req);
        expect(body).toEqual({ recipient_id: "4242" });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ id: "3001" }));
        return;
      }
      if (method === "GET" && url.startsWith("/channels/3001/messages")) {
        const parsed = new URL(`http://127.0.0.1${url}`);
        const after = parsed.searchParams.get("after");
        if (!after && !deliveredMessage) {
          deliveredMessage = true;
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(
            JSON.stringify([
              {
                id: "9001",
                channel_id: "3001",
                content: "  hello from discord inbound  ",
                timestamp: "2026-02-07T03:00:00.000Z",
                author: { id: "4242", bot: false },
                attachments: [
                  {
                    id: "att-1",
                    filename: "cat.png",
                    content_type: "image/png",
                    size: pngBuffer.byteLength,
                    url: `${discordApi.url}/files/cat.png`,
                  },
                ],
              },
            ]),
          );
          return;
        }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify([]));
        return;
      }
      if (method === "GET" && url === "/files/cat.png") {
        res.writeHead(200, {
          "content-type": "image/png",
          "content-length": String(pngBuffer.byteLength),
        });
        res.end(pngBuffer);
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([
        {
          id: "tenant-a",
          name: "Tenant A",
          apiKey: "tenant-a-key",
          inboundUrl: `${inbound.url}/v1/mux/inbound`,
          inboundTimeoutMs: 2_000,
        },
      ]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-IN-DC-1",
          channel: "discord",
          routeKey: "discord:default:dm:user:4242",
          scope: "dm",
        },
      ]),
      extraEnv: {
        MUX_DISCORD_INBOUND_ENABLED: "true",
        MUX_DISCORD_API_BASE_URL: discordApi.url,
        MUX_DISCORD_POLL_INTERVAL_MS: "50",
        MUX_DISCORD_BOOTSTRAP_LATEST: "false",
      },
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-IN-DC-1",
      sessionKey: "dc:dm:4242",
    });
    expect(claim.status).toBe(200);

    await waitForCondition(
      () => inboundRequests.length > 0,
      5_000,
      "timed out waiting for discord inbound forward",
    );

    expect(inboundRequests).toHaveLength(1);
    const payload = inboundRequests[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      channel: "discord",
      sessionKey: "dc:dm:4242",
      body: "  hello from discord inbound  ",
      from: "discord:4242",
      to: "channel:3001",
      accountId: "default",
      chatType: "direct",
      messageId: "9001",
    });

    const attachments = Array.isArray(payload.attachments)
      ? (payload.attachments as Array<Record<string, unknown>>)
      : [];
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.mimeType).toBe("image/png");
    expect(typeof attachments[0]?.content).toBe("string");
    expect(String(attachments[0]?.content)).toBe(pngBase64);

    const channelData =
      payload.channelData && typeof payload.channelData === "object"
        ? (payload.channelData as Record<string, unknown>)
        : {};
    expect(channelData.routeKey).toBe("discord:default:dm:user:4242");
    const discordData =
      channelData.discord && typeof channelData.discord === "object"
        ? (channelData.discord as Record<string, unknown>)
        : {};
    const rawMessage =
      discordData.rawMessage && typeof discordData.rawMessage === "object"
        ? (discordData.rawMessage as Record<string, unknown>)
        : {};
    expect(rawMessage.id).toBe("9001");
    expect(rawMessage.content).toBe("  hello from discord inbound  ");
  });

  test("retries Discord failed message without replaying already-acked earlier message", async () => {
    const inboundAttempts: Array<Record<string, unknown>> = [];
    let msgTwoFailures = 0;
    const inbound = await startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      const payload = await readJsonBody(req);
      inboundAttempts.push(payload);
      if (payload.body === "msg-two" && msgTwoFailures === 0) {
        msgTwoFailures += 1;
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "retry me" }));
        return;
      }
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });

    const discordApi = await startHttpServer(async (req, res) => {
      const method = req.method ?? "GET";
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      if (method === "POST" && requestUrl.pathname === "/users/@me/channels") {
        const body = await readJsonBody(req);
        expect(body).toEqual({ recipient_id: "4242" });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ id: "3001" }));
        return;
      }
      if (method === "GET" && requestUrl.pathname === "/channels/3001/messages") {
        const after = requestUrl.searchParams.get("after");
        const result =
          after === null
            ? [
                {
                  id: "1001",
                  channel_id: "3001",
                  content: "msg-one",
                  timestamp: "2026-02-07T03:00:00.000Z",
                  author: { id: "4242", bot: false },
                  attachments: [],
                },
                {
                  id: "1002",
                  channel_id: "3001",
                  content: "msg-two",
                  timestamp: "2026-02-07T03:00:01.000Z",
                  author: { id: "4242", bot: false },
                  attachments: [],
                },
              ]
            : after === "1001"
              ? [
                  {
                    id: "1002",
                    channel_id: "3001",
                    content: "msg-two",
                    timestamp: "2026-02-07T03:00:01.000Z",
                    author: { id: "4242", bot: false },
                    attachments: [],
                  },
                ]
              : [];
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([
        {
          id: "tenant-a",
          name: "Tenant A",
          apiKey: "tenant-a-key",
          inboundUrl: `${inbound.url}/v1/mux/inbound`,
          inboundTimeoutMs: 2_000,
        },
      ]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-IN-DC-RETRY-1",
          channel: "discord",
          routeKey: "discord:default:dm:user:4242",
          scope: "dm",
        },
      ]),
      extraEnv: {
        MUX_DISCORD_INBOUND_ENABLED: "true",
        MUX_DISCORD_API_BASE_URL: discordApi.url,
        MUX_DISCORD_POLL_INTERVAL_MS: "50",
        MUX_DISCORD_BOOTSTRAP_LATEST: "false",
      },
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-IN-DC-RETRY-1",
      sessionKey: "dc:dm:4242",
    });
    expect(claim.status).toBe(200);

    await waitForCondition(
      () =>
        inboundAttempts.filter((payload) => payload.body === "msg-one").length >= 1 &&
        inboundAttempts.filter((payload) => payload.body === "msg-two").length >= 2,
      6_000,
      "timed out waiting for discord retry behavior",
    );

    const msgOneCount = inboundAttempts.filter((payload) => payload.body === "msg-one").length;
    const msgTwoCount = inboundAttempts.filter((payload) => payload.body === "msg-two").length;
    expect(msgOneCount).toBe(1);
    expect(msgTwoCount).toBe(2);
  }, 15_000);

  test("pairs from dashboard token sent via /start and forwards later message", async () => {
    const inboundRequests: Array<Record<string, unknown>> = [];
    const inbound = await startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      inboundRequests.push(await readJsonBody(req));
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });

    const pendingUpdates: Array<Record<string, unknown>> = [];
    const sentMessages: Array<Record<string, unknown>> = [];
    const telegramApi = await startHttpServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.url === "/botdummy-token/getUpdates") {
        const body = await readJsonBody(req);
        const offset = typeof body.offset === "number" ? Number(body.offset) : 0;
        const deliverable = pendingUpdates
          .map((entry) => {
            const updateId = Number(entry.update_id ?? 0);
            return { entry, updateId };
          })
          .filter((entry) => Number.isFinite(entry.updateId) && entry.updateId >= offset)
          .sort((a, b) => a.updateId - b.updateId);
        const result = deliverable.map((entry) => entry.entry);
        if (deliverable.length > 0) {
          const maxDelivered = deliverable[deliverable.length - 1]?.updateId ?? 0;
          for (let i = pendingUpdates.length - 1; i >= 0; i -= 1) {
            const updateId = Number(pendingUpdates[i]?.update_id ?? 0);
            if (Number.isFinite(updateId) && updateId <= maxDelivered) {
              pendingUpdates.splice(i, 1);
            }
          }
        }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, result }));
        return;
      }
      if (req.url === "/botdummy-token/sendMessage") {
        sentMessages.push(await readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: true,
            result: {
              message_id: 901,
              chat: { id: -100777, type: "supergroup", title: "pairing-test" },
            },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([
        {
          id: "tenant-a",
          name: "Tenant A",
          apiKey: "tenant-a-key",
          inboundUrl: `${inbound.url}/v1/mux/inbound`,
          inboundTimeoutMs: 2_000,
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_INBOUND_ENABLED: "true",
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
        MUX_TELEGRAM_POLL_TIMEOUT_SEC: "1",
        MUX_TELEGRAM_POLL_RETRY_MS: "50",
        MUX_TELEGRAM_BOOTSTRAP_LATEST: "false",
        MUX_TELEGRAM_BOT_USERNAME: "dummy_bot",
        MUX_PAIRING_INVALID_TEXT: "Invalid token. Request a new link.",
        MUX_UNPAIRED_HINT_TEXT: "This chat is not paired.",
      },
    });

    const tokenResponse = await createPairingToken({
      port: server.port,
      apiKey: "tenant-a-key",
      channel: "telegram",
      sessionKey: "tg:group:-100777:thread:2",
      ttlSec: 120,
    });
    expect(tokenResponse.status).toBe(200);
    const tokenBody = (await tokenResponse.json()) as {
      token: string;
      deepLink?: string | null;
      startCommand?: string | null;
    };
    expect(tokenBody.token.startsWith("mpt_")).toBe(true);
    expect(tokenBody.deepLink).toContain(tokenBody.token);
    expect(tokenBody.startCommand).toContain(tokenBody.token);

    pendingUpdates.push({
      update_id: 3001,
      message: {
        message_id: 8001,
        text: `/start ${tokenBody.token}`,
        date: 1_700_000_000,
        from: { id: 1234 },
        chat: { id: -100777, type: "supergroup" },
        message_thread_id: 2,
      },
    });
    pendingUpdates.push({
      update_id: 3002,
      message: {
        message_id: 8002,
        text: "hello after pair",
        date: 1_700_000_001,
        from: { id: 1234 },
        chat: { id: -100777, type: "supergroup" },
        message_thread_id: 2,
      },
    });
    pendingUpdates.push({
      update_id: 3003,
      message: {
        message_id: 8003,
        text: `/start ${tokenBody.token}`,
        date: 1_700_000_002,
        from: { id: 1234 },
        chat: { id: 999, type: "private" },
      },
    });
    pendingUpdates.push({
      update_id: 3004,
      message: {
        message_id: 8004,
        text: "/help",
        date: 1_700_000_003,
        from: { id: 1234 },
        chat: { id: 999, type: "private" },
      },
    });

    await waitForCondition(
      () => inboundRequests.length >= 1 && sentMessages.length >= 3,
      5_000,
      "timed out waiting for post-pair inbound forward and notices",
    );

    expect(inboundRequests).toHaveLength(1);
    expect(inboundRequests[0]).toMatchObject({
      channel: "telegram",
      sessionKey: "tg:group:-100777:thread:2",
      body: "hello after pair",
      messageId: "8002",
      threadId: 2,
      channelData: {
        chatId: "-100777",
        topicId: 2,
        routeKey: "telegram:default:chat:-100777:topic:2",
      },
    });

    expect(sentMessages.some((message) => String(message.text ?? "").includes("Paired"))).toBe(
      true,
    );
    expect(
      sentMessages.some(
        (message) =>
          String(message.chat_id ?? "") === "999" &&
          String(message.text ?? "").includes("Invalid token"),
      ),
    ).toBe(true);
    expect(
      sentMessages.some(
        (message) =>
          String(message.chat_id ?? "") === "999" &&
          String(message.text ?? "").includes("This chat is not paired"),
      ),
    ).toBe(true);

    const pairings = await listPairings({ port: server.port, apiKey: "tenant-a-key" });
    expect(pairings.status).toBe(200);
    expect(await pairings.json()).toEqual({
      items: [
        {
          bindingId: expect.stringContaining("bind_"),
          channel: "telegram",
          scope: "topic",
          routeKey: "telegram:default:chat:-100777:topic:2",
        },
      ],
    });
  });

  test("pairs from dashboard token sent in discord DM and forwards later message", async () => {
    const inboundRequests: Array<Record<string, unknown>> = [];
    const inbound = await startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      inboundRequests.push(await readJsonBody(req));
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });

    const dmChannelId = "777001";
    const dmUserId = "4242";
    const pendingMessages: Array<Record<string, unknown>> = [];
    const sentMessages: Array<Record<string, unknown>> = [];

    const discordApi = await startHttpServer(async (req, res) => {
      const method = req.method ?? "GET";
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");

      if (method === "POST" && requestUrl.pathname === "/users/@me/channels") {
        const body = await readJsonBody(req);
        if (String(body.recipient_id ?? "") !== dmUserId) {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "unexpected recipient" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ id: dmChannelId, type: 1 }));
        return;
      }

      if (method === "GET" && requestUrl.pathname === `/channels/${dmChannelId}/messages`) {
        const afterRaw = requestUrl.searchParams.get("after");
        const limitRaw = requestUrl.searchParams.get("limit");
        const after = afterRaw ? BigInt(afterRaw) : 0n;
        const limit = Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 50;
        const deliverable = pendingMessages
          .filter((entry) => {
            const id = String(entry.id ?? "0");
            if (!/^\d+$/.test(id)) {
              return false;
            }
            return BigInt(id) > after;
          })
          .sort((a, b) => {
            const aId = BigInt(String(a.id ?? "0"));
            const bId = BigInt(String(b.id ?? "0"));
            return aId < bId ? -1 : aId > bId ? 1 : 0;
          })
          .slice(0, Math.max(1, Math.min(100, limit)));
        if (deliverable.length > 0) {
          const maxDelivered = BigInt(String(deliverable[deliverable.length - 1]?.id ?? "0"));
          for (let i = pendingMessages.length - 1; i >= 0; i -= 1) {
            const id = String(pendingMessages[i]?.id ?? "0");
            if (/^\d+$/.test(id) && BigInt(id) <= maxDelivered) {
              pendingMessages.splice(i, 1);
            }
          }
        }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(deliverable));
        return;
      }

      if (method === "POST" && requestUrl.pathname === `/channels/${dmChannelId}/messages`) {
        sentMessages.push(await readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            id: String(9000 + sentMessages.length),
            channel_id: dmChannelId,
          }),
        );
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const server = await startServer({
      tenantsJson: JSON.stringify([
        {
          id: "tenant-a",
          name: "Tenant A",
          apiKey: "tenant-a-key",
          inboundUrl: `${inbound.url}/v1/mux/inbound`,
          inboundTimeoutMs: 2_000,
        },
      ]),
      extraEnv: {
        MUX_DISCORD_INBOUND_ENABLED: "true",
        MUX_DISCORD_API_BASE_URL: discordApi.url,
        MUX_DISCORD_POLL_INTERVAL_MS: "50",
        MUX_DISCORD_BOOTSTRAP_LATEST: "false",
        MUX_PAIRING_INVALID_TEXT: "Invalid token. Request a new link.",
        MUX_UNPAIRED_HINT_TEXT: "This chat is not paired.",
      },
    });

    const tokenResponse = await createPairingToken({
      port: server.port,
      apiKey: "tenant-a-key",
      channel: "discord",
      routeKey: "discord:default:dm:user:4242",
      sessionKey: "dc:dm:4242",
      ttlSec: 120,
    });
    expect(tokenResponse.status).toBe(200);
    const tokenBody = (await tokenResponse.json()) as {
      token: string;
      deepLink?: string | null;
      startCommand?: string | null;
    };
    expect(tokenBody.token.startsWith("mpt_")).toBe(true);
    expect(tokenBody.deepLink ?? null).toBeNull();
    expect(tokenBody.startCommand ?? null).toBeNull();

    const baseAuthor = {
      id: dmUserId,
      bot: false,
      username: "tester",
    };
    pendingMessages.push({
      id: "1001",
      channel_id: dmChannelId,
      type: 0,
      content: "/help",
      author: baseAuthor,
      attachments: [],
      mentions: [],
      mention_roles: [],
      timestamp: "2026-01-01T00:00:01.000Z",
    });
    pendingMessages.push({
      id: "1002",
      channel_id: dmChannelId,
      type: 0,
      content: "mpt_abcdefghijklmnopqrstuvwxyz",
      author: baseAuthor,
      attachments: [],
      mentions: [],
      mention_roles: [],
      timestamp: "2026-01-01T00:00:02.000Z",
    });
    pendingMessages.push({
      id: "1003",
      channel_id: dmChannelId,
      type: 0,
      content: tokenBody.token,
      author: baseAuthor,
      attachments: [],
      mentions: [],
      mention_roles: [],
      timestamp: "2026-01-01T00:00:03.000Z",
    });
    pendingMessages.push({
      id: "1004",
      channel_id: dmChannelId,
      type: 0,
      content: "hello after pair",
      author: baseAuthor,
      attachments: [],
      mentions: [],
      mention_roles: [],
      timestamp: "2026-01-01T00:00:04.000Z",
    });

    await waitForCondition(
      () => inboundRequests.length >= 1 && sentMessages.length >= 3,
      12_000,
      "timed out waiting for discord post-pair inbound forward and notices",
    );

    expect(inboundRequests).toHaveLength(1);
    expect(inboundRequests[0]).toMatchObject({
      channel: "discord",
      sessionKey: "dc:dm:4242",
      body: "hello after pair",
      messageId: "1004",
      from: "discord:4242",
      to: "channel:777001",
      chatType: "direct",
      channelData: {
        channelId: "777001",
        routeKey: "discord:default:dm:user:4242",
      },
    });

    expect(
      sentMessages.some((message) =>
        String(message.content ?? "").includes("This chat is not paired"),
      ),
    ).toBe(true);
    expect(
      sentMessages.some((message) => String(message.content ?? "").includes("Invalid token")),
    ).toBe(true);
    expect(sentMessages.some((message) => String(message.content ?? "").includes("Paired"))).toBe(
      true,
    );

    const pairings = await listPairings({ port: server.port, apiKey: "tenant-a-key" });
    expect(pairings.status).toBe(200);
    expect(await pairings.json()).toEqual({
      items: [
        {
          bindingId: expect.stringContaining("bind_"),
          channel: "discord",
          scope: "dm",
          routeKey: "discord:default:dm:user:4242",
        },
      ],
    });
  }, 15_000);

  test("issues whatsapp pairing token without deep link or start command", async () => {
    const server = await startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
    });

    const tokenResponse = await createPairingToken({
      port: server.port,
      apiKey: "tenant-a-key",
      channel: "whatsapp",
      sessionKey: "wa:chat:15550001111@s.whatsapp.net",
      ttlSec: 120,
    });
    expect(tokenResponse.status).toBe(200);
    expect(await tokenResponse.json()).toMatchObject({
      ok: true,
      channel: "whatsapp",
      token: expect.stringMatching(/^mpt_/),
      deepLink: null,
      startCommand: null,
    });
  });

  test("whatsapp outbound returns 502 when no active listener is available", async () => {
    const server = await startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-WA-1",
          channel: "whatsapp",
          routeKey: "whatsapp:default:chat:15550001111@s.whatsapp.net",
          scope: "chat",
        },
      ]),
    });

    const claim = await claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-WA-1",
      sessionKey: "wa:chat:15550001111@s.whatsapp.net",
    });
    expect(claim.status).toBe(200);

    const response = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "whatsapp",
        sessionKey: "wa:chat:15550001111@s.whatsapp.net",
        text: "hello wa",
      }),
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "whatsapp send failed",
    });
  });

  test("idempotency replays same payload and rejects mismatched payload", async () => {
    const server = await startServer();
    const first = await sendWithIdempotency({
      port: server.port,
      apiKey: "test-key",
      idempotencyKey: "idem-test-1",
      text: "route not bound check",
    });
    expect(first.status).toBe(403);
    expect(await first.json()).toEqual({
      ok: false,
      error: "route not bound",
      code: "ROUTE_NOT_BOUND",
    });

    const replay = await sendWithIdempotency({
      port: server.port,
      apiKey: "test-key",
      idempotencyKey: "idem-test-1",
      text: "route not bound check",
    });
    expect(replay.status).toBe(403);
    expect(await replay.json()).toEqual({
      ok: false,
      error: "route not bound",
      code: "ROUTE_NOT_BOUND",
    });

    const mismatch = await sendWithIdempotency({
      port: server.port,
      apiKey: "test-key",
      idempotencyKey: "idem-test-1",
      text: "different payload",
    });
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toEqual({
      ok: false,
      error: "idempotency key reused with different payload",
    });
  });

  test("idempotency survives restart with SQLite", async () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "mux-server-restart-"));
    const dbPath = resolve(tempDir, "mux-server.sqlite");

    const firstServer = await startServer({
      tempDir,
      cleanupTempDir: false,
      dbPath,
    });
    const first = await sendWithIdempotency({
      port: firstServer.port,
      apiKey: "test-key",
      idempotencyKey: "idem-test-restart",
      text: "route not bound before restart",
    });
    expect(first.status).toBe(403);
    expect(await first.json()).toEqual({
      ok: false,
      error: "route not bound",
      code: "ROUTE_NOT_BOUND",
    });

    await stopServer(firstServer);
    removeRunningServer(firstServer);

    const secondServer = await startServer({
      tempDir,
      cleanupTempDir: false,
      dbPath,
    });
    const replay = await sendWithIdempotency({
      port: secondServer.port,
      apiKey: "test-key",
      idempotencyKey: "idem-test-restart",
      text: "route not bound before restart",
    });
    expect(replay.status).toBe(403);
    expect(await replay.json()).toEqual({
      ok: false,
      error: "route not bound",
      code: "ROUTE_NOT_BOUND",
    });

    const mismatch = await sendWithIdempotency({
      port: secondServer.port,
      apiKey: "test-key",
      idempotencyKey: "idem-test-restart",
      text: "different payload after restart",
    });
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toEqual({
      ok: false,
      error: "idempotency key reused with different payload",
    });

    await stopServer(secondServer);
    removeRunningServer(secondServer);
    rmSync(tempDir, { recursive: true, force: true });
  });
});
