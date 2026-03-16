import { describe, expect, test } from "vitest";
import * as h from "./server.test.helpers";

describe("mux server", () => {
  test("idempotency replays same payload and rejects mismatched payload", async () => {
    const server = await h.startServer();
    const first = await h.sendWithIdempotency({
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

    const replay = await h.sendWithIdempotency({
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

    const mismatch = await h.sendWithIdempotency({
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
    const tempDir = h.mkdtempSync(h.resolve(h.tmpdir(), "mux-server-restart-"));
    const dbPath = h.resolve(tempDir, "mux-server.sqlite");

    const firstServer = await h.startServer({
      tempDir,
      cleanupTempDir: false,
      dbPath,
    });
    const first = await h.sendWithIdempotency({
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

    await h.stopServer(firstServer);
    h.removeRunningServer(firstServer);

    const secondServer = await h.startServer({
      tempDir,
      cleanupTempDir: false,
      dbPath,
    });
    const replay = await h.sendWithIdempotency({
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

    const mismatch = await h.sendWithIdempotency({
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

    await h.stopServer(secondServer);
    h.removeRunningServer(secondServer);
    h.rmSync(tempDir, { recursive: true, force: true });
  }, 20_000);

  test("telegram canonical fallback survives restart without creating a sticky session alias", async () => {
    const telegramRequests: Array<Record<string, unknown>> = [];
    const telegramApi = await h.startHttpServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/botdummy-token/sendMessage") {
        telegramRequests.push(await h.readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: true,
            result: { message_id: 9910 },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const tempDir = h.mkdtempSync(h.resolve(h.tmpdir(), "mux-server-fallback-restart-"));
    const dbPath = h.resolve(tempDir, "mux-server.sqlite");
    const logPath = h.resolve(tempDir, "mux-server.log");

    const firstServer = await h.startServer({
      tempDir,
      cleanupTempDir: false,
      dbPath,
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-TG-RESTART-FALLBACK",
          channel: "telegram",
          routeKey: "telegram:default:chat:1001",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
      },
    });

    const firstClaim = await h.claimPairing({
      port: firstServer.port,
      apiKey: "test-key",
      code: "PAIR-TG-RESTART-FALLBACK",
      sessionKey: "agent:main:telegram:direct:1001",
    });
    expect(firstClaim.status).toBe(200);

    const firstOutbound = await fetch(`http://127.0.0.1:${firstServer.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "telegram",
        sessionKey: "agent:main:main",
        to: "1001",
        raw: {
          telegram: {
            method: "sendMessage",
            body: {
              chat_id: "1001",
              text: "canonical before restart",
            },
          },
        },
      }),
    });

    expect(firstOutbound.status).toBe(200);
    expect(await firstOutbound.json()).toMatchObject({
      ok: true,
      messageId: "9910",
      rawPassthrough: true,
    });
    expect(telegramRequests).toHaveLength(1);
    expect(telegramRequests[0]).toMatchObject({
      chat_id: "1001",
      text: "canonical before restart",
    });
    const sessionRouteKeysBeforeRestart = h.readSessionRouteKeys({
      dbPath,
      channel: "telegram",
    });
    expect(sessionRouteKeysBeforeRestart).not.toContain("agent:main:main");
    expect(h.readMuxServerLog(logPath)).toContain('"type":"outbound_route_fallback"');

    await h.stopServer(firstServer);
    h.removeRunningServer(firstServer);

    const secondServer = await h.startServer({
      tempDir,
      cleanupTempDir: false,
      dbPath,
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-TG-RESTART-FALLBACK",
          channel: "telegram",
          routeKey: "telegram:default:chat:1001",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
      },
    });

    const secondOutbound = await fetch(
      `http://127.0.0.1:${secondServer.port}/v1/mux/outbound/send`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer test-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          channel: "telegram",
          sessionKey: "agent:main:main",
          to: "1001",
          raw: {
            telegram: {
              method: "sendMessage",
              body: {
                chat_id: "1001",
                text: "canonical after restart",
              },
            },
          },
        }),
      },
    );

    expect(secondOutbound.status).toBe(200);
    expect(await secondOutbound.json()).toMatchObject({
      ok: true,
      messageId: "9910",
      rawPassthrough: true,
    });
    expect(telegramRequests).toHaveLength(2);
    expect(telegramRequests[1]).toMatchObject({
      chat_id: "1001",
      text: "canonical after restart",
    });
    expect(
      h.readSessionRouteKeys({
        dbPath,
        channel: "telegram",
      }),
    ).toEqual(sessionRouteKeysBeforeRestart);
    expect(
      h.readMuxServerLog(logPath).match(/"type":"outbound_route_fallback"/g)?.length ?? 0,
    ).toBe(2);

    await h.stopServer(secondServer);
    h.removeRunningServer(secondServer);
    h.rmSync(tempDir, { recursive: true, force: true });
  }, 20_000);
});
