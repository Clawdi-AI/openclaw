import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, test } from "vitest";
import * as h from "./server.test.helpers";

function readWhatsAppQueueDepth(dbPath: string): number {
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true });
  try {
    const row = db.prepare("SELECT COUNT(*) AS count FROM whatsapp_inbound_queue").get() as {
      count?: unknown;
    };
    return typeof row.count === "number" && Number.isFinite(row.count) ? Math.trunc(row.count) : 0;
  } finally {
    db.close();
  }
}

function writeWhatsAppRuntimeMock(params: {
  runtimePath: string;
  message: Record<string, unknown>;
  emitDelayMs?: number;
}) {
  h.writeFileSync(
    params.runtimePath,
    `const emitDelayMs = Number(process.env.MUX_TEST_WHATSAPP_EMIT_DELAY_MS || ${Math.max(
      0,
      Math.trunc(params.emitDelayMs ?? 300),
    )});
const message = ${JSON.stringify(params.message)};

export async function monitorWebInbox(options) {
  let closeResolve;
  const onClose = new Promise((resolve) => {
    closeResolve = resolve;
  });
  setTimeout(() => {
    void options.onMessage(message);
  }, emitDelayMs);
  return {
    onClose,
    async close() {
      closeResolve?.({ status: 0, isLoggedOut: false });
    },
  };
}

export async function sendMessageWhatsApp() {
  return { messageId: "mock-message-id", toJid: "15550001111@s.whatsapp.net" };
}

export async function sendTypingWhatsApp() {}

export function setActiveWebListener() {}
`,
    "utf8",
  );
}

describe("mux server", () => {
  test("forwards inbound Telegram updates to tenant inbound endpoint", async () => {
    const inboundRequests: Array<{
      authorization: string | undefined;
      openclawIdHeader: string | undefined;
      payload: Record<string, unknown>;
    }> = [];
    const inbound = await h.startHttpServer(async (req, res) => {
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
      inboundRequests.push({ authorization, openclawIdHeader, payload });
      res.writeHead(202, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true }));
    });

    const telegramRequests: Array<Record<string, unknown>> = [];
    let releaseUpdates = false;
    let hasSentUpdate = false;
    const telegramApi = await h.startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/botdummy-token/getUpdates") {
        res.writeHead(404);
        res.end();
        return;
      }
      const body = await h.readJsonBody(req);
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
          code: "PAIR-IN-1",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100555",
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
      code: "PAIR-IN-1",
      sessionKey: "agent:main:telegram:group:-100555",
    });
    expect(claim.status).toBe(200);
    releaseUpdates = true;

    await h.waitForCondition(
      () => inboundRequests.length > 0,
      5_000,
      "timed out waiting for inbound forward",
    );

    expect(inboundRequests).toHaveLength(1);
    h.expectInboundJwtAuth(
      {
        authorization: inboundRequests[0]?.authorization,
        openclawIdHeader: inboundRequests[0]?.openclawIdHeader,
      },
      "tenant-a",
    );
    expect(inboundRequests[0]?.payload).toMatchObject({
      eventId: "tg:461",
      channel: "telegram",
      sessionKey: "agent:main:telegram:group:-100555",
      body: "  hello from mux inbound  ",
      from: "telegram:1234",
      to: "telegram:-100555",
      accountId: "default",
      chatType: "group",
      messageId: "462",
      openclawId: "tenant-a",
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

    const callbackAnswers: Array<Record<string, unknown>> = [];
    let releaseUpdates = false;
    let hasSentUpdate = false;
    const telegramApi = await h.startHttpServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/botdummy-token/getUpdates") {
        const body = await h.readJsonBody(req);
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
        callbackAnswers.push(await h.readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, result: true }));
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
          code: "PAIR-CB-TG-1",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100555",
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
      code: "PAIR-CB-TG-1",
      sessionKey: "agent:main:telegram:group:-100555",
    });
    expect(claim.status).toBe(200);
    releaseUpdates = true;

    await h.waitForCondition(
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
      sessionKey: "agent:main:telegram:group:-100555",
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

  test("advances Telegram offset on forward failure and retries in background", async () => {
    const inboundAttempts: Array<Record<string, unknown>> = [];
    let failFirstForward = true;
    const inbound = await h.startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      inboundAttempts.push(await h.readJsonBody(req));
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
    const telegramApi = await h.startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/botdummy-token/getUpdates") {
        res.writeHead(404);
        res.end();
        return;
      }
      const body = await h.readJsonBody(req);
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
          code: "PAIR-IN-RETRY-TG-1",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100556",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
        MUX_TELEGRAM_POLL_TIMEOUT_SEC: "1",
        MUX_TELEGRAM_POLL_RETRY_MS: "50",
        MUX_TELEGRAM_BOOTSTRAP_LATEST: "false",
        // Short retry interval while leaving enough time to observe pending backlog.
        MUX_TELEGRAM_BG_RETRY_INTERVAL_MS: "300",
      },
    });

    const claim = await h.claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-IN-RETRY-TG-1",
      sessionKey: "agent:main:telegram:group:-100556",
    });
    expect(claim.status).toBe(200);
    releaseUpdates = true;

    await h.waitForCondition(
      () => inboundAttempts.length >= 1,
      4_000,
      "timed out waiting for first failed telegram forward attempt",
    );

    let observedRetryBacklog = false;
    const backlogDeadline = Date.now() + 4_000;
    while (Date.now() < backlogDeadline) {
      const readiness = await fetch(`http://127.0.0.1:${server.port}/health/ready`);
      const body = (await readiness.json()) as {
        queues?: { depth?: { telegram?: unknown }; oldestQueuedAgeMs?: { telegram?: unknown } };
      };
      const depth = Number(body.queues?.depth?.telegram);
      if (Number.isFinite(depth) && depth >= 1) {
        observedRetryBacklog = true;
        expect(typeof body.queues?.oldestQueuedAgeMs?.telegram).toBe("number");
        break;
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
    }
    expect(observedRetryBacklog).toBe(true);

    const metrics = await fetch(`http://127.0.0.1:${server.port}/metrics`);
    expect(metrics.status).toBe(200);
    const metricsBody = await metrics.text();
    expect(metricsBody).toContain('mux_queue_depth{channel="telegram"}');

    // The poller should advance the offset immediately (to 462) even though
    // the first forward fails. The background retry delivers the message.
    await h.waitForCondition(
      () => inboundAttempts.length >= 2,
      6_000,
      "timed out waiting for telegram background retry",
    );

    expect(inboundAttempts[0]?.body).toBe("retry telegram message");
    expect(inboundAttempts[1]?.body).toBe("retry telegram message");

    // Offset should advance past 461 after the first (failed) attempt —
    // the poller must NOT re-poll with offset=1 twice.
    const seenOffsets = telegramRequests
      .map((request) => (typeof request.offset === "number" ? Number(request.offset) : null))
      .filter((offset): offset is number => offset !== null);
    expect(seenOffsets.some((offset) => offset === 462)).toBe(true);
  }, 15_000);

  test("forwards media-only Telegram photo updates with attachment payload", async () => {
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

    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5ZfXkAAAAASUVORK5CYII=";
    const pngBuffer = Buffer.from(pngBase64, "base64");
    let releaseUpdates = false;
    let hasSentUpdate = false;
    const telegramApi = await h.startHttpServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/botdummy-token/getUpdates") {
        const body = await h.readJsonBody(req);
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
        const body = await h.readJsonBody(req);
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
          code: "PAIR-IN-MEDIA-1",
          channel: "telegram",
          routeKey: "telegram:default:chat:999",
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
      code: "PAIR-IN-MEDIA-1",
      sessionKey: "agent:main:telegram:direct:999",
    });
    expect(claim.status).toBe(200);

    releaseUpdates = true;
    await h.waitForCondition(
      () => inboundRequests.length > 0,
      5_000,
      "timed out waiting for media-only inbound forward",
    );

    expect(inboundRequests).toHaveLength(1);
    const payload = inboundRequests[0];
    expect(payload.channel).toBe("telegram");
    expect(payload.sessionKey).toBe("agent:main:telegram:direct:999");
    expect(payload.body).toBe("");
    expect(payload.messageId).toBe("9001");

    const attachments = Array.isArray(payload.attachments)
      ? (payload.attachments as Array<Record<string, unknown>>)
      : [];
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.mimeType).toBe("image/jpeg");
    expect(typeof attachments[0]?.url).toBe("string");
    expect(String(attachments[0]?.url)).toContain("/v1/mux/files/telegram?fileId=");

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

  test("forwards voice-only Telegram updates with attachment payload", async () => {
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

    let releaseUpdates = false;
    let hasSentUpdate = false;
    const telegramApi = await h.startHttpServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/botdummy-token/getUpdates") {
        const body = await h.readJsonBody(req);
        const hasOffset = typeof body.offset === "number";
        const shouldSend = hasOffset && releaseUpdates && !hasSentUpdate;
        if (shouldSend) {
          hasSentUpdate = true;
        }
        const result = shouldSend
          ? [
              {
                update_id: 4902,
                message: {
                  message_id: 9002,
                  date: 1_700_000_101,
                  from: { id: 1234 },
                  chat: { id: 999, type: "private" },
                  voice: {
                    file_id: "voice-file-id",
                    mime_type: "audio/ogg",
                    duration: 7,
                    file_size: 2048,
                  },
                },
              },
            ]
          : [];
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, result }));
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
          code: "PAIR-IN-VOICE-1",
          channel: "telegram",
          routeKey: "telegram:default:chat:999",
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
      code: "PAIR-IN-VOICE-1",
      sessionKey: "agent:main:telegram:direct:999",
    });
    expect(claim.status).toBe(200);

    releaseUpdates = true;
    await h.waitForCondition(
      () => inboundRequests.length > 0,
      5_000,
      "timed out waiting for voice-only inbound forward",
    );

    expect(inboundRequests).toHaveLength(1);
    const payload = inboundRequests[0];
    expect(payload.channel).toBe("telegram");
    expect(payload.sessionKey).toBe("agent:main:telegram:direct:999");
    expect(payload.body).toBe("");
    expect(payload.messageId).toBe("9002");

    const attachments = Array.isArray(payload.attachments)
      ? (payload.attachments as Array<Record<string, unknown>>)
      : [];
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.type).toBe("audio");
    expect(attachments[0]?.mimeType).toBe("audio/ogg");
    expect(typeof attachments[0]?.url).toBe("string");
    expect(String(attachments[0]?.url)).toContain("/v1/mux/files/telegram?fileId=voice-file-id");

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
    expect(media[0]?.kind).toBe("voice");
    expect(media[0]?.fileId).toBe("voice-file-id");
    expect(media[0]?.mimeType).toBe("audio/ogg");
    expect(media[0]?.durationSec).toBe(7);
  });

  test("forwards inbound Discord DM messages with raw payload and media attachment", async () => {
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

    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5ZfXkAAAAASUVORK5CYII=";
    const pngBuffer = Buffer.from(pngBase64, "base64");
    let deliveredMessage = false;

    const discordApi = await h.startHttpServer(async (req, res) => {
      const method = req.method ?? "GET";
      const url = req.url ?? "/";
      if (method === "POST" && url === "/users/@me/channels") {
        const body = await h.readJsonBody(req);
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
          code: "PAIR-IN-DC-1",
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

    const claim = await h.claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-IN-DC-1",
      sessionKey: "dc:dm:4242",
    });
    expect(claim.status).toBe(200);

    await h.waitForCondition(
      () => inboundRequests.length > 0,
      5_000,
      "timed out waiting for discord inbound forward",
    );

    expect(inboundRequests).toHaveLength(1);
    const payload = inboundRequests[0];
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
    expect(typeof attachments[0]?.url).toBe("string");
    expect(String(attachments[0]?.url)).toContain("/files/cat.png");

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
    const inbound = await h.startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      const payload = await h.readJsonBody(req);
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

    const discordApi = await h.startHttpServer(async (req, res) => {
      const method = req.method ?? "GET";
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
      if (method === "POST" && requestUrl.pathname === "/users/@me/channels") {
        const body = await h.readJsonBody(req);
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
          code: "PAIR-IN-DC-RETRY-1",
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

    const claim = await h.claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-IN-DC-RETRY-1",
      sessionKey: "dc:dm:4242",
    });
    expect(claim.status).toBe(200);

    await h.waitForCondition(
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

  test("expires WhatsApp queued inbound retries after the retention window", async () => {
    const tempDir = h.mkdtempSync(h.resolve(h.tmpdir(), "mux-server-wa-retry-expire-"));
    const authDir = h.resolve(tempDir, "wa-auth");
    const runtimePath = h.resolve(tempDir, "mock-web-runtime.mjs");
    const dbPath = h.resolve(tempDir, "mux-server.sqlite");
    const logPath = h.resolve(tempDir, "mux-server.log");
    mkdirSync(authDir, { recursive: true });
    h.writeFileSync(h.resolve(authDir, "creds.json"), "{}", "utf8");
    writeWhatsAppRuntimeMock({
      runtimePath,
      emitDelayMs: 300,
      message: {
        id: "wa-expire-1",
        from: "15550001111@s.whatsapp.net",
        to: "15559990000@s.whatsapp.net",
        accountId: "default",
        body: "queued transport failure",
        timestamp: 1_700_000_000_000,
        chatType: "direct",
        chatId: "15550001111@s.whatsapp.net",
        senderJid: "15550001111@s.whatsapp.net",
        senderE164: "+15550001111",
      },
    });

    const unavailablePort = await h.getFreePort();
    const server = await h.startServer({
      tempDir,
      cleanupTempDir: false,
      dbPath,
      tenantsJson: JSON.stringify([
        {
          id: "tenant-a",
          name: "Tenant A",
          apiKey: "tenant-a-key",
          inboundUrl: `http://127.0.0.1:${unavailablePort}/v1/mux/inbound`,
          inboundTimeoutMs: 200,
        },
      ]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-WA-RETRY-EXPIRE",
          channel: "whatsapp",
          routeKey: "whatsapp:default:chat:15550001111@s.whatsapp.net",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_WEB_RUNTIME_MODULE_PATH: runtimePath,
        MUX_WHATSAPP_AUTH_DIR: authDir,
        MUX_WHATSAPP_QUEUE_POLL_MS: "25",
        MUX_WHATSAPP_QUEUE_RETRY_INITIAL_MS: "50",
        MUX_WHATSAPP_QUEUE_RETRY_MAX_MS: "50",
        MUX_WHATSAPP_QUEUE_MAX_AGE_MS: "220",
      },
    });

    const claim = await h.claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-WA-RETRY-EXPIRE",
      sessionKey: "agent:main:whatsapp:direct:15550001111",
    });
    expect(claim.status).toBe(200);

    await h.waitForCondition(
      () => h.readMuxServerLog(logPath).includes('"type":"whatsapp_inbound_retry_deferred"'),
      4_000,
      "timed out waiting for WhatsApp retry deferral",
    );
    await h.waitForCondition(
      () => h.readMuxServerLog(logPath).includes('"type":"whatsapp_inbound_bg_retry_exhausted"'),
      4_000,
      "timed out waiting for WhatsApp retry exhaustion",
    );

    expect(readWhatsAppQueueDepth(dbPath)).toBe(0);
    const logText = h.readMuxServerLog(logPath);
    expect(logText).toContain('"messageId":"wa-expire-1"');
    expect(logText).toContain('"retryable":true');

    await h.stopServer(server);
    h.removeRunningServer(server);
    h.rmSync(tempDir, { recursive: true, force: true });
  }, 15_000);

  test("drops non-retryable WhatsApp inbound delivery failures immediately", async () => {
    const tempDir = h.mkdtempSync(h.resolve(h.tmpdir(), "mux-server-wa-nonretryable-"));
    const authDir = h.resolve(tempDir, "wa-auth");
    const runtimePath = h.resolve(tempDir, "mock-web-runtime.mjs");
    const dbPath = h.resolve(tempDir, "mux-server.sqlite");
    const logPath = h.resolve(tempDir, "mux-server.log");
    mkdirSync(authDir, { recursive: true });
    h.writeFileSync(h.resolve(authDir, "creds.json"), "{}", "utf8");
    writeWhatsAppRuntimeMock({
      runtimePath,
      emitDelayMs: 300,
      message: {
        id: "wa-nonretryable-1",
        from: "15550002222@s.whatsapp.net",
        to: "15559990000@s.whatsapp.net",
        accountId: "default",
        body: "bad request",
        timestamp: 1_700_000_000_000,
        chatType: "direct",
        chatId: "15550002222@s.whatsapp.net",
        senderJid: "15550002222@s.whatsapp.net",
        senderE164: "+15550002222",
      },
    });

    const inbound = await h.startHttpServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/mux/inbound") {
        res.writeHead(404);
        res.end();
        return;
      }
      await h.readJsonBody(req);
      res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "bad request" }));
    });

    const server = await h.startServer({
      tempDir,
      cleanupTempDir: false,
      dbPath,
      tenantsJson: JSON.stringify([
        {
          id: "tenant-a",
          name: "Tenant A",
          apiKey: "tenant-a-key",
          inboundUrl: `${inbound.url}/v1/mux/inbound`,
          inboundTimeoutMs: 1_000,
        },
      ]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-WA-NONRETRYABLE",
          channel: "whatsapp",
          routeKey: "whatsapp:default:chat:15550002222@s.whatsapp.net",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_WEB_RUNTIME_MODULE_PATH: runtimePath,
        MUX_WHATSAPP_AUTH_DIR: authDir,
        MUX_WHATSAPP_QUEUE_POLL_MS: "25",
        MUX_WHATSAPP_QUEUE_RETRY_INITIAL_MS: "500",
        MUX_WHATSAPP_QUEUE_RETRY_MAX_MS: "500",
        MUX_WHATSAPP_QUEUE_MAX_AGE_MS: "5000",
      },
    });

    const claim = await h.claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-WA-NONRETRYABLE",
      sessionKey: "agent:main:whatsapp:direct:15550002222",
    });
    expect(claim.status).toBe(200);

    await h.waitForCondition(
      () => h.readMuxServerLog(logPath).includes('"type":"whatsapp_inbound_bg_retry_exhausted"'),
      4_000,
      "timed out waiting for non-retryable WhatsApp exhaustion",
    );

    expect(readWhatsAppQueueDepth(dbPath)).toBe(0);
    const logText = h.readMuxServerLog(logPath);
    expect(logText).toContain('"messageId":"wa-nonretryable-1"');
    expect(logText).toContain('"retryable":false');
    expect(logText).not.toContain('"type":"whatsapp_inbound_retry_deferred"');

    await h.stopServer(server);
    h.removeRunningServer(server);
    h.rmSync(tempDir, { recursive: true, force: true });
  }, 15_000);
});
