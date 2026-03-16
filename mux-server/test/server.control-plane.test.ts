import { describe, expect, test } from "vitest";
import * as h from "./server.test.helpers";

describe("mux server", () => {
  test("health endpoint responds", async () => {
    const server = await h.startServer();
    const response = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("health endpoint reports telegram poll conflict when getUpdates returns 409", async () => {
    const telegramApi = await h.startHttpServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/botdummy-token/getUpdates") {
        res.writeHead(409, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error_code: 409, description: "Conflict" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, result: { username: "test_bot" } }));
    });

    const server = await h.startServer({
      extraEnv: {
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
        MUX_TELEGRAM_POLL_RETRY_MS: "100",
      },
    });

    const deadline = Date.now() + 5_000;
    let healthBody: Record<string, unknown> | null = null;
    while (Date.now() < deadline) {
      const health = await fetch(`http://127.0.0.1:${server.port}/health`);
      healthBody = (await health.json()) as Record<string, unknown>;
      const telegramInbound =
        healthBody.telegramInbound && typeof healthBody.telegramInbound === "object"
          ? (healthBody.telegramInbound as Record<string, unknown>)
          : null;
      if (telegramInbound?.code === "poll_conflict") {
        break;
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
    }

    expect(healthBody).toBeTruthy();
    const telegramInbound =
      healthBody?.telegramInbound && typeof healthBody.telegramInbound === "object"
        ? (healthBody.telegramInbound as Record<string, unknown>)
        : null;
    expect(telegramInbound).toMatchObject({
      status: "degraded",
      code: "poll_conflict",
      message: "Telegram getUpdates returned 409; another poller is using this bot token.",
    });
    expect(typeof telegramInbound?.lastConflictAtMs).toBe("number");
    expect(JSON.stringify(telegramInbound?.lastError ?? "")).toContain("getUpdates failed (409)");

    const readiness = await fetch(`http://127.0.0.1:${server.port}/health/ready`);
    expect(readiness.status).toBe(503);
    const readinessBody = (await readiness.json()) as Record<string, unknown>;
    const channels = readinessBody.channels as Record<string, unknown> | undefined;
    const telegram = channels?.telegram as Record<string, unknown> | undefined;
    expect(readinessBody.ok).toBe(false);
    expect(telegram?.ready).toBe(false);
    expect(telegram?.reason).toBe("poll_conflict");
  });

  test("metrics endpoint exposes prom counters", async () => {
    const server = await h.startServer({
      extraEnv: {
        MUX_REGISTER_KEY: "register-key-1",
        TELEGRAM_BOT_TOKEN: "",
        DISCORD_BOT_TOKEN: "",
      },
    });

    const unauthorizedRegister = await fetch(
      `http://127.0.0.1:${server.port}/v1/instances/register`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          openclawId: "oc-1",
          inboundUrl: "http://127.0.0.1:18789/v1/mux/inbound",
        }),
      },
    );
    expect(unauthorizedRegister.status).toBe(401);

    const outbound = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "telegram",
        sessionKey: "tg:dm:123",
        text: "hello",
      }),
    });
    expect(outbound.status).toBe(403);

    const metrics = await fetch(`http://127.0.0.1:${server.port}/metrics`);
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get("content-type")).toContain("text/plain");
    const body = await metrics.text();
    expect(body).toContain('mux_auth_failures_total{surface="register"} 1');
    expect(body).toContain(
      'mux_outbound_requests_total{channel="telegram",method="send",outcome="error"} 1',
    );
    expect(body).toContain('mux_queue_depth{channel="whatsapp"} 0');
    expect(body).toContain('mux_active_users{channel="telegram",window="5m"} 0');
  });

  test("instance register endpoint requires shared register key and returns runtime jwt metadata", async () => {
    const server = await h.startServer({
      extraEnv: {
        MUX_REGISTER_KEY: "register-shared-key",
      },
    });

    const unauthorized = await fetch(`http://127.0.0.1:${server.port}/v1/instances/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        openclawId: "oc-1",
        inboundUrl: "http://127.0.0.1:18789/v1/mux/inbound",
      }),
    });
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ ok: false, error: "unauthorized" });

    const registered = await h.registerInstance({
      port: server.port,
      registerKey: "register-shared-key",
      openclawId: "oc-1",
      inboundUrl: "http://127.0.0.1:18789/v1/mux/inbound",
      inboundTimeoutMs: 5_000,
    });
    expect(registered.status).toBe(200);
    const registerBody = (await registered.json()) as {
      ok?: unknown;
      openclawId?: unknown;
      tokenType?: unknown;
      runtimeToken?: unknown;
      expiresAtMs?: unknown;
    };
    expect(registerBody).toMatchObject({
      ok: true,
      openclawId: "oc-1",
      tokenType: "Bearer",
    });
    expect(typeof registerBody.runtimeToken).toBe("string");
    expect(typeof registerBody.expiresAtMs).toBe("number");

    const jwks = await fetch(`http://127.0.0.1:${server.port}/.well-known/jwks.json`);
    expect(jwks.status).toBe(200);
    const body = (await jwks.json()) as { keys?: Array<{ kid?: string; alg?: string }> };
    expect(Array.isArray(body.keys)).toBe(true);
    expect(body.keys?.[0]).toMatchObject({
      alg: "EdDSA",
    });
    expect(typeof body.keys?.[0]?.kid).toBe("string");
  });

  test("admin pairing token endpoint requires admin auth and issues token (control-plane flow)", async () => {
    const server = await h.startServer({
      extraEnv: {
        MUX_ADMIN_TOKEN: "admin-token-1",
      },
    });

    const unauthorized = await fetch(`http://127.0.0.1:${server.port}/v1/admin/pairings/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        openclawId: "oc-1",
        channel: "telegram",
        ttlSec: 60,
      }),
    });
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ ok: false, error: "unauthorized" });

    const issued = await h.createAdminPairingToken({
      port: server.port,
      adminToken: "admin-token-1",
      openclawId: "oc-1",
      inboundUrl: "http://127.0.0.1:18789/v1/mux/inbound",
      inboundTimeoutMs: 5_000,
      channel: "telegram",
      ttlSec: 60,
    });
    expect(issued.status).toBe(200);
    const body = (await issued.json()) as { ok?: unknown; token?: unknown; expiresAtMs?: unknown };
    expect(body.ok).toBe(true);
    expect(typeof body.token).toBe("string");
    expect(typeof body.expiresAtMs).toBe("number");
  });

  test("runtime jwt auth enforces openclaw identity on outbound endpoints", async () => {
    const server = await h.startServer({
      extraEnv: {
        MUX_REGISTER_KEY: "register-shared-key",
      },
    });
    const registered = await h.registerInstance({
      port: server.port,
      registerKey: "register-shared-key",
      openclawId: "oc-1",
      inboundUrl: "http://127.0.0.1:18789/v1/mux/inbound",
    });
    const registerBody = (await registered.json()) as {
      runtimeToken?: string;
    };
    const runtimeToken = h.toSafeString(registerBody.runtimeToken);
    expect(runtimeToken).toBeTruthy();

    const valid = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${runtimeToken}`,
        "X-OpenClaw-Id": "oc-1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "telegram",
        sessionKey: "tg:dm:123",
        text: "hello",
        openclawId: "oc-1",
      }),
    });
    expect(valid.status).toBe(403);
    expect(await valid.json()).toEqual({
      ok: false,
      error: "route not bound",
      code: "ROUTE_NOT_BOUND",
    });

    const mismatch = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${runtimeToken}`,
        "X-OpenClaw-Id": "oc-1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "telegram",
        sessionKey: "tg:dm:123",
        text: "hello",
        openclawId: "oc-other",
      }),
    });
    expect(mismatch.status).toBe(401);
    expect(await mismatch.json()).toEqual({
      ok: false,
      error: "openclawId mismatch",
    });
  });

  test("outbound endpoint rejects unauthorized requests", async () => {
    const server = await h.startServer();
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer wrong-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(h.requestPayload("hello")),
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: "unauthorized" });
  });

  test("returns 400 for invalid JSON body", async () => {
    const server = await h.startServer();
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: "{not-json",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ ok: false, error: "invalid JSON body" });
  });

  test("returns 413 when request body exceeds max size", async () => {
    const server = await h.startServer({
      extraEnv: {
        MUX_MAX_BODY_BYTES: "128",
      },
    });
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "telegram",
        sessionKey: "tg:dm:123",
        text: "x".repeat(2_000),
      }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ ok: false, error: "payload too large" });
  });

  test("supports per-tenant auth from MUX_TENANTS_JSON", async () => {
    const server = await h.startServer({
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
      body: JSON.stringify(h.requestPayload("message without binding")),
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
      body: JSON.stringify(h.requestPayload("missing to should return 400")),
    });
    expect(fallback.status).toBe(401);
    expect(await fallback.json()).toEqual({ ok: false, error: "unauthorized" });
  });

  test("admin whatsapp health endpoint requires admin auth", async () => {
    const server = await h.startServer({
      extraEnv: {
        MUX_ADMIN_TOKEN: "admin-secret",
      },
    });
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/admin/whatsapp/health`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: "unauthorized" });
  });

  test("admin whatsapp health endpoint reports credential presence", async () => {
    const authDir = h.mkdtempSync(h.resolve(h.tmpdir(), "mux-wa-auth-"));
    h.writeFileSync(
      h.resolve(authDir, "creds.json"),
      JSON.stringify({ me: { id: "16693773518:1@s.whatsapp.net" } }),
      "utf8",
    );
    h.writeFileSync(h.resolve(authDir, "session-117901482786828_1.0.json"), "{}", "utf8");
    h.writeFileSync(h.resolve(authDir, "pre-key-1.json"), "{}", "utf8");

    try {
      const server = await h.startServer({
        extraEnv: {
          MUX_ADMIN_TOKEN: "admin-secret",
          MUX_WHATSAPP_AUTH_DIR: authDir,
        },
      });

      const response = await h.getAdminWhatsAppHealth({
        port: server.port,
        adminToken: "admin-secret",
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        ok: boolean;
        whatsapp: {
          status: string;
          inboundEnabled: boolean;
          authDir: string;
          authDirExists: boolean;
          credsPath: string;
          creds: { present: boolean };
          fileCounts: { session: number; preKey: number };
          runtime: { listenerActive: boolean };
        };
      };
      expect(body.ok).toBe(true);
      expect(body.whatsapp.inboundEnabled).toBe(true);
      expect(body.whatsapp.authDir).toBe(authDir);
      expect(body.whatsapp.authDirExists).toBe(true);
      expect(body.whatsapp.credsPath).toBe(h.resolve(authDir, "creds.json"));
      expect(body.whatsapp.creds.present).toBe(true);
      expect(body.whatsapp.fileCounts.session).toBe(1);
      expect(body.whatsapp.fileCounts.preKey).toBe(1);
      expect(["starting_or_idle", "listening", "listener_error"]).toContain(body.whatsapp.status);
    } finally {
      h.rmSync(authDir, { recursive: true, force: true });
    }
  });

  test("instance register updates inbound target and forwards to latest inbound url", async () => {
    const inboundARequests: Array<{
      authorization: string | undefined;
      openclawIdHeader: string | undefined;
      traceIdHeader: string | undefined;
      payload: Record<string, unknown>;
    }> = [];
    const inboundBRequests: Array<{
      authorization: string | undefined;
      openclawIdHeader: string | undefined;
      traceIdHeader: string | undefined;
      payload: Record<string, unknown>;
    }> = [];

    const inboundA = await h.startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      const payload = await h.readJsonBody(req);
      const authorization =
        typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
      const openclawIdHeader =
        typeof req.headers["x-openclaw-id"] === "string" ? req.headers["x-openclaw-id"] : undefined;
      const traceIdHeader =
        typeof req.headers["x-mux-trace-id"] === "string"
          ? req.headers["x-mux-trace-id"]
          : undefined;
      inboundARequests.push({ authorization, openclawIdHeader, traceIdHeader, payload });
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });

    const inboundB = await h.startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      const payload = await h.readJsonBody(req);
      const authorization =
        typeof req.headers.authorization === "string" ? req.headers.authorization : undefined;
      const openclawIdHeader =
        typeof req.headers["x-openclaw-id"] === "string" ? req.headers["x-openclaw-id"] : undefined;
      const traceIdHeader =
        typeof req.headers["x-mux-trace-id"] === "string"
          ? req.headers["x-mux-trace-id"]
          : undefined;
      inboundBRequests.push({ authorization, openclawIdHeader, traceIdHeader, payload });
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });

    let releaseFirst = false;
    let releaseSecond = false;
    const telegramApi = await h.startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/botdummy-token/getUpdates") {
        res.writeHead(404);
        res.end();
        return;
      }
      const body = await h.readJsonBody(req);
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

    const server = await h.startServer({
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-ROTATE-TARGET-1",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100557",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_REGISTER_KEY: "register-shared-key",
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
        MUX_TELEGRAM_POLL_TIMEOUT_SEC: "1",
        MUX_TELEGRAM_POLL_RETRY_MS: "50",
        MUX_TELEGRAM_BOOTSTRAP_LATEST: "false",
      },
    });

    const registeredA = await h.registerInstance({
      port: server.port,
      registerKey: "register-shared-key",
      openclawId: "tenant-a",
      inboundUrl: `${inboundA.url}/v1/mux/inbound`,
      inboundTimeoutMs: 2_000,
    });
    expect(registeredA.status).toBe(200);
    const registerBody = (await registeredA.json()) as { runtimeToken?: unknown };
    const runtimeToken = h.toSafeString(registerBody.runtimeToken);
    expect(runtimeToken).toBeTruthy();

    const claim = await fetch(`http://127.0.0.1:${server.port}/v1/pairings/claim`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${runtimeToken}`,
        "X-OpenClaw-Id": "tenant-a",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code: "PAIR-ROTATE-TARGET-1",
        sessionKey: "agent:main:telegram:group:-100557",
      }),
    });
    expect(claim.status).toBe(200);

    releaseFirst = true;
    await h.waitForCondition(
      () => inboundARequests.length >= 1,
      8_000,
      "timed out waiting for first inbound target",
    );
    h.expectInboundJwtAuth(
      {
        authorization: inboundARequests[0]?.authorization,
        openclawIdHeader: inboundARequests[0]?.openclawIdHeader,
      },
      "tenant-a",
    );
    h.expectMuxTraceIdHeader(inboundARequests[0]?.traceIdHeader);
    expect(inboundARequests[0]?.payload.body).toBe("first target");

    const registeredB = await h.registerInstance({
      port: server.port,
      registerKey: "register-shared-key",
      openclawId: "tenant-a",
      inboundUrl: `${inboundB.url}/v1/mux/inbound`,
      inboundTimeoutMs: 2_000,
    });
    expect(registeredB.status).toBe(200);

    releaseSecond = true;
    await h.waitForCondition(
      () => inboundBRequests.length >= 1,
      8_000,
      "timed out waiting for rotated inbound target",
    );
    h.expectInboundJwtAuth(
      {
        authorization: inboundBRequests[0]?.authorization,
        openclawIdHeader: inboundBRequests[0]?.openclawIdHeader,
      },
      "tenant-a",
    );
    h.expectMuxTraceIdHeader(inboundBRequests[0]?.traceIdHeader);
    expect(inboundBRequests[0]?.payload.body).toBe("second target");
    expect(inboundARequests.length).toBe(1);
  }, 20_000);

  test("supports pairing claim/list/unbind", async () => {
    const server = await h.startServer({
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

    const claim = await h.claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-1",
      sessionKey: "agent:main:telegram:group:-100123:topic:2",
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
    expect((claimBody as Record<string, unknown>).sessionKey).toBe(
      "agent:main:telegram:group:-100123:topic:2",
    );

    const listedBeforeUnbind = await h.listPairings({ port: server.port, apiKey: "tenant-a-key" });
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

    const unbind = await h.unbindPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      bindingId: claimBody.bindingId,
    });
    expect(unbind.status).toBe(200);
    expect(await unbind.json()).toEqual({ ok: true });

    const listedAfterUnbind = await h.listPairings({ port: server.port, apiKey: "tenant-a-key" });
    expect(listedAfterUnbind.status).toBe(200);
    expect(await listedAfterUnbind.json()).toEqual({ items: [] });
  });

  test("rejects duplicate pairing claim", async () => {
    const server = await h.startServer({
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

    const firstClaim = await h.claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-2",
    });
    expect(firstClaim.status).toBe(200);

    const secondClaim = await h.claimPairing({
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

  test("rejects cross-tenant route collisions during pairing claim", async () => {
    const server = await h.startServer({
      tenantsJson: JSON.stringify([
        { id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" },
        { id: "tenant-b", name: "Tenant B", apiKey: "tenant-b-key" },
      ]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-ROUTE-A",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100555",
          scope: "chat",
        },
        {
          code: "PAIR-ROUTE-B",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100555",
          scope: "chat",
        },
      ]),
    });

    const first = await h.claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-ROUTE-A",
      sessionKey: "agent:main:telegram:group:-100555",
    });
    expect(first.status).toBe(200);

    const second = await h.claimPairing({
      port: server.port,
      apiKey: "tenant-b-key",
      code: "PAIR-ROUTE-B",
      sessionKey: "agent:main:telegram:group:-100555",
    });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({
      ok: false,
      error: "route already bound",
    });
  });
});
