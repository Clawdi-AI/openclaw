import { describe, expect, test } from "vitest";
import * as h from "./server.test.helpers";

describe("mux server", () => {
  test("pairs from dashboard token sent via /start and forwards later message", async () => {
    const inboundRequests: Array<Record<string, unknown>> = [];
    const inbound = await h.startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      inboundRequests.push(await h.readJsonBody(req));
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });

    const pendingUpdates: Array<Record<string, unknown>> = [];
    const sentMessages: Array<Record<string, unknown>> = [];
    const telegramApi = await h.startHttpServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.url === "/botdummy-token/getUpdates") {
        const body = await h.readJsonBody(req);
        const offset = typeof body.offset === "number" ? Number(body.offset) : 0;
        const deliverable = pendingUpdates
          .map((entry) => {
            const updateId = Number(entry.update_id ?? 0);
            return { entry, updateId };
          })
          .filter((entry) => Number.isFinite(entry.updateId) && entry.updateId >= offset)
          .toSorted((a, b) => a.updateId - b.updateId);
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
        sentMessages.push(await h.readJsonBody(req));
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

    const server = await h.startServer({
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
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
        MUX_TELEGRAM_POLL_TIMEOUT_SEC: "1",
        MUX_TELEGRAM_POLL_RETRY_MS: "50",
        MUX_TELEGRAM_BOOTSTRAP_LATEST: "false",
        MUX_TELEGRAM_BOT_USERNAME: "dummy_bot",
        MUX_PAIRING_INVALID_TEXT: "Invalid token. Request a new link.",
        MUX_UNPAIRED_HINT_TEXT: "This chat is not paired.",
      },
    });

    const tokenResponse = await h.createAdminPairingToken({
      port: server.port,
      adminToken: h.DEFAULT_ADMIN_TOKEN,
      openclawId: "tenant-a",
      channel: "telegram",
      sessionKey: "agent:main:telegram:group:-100777:topic:2",
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
        chat: { id: -100777, type: "supergroup", is_forum: true },
        message_thread_id: 2,
      },
    });
    pendingUpdates.push({
      update_id: 3002,
      message: {
        message_id: 8002,
        text: "/help",
        date: 1_700_000_001,
        from: { id: 1234 },
        chat: { id: -100777, type: "supergroup", is_forum: true },
        message_thread_id: 2,
      },
    });
    pendingUpdates.push({
      update_id: 3005,
      message: {
        message_id: 8005,
        text: "/reasoning",
        date: 1_700_000_001,
        from: { id: 1234 },
        chat: { id: -100777, type: "supergroup", is_forum: true },
        message_thread_id: 3,
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
        text: "hello before pairing",
        date: 1_700_000_003,
        from: { id: 1234 },
        chat: { id: 999, type: "private" },
      },
    });

    await h.waitForCondition(
      () => h.filterRealInbound(inboundRequests).length >= 2 && sentMessages.length >= 3,
      5_000,
      "timed out waiting for post-pair inbound forwards and notices",
    );

    const realInbound = h.filterRealInbound(inboundRequests);
    expect(realInbound).toHaveLength(2);
    expect(realInbound).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "telegram",
          sessionKey: "agent:main:telegram:group:-100777:topic:2",
          body: "/help",
          messageId: "8002",
          threadId: 2,
          channelData: expect.objectContaining({
            chatId: "-100777",
            topicId: 2,
            routeKey: "telegram:default:chat:-100777:topic:2",
          }),
        }),
        expect.objectContaining({
          channel: "telegram",
          sessionKey: "agent:main:telegram:group:-100777:topic:3",
          body: "/reasoning",
          messageId: "8005",
          threadId: 3,
          channelData: expect.objectContaining({
            chatId: "-100777",
            topicId: 3,
            routeKey: "telegram:default:chat:-100777:topic:3",
          }),
        }),
      ]),
    );

    expect(sentMessages.some((message) => h.toSafeString(message.text).includes("Paired"))).toBe(
      true,
    );
    expect(
      sentMessages.some(
        (message) =>
          h.toSafeString(message.chat_id) === "999" &&
          h.toSafeString(message.text).includes("Invalid token"),
      ),
    ).toBe(true);
    expect(
      sentMessages.some(
        (message) =>
          h.toSafeString(message.chat_id) === "999" &&
          h.toSafeString(message.text).includes("This chat is not paired"),
      ),
    ).toBe(true);

    const pairings = await h.listPairings({ port: server.port, apiKey: "tenant-a-key" });
    expect(pairings.status).toBe(200);
    expect(await pairings.json()).toEqual({
      items: [
        {
          bindingId: expect.stringContaining("bind_"),
          channel: "telegram",
          scope: "chat",
          routeKey: "telegram:default:chat:-100777",
        },
      ],
    });
  }, 10_000);

  test("handles unpaired /bot_help in forum General without message_thread_id", async () => {
    const pendingUpdates: Array<Record<string, unknown>> = [];
    const sentMessages: Array<Record<string, unknown>> = [];
    const telegramApi = await h.startHttpServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.url === "/botdummy-token/getUpdates") {
        const body = await h.readJsonBody(req);
        const offset = typeof body.offset === "number" ? Number(body.offset) : 0;
        const deliverable = pendingUpdates
          .map((entry) => {
            const updateId = Number(entry.update_id ?? 0);
            return { entry, updateId };
          })
          .filter((entry) => Number.isFinite(entry.updateId) && entry.updateId >= offset)
          .toSorted((a, b) => a.updateId - b.updateId);
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
        const body = await h.readJsonBody(req);
        sentMessages.push(body);
        if (Number(body.message_thread_id) === 1) {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          res.end(
            JSON.stringify({
              ok: false,
              error_code: 400,
              description: "Bad Request: message thread not found",
            }),
          );
          return;
        }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: true,
            result: { message_id: 9901, chat: { id: -100909, type: "supergroup" } },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await h.startServer({
      extraEnv: {
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
        MUX_TELEGRAM_POLL_TIMEOUT_SEC: "1",
        MUX_TELEGRAM_POLL_RETRY_MS: "50",
        MUX_TELEGRAM_BOOTSTRAP_LATEST: "false",
        MUX_UNPAIRED_HINT_TEXT: "This chat is not paired.",
      },
    });

    pendingUpdates.push({
      update_id: 5101,
      message: {
        message_id: 9101,
        text: "/bot_help",
        date: 1_700_000_100,
        from: { id: 1234 },
        chat: { id: -100909, type: "supergroup", is_forum: true },
      },
    });

    await h.waitForCondition(
      () => sentMessages.length > 0,
      5_000,
      "timed out waiting for unpaired forum General notice",
    );

    expect(h.toSafeString(sentMessages[0]?.chat_id)).toBe("-100909");
    expect(sentMessages[0]?.message_thread_id).toBeUndefined();
    expect(h.toSafeString(sentMessages[0]?.text)).toContain("Bot control commands");
    expect(sentMessages.some((message) => Number(message.message_thread_id) === 1)).toBe(false);
  });

  test("retries unpaired notice without topic thread when Telegram rejects thread ID", async () => {
    const pendingUpdates: Array<Record<string, unknown>> = [];
    const sentMessages: Array<Record<string, unknown>> = [];
    const telegramApi = await h.startHttpServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.url === "/botdummy-token/getUpdates") {
        const body = await h.readJsonBody(req);
        const offset = typeof body.offset === "number" ? Number(body.offset) : 0;
        const deliverable = pendingUpdates
          .map((entry) => {
            const updateId = Number(entry.update_id ?? 0);
            return { entry, updateId };
          })
          .filter((entry) => Number.isFinite(entry.updateId) && entry.updateId >= offset)
          .toSorted((a, b) => a.updateId - b.updateId);
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
        const body = await h.readJsonBody(req);
        sentMessages.push(body);
        if (Number(body.message_thread_id) === 2) {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          res.end(
            JSON.stringify({
              ok: false,
              error_code: 400,
              description: "Bad Request: message thread not found",
            }),
          );
          return;
        }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: true,
            result: { message_id: 9902, chat: { id: -100910, type: "supergroup" } },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await h.startServer({
      extraEnv: {
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
        MUX_TELEGRAM_POLL_TIMEOUT_SEC: "1",
        MUX_TELEGRAM_POLL_RETRY_MS: "50",
        MUX_TELEGRAM_BOOTSTRAP_LATEST: "false",
        MUX_UNPAIRED_HINT_TEXT: "This chat is not paired.",
      },
    });

    pendingUpdates.push({
      update_id: 5102,
      message: {
        message_id: 9102,
        text: "/bot_help",
        date: 1_700_000_101,
        from: { id: 1234 },
        chat: { id: -100910, type: "supergroup", is_forum: true },
        message_thread_id: 2,
      },
    });

    await h.waitForCondition(
      () => sentMessages.length >= 2,
      5_000,
      "timed out waiting for thread-not-found fallback notice",
    );

    expect(h.toSafeString(sentMessages[0]?.chat_id)).toBe("-100910");
    expect(sentMessages[0]?.message_thread_id).toBe(2);
    expect(sentMessages[1]?.message_thread_id).toBeUndefined();
    expect(h.toSafeString(sentMessages[1]?.text)).toContain("Bot control commands");
  });

  test("pairs telegram DM threads once and isolates sessions per thread", async () => {
    const inboundRequests: Array<Record<string, unknown>> = [];
    const inbound = await h.startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      inboundRequests.push(await h.readJsonBody(req));
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });

    const pendingUpdates: Array<Record<string, unknown>> = [];
    const sentMessages: Array<Record<string, unknown>> = [];
    const telegramApi = await h.startHttpServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.url === "/botdummy-token/getUpdates") {
        const body = await h.readJsonBody(req);
        const offset = typeof body.offset === "number" ? Number(body.offset) : 0;
        const deliverable = pendingUpdates
          .map((entry) => {
            const updateId = Number(entry.update_id ?? 0);
            return { entry, updateId };
          })
          .filter((entry) => Number.isFinite(entry.updateId) && entry.updateId >= offset)
          .toSorted((a, b) => a.updateId - b.updateId);
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
        sentMessages.push(await h.readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: true,
            result: {
              message_id: 902,
              chat: { id: 999, type: "private" },
            },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await h.startServer({
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
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
        MUX_TELEGRAM_POLL_TIMEOUT_SEC: "1",
        MUX_TELEGRAM_POLL_RETRY_MS: "50",
        MUX_TELEGRAM_BOOTSTRAP_LATEST: "false",
      },
    });

    const tokenResponse = await h.createAdminPairingToken({
      port: server.port,
      adminToken: h.DEFAULT_ADMIN_TOKEN,
      openclawId: "tenant-a",
      channel: "telegram",
      ttlSec: 120,
    });
    expect(tokenResponse.status).toBe(200);
    const tokenBody = (await tokenResponse.json()) as {
      token: string;
    };
    expect(tokenBody.token.startsWith("mpt_")).toBe(true);

    pendingUpdates.push(
      {
        update_id: 4101,
        message: {
          message_id: 9101,
          text: `/start ${tokenBody.token}`,
          date: 1_700_000_100,
          from: { id: 1234 },
          chat: { id: 999, type: "private" },
          message_thread_id: 2,
        },
      },
      {
        update_id: 4102,
        message: {
          message_id: 9102,
          text: "hello thread two",
          date: 1_700_000_101,
          from: { id: 1234 },
          chat: { id: 999, type: "private" },
          message_thread_id: 2,
        },
      },
      {
        update_id: 4103,
        message: {
          message_id: 9103,
          text: "hello thread three",
          date: 1_700_000_102,
          from: { id: 1234 },
          chat: { id: 999, type: "private" },
          message_thread_id: 3,
        },
      },
    );

    await h.waitForCondition(
      () => inboundRequests.length >= 2,
      5_000,
      "timed out waiting for thread-scoped inbound forwards",
    );

    expect(inboundRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "telegram",
          sessionKey: "agent:main:telegram:direct:999:thread:2",
          body: "hello thread two",
          threadId: 2,
          channelData: expect.objectContaining({
            routeKey: "telegram:default:chat:999:topic:2",
          }),
        }),
        expect.objectContaining({
          channel: "telegram",
          sessionKey: "agent:main:telegram:direct:999:thread:3",
          body: "hello thread three",
          threadId: 3,
          channelData: expect.objectContaining({
            routeKey: "telegram:default:chat:999:topic:3",
          }),
        }),
      ]),
    );

    const pairings = await h.listPairings({ port: server.port, apiKey: "tenant-a-key" });
    expect(pairings.status).toBe(200);
    expect(await pairings.json()).toEqual({
      items: [
        {
          bindingId: expect.stringContaining("bind_"),
          channel: "telegram",
          scope: "chat",
          routeKey: "telegram:default:chat:999",
        },
      ],
    });

    const outbound = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "telegram",
        sessionKey: "agent:main:telegram:direct:999:thread:3",
        raw: {
          telegram: {
            method: "sendMessage",
            body: {
              text: "reply thread 3",
            },
          },
        },
      }),
    });
    expect(outbound.status).toBe(200);
    expect(await outbound.json()).toMatchObject({
      ok: true,
      messageId: "902",
      rawPassthrough: true,
    });

    const threadReply = sentMessages.find(
      (message) => h.toSafeString(message.text) === "reply thread 3",
    );
    expect(threadReply).toBeDefined();
    expect(h.toSafeString(threadReply?.chat_id)).toBe("999");
    expect(threadReply?.message_thread_id).toBe(3);
  }, 10_000);

  test("maps forum general topic to thread 1 and omits message_thread_id on sendMessage", async () => {
    const inboundRequests: Array<Record<string, unknown>> = [];
    const inbound = await h.startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      inboundRequests.push(await h.readJsonBody(req));
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });

    const telegramRequests: Array<{ path: string; body: Record<string, unknown> }> = [];
    let releaseUpdates = false;
    let hasSentUpdate = false;
    const telegramApi = await h.startHttpServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(404);
        res.end();
        return;
      }
      const body = await h.readJsonBody(req);
      if (!req.url) {
        res.writeHead(404);
        res.end();
        return;
      }
      telegramRequests.push({ path: req.url, body });
      if (req.url === "/botdummy-token/getUpdates") {
        const hasOffset = typeof body.offset === "number";
        const shouldSend = hasOffset && releaseUpdates && !hasSentUpdate;
        if (shouldSend) {
          hasSentUpdate = true;
        }
        const result = shouldSend
          ? [
              {
                update_id: 7001,
                message: {
                  message_id: 7002,
                  date: 1_700_000_300,
                  text: "hello from forum general",
                  from: { id: 1234 },
                  chat: { id: -100909, type: "supergroup", is_forum: true },
                },
              },
            ]
          : [];
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, result }));
        return;
      }
      if (
        req.url === "/botdummy-token/sendMessage" ||
        req.url === "/botdummy-token/sendChatAction"
      ) {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: true,
            result: { message_id: 9911, chat: { id: -100909 } },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await h.startServer({
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
          code: "PAIR-FORUM-GEN-1",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100909",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
        MUX_TELEGRAM_POLL_TIMEOUT_SEC: "1",
        MUX_TELEGRAM_POLL_RETRY_MS: "50",
        MUX_TELEGRAM_BOOTSTRAP_LATEST: "false",
      },
    });

    const claim = await h.claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-FORUM-GEN-1",
    });
    expect(claim.status).toBe(200);
    releaseUpdates = true;

    await h.waitForCondition(
      () => inboundRequests.length > 0,
      5_000,
      "timed out waiting for forum general inbound forward",
    );

    expect(inboundRequests[0]).toMatchObject({
      channel: "telegram",
      sessionKey: "agent:main:telegram:group:-100909:topic:1",
      threadId: 1,
      channelData: {
        chatId: "-100909",
        topicId: 1,
        routeKey: "telegram:default:chat:-100909:topic:1",
      },
    });

    const outbound = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "telegram",
        sessionKey: "agent:main:telegram:group:-100909:topic:1",
        raw: {
          telegram: {
            method: "sendMessage",
            body: {
              text: "forum general reply",
              message_thread_id: 1,
            },
          },
        },
      }),
    });
    expect(outbound.status).toBe(200);

    const sendMessageRequest = telegramRequests.find(
      (request) =>
        request.path === "/botdummy-token/sendMessage" &&
        h.toSafeString(request.body.text) === "forum general reply",
    );
    expect(sendMessageRequest).toBeDefined();
    expect(h.toSafeString(sendMessageRequest?.body.chat_id)).toBe("-100909");
    expect(sendMessageRequest?.body.message_thread_id).toBeUndefined();

    const typing = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "telegram",
        sessionKey: "agent:main:telegram:group:-100909:topic:1",
        op: "action",
        action: "typing",
      }),
    });
    expect(typing.status).toBe(200);

    const typingRequest = telegramRequests.find(
      (request) => request.path === "/botdummy-token/sendChatAction",
    );
    expect(typingRequest).toBeDefined();
    expect(h.toSafeString(typingRequest?.body.chat_id)).toBe("-100909");
    expect(h.toSafeString(typingRequest?.body.action)).toBe("typing");
    expect(typingRequest?.body.message_thread_id).toBe(1);
  });

  test("pairs from dashboard token sent in discord DM and forwards later message", async () => {
    const inboundRequests: Array<Record<string, unknown>> = [];
    const inbound = await h.startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      inboundRequests.push(await h.readJsonBody(req));
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });

    const dmChannelId = "777001";
    const dmUserId = "4242";
    const pairingNotices: Array<Record<string, unknown>> = [];
    const gatewayState: {
      socket: h.TestWebSocket | null;
      identified: boolean;
      dispatched: boolean;
      pairingToken: string | null;
    } = {
      socket: null,
      identified: false,
      dispatched: false,
      pairingToken: null,
    };

    const dispatchGatewayMessages = () => {
      if (
        !gatewayState.socket ||
        !gatewayState.identified ||
        !gatewayState.pairingToken ||
        gatewayState.dispatched
      ) {
        return;
      }
      gatewayState.dispatched = true;
      const socket = gatewayState.socket;
      const author = {
        id: dmUserId,
        bot: false,
        username: "tester",
      };
      const buildMessage = (id: string, content: string, timestamp: string) => ({
        id,
        channel_id: dmChannelId,
        type: 0,
        content,
        author,
        attachments: [],
        mentions: [],
        mention_roles: [],
        timestamp,
      });
      setTimeout(() => {
        socket.send(
          JSON.stringify({
            op: 0,
            t: "MESSAGE_CREATE",
            s: 2,
            d: buildMessage("1001", "hello before pairing", "2026-01-01T00:00:01.000Z"),
          }),
        );
      }, 40);
      setTimeout(() => {
        socket.send(
          JSON.stringify({
            op: 0,
            t: "MESSAGE_CREATE",
            s: 3,
            d: buildMessage("1002", "mpt_abcdefghijklmnopqrstuvwxyz", "2026-01-01T00:00:02.000Z"),
          }),
        );
      }, 120);
      setTimeout(() => {
        socket.send(
          JSON.stringify({
            op: 0,
            t: "MESSAGE_CREATE",
            s: 4,
            d: buildMessage("1003", gatewayState.pairingToken ?? "", "2026-01-01T00:00:03.000Z"),
          }),
        );
      }, 200);
      setTimeout(() => {
        socket.send(
          JSON.stringify({
            op: 0,
            t: "MESSAGE_CREATE",
            s: 5,
            d: buildMessage("1004", "hello after pair", "2026-01-01T00:00:04.000Z"),
          }),
        );
      }, 280);
    };

    const gateway = await h.startWsServer((socket) => {
      gatewayState.socket = socket;
      socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }));
      socket.on("message", (raw) => {
        const payloadText =
          typeof raw === "string"
            ? raw
            : Buffer.isBuffer(raw)
              ? raw.toString("utf8")
              : Array.isArray(raw)
                ? Buffer.concat(raw).toString("utf8")
                : Buffer.from(raw).toString("utf8");
        const frame = JSON.parse(payloadText) as { op?: unknown };
        if (Number(frame.op) !== 2) {
          return;
        }
        gatewayState.identified = true;
        socket.send(
          JSON.stringify({
            op: 0,
            t: "READY",
            s: 1,
            d: { session_id: "gateway-session-dm-test" },
          }),
        );
        dispatchGatewayMessages();
      });
      socket.on("close", () => {
        gatewayState.socket = null;
        gatewayState.identified = false;
      });
    });

    const discordApi = await h.startHttpServer(async (req, res) => {
      const method = req.method ?? "GET";
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");

      if (method === "GET" && requestUrl.pathname === "/gateway/bot") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ url: gateway.url }));
        return;
      }

      const channelMessagesMatch = requestUrl.pathname.match(/^\/channels\/(\d+)\/messages$/);
      if (method === "POST" && channelMessagesMatch) {
        pairingNotices.push(await h.readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            id: String(9000 + pairingNotices.length),
            channel_id: channelMessagesMatch[1],
          }),
        );
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const server = await h.startServer({
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
        MUX_DISCORD_API_BASE_URL: discordApi.url,
        MUX_DISCORD_POLL_INTERVAL_MS: "50",
        MUX_DISCORD_BOOTSTRAP_LATEST: "false",
        MUX_PAIRING_INVALID_TEXT: "Invalid token. Request a new link.",
        MUX_UNPAIRED_HINT_TEXT: "This chat is not paired.",
      },
    });

    const tokenResponse = await h.createAdminPairingToken({
      port: server.port,
      adminToken: h.DEFAULT_ADMIN_TOKEN,
      openclawId: "tenant-a",
      ttlSec: 120,
    });
    expect(tokenResponse.status).toBe(200);
    const tokenBody = (await tokenResponse.json()) as {
      token: string;
      deepLink?: string | null;
      startCommand?: string | null;
    };
    expect(tokenBody.token.startsWith("mpt_")).toBe(true);

    gatewayState.pairingToken = tokenBody.token;
    dispatchGatewayMessages();

    await h.waitForCondition(
      () => h.filterRealInbound(inboundRequests).length >= 1 && pairingNotices.length >= 3,
      12_000,
      "timed out waiting for discord post-pair inbound forward and notices",
    );

    const realInbound = h.filterRealInbound(inboundRequests);
    expect(realInbound).toHaveLength(1);
    expect(realInbound[0]).toMatchObject({
      channel: "discord",
      sessionKey: "agent:main:discord:direct:4242",
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
      pairingNotices.some((message) =>
        h.toSafeString(message.content).includes("This chat is not paired"),
      ),
    ).toBe(true);
    expect(
      pairingNotices.some((message) => h.toSafeString(message.content).includes("Invalid token")),
    ).toBe(true);
    expect(
      pairingNotices.some((message) => h.toSafeString(message.content).includes("Paired")),
    ).toBe(true);

    const pairings = await h.listPairings({ port: server.port, apiKey: "tenant-a-key" });
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

  test("maps discord guild threads to thread-scoped sessions from guild-scoped pairing", async () => {
    const inboundRequests: Array<Record<string, unknown>> = [];
    const inbound = await h.startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      inboundRequests.push(await h.readJsonBody(req));
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });

    const guildId = "9001";
    const guildChannelId = "12345";
    const threadAId = "777101";
    const threadBId = "777102";
    const guildUserId = "4242";
    const pairingNotices: Array<Record<string, unknown>> = [];

    const gatewayState: {
      socket: h.TestWebSocket | null;
      identified: boolean;
      dispatched: boolean;
      pairingToken: string | null;
    } = {
      socket: null,
      identified: false,
      dispatched: false,
      pairingToken: null,
    };

    const dispatchGatewayMessages = () => {
      if (
        !gatewayState.socket ||
        !gatewayState.identified ||
        !gatewayState.pairingToken ||
        gatewayState.dispatched
      ) {
        return;
      }
      gatewayState.dispatched = true;
      const socket = gatewayState.socket;
      const author = {
        id: guildUserId,
        bot: false,
        username: "guild-user",
      };
      const buildMessage = (
        id: string,
        channelId: string,
        content: string,
        isoTimestamp: string,
      ) => ({
        id,
        channel_id: channelId,
        guild_id: guildId,
        type: 0,
        content,
        author,
        thread: {
          id: channelId,
          parent_id: guildChannelId,
        },
        attachments: [],
        mentions: [],
        mention_roles: [],
        timestamp: isoTimestamp,
      });
      setTimeout(() => {
        socket.send(
          JSON.stringify({
            op: 0,
            t: "MESSAGE_CREATE",
            s: 2,
            d: buildMessage(
              "2001",
              threadAId,
              gatewayState.pairingToken ?? "",
              "2026-01-01T00:01:01.000Z",
            ),
          }),
        );
      }, 40);
      setTimeout(() => {
        socket.send(
          JSON.stringify({
            op: 0,
            t: "MESSAGE_CREATE",
            s: 3,
            d: buildMessage("2002", threadAId, "hello guild thread a", "2026-01-01T00:01:02.000Z"),
          }),
        );
      }, 180);
      setTimeout(() => {
        socket.send(
          JSON.stringify({
            op: 0,
            t: "MESSAGE_CREATE",
            s: 4,
            d: buildMessage("2003", threadBId, "hello guild thread b", "2026-01-01T00:01:03.000Z"),
          }),
        );
      }, 320);
    };

    const gateway = await h.startWsServer((socket) => {
      gatewayState.socket = socket;
      socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }));
      socket.on("message", (raw) => {
        const payloadText =
          typeof raw === "string"
            ? raw
            : Buffer.isBuffer(raw)
              ? raw.toString("utf8")
              : Array.isArray(raw)
                ? Buffer.concat(raw).toString("utf8")
                : Buffer.from(raw).toString("utf8");
        const frame = JSON.parse(payloadText) as { op?: unknown };
        if (Number(frame.op) !== 2) {
          return;
        }
        gatewayState.identified = true;
        socket.send(
          JSON.stringify({
            op: 0,
            t: "READY",
            s: 1,
            d: { session_id: "gateway-session-test" },
          }),
        );
        dispatchGatewayMessages();
      });
      socket.on("close", () => {
        gatewayState.socket = null;
        gatewayState.identified = false;
      });
    });

    const discordApi = await h.startHttpServer(async (req, res) => {
      const method = req.method ?? "GET";
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");

      if (method === "GET" && requestUrl.pathname === "/gateway/bot") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ url: gateway.url }));
        return;
      }

      const channelMessagesMatch = requestUrl.pathname.match(/^\/channels\/(\d+)\/messages$/);
      if (channelMessagesMatch) {
        if (method === "GET") {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify([]));
          return;
        }
        if (method === "POST") {
          pairingNotices.push(await h.readJsonBody(req));
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(
            JSON.stringify({
              id: String(10_000 + pairingNotices.length),
              channel_id: channelMessagesMatch[1],
            }),
          );
          return;
        }
      }

      const channelMatch = requestUrl.pathname.match(/^\/channels\/(\d+)$/);
      if (method === "GET" && channelMatch) {
        const channelId = channelMatch[1];
        if (channelId === threadAId || channelId === threadBId) {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(
            JSON.stringify({
              id: channelId,
              guild_id: guildId,
              parent_id: guildChannelId,
              type: 11,
            }),
          );
          return;
        }
        if (channelId === guildChannelId) {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(
            JSON.stringify({
              id: channelId,
              guild_id: guildId,
              type: 0,
            }),
          );
          return;
        }
      }

      res.writeHead(404);
      res.end();
    });

    const server = await h.startServer({
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
        MUX_DISCORD_API_BASE_URL: discordApi.url,
        MUX_DISCORD_POLL_INTERVAL_MS: "50",
        MUX_DISCORD_BOOTSTRAP_LATEST: "false",
        MUX_DISCORD_GATEWAY_DM_ENABLED: "false",
        MUX_DISCORD_GATEWAY_GUILD_ENABLED: "true",
      },
    });

    const tokenResponse = await h.createAdminPairingToken({
      port: server.port,
      adminToken: h.DEFAULT_ADMIN_TOKEN,
      openclawId: "tenant-a",
      channel: "discord",
      sessionKey: `agent:main:discord:channel:${guildChannelId}`,
      ttlSec: 120,
    });
    expect(tokenResponse.status).toBe(200);
    const tokenBody = (await tokenResponse.json()) as {
      token: string;
    };
    gatewayState.pairingToken = tokenBody.token;
    dispatchGatewayMessages();

    await h.waitForCondition(
      () =>
        h.filterRealInbound(inboundRequests).length >= 2 &&
        inboundRequests.some((request) =>
          h.toSafeString(request.messageId).startsWith("synth:pair:"),
        ),
      25_000,
      "timed out waiting for discord guild thread inbound forwards",
    );

    const realInbound = h.filterRealInbound(inboundRequests);
    const syntheticInbound = inboundRequests.find((request) =>
      h.toSafeString(request.messageId).startsWith("synth:pair:"),
    );
    expect(realInbound).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "discord",
          sessionKey: `agent:main:discord:channel:${threadAId}`,
          body: "hello guild thread a",
          threadId: threadAId,
          chatType: "group",
          channelData: expect.objectContaining({
            channelId: threadAId,
            guildId,
            routeKey: `discord:default:guild:${guildId}:channel:${guildChannelId}:thread:${threadAId}`,
          }),
        }),
        expect.objectContaining({
          channel: "discord",
          sessionKey: `agent:main:discord:channel:${threadBId}`,
          body: "hello guild thread b",
          threadId: threadBId,
          chatType: "group",
          channelData: expect.objectContaining({
            channelId: threadBId,
            guildId,
            routeKey: `discord:default:guild:${guildId}:channel:${guildChannelId}:thread:${threadBId}`,
          }),
        }),
      ]),
    );
    expect(syntheticInbound).toMatchObject({
      channel: "discord",
      sessionKey: `agent:main:discord:channel:${threadAId}`,
      chatType: "group",
      channelData: expect.objectContaining({
        channelId: threadAId,
        guildId,
        routeKey: `discord:default:guild:${guildId}`,
      }),
    });

    expect(pairingNotices.some((notice) => h.toSafeString(notice.content).includes("Paired"))).toBe(
      true,
    );

    const pairings = await h.listPairings({ port: server.port, apiKey: "tenant-a-key" });
    expect(pairings.status).toBe(200);
    expect(await pairings.json()).toEqual({
      items: [
        {
          bindingId: expect.stringContaining("bind_"),
          channel: "discord",
          scope: "guild",
          routeKey: `discord:default:guild:${guildId}`,
        },
      ],
    });
  }, 30_000);

  test("keeps legacy discord channel-scoped guild bindings routable during migration", async () => {
    const inboundRequests: Array<Record<string, unknown>> = [];
    const inbound = await h.startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      inboundRequests.push(await h.readJsonBody(req));
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });

    const guildId = "9010";
    const guildChannelId = "22345";
    const threadAId = "887101";
    const threadBId = "887102";
    const guildUserId = "5252";

    const gatewayState: {
      socket: h.TestWebSocket | null;
      identified: boolean;
      dispatched: boolean;
    } = {
      socket: null,
      identified: false,
      dispatched: false,
    };

    const dispatchGatewayMessages = () => {
      if (!gatewayState.socket || !gatewayState.identified || gatewayState.dispatched) {
        return;
      }
      gatewayState.dispatched = true;
      const socket = gatewayState.socket;
      const author = {
        id: guildUserId,
        bot: false,
        username: "legacy-guild-user",
      };
      const buildMessage = (
        id: string,
        channelId: string,
        content: string,
        isoTimestamp: string,
      ) => ({
        id,
        channel_id: channelId,
        guild_id: guildId,
        type: 0,
        content,
        author,
        thread: {
          id: channelId,
          parent_id: guildChannelId,
        },
        attachments: [],
        mentions: [],
        mention_roles: [],
        timestamp: isoTimestamp,
      });
      setTimeout(() => {
        socket.send(
          JSON.stringify({
            op: 0,
            t: "MESSAGE_CREATE",
            s: 2,
            d: buildMessage("3001", threadAId, "hello legacy thread a", "2026-01-01T00:02:01.000Z"),
          }),
        );
      }, 80);
      setTimeout(() => {
        socket.send(
          JSON.stringify({
            op: 0,
            t: "MESSAGE_CREATE",
            s: 3,
            d: buildMessage("3002", threadBId, "hello legacy thread b", "2026-01-01T00:02:02.000Z"),
          }),
        );
      }, 220);
    };

    const gateway = await h.startWsServer((socket) => {
      gatewayState.socket = socket;
      socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }));
      socket.on("message", (raw) => {
        const payloadText =
          typeof raw === "string"
            ? raw
            : Buffer.isBuffer(raw)
              ? raw.toString("utf8")
              : Array.isArray(raw)
                ? Buffer.concat(raw).toString("utf8")
                : Buffer.from(raw).toString("utf8");
        const frame = JSON.parse(payloadText) as { op?: unknown };
        if (Number(frame.op) !== 2) {
          return;
        }
        gatewayState.identified = true;
        socket.send(
          JSON.stringify({
            op: 0,
            t: "READY",
            s: 1,
            d: { session_id: "gateway-session-legacy-channel-binding" },
          }),
        );
        dispatchGatewayMessages();
      });
      socket.on("close", () => {
        gatewayState.socket = null;
        gatewayState.identified = false;
      });
    });

    const discordApi = await h.startHttpServer(async (req, res) => {
      const method = req.method ?? "GET";
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");

      if (method === "GET" && requestUrl.pathname === "/gateway/bot") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ url: gateway.url }));
        return;
      }

      const channelMessagesMatch = requestUrl.pathname.match(/^\/channels\/(\d+)\/messages$/);
      if (channelMessagesMatch && method === "GET") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify([]));
        return;
      }

      const channelMatch = requestUrl.pathname.match(/^\/channels\/(\d+)$/);
      if (method === "GET" && channelMatch) {
        const channelId = channelMatch[1];
        if (channelId === threadAId || channelId === threadBId) {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(
            JSON.stringify({
              id: channelId,
              guild_id: guildId,
              parent_id: guildChannelId,
              type: 11,
            }),
          );
          return;
        }
        if (channelId === guildChannelId) {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(
            JSON.stringify({
              id: channelId,
              guild_id: guildId,
              type: 0,
            }),
          );
          return;
        }
      }

      res.writeHead(404);
      res.end();
    });

    const server = await h.startServer({
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
          code: "LEGACYCH",
          tenantId: "tenant-a",
          channel: "discord",
          scope: "channel",
          routeKey: `discord:default:guild:${guildId}:channel:${guildChannelId}`,
        },
      ]),
      extraEnv: {
        MUX_DISCORD_API_BASE_URL: discordApi.url,
        MUX_DISCORD_POLL_INTERVAL_MS: "50",
        MUX_DISCORD_BOOTSTRAP_LATEST: "false",
        MUX_DISCORD_GATEWAY_DM_ENABLED: "false",
        MUX_DISCORD_GATEWAY_GUILD_ENABLED: "true",
      },
    });

    const claim = await h.claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "LEGACYCH",
      sessionKey: `agent:main:discord:channel:${guildChannelId}`,
    });
    expect(claim.status).toBe(200);

    await h.waitForCondition(
      () => h.filterRealInbound(inboundRequests).length >= 2,
      25_000,
      "timed out waiting for discord legacy channel binding inbound forwards",
    );

    const realInbound = h.filterRealInbound(inboundRequests);
    expect(realInbound).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "discord",
          sessionKey: `agent:main:discord:channel:${threadAId}`,
          body: "hello legacy thread a",
          threadId: threadAId,
          chatType: "group",
          channelData: expect.objectContaining({
            channelId: threadAId,
            guildId,
            routeKey: `discord:default:guild:${guildId}:channel:${guildChannelId}:thread:${threadAId}`,
          }),
        }),
        expect.objectContaining({
          channel: "discord",
          sessionKey: `agent:main:discord:channel:${threadBId}`,
          body: "hello legacy thread b",
          threadId: threadBId,
          chatType: "group",
          channelData: expect.objectContaining({
            channelId: threadBId,
            guildId,
            routeKey: `discord:default:guild:${guildId}:channel:${guildChannelId}:thread:${threadBId}`,
          }),
        }),
      ]),
    );

    const pairings = await h.listPairings({ port: server.port, apiKey: "tenant-a-key" });
    expect(pairings.status).toBe(200);
    expect(await pairings.json()).toEqual({
      items: [
        {
          bindingId: expect.stringContaining("bind_"),
          channel: "discord",
          scope: "channel",
          routeKey: `discord:default:guild:${guildId}:channel:${guildChannelId}`,
        },
      ],
    });
  }, 30_000);

  test("telegram bot control commands support help, status, unpair, and switch", async () => {
    const inboundRequests: Array<Record<string, unknown>> = [];
    const inbound = await h.startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      inboundRequests.push(await h.readJsonBody(req));
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });

    const pendingUpdates: Array<Record<string, unknown>> = [];
    const sentMessages: Array<Record<string, unknown>> = [];
    const telegramApi = await h.startHttpServer(async (req, res) => {
      if (req.method !== "POST") {
        res.writeHead(404);
        res.end();
        return;
      }
      if (req.url === "/botdummy-token/getUpdates") {
        const body = await h.readJsonBody(req);
        const offset = typeof body.offset === "number" ? Number(body.offset) : 0;
        const deliverable = pendingUpdates
          .map((entry) => {
            const updateId = Number(entry.update_id ?? 0);
            return { entry, updateId };
          })
          .filter((entry) => Number.isFinite(entry.updateId) && entry.updateId >= offset)
          .toSorted((a, b) => a.updateId - b.updateId);
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
        sentMessages.push(await h.readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: true,
            result: {
              message_id: 1101,
              chat: { id: -100888, type: "supergroup", title: "mux-bot-control" },
            },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await h.startServer({
      tenantsJson: JSON.stringify([
        {
          id: "tenant-a",
          name: "Tenant A",
          apiKey: "tenant-a-key",
          inboundUrl: `${inbound.url}/v1/mux/inbound`,
          inboundTimeoutMs: 2_000,
        },
        {
          id: "tenant-b",
          name: "Tenant B",
          apiKey: "tenant-b-key",
          inboundUrl: `${inbound.url}/v1/mux/inbound`,
          inboundTimeoutMs: 2_000,
        },
      ]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-TG-BOT-CTRL",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100888",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
        MUX_TELEGRAM_POLL_TIMEOUT_SEC: "1",
        MUX_TELEGRAM_POLL_RETRY_MS: "50",
        MUX_TELEGRAM_BOOTSTRAP_LATEST: "false",
      },
    });

    const initialClaim = await h.claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-TG-BOT-CTRL",
      sessionKey: "agent:main:telegram:group:-100888",
    });
    expect(initialClaim.status).toBe(200);

    const switchTokenResponse = await h.createAdminPairingToken({
      port: server.port,
      adminToken: h.DEFAULT_ADMIN_TOKEN,
      openclawId: "tenant-b",
      channel: "telegram",
      sessionKey: "agent:main:telegram:group:-100888:switch",
      ttlSec: 120,
    });
    expect(switchTokenResponse.status).toBe(200);
    const switchTokenBody = (await switchTokenResponse.json()) as { token: string };
    expect(switchTokenBody.token.startsWith("mpt_")).toBe(true);

    pendingUpdates.push(
      {
        update_id: 4101,
        message: {
          message_id: 9101,
          text: "/bot_help",
          date: 1_700_000_100,
          from: { id: 1234 },
          chat: { id: -100888, type: "supergroup" },
        },
      },
      {
        update_id: 4102,
        message: {
          message_id: 9102,
          text: "/bot_status",
          date: 1_700_000_101,
          from: { id: 1234 },
          chat: { id: -100888, type: "supergroup" },
        },
      },
      {
        update_id: 4103,
        message: {
          message_id: 9103,
          text: "/bot_unpair",
          date: 1_700_000_102,
          from: { id: 1234 },
          chat: { id: -100888, type: "supergroup" },
        },
      },
      {
        update_id: 4104,
        message: {
          message_id: 9104,
          text: `/bot_switch ${switchTokenBody.token}`,
          date: 1_700_000_103,
          from: { id: 1234 },
          chat: { id: -100888, type: "supergroup" },
        },
      },
      {
        update_id: 4105,
        message: {
          message_id: 9105,
          text: "/help",
          date: 1_700_000_104,
          from: { id: 1234 },
          chat: { id: -100888, type: "supergroup" },
        },
      },
    );

    await h.waitForCondition(
      () => h.filterRealInbound(inboundRequests).length >= 1 && sentMessages.length >= 4,
      7_000,
      "timed out waiting for telegram bot control flow",
    );

    expect(
      sentMessages.some((msg) => h.toSafeString(msg.text).includes("Bot control commands")),
    ).toBe(true);
    expect(sentMessages.some((msg) => h.toSafeString(msg.text).includes("Bot status"))).toBe(true);
    expect(sentMessages.some((msg) => h.toSafeString(msg.text).includes("Paired: yes"))).toBe(true);
    expect(
      sentMessages.some((msg) => h.toSafeString(msg.text).includes("Unpaired successfully")),
    ).toBe(true);
    expect(
      sentMessages.some((msg) => h.toSafeString(msg.text).includes("Paired successfully")),
    ).toBe(true);

    const realInboundTg = h.filterRealInbound(inboundRequests);
    expect(realInboundTg).toHaveLength(1);
    expect(realInboundTg[0]).toMatchObject({
      channel: "telegram",
      sessionKey: "agent:main:telegram:group:-100888:switch",
      body: "/help",
      channelData: {
        routeKey: "telegram:default:chat:-100888",
      },
    });
    expect(
      inboundRequests.find((request) =>
        h.toSafeString(request.messageId).startsWith("synth:pair:"),
      ),
    ).toMatchObject({
      channel: "telegram",
      from: "telegram:1234",
      sessionKey: "agent:main:telegram:group:-100888:switch",
      channelData: {
        routeKey: "telegram:default:chat:-100888",
      },
    });

    const pairingsA = await h.listPairings({ port: server.port, apiKey: "tenant-a-key" });
    expect(pairingsA.status).toBe(200);
    expect(await pairingsA.json()).toEqual({ items: [] });

    const pairingsB = await h.listPairings({ port: server.port, apiKey: "tenant-b-key" });
    expect(pairingsB.status).toBe(200);
    expect(await pairingsB.json()).toEqual({
      items: [
        {
          bindingId: expect.stringContaining("bind_"),
          channel: "telegram",
          scope: "chat",
          routeKey: "telegram:default:chat:-100888",
        },
      ],
    });
  }, 20_000);

  test("discord bot control commands support status, unpair, and switch on an active route", async () => {
    const inboundRequests: Array<Record<string, unknown>> = [];
    const inbound = await h.startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      inboundRequests.push(await h.readJsonBody(req));
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });

    const dmChannelId = "778001";
    const dmUserId = "4242";
    const sentMessages: Array<Record<string, unknown>> = [];
    const pendingMessages: Array<Record<string, unknown>> = [];
    const discordApi = await h.startHttpServer(async (req, res) => {
      const method = req.method ?? "GET";
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");

      if (method === "POST" && requestUrl.pathname === "/users/@me/channels") {
        const body = await h.readJsonBody(req);
        const recipientId = h.toSafeString(body.recipient_id);
        if (recipientId === dmUserId) {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ id: dmChannelId }));
          return;
        }
      }

      if (method === "GET" && requestUrl.pathname === `/channels/${dmChannelId}/messages`) {
        const after = requestUrl.searchParams.get("after");
        const afterNum = after && /^\d+$/.test(after) ? BigInt(after) : null;
        const deliverable = pendingMessages
          .filter((message) => {
            const id = h.toSafeString(message.id);
            if (!/^\d+$/.test(id)) {
              return false;
            }
            return afterNum === null ? true : BigInt(id) > afterNum;
          })
          .toSorted(
            (a, b) => Number(h.toSafeString(a.id, "0")) - Number(h.toSafeString(b.id, "0")),
          );
        if (deliverable.length > 0) {
          const maxDelivered = BigInt(h.toSafeString(deliverable[deliverable.length - 1]?.id, "0"));
          for (let i = pendingMessages.length - 1; i >= 0; i -= 1) {
            const id = h.toSafeString(pendingMessages[i]?.id, "0");
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
        sentMessages.push(await h.readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            id: String(9500 + sentMessages.length),
            channel_id: dmChannelId,
          }),
        );
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const server = await h.startServer({
      tenantsJson: JSON.stringify([
        {
          id: "tenant-a",
          name: "Tenant A",
          apiKey: "tenant-a-key",
          inboundUrl: `${inbound.url}/v1/mux/inbound`,
          inboundTimeoutMs: 2_000,
        },
        {
          id: "tenant-b",
          name: "Tenant B",
          apiKey: "tenant-b-key",
          inboundUrl: `${inbound.url}/v1/mux/inbound`,
          inboundTimeoutMs: 2_000,
        },
      ]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-DC-BOT-CTRL",
          channel: "discord",
          routeKey: "discord:default:dm:user:4242",
          scope: "dm",
        },
      ]),
      extraEnv: {
        MUX_DISCORD_API_BASE_URL: discordApi.url,
        MUX_DISCORD_POLL_INTERVAL_MS: "50",
        MUX_DISCORD_BOOTSTRAP_LATEST: "false",
      },
    });

    const initialClaim = await h.claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-DC-BOT-CTRL",
      sessionKey: "dc:dm:4242",
    });
    expect(initialClaim.status).toBe(200);

    const switchTokenResponse = await h.createAdminPairingToken({
      port: server.port,
      adminToken: h.DEFAULT_ADMIN_TOKEN,
      openclawId: "tenant-b",
      channel: "discord",
      sessionKey: "dc:dm:4242:switch",
      ttlSec: 120,
    });
    expect(switchTokenResponse.status).toBe(200);
    const switchTokenBody = (await switchTokenResponse.json()) as { token: string };
    expect(switchTokenBody.token.startsWith("mpt_")).toBe(true);

    pendingMessages.push(
      {
        id: "1201",
        channel_id: dmChannelId,
        type: 0,
        content: "!bot_status",
        author: { id: dmUserId, bot: false, username: "tester" },
        attachments: [],
        mentions: [],
        mention_roles: [],
        timestamp: "2026-01-01T00:10:01.000Z",
      },
      {
        id: "1202",
        channel_id: dmChannelId,
        type: 0,
        content: "/bot_unpair",
        author: { id: dmUserId, bot: false, username: "tester" },
        attachments: [],
        mentions: [],
        mention_roles: [],
        timestamp: "2026-01-01T00:10:02.000Z",
      },
      {
        id: "1203",
        channel_id: dmChannelId,
        type: 0,
        content: "!bot_status",
        author: { id: dmUserId, bot: false, username: "tester" },
        attachments: [],
        mentions: [],
        mention_roles: [],
        timestamp: "2026-01-01T00:10:03.000Z",
      },
      {
        id: "1204",
        channel_id: dmChannelId,
        type: 0,
        content: `!bot_switch ${switchTokenBody.token}`,
        author: { id: dmUserId, bot: false, username: "tester" },
        attachments: [],
        mentions: [],
        mention_roles: [],
        timestamp: "2026-01-01T00:10:04.000Z",
      },
    );

    await h.waitForCondition(
      () => sentMessages.some((msg) => h.toSafeString(msg.content).includes("Paired successfully")),
      12_000,
      "timed out waiting for discord bot switch success",
    );

    pendingMessages.push({
      id: "1205",
      channel_id: dmChannelId,
      type: 0,
      content: "/help",
      author: { id: dmUserId, bot: false, username: "tester" },
      attachments: [],
      mentions: [],
      mention_roles: [],
      timestamp: "2026-01-01T00:10:05.000Z",
    });

    await h.waitForCondition(
      () => h.filterRealInbound(inboundRequests).length >= 1,
      12_000,
      "timed out waiting for discord /help forward after switch",
    );

    expect(sentMessages.some((msg) => h.toSafeString(msg.content).includes("Bot status"))).toBe(
      true,
    );
    expect(sentMessages.some((msg) => h.toSafeString(msg.content).includes("Paired: yes"))).toBe(
      true,
    );
    expect(sentMessages.some((msg) => h.toSafeString(msg.content).includes("Paired: no"))).toBe(
      true,
    );
    expect(
      sentMessages.some((msg) => h.toSafeString(msg.content).includes("Unpaired successfully")),
    ).toBe(true);
    expect(
      sentMessages.some((msg) => h.toSafeString(msg.content).includes("Paired successfully")),
    ).toBe(true);

    const realInboundDc = h.filterRealInbound(inboundRequests);
    expect(realInboundDc).toHaveLength(1);
    expect(realInboundDc[0]).toMatchObject({
      channel: "discord",
      sessionKey: "dc:dm:4242:switch",
      body: "/help",
      channelData: {
        routeKey: "discord:default:dm:user:4242",
      },
    });

    const pairingsA = await h.listPairings({ port: server.port, apiKey: "tenant-a-key" });
    expect(pairingsA.status).toBe(200);
    expect(await pairingsA.json()).toEqual({ items: [] });

    const pairingsB = await h.listPairings({ port: server.port, apiKey: "tenant-b-key" });
    expect(pairingsB.status).toBe(200);
    expect(await pairingsB.json()).toEqual({
      items: [
        {
          bindingId: expect.stringContaining("bind_"),
          channel: "discord",
          scope: "dm",
          routeKey: "discord:default:dm:user:4242",
        },
      ],
    });
  }, 20_000);

  test("discord guild bot_switch preserves the claimer user id in post-pair synthetic inbound", async () => {
    const inboundRequests: Array<Record<string, unknown>> = [];
    const inbound = await h.startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      inboundRequests.push(await h.readJsonBody(req));
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });

    const guildId = "555001";
    const parentChannelId = "777001";
    const threadId = "777102";
    const claimerId = "4242";
    const sentMessages: Array<Record<string, unknown>> = [];
    const gatewayState: {
      socket: h.TestWebSocket | null;
      identified: boolean;
    } = {
      socket: null,
      identified: false,
    };

    const dispatchThreadMessage = (id: string, content: string, timestamp: string) => {
      if (!gatewayState.socket || !gatewayState.identified) {
        return;
      }
      gatewayState.socket.send(
        JSON.stringify({
          op: 0,
          t: "MESSAGE_CREATE",
          s: Number(id),
          d: {
            id,
            channel_id: threadId,
            guild_id: guildId,
            type: 0,
            content,
            author: {
              id: claimerId,
              bot: false,
              username: "tester",
            },
            thread: {
              id: threadId,
              parent_id: parentChannelId,
            },
            attachments: [],
            mentions: [],
            mention_roles: [],
            timestamp,
          },
        }),
      );
    };

    const gateway = await h.startWsServer((socket) => {
      gatewayState.socket = socket;
      socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }));
      socket.on("message", (raw) => {
        const payloadText =
          typeof raw === "string"
            ? raw
            : Buffer.isBuffer(raw)
              ? raw.toString("utf8")
              : Array.isArray(raw)
                ? Buffer.concat(raw).toString("utf8")
                : Buffer.from(raw).toString("utf8");
        const frame = JSON.parse(payloadText) as { op?: unknown };
        if (Number(frame.op) !== 2) {
          return;
        }
        gatewayState.identified = true;
        socket.send(
          JSON.stringify({
            op: 0,
            t: "READY",
            s: 1,
            d: { session_id: "gateway-session-discord-guild-bot-switch" },
          }),
        );
      });
      socket.on("close", () => {
        gatewayState.socket = null;
        gatewayState.identified = false;
      });
    });

    const discordApi = await h.startHttpServer(async (req, res) => {
      const method = req.method ?? "GET";
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      if (method === "GET" && requestUrl.pathname === "/gateway/bot") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ url: gateway.url }));
        return;
      }

      const channelMessagesMatch = requestUrl.pathname.match(/^\/channels\/(\d+)\/messages$/);
      if (method === "POST" && channelMessagesMatch) {
        sentMessages.push(await h.readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            id: String(9600 + sentMessages.length),
            channel_id: channelMessagesMatch[1],
          }),
        );
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const server = await h.startServer({
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
        MUX_DISCORD_API_BASE_URL: discordApi.url,
        MUX_DISCORD_BOOTSTRAP_LATEST: "false",
        MUX_DISCORD_GATEWAY_DM_ENABLED: "false",
        MUX_DISCORD_GATEWAY_GUILD_ENABLED: "true",
      },
    });

    const tokenResponse = await h.createAdminPairingToken({
      port: server.port,
      adminToken: h.DEFAULT_ADMIN_TOKEN,
      openclawId: "tenant-a",
      channel: "discord",
      sessionKey: `agent:main:discord:channel:${threadId}`,
      ttlSec: 120,
    });
    expect(tokenResponse.status).toBe(200);
    const tokenBody = (await tokenResponse.json()) as { token: string };
    expect(tokenBody.token.startsWith("mpt_")).toBe(true);

    await h.waitForCondition(
      () => gatewayState.identified,
      5_000,
      "timed out waiting for discord gateway identify before guild bot_switch",
    );

    dispatchThreadMessage("2001", `!bot_switch ${tokenBody.token}`, "2026-01-01T00:20:01.000Z");

    await h.waitForCondition(
      () =>
        sentMessages.some((message) => h.toSafeString(message.content).includes("Paired")) &&
        inboundRequests.some((request) =>
          h.toSafeString(request.messageId).startsWith("synth:pair:"),
        ),
      8_000,
      "timed out waiting for discord guild post-pair synthetic inbound",
    );

    expect(sentMessages.some((message) => h.toSafeString(message.content).includes("Paired"))).toBe(
      true,
    );
    expect(
      inboundRequests.find((request) =>
        h.toSafeString(request.messageId).startsWith("synth:pair:"),
      ),
    ).toMatchObject({
      channel: "discord",
      from: `discord:${claimerId}`,
      to: `channel:${threadId}`,
      sessionKey: `agent:main:discord:channel:${threadId}`,
      chatType: "group",
      channelData: {
        routeKey: `discord:default:guild:${guildId}`,
        channelId: threadId,
        guildId,
      },
    });
  }, 20_000);

  test("acks discord invalid pairing token message to avoid replay spam", async () => {
    const dmChannelId = "997001";
    const dmUserId = "9090";
    const sentMessages: Array<Record<string, unknown>> = [];
    const gatewayState: {
      socket: h.TestWebSocket | null;
      identified: boolean;
      allowDispatch: boolean;
      dispatched: boolean;
    } = {
      socket: null,
      identified: false,
      allowDispatch: false,
      dispatched: false,
    };

    const dispatchInvalidTokenMessage = () => {
      if (
        !gatewayState.socket ||
        !gatewayState.identified ||
        !gatewayState.allowDispatch ||
        gatewayState.dispatched
      ) {
        return;
      }
      gatewayState.dispatched = true;
      gatewayState.socket.send(
        JSON.stringify({
          op: 0,
          t: "MESSAGE_CREATE",
          s: 2,
          d: {
            id: "1001",
            channel_id: dmChannelId,
            type: 0,
            content: "mpt_invalid_token_value_abcdefghijklmnopqrstuvwxyz",
            author: {
              id: dmUserId,
              bot: false,
              username: "tester",
            },
            attachments: [],
            mentions: [],
            mention_roles: [],
            timestamp: "2026-01-01T00:00:01.000Z",
          },
        }),
      );
    };

    const gateway = await h.startWsServer((socket) => {
      gatewayState.socket = socket;
      socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }));
      socket.on("message", (raw) => {
        const payloadText =
          typeof raw === "string"
            ? raw
            : Buffer.isBuffer(raw)
              ? raw.toString("utf8")
              : Array.isArray(raw)
                ? Buffer.concat(raw).toString("utf8")
                : Buffer.from(raw).toString("utf8");
        const frame = JSON.parse(payloadText) as { op?: unknown };
        if (Number(frame.op) !== 2) {
          return;
        }
        gatewayState.identified = true;
        socket.send(
          JSON.stringify({
            op: 0,
            t: "READY",
            s: 1,
            d: { session_id: "gateway-session-invalid-token" },
          }),
        );
        dispatchInvalidTokenMessage();
      });
      socket.on("close", () => {
        gatewayState.socket = null;
        gatewayState.identified = false;
      });
    });

    const discordApi = await h.startHttpServer(async (req, res) => {
      const method = req.method ?? "GET";
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      if (method === "GET" && requestUrl.pathname === "/gateway/bot") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ url: gateway.url }));
        return;
      }

      const channelMessagesMatch = requestUrl.pathname.match(/^\/channels\/(\d+)\/messages$/);
      if (method === "POST" && channelMessagesMatch) {
        sentMessages.push(await h.readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            id: String(9000 + sentMessages.length),
            channel_id: channelMessagesMatch[1],
          }),
        );
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      extraEnv: {
        MUX_DISCORD_API_BASE_URL: discordApi.url,
        MUX_DISCORD_POLL_INTERVAL_MS: "50",
        MUX_DISCORD_BOOTSTRAP_LATEST: "false",
        MUX_PAIRING_INVALID_TEXT: "Invalid token. Request a new link.",
      },
    });

    const tokenResponse = await h.createAdminPairingToken({
      port: server.port,
      adminToken: h.DEFAULT_ADMIN_TOKEN,
      openclawId: "tenant-a",
      channel: "discord",
      sessionKey: "dc:dm:9090",
      ttlSec: 120,
    });
    expect(tokenResponse.status).toBe(200);
    await h.waitForCondition(
      () => gatewayState.identified,
      5_000,
      "timed out waiting for discord gateway identify",
    );
    gatewayState.allowDispatch = true;
    dispatchInvalidTokenMessage();

    await h.waitForCondition(
      () =>
        sentMessages.some((message) => h.toSafeString(message.content).includes("Invalid token")),
      8_000,
      "timed out waiting for discord invalid-token notice",
    );
    const noticeCountAtFirstAck = sentMessages.length;
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 500));
    expect(sentMessages.length).toBe(noticeCountAtFirstAck);
  }, 15_000);

  test("allows multiple discord pairing tokens without route pre-locking", async () => {
    const server = await h.startServer({
      tenantsJson: JSON.stringify([
        { id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" },
        { id: "tenant-b", name: "Tenant B", apiKey: "tenant-b-key" },
      ]),
    });

    const firstToken = await h.createAdminPairingToken({
      port: server.port,
      adminToken: h.DEFAULT_ADMIN_TOKEN,
      openclawId: "tenant-a",
      sessionKey: "dc:dm:777777",
      ttlSec: 120,
    });
    expect(firstToken.status).toBe(200);
    expect(await firstToken.json()).toMatchObject({
      ok: true,
      token: expect.stringMatching(/^mpt_/),
    });

    const secondToken = await h.createAdminPairingToken({
      port: server.port,
      adminToken: h.DEFAULT_ADMIN_TOKEN,
      openclawId: "tenant-b",
      sessionKey: "dc:dm:777777",
      ttlSec: 120,
    });
    expect(secondToken.status).toBe(200);
    expect(await secondToken.json()).toMatchObject({
      ok: true,
    });
  }, 15_000);

  test("channel-agnostic token can be claimed by any channel", async () => {
    const dmChannelId = "997001";
    const dmUserId = "9090";
    const sentMessages: Array<Record<string, unknown>> = [];
    const gatewayState: {
      socket: h.TestWebSocket | null;
      identified: boolean;
    } = {
      socket: null,
      identified: false,
    };

    const dispatchMessage = (id: string, content: string, timestamp: string) => {
      if (!gatewayState.socket || !gatewayState.identified) {
        return;
      }
      gatewayState.socket.send(
        JSON.stringify({
          op: 0,
          t: "MESSAGE_CREATE",
          s: Number(id),
          d: {
            id,
            channel_id: dmChannelId,
            type: 0,
            content,
            author: {
              id: dmUserId,
              bot: false,
              username: "tester",
            },
            attachments: [],
            mentions: [],
            mention_roles: [],
            timestamp,
          },
        }),
      );
    };

    const gateway = await h.startWsServer((socket) => {
      gatewayState.socket = socket;
      socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }));
      socket.on("message", (raw) => {
        const payloadText =
          typeof raw === "string"
            ? raw
            : Buffer.isBuffer(raw)
              ? raw.toString("utf8")
              : Array.isArray(raw)
                ? Buffer.concat(raw).toString("utf8")
                : Buffer.from(raw).toString("utf8");
        const frame = JSON.parse(payloadText) as { op?: unknown };
        if (Number(frame.op) !== 2) {
          return;
        }
        gatewayState.identified = true;
        socket.send(
          JSON.stringify({
            op: 0,
            t: "READY",
            s: 1,
            d: { session_id: "gateway-session-claim-retry" },
          }),
        );
      });
      socket.on("close", () => {
        gatewayState.socket = null;
        gatewayState.identified = false;
      });
    });

    const discordApi = await h.startHttpServer(async (req, res) => {
      const method = req.method ?? "GET";
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      if (method === "GET" && requestUrl.pathname === "/gateway/bot") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ url: gateway.url }));
        return;
      }

      const channelMessagesMatch = requestUrl.pathname.match(/^\/channels\/(\d+)\/messages$/);
      if (method === "POST" && channelMessagesMatch) {
        sentMessages.push(await h.readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            id: String(9000 + sentMessages.length),
            channel_id: channelMessagesMatch[1],
          }),
        );
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      extraEnv: {
        MUX_DISCORD_API_BASE_URL: discordApi.url,
        MUX_DISCORD_POLL_INTERVAL_MS: "50",
        MUX_DISCORD_BOOTSTRAP_LATEST: "false",
        MUX_PAIRING_INVALID_TEXT: "Invalid token. Request a new link.",
      },
    });

    const tokenResponse = await h.createAdminPairingToken({
      port: server.port,
      adminToken: h.DEFAULT_ADMIN_TOKEN,
      openclawId: "tenant-a",
      sessionKey: "dc:dm:9090",
      ttlSec: 120,
    });
    expect(tokenResponse.status).toBe(200);
    const tokenBody = (await tokenResponse.json()) as { token: string };
    await h.waitForCondition(
      () => gatewayState.identified,
      5_000,
      "timed out waiting for discord gateway identify before token claim",
    );

    // Token issued without channel — should be claimable by discord
    dispatchMessage("1001", tokenBody.token, "2026-01-01T00:00:01.000Z");

    await h.waitForCondition(
      () => sentMessages.some((message) => h.toSafeString(message.content).includes("Paired")),
      6_000,
      "timed out waiting for channel-agnostic discord token claim",
    );
  }, 20_000);

  test("issues channel-agnostic pairing token with telegram deep link", async () => {
    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
    });

    const tokenResponse = await h.createAdminPairingToken({
      port: server.port,
      adminToken: h.DEFAULT_ADMIN_TOKEN,
      openclawId: "tenant-a",
      sessionKey: "agent:main:whatsapp:direct:+15550001111",
      ttlSec: 120,
    });
    expect(tokenResponse.status).toBe(200);
    const body = await tokenResponse.json();
    expect(body).toMatchObject({
      ok: true,
      token: expect.stringMatching(/^mpt_/),
    });
    // Channel-agnostic tokens always include telegram startCommand and deepLink
    expect(typeof (body as Record<string, unknown>).startCommand).toBe("string");
  });
});
