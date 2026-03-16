import { describe, expect, test } from "vitest";
import * as h from "./server.test.helpers";

describe("mux server", () => {
  test("outbound resolves route from (tenant, channel, sessionKey) mapping", async () => {
    const server = await h.startServer({
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

    const claim = await h.claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-3",
      sessionKey: "agent:main:telegram:group:-100123:topic:2",
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
        sessionKey: "agent:main:telegram:group:-100123:topic:2",
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

  test("telegram outbound requires raw envelope", async () => {
    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-TG-BTN",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100123:topic:2",
          scope: "chat",
        },
      ]),
    });

    const claim = await h.claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-TG-BTN",
      sessionKey: "agent:main:telegram:group:-100123:topic:2",
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
        sessionKey: "agent:main:telegram:group:-100123:topic:2",
        text: "paged commands",
      }),
    });

    expect(outbound.status).toBe(400);
    expect(await outbound.json()).toEqual({
      ok: false,
      error: "telegram outbound requires raw.telegram.method and raw.telegram.body",
    });
  });

  test("telegram outbound raw envelope preserves body and enforces route lock", async () => {
    const telegramRequests: Array<Record<string, unknown>> = [];
    const telegramApi = await h.startHttpServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/botdummy-token/sendMessage") {
        telegramRequests.push(await h.readJsonBody(req));
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

    const server = await h.startServer({
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

    const claim = await h.claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-TG-RAW",
      sessionKey: "agent:main:telegram:group:-100123:topic:2",
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
        sessionKey: "agent:main:telegram:group:-100123:topic:2",
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

  test("telegram outbound falls back to the request route without sticking a shared canonical session", async () => {
    const telegramRequests: Array<Record<string, unknown>> = [];
    const telegramApi = await h.startHttpServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/botdummy-token/sendMessage") {
        telegramRequests.push(await h.readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: true,
            result: { message_id: 9902 },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-TG-COMPAT-1",
          channel: "telegram",
          routeKey: "telegram:default:chat:1001",
          scope: "chat",
        },
        {
          code: "PAIR-TG-COMPAT-2",
          channel: "telegram",
          routeKey: "telegram:default:chat:2002",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
      },
    });

    expect(
      (
        await h.claimPairing({
          port: server.port,
          apiKey: "tenant-a-key",
          code: "PAIR-TG-COMPAT-1",
          sessionKey: "agent:main:telegram:direct:1001",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await h.claimPairing({
          port: server.port,
          apiKey: "tenant-a-key",
          code: "PAIR-TG-COMPAT-2",
          sessionKey: "agent:main:telegram:direct:2002",
        })
      ).status,
    ).toBe(200);

    const first = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "telegram",
        sessionKey: "agent:main:main",
        raw: {
          telegram: {
            method: "sendMessage",
            body: {
              chat_id: "1001",
              text: "first canonical send",
            },
          },
        },
      }),
    });
    expect(first.status).toBe(200);

    const second = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "telegram",
        sessionKey: "agent:main:main",
        raw: {
          telegram: {
            method: "sendMessage",
            body: {
              chat_id: "2002",
              text: "second canonical send",
            },
          },
        },
      }),
    });
    expect(second.status).toBe(200);

    expect(telegramRequests).toHaveLength(2);
    expect(telegramRequests.map((body) => h.toSafeString(body.chat_id))).toEqual(["1001", "2002"]);
  });

  test("telegram canonical raw send without explicit target returns route not bound", async () => {
    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-TG-NO-TARGET",
          channel: "telegram",
          routeKey: "telegram:default:chat:1001",
          scope: "chat",
        },
      ]),
    });

    expect(
      (
        await h.claimPairing({
          port: server.port,
          apiKey: "tenant-a-key",
          code: "PAIR-TG-NO-TARGET",
          sessionKey: "agent:main:telegram:direct:1001",
        })
      ).status,
    ).toBe(200);

    const outbound = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "telegram",
        sessionKey: "agent:main:main",
        raw: {
          telegram: {
            method: "sendMessage",
            body: {
              text: "missing explicit chat target",
            },
          },
        },
      }),
    });

    expect(outbound.status).toBe(403);
    expect(await outbound.json()).toEqual({
      ok: false,
      error: "route not bound",
      code: "ROUTE_NOT_BOUND",
    });
  });

  test("telegram canonical fallback rejects explicit chat targets with no bound route", async () => {
    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-TG-WRONG-TARGET",
          channel: "telegram",
          routeKey: "telegram:default:chat:1001",
          scope: "chat",
        },
      ]),
    });

    expect(
      (
        await h.claimPairing({
          port: server.port,
          apiKey: "tenant-a-key",
          code: "PAIR-TG-WRONG-TARGET",
          sessionKey: "agent:main:telegram:direct:1001",
        })
      ).status,
    ).toBe(200);

    const outbound = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "telegram",
        sessionKey: "agent:main:main",
        raw: {
          telegram: {
            method: "sendMessage",
            body: {
              chat_id: "9999",
              text: "wrong explicit telegram target",
            },
          },
        },
      }),
    });

    expect(outbound.status).toBe(403);
    expect(await outbound.json()).toEqual({
      ok: false,
      error: "route not bound",
      code: "ROUTE_NOT_BOUND",
    });
  });

  test("telegram canonical fallback rejects conflicting explicit chat targets even when both chats are bound", async () => {
    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-TG-CONFLICT-A",
          channel: "telegram",
          routeKey: "telegram:default:chat:1001",
          scope: "chat",
        },
        {
          code: "PAIR-TG-CONFLICT-B",
          channel: "telegram",
          routeKey: "telegram:default:chat:9999",
          scope: "chat",
        },
      ]),
    });

    expect(
      (
        await h.claimPairing({
          port: server.port,
          apiKey: "tenant-a-key",
          code: "PAIR-TG-CONFLICT-A",
          sessionKey: "agent:main:telegram:direct:1001",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await h.claimPairing({
          port: server.port,
          apiKey: "tenant-a-key",
          code: "PAIR-TG-CONFLICT-B",
          sessionKey: "agent:main:telegram:direct:9999",
        })
      ).status,
    ).toBe(200);

    const outbound = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "telegram",
        sessionKey: "agent:main:main",
        to: "telegram:1001",
        raw: {
          telegram: {
            method: "sendMessage",
            body: {
              chat_id: "9999",
              text: "conflicting explicit telegram targets",
            },
          },
        },
      }),
    });

    expect(outbound.status).toBe(403);
    expect(await outbound.json()).toEqual({
      ok: false,
      error: "route not bound",
      code: "ROUTE_NOT_BOUND",
    });
  });

  test("telegram outbound falls back to prefixed request targets for canonical sessions", async () => {
    const telegramRequests: Array<Record<string, unknown>> = [];
    const telegramApi = await h.startHttpServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/botdummy-token/editMessageText") {
        telegramRequests.push(await h.readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: true,
            result: { message_id: 9903, chat: { id: 1001 } },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-TG-PREFIXED-TARGET",
          channel: "telegram",
          routeKey: "telegram:default:chat:1001",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
      },
    });

    expect(
      (
        await h.claimPairing({
          port: server.port,
          apiKey: "tenant-a-key",
          code: "PAIR-TG-PREFIXED-TARGET",
          sessionKey: "agent:main:telegram:direct:1001",
        })
      ).status,
    ).toBe(200);

    const outbound = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "telegram",
        sessionKey: "agent:main:main",
        to: "telegram:1001",
        raw: {
          telegram: {
            method: "editMessageText",
            body: {
              message_id: 321,
              text: "edited through prefixed target",
            },
          },
        },
      }),
    });

    expect(outbound.status).toBe(200);
    expect(await outbound.json()).toMatchObject({
      ok: true,
      messageId: "9903",
      rawPassthrough: true,
    });
    expect(telegramRequests).toHaveLength(1);
    expect(telegramRequests[0]).toMatchObject({
      chat_id: "1001",
      message_id: 321,
      text: "edited through prefixed target",
    });
  });

  test("telegram outbound prefers exact session binding in session-first mode when request target conflicts", async () => {
    const telegramRequests: Array<Record<string, unknown>> = [];
    const telegramApi = await h.startHttpServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/botdummy-token/sendMessage") {
        telegramRequests.push(await h.readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: true,
            result: { message_id: 9903 },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-TG-MODE-1",
          channel: "telegram",
          routeKey: "telegram:default:chat:1001",
          scope: "chat",
        },
        {
          code: "PAIR-TG-MODE-2",
          channel: "telegram",
          routeKey: "telegram:default:chat:2002",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
      },
    });

    expect(
      (
        await h.claimPairing({
          port: server.port,
          apiKey: "tenant-a-key",
          code: "PAIR-TG-MODE-1",
          sessionKey: "agent:main:telegram:direct:1001",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await h.claimPairing({
          port: server.port,
          apiKey: "tenant-a-key",
          code: "PAIR-TG-MODE-2",
          sessionKey: "agent:main:telegram:direct:2002",
        })
      ).status,
    ).toBe(200);

    const outbound = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "telegram",
        sessionKey: "agent:main:telegram:direct:1001",
        to: "2002",
        raw: {
          telegram: {
            method: "sendMessage",
            body: {
              chat_id: "2002",
              text: "prefer exact session binding",
            },
          },
        },
      }),
    });

    expect(outbound.status).toBe(200);
    expect(await outbound.json()).toMatchObject({
      ok: true,
      messageId: "9903",
      rawPassthrough: true,
    });
    expect(telegramRequests).toHaveLength(1);
    expect(telegramRequests[0]).toMatchObject({
      chat_id: "1001",
      text: "prefer exact session binding",
    });

    const metrics = await fetch(`http://127.0.0.1:${server.port}/metrics`);
    expect(metrics.status).toBe(200);
    const metricsBody = await metrics.text();
    expect(metricsBody).toContain(
      'mux_outbound_route_resolution_total{channel="telegram",mode="session-first",via="session"} 1',
    );
  });

  test("telegram outbound prefers explicit request target in target-first mode when legacy binding conflicts", async () => {
    const telegramRequests: Array<Record<string, unknown>> = [];
    const telegramApi = await h.startHttpServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/botdummy-token/sendMessage") {
        telegramRequests.push(await h.readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: true,
            result: { message_id: 9904 },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-TG-TARGET-1",
          channel: "telegram",
          routeKey: "telegram:default:chat:1001",
          scope: "chat",
        },
        {
          code: "PAIR-TG-TARGET-2",
          channel: "telegram",
          routeKey: "telegram:default:chat:2002",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
        MUX_OUTBOUND_RESOLUTION_MODE: "target-first",
      },
    });

    expect(
      (
        await h.claimPairing({
          port: server.port,
          apiKey: "tenant-a-key",
          code: "PAIR-TG-TARGET-1",
          sessionKey: "agent:main:telegram:direct:1001",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await h.claimPairing({
          port: server.port,
          apiKey: "tenant-a-key",
          code: "PAIR-TG-TARGET-2",
          sessionKey: "agent:main:telegram:direct:2002",
        })
      ).status,
    ).toBe(200);

    const outbound = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "telegram",
        sessionKey: "agent:main:telegram:direct:1001",
        to: "2002",
        raw: {
          telegram: {
            method: "sendMessage",
            body: {
              chat_id: "2002",
              text: "prefer explicit target",
            },
          },
        },
      }),
    });

    expect(outbound.status).toBe(200);
    expect(await outbound.json()).toMatchObject({
      ok: true,
      messageId: "9904",
      rawPassthrough: true,
    });
    expect(telegramRequests).toHaveLength(1);
    expect(telegramRequests[0]).toMatchObject({
      chat_id: "2002",
      text: "prefer explicit target",
    });

    const metrics = await fetch(`http://127.0.0.1:${server.port}/metrics`);
    expect(metrics.status).toBe(200);
    const metricsBody = await metrics.text();
    expect(metricsBody).toContain(
      'mux_outbound_route_resolution_total{channel="telegram",mode="target-first",via="route"} 1',
    );
  });

  test("telegram outbound raw sendMessage retries without HTML parse_mode on parse errors", async () => {
    const telegramRequests: Array<Record<string, unknown>> = [];
    const telegramApi = await h.startHttpServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/botdummy-token/sendMessage") {
        telegramRequests.push(await h.readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        if (telegramRequests.length === 1) {
          res.end(
            JSON.stringify({
              ok: false,
              error_code: 400,
              description: "Bad Request: can't parse entities: Can't find end of the entity",
            }),
          );
          return;
        }
        res.end(
          JSON.stringify({
            ok: true,
            result: { message_id: 9904, chat: { id: -100123 } },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-TG-RAW-PARSE",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100123:topic:2",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
      },
    });

    const claim = await h.claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-TG-RAW-PARSE",
      sessionKey: "agent:main:telegram:group:-100123:topic:2",
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
        sessionKey: "agent:main:telegram:group:-100123:topic:2",
        raw: {
          telegram: {
            method: "sendMessage",
            body: {
              text: "/model <provider/model>",
              parse_mode: "HTML",
            },
          },
        },
      }),
    });

    expect(outbound.status).toBe(200);
    expect(await outbound.json()).toMatchObject({
      ok: true,
      messageId: "9904",
      rawPassthrough: true,
    });
    expect(telegramRequests).toHaveLength(2);
    expect(telegramRequests[0]).toMatchObject({
      chat_id: "-100123",
      message_thread_id: 2,
      text: "/model <provider/model>",
      parse_mode: "HTML",
    });
    expect(telegramRequests[1]).toMatchObject({
      chat_id: "-100123",
      message_thread_id: 2,
      text: "/model <provider/model>",
    });
    expect(telegramRequests[1]?.parse_mode).toBeUndefined();
  });

  test("telegram outbound raw sendMessage retries without thread when the topic is gone", async () => {
    const telegramRequests: Array<Record<string, unknown>> = [];
    const telegramApi = await h.startHttpServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/botdummy-token/sendMessage") {
        telegramRequests.push(await h.readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        if (telegramRequests.length === 1) {
          res.end(
            JSON.stringify({
              ok: false,
              error_code: 400,
              description: "Bad Request: message thread not found",
            }),
          );
          return;
        }
        res.end(
          JSON.stringify({
            ok: true,
            result: { message_id: 9906, chat: { id: -100123 } },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-TG-RAW-THREAD",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100123:topic:2",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
      },
    });

    const claim = await h.claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-TG-RAW-THREAD",
      sessionKey: "agent:main:telegram:group:-100123:topic:2",
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
        sessionKey: "agent:main:telegram:group:-100123:topic:2",
        raw: {
          telegram: {
            method: "sendMessage",
            body: {
              text: "retry without thread",
            },
          },
        },
      }),
    });

    expect(outbound.status).toBe(200);
    expect(await outbound.json()).toMatchObject({
      ok: true,
      messageId: "9906",
      rawPassthrough: true,
    });
    expect(telegramRequests).toHaveLength(2);
    expect(telegramRequests[0]).toMatchObject({
      chat_id: "-100123",
      message_thread_id: 2,
      text: "retry without thread",
    });
    expect(telegramRequests[1]).toMatchObject({
      chat_id: "-100123",
      text: "retry without thread",
    });
    expect(telegramRequests[1]?.message_thread_id).toBeUndefined();
  });

  test("telegram outbound raw sendMessage does not retry when chat is not found", async () => {
    const telegramRequests: Array<Record<string, unknown>> = [];
    const telegramApi = await h.startHttpServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/botdummy-token/sendMessage") {
        telegramRequests.push(await h.readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: false,
            error_code: 400,
            description: "Bad Request: chat not found",
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-TG-RAW-CHAT-NOT-FOUND",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100123:topic:2",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
      },
    });

    const claim = await h.claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-TG-RAW-CHAT-NOT-FOUND",
      sessionKey: "agent:main:telegram:group:-100123:topic:2",
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
        sessionKey: "agent:main:telegram:group:-100123:topic:2",
        raw: {
          telegram: {
            method: "sendMessage",
            body: {
              text: "do not retry chat-not-found",
            },
          },
        },
      }),
    });

    expect(outbound.status).toBe(502);
    expect(await outbound.json()).toMatchObject({
      ok: false,
      error: "telegram raw send failed",
      details: {
        ok: false,
        error_code: 400,
        description: "Bad Request: chat not found",
      },
    });
    expect(telegramRequests).toHaveLength(1);
    expect(telegramRequests[0]).toMatchObject({
      chat_id: "-100123",
      message_thread_id: 2,
      text: "do not retry chat-not-found",
    });
  });

  test("telegram outbound raw editMessageText retries without HTML parse_mode on parse errors", async () => {
    const telegramRequests: Array<Record<string, unknown>> = [];
    const telegramApi = await h.startHttpServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/botdummy-token/editMessageText") {
        telegramRequests.push(await h.readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        if (telegramRequests.length === 1) {
          res.end(
            JSON.stringify({
              ok: false,
              error_code: 400,
              description: "Bad Request: can't parse entities: Can't find end of the entity",
            }),
          );
          return;
        }
        res.end(
          JSON.stringify({
            ok: true,
            result: { message_id: 9905, chat: { id: -100123 } },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-TG-RAW-EDIT-PARSE",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100123:topic:2",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
      },
    });

    const claim = await h.claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-TG-RAW-EDIT-PARSE",
      sessionKey: "agent:main:telegram:group:-100123:topic:2",
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
        sessionKey: "agent:main:telegram:group:-100123:topic:2",
        raw: {
          telegram: {
            method: "editMessageText",
            body: {
              message_id: 321,
              text: "/model <provider/model>",
              parse_mode: "HTML",
            },
          },
        },
      }),
    });

    expect(outbound.status).toBe(200);
    expect(await outbound.json()).toMatchObject({
      ok: true,
      messageId: "9905",
      rawPassthrough: true,
    });
    expect(telegramRequests).toHaveLength(2);
    expect(telegramRequests[0]).toMatchObject({
      chat_id: "-100123",
      message_id: 321,
      text: "/model <provider/model>",
      parse_mode: "HTML",
    });
    expect(telegramRequests[0]?.message_thread_id).toBeUndefined();
    expect(telegramRequests[1]).toMatchObject({
      chat_id: "-100123",
      message_id: 321,
      text: "/model <provider/model>",
    });
    expect(telegramRequests[1]?.parse_mode).toBeUndefined();
    expect(telegramRequests[1]?.message_thread_id).toBeUndefined();
  });

  test("telegram outbound raw editMessageText keeps route lock and skips thread id injection", async () => {
    const telegramRequests: Array<Record<string, unknown>> = [];
    const telegramApi = await h.startHttpServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/botdummy-token/editMessageText") {
        telegramRequests.push(await h.readJsonBody(req));
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

    const server = await h.startServer({
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

    const claim = await h.claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-TG-RAW-EDIT",
      sessionKey: "agent:main:telegram:group:-100123:topic:2",
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
        sessionKey: "agent:main:telegram:group:-100123:topic:2",
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

  test("telegram outbound raw sendDocument passthrough with route lock", async () => {
    const telegramRequests: Array<Record<string, unknown>> = [];
    const telegramApi = await h.startHttpServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/botdummy-token/sendDocument") {
        telegramRequests.push(await h.readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: true,
            result: { message_id: 9903, chat: { id: -100123 } },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-TG-RAW-DOC",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100123:topic:2",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
      },
    });

    const claim = await h.claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-TG-RAW-DOC",
      sessionKey: "agent:main:telegram:group:-100123:topic:2",
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
        sessionKey: "agent:main:telegram:group:-100123:topic:2",
        raw: {
          telegram: {
            method: "sendDocument",
            body: {
              document: "https://example.com/file.txt",
              caption: "here",
              parse_mode: "HTML",
            },
          },
        },
      }),
    });

    expect(outbound.status).toBe(200);
    expect(await outbound.json()).toMatchObject({
      ok: true,
      messageId: "9903",
      rawPassthrough: true,
    });
    expect(telegramRequests).toHaveLength(1);
    expect(telegramRequests[0]).toMatchObject({
      chat_id: "-100123",
      message_thread_id: 2,
      document: "https://example.com/file.txt",
      caption: "here",
      parse_mode: "HTML",
    });
  });

  test("telegram outbound raw setMessageReaction injects chat_id but not thread_id", async () => {
    const telegramRequests: Array<Record<string, unknown>> = [];
    const telegramApi = await h.startHttpServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/botdummy-token/setMessageReaction") {
        telegramRequests.push(await h.readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, result: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-TG-REACT",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100123:topic:2",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
      },
    });

    const claim = await h.claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-TG-REACT",
      sessionKey: "agent:main:telegram:group:-100123:topic:2",
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
        sessionKey: "agent:main:telegram:group:-100123:topic:2",
        raw: {
          telegram: {
            method: "setMessageReaction",
            body: {
              message_id: 555,
              reaction: [{ type: "emoji", emoji: "👍" }],
            },
          },
        },
      }),
    });

    expect(outbound.status).toBe(200);
    expect(telegramRequests).toHaveLength(1);
    expect(telegramRequests[0]).toMatchObject({
      chat_id: "-100123",
      message_id: 555,
      reaction: [{ type: "emoji", emoji: "👍" }],
    });
    // setMessageReaction is NOT in THREAD_ID_METHODS — no thread injection
    expect(telegramRequests[0]?.message_thread_id).toBeUndefined();
  });

  test("telegram outbound raw setMyCommands skips chat_id injection", async () => {
    const telegramRequests: Array<Record<string, unknown>> = [];
    const telegramApi = await h.startHttpServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/botdummy-token/setMyCommands") {
        telegramRequests.push(await h.readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, result: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-TG-CMDS",
          channel: "telegram",
          routeKey: "telegram:default:chat:-100123:topic:2",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
      },
    });

    const claim = await h.claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-TG-CMDS",
      sessionKey: "agent:main:telegram:group:-100123:topic:2",
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
        sessionKey: "agent:main:telegram:group:-100123:topic:2",
        raw: {
          telegram: {
            method: "setMyCommands",
            body: {
              commands: [
                { command: "help", description: "Show help" },
                { command: "status", description: "Show status" },
              ],
            },
          },
        },
      }),
    });

    expect(outbound.status).toBe(200);
    expect(telegramRequests).toHaveLength(1);
    // NO_CHAT_ID_METHODS — no chat_id or message_thread_id
    expect(telegramRequests[0]?.chat_id).toBeUndefined();
    expect(telegramRequests[0]?.message_thread_id).toBeUndefined();
    expect(telegramRequests[0]).toMatchObject({
      commands: [
        { command: "help", description: "Show help" },
        { command: "status", description: "Show status" },
      ],
    });
  });

  test("telegram typing action via /send sends chat action for bound route", async () => {
    const telegramRequests: Array<Record<string, unknown>> = [];
    const telegramApi = await h.startHttpServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/botdummy-token/sendChatAction") {
        telegramRequests.push(await h.readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, result: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await h.startServer({
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

    const claim = await h.claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-TG-TYPING",
      sessionKey: "agent:main:telegram:group:-100123:topic:2",
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
        sessionKey: "agent:main:telegram:group:-100123:topic:2",
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

  test("telegram typing action falls back to explicit target for canonical session", async () => {
    const telegramRequests: Array<Record<string, unknown>> = [];
    const telegramApi = await h.startHttpServer(async (req, res) => {
      if (req.method === "POST" && req.url === "/botdummy-token/sendChatAction") {
        telegramRequests.push(await h.readJsonBody(req));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, result: true }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-TG-TYPING-CANON",
          channel: "telegram",
          routeKey: "telegram:default:chat:424242",
          scope: "chat",
        },
      ]),
      extraEnv: {
        MUX_TELEGRAM_API_BASE_URL: telegramApi.url,
      },
    });

    const claim = await h.claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-TG-TYPING-CANON",
      sessionKey: "agent:main:telegram:direct:424242",
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
        sessionKey: "agent:main:main",
        to: "telegram:424242",
      }),
    });

    expect(typing.status).toBe(200);
    expect(await typing.json()).toEqual({ ok: true });
    expect(telegramRequests).toHaveLength(1);
    expect(telegramRequests[0]).toMatchObject({
      chat_id: "424242",
      action: "typing",
    });
  });

  test("discord typing action via /send triggers typing on bound DM route", async () => {
    const discordRequests: Array<{
      method: string;
      url: string;
      body?: Record<string, unknown>;
    }> = [];

    const discordApi = await h.startHttpServer(async (req, res) => {
      const method = req.method ?? "GET";
      const url = req.url ?? "/";
      if (method === "POST" && url === "/users/@me/channels") {
        const body = await h.readJsonBody(req);
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

    const server = await h.startServer({
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

    const claim = await h.claimPairing({
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

  test("whatsapp typing action via /send tries composing on bound route", async () => {
    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-WA-TYPING",
          channel: "whatsapp",
          routeKey: "whatsapp:default:chat:15550001111@s.whatsapp.net",
          scope: "chat",
        },
      ]),
    });

    const claim = await h.claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-WA-TYPING",
      sessionKey: "agent:main:whatsapp:direct:+15550001111",
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
        channel: "whatsapp",
        sessionKey: "agent:main:whatsapp:direct:+15550001111",
      }),
    });

    expect(typing.status).toBe(502);
    expect(await typing.json()).toMatchObject({
      ok: false,
      error: "whatsapp typing failed",
    });
  }, 10_000);

  test("discord outbound raw envelope forwards body unchanged", async () => {
    const discordRequests: Array<{
      method: string;
      url: string;
      body?: Record<string, unknown>;
    }> = [];

    const discordApi = await h.startHttpServer(async (req, res) => {
      const method = req.method ?? "GET";
      const url = req.url ?? "/";
      if (method === "POST" && url === "/users/@me/channels") {
        const body = await h.readJsonBody(req);
        discordRequests.push({ method, url, body });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ id: "2001" }));
        return;
      }
      if (method === "POST" && url === "/channels/2001/messages") {
        const body = await h.readJsonBody(req);
        discordRequests.push({ method, url, body });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ id: "7007", channel_id: "2001" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await h.startServer({
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

    const claim = await h.claimPairing({
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

  test("discord outbound requires raw envelope", async () => {
    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-DISCORD-RAW-REQUIRED",
          channel: "discord",
          routeKey: "discord:default:dm:user:42",
          scope: "dm",
        },
      ]),
    });

    const claim = await h.claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-DISCORD-RAW-REQUIRED",
      sessionKey: "dc:dm:42",
    });
    expect(claim.status).toBe(200);

    const outbound = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "discord",
        sessionKey: "dc:dm:42",
        text: "hello without raw",
      }),
    });

    expect(outbound.status).toBe(400);
    expect(await outbound.json()).toEqual({
      ok: false,
      error: "discord outbound requires raw.discord.body or raw.discord.send",
    });
  });

  test("discord outbound falls back to the request target for canonical sessions", async () => {
    const discordRequests: Array<{
      method: string;
      url: string;
      body: Record<string, unknown>;
    }> = [];
    const discordApi = await h.startHttpServer(async (req, res) => {
      const url = req.url ?? "";
      if (req.method === "POST" && url === "/users/@me/channels") {
        discordRequests.push({
          method: "POST",
          url,
          body: await h.readJsonBody(req),
        });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ id: "2001" }));
        return;
      }
      if (req.method === "POST" && url === "/channels/2001/messages") {
        discordRequests.push({
          method: "POST",
          url,
          body: await h.readJsonBody(req),
        });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ id: "7008", channel_id: "2001" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-DISCORD-COMPAT",
          channel: "discord",
          routeKey: "discord:default:dm:user:42",
          scope: "dm",
        },
      ]),
      extraEnv: {
        MUX_DISCORD_API_BASE_URL: discordApi.url,
      },
    });

    expect(
      (
        await h.claimPairing({
          port: server.port,
          apiKey: "tenant-a-key",
          code: "PAIR-DISCORD-COMPAT",
          sessionKey: "dc:dm:42",
        })
      ).status,
    ).toBe(200);

    const outbound = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "discord",
        sessionKey: "agent:main:main",
        to: "user:42",
        raw: {
          discord: {
            send: {
              text: "compat fallback",
            },
          },
        },
      }),
    });

    expect(outbound.status).toBe(200);
    expect(await outbound.json()).toMatchObject({
      ok: true,
      messageId: "7008",
      channelId: "2001",
      rawPassthrough: true,
    });
    expect(discordRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "POST",
          url: "/users/@me/channels",
          body: { recipient_id: "42" },
        }),
        expect.objectContaining({
          method: "POST",
          url: "/channels/2001/messages",
        }),
      ]),
    );
  });

  test("discord canonical outbound without explicit target returns route not bound", async () => {
    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-DISCORD-NO-TARGET",
          channel: "discord",
          routeKey: "discord:default:dm:user:42",
          scope: "dm",
        },
      ]),
    });

    expect(
      (
        await h.claimPairing({
          port: server.port,
          apiKey: "tenant-a-key",
          code: "PAIR-DISCORD-NO-TARGET",
          sessionKey: "dc:dm:42",
        })
      ).status,
    ).toBe(200);

    const outbound = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "discord",
        sessionKey: "agent:main:main",
        raw: {
          discord: {
            send: {
              text: "missing explicit discord target",
            },
          },
        },
      }),
    });

    expect(outbound.status).toBe(403);
    expect(await outbound.json()).toEqual({
      ok: false,
      error: "route not bound",
      code: "ROUTE_NOT_BOUND",
    });
  });

  test("discord canonical fallback rejects explicit DM targets with no bound route", async () => {
    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-DISCORD-WRONG-TARGET",
          channel: "discord",
          routeKey: "discord:default:dm:user:42",
          scope: "dm",
        },
      ]),
    });

    expect(
      (
        await h.claimPairing({
          port: server.port,
          apiKey: "tenant-a-key",
          code: "PAIR-DISCORD-WRONG-TARGET",
          sessionKey: "dc:dm:42",
        })
      ).status,
    ).toBe(200);

    const outbound = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "discord",
        sessionKey: "agent:main:main",
        to: "user:99",
        raw: {
          discord: {
            body: {
              content: "wrong explicit discord target",
            },
          },
        },
      }),
    });

    expect(outbound.status).toBe(403);
    expect(await outbound.json()).toEqual({
      ok: false,
      error: "route not bound",
      code: "ROUTE_NOT_BOUND",
    });
  });

  test("discord canonical fallback rejects conflicting explicit guild targets", async () => {
    const discordApi = await h.startHttpServer(async (req, res) => {
      const url = req.url ?? "";
      if (req.method === "GET" && url === "/channels/2001") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ id: "2001", guild_id: "9001" }));
        return;
      }
      if (req.method === "GET" && url === "/channels/3002") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            id: "3002",
            guild_id: "9001",
            parent_id: "2002",
            type: 11,
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-DISCORD-CONFLICTING-GUILD",
          channel: "discord",
          routeKey: "discord:default:guild:9001",
          scope: "guild",
        },
      ]),
      extraEnv: {
        MUX_DISCORD_API_BASE_URL: discordApi.url,
      },
    });

    expect(
      (
        await h.claimPairing({
          port: server.port,
          apiKey: "tenant-a-key",
          code: "PAIR-DISCORD-CONFLICTING-GUILD",
          sessionKey: "dc:guild:9001",
        })
      ).status,
    ).toBe(200);

    const outbound = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "discord",
        sessionKey: "agent:main:main",
        to: "channel:2001",
        threadId: "3002",
        raw: {
          discord: {
            send: {
              text: "conflicting explicit discord targets",
            },
          },
        },
      }),
    });

    expect(outbound.status).toBe(403);
    expect(await outbound.json()).toEqual({
      ok: false,
      error: "route not bound",
      code: "ROUTE_NOT_BOUND",
    });
  });

  test("discord guild-bound raw send rejects thread target outside the bound channel", async () => {
    const discordApi = await h.startHttpServer(async (req, res) => {
      const url = req.url ?? "";
      if (req.method === "GET" && url === "/channels/3003") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            id: "3003",
            guild_id: "9001",
            parent_id: "2002",
            type: 11,
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-DISCORD-THREAD-LOCK",
          channel: "discord",
          routeKey: "discord:default:guild:9001:channel:2001",
          scope: "guild",
        },
      ]),
      extraEnv: {
        MUX_DISCORD_API_BASE_URL: discordApi.url,
      },
    });

    expect(
      (
        await h.claimPairing({
          port: server.port,
          apiKey: "tenant-a-key",
          code: "PAIR-DISCORD-THREAD-LOCK",
          sessionKey: "dc:guild:9001:channel:2001",
        })
      ).status,
    ).toBe(200);

    const outbound = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "discord",
        sessionKey: "dc:guild:9001:channel:2001",
        threadId: "3003",
        raw: {
          discord: {
            send: {
              text: "wrong sibling thread",
            },
          },
        },
      }),
    });

    expect(outbound.status).toBe(403);
    expect(await outbound.json()).toEqual({
      ok: false,
      error: "discord channel not allowed for this bound guild",
    });
  });

  test("discord outbound prefers exact session binding in session-first mode when request target conflicts", async () => {
    const discordRequests: Array<{
      method: string;
      url: string;
      body: Record<string, unknown>;
    }> = [];
    const discordApi = await h.startHttpServer(async (req, res) => {
      const url = req.url ?? "";
      if (req.method === "POST" && url === "/users/@me/channels") {
        const body = await h.readJsonBody(req);
        discordRequests.push({
          method: "POST",
          url,
          body,
        });
        if (body.recipient_id === "42") {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ id: "2001" }));
          return;
        }
        if (body.recipient_id === "43") {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ id: "2002" }));
          return;
        }
      }
      if (req.method === "POST" && url === "/channels/2001/messages") {
        discordRequests.push({
          method: "POST",
          url,
          body: await h.readJsonBody(req),
        });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ id: "7009", channel_id: "2001" }));
        return;
      }
      if (req.method === "POST" && url === "/channels/2002/messages") {
        discordRequests.push({
          method: "POST",
          url,
          body: await h.readJsonBody(req),
        });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ id: "7010", channel_id: "2002" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-DISCORD-MODE-1",
          channel: "discord",
          routeKey: "discord:default:dm:user:42",
          scope: "dm",
        },
        {
          code: "PAIR-DISCORD-MODE-2",
          channel: "discord",
          routeKey: "discord:default:dm:user:43",
          scope: "dm",
        },
      ]),
      extraEnv: {
        MUX_DISCORD_API_BASE_URL: discordApi.url,
      },
    });

    expect(
      (
        await h.claimPairing({
          port: server.port,
          apiKey: "tenant-a-key",
          code: "PAIR-DISCORD-MODE-1",
          sessionKey: "dc:dm:42",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await h.claimPairing({
          port: server.port,
          apiKey: "tenant-a-key",
          code: "PAIR-DISCORD-MODE-2",
          sessionKey: "dc:dm:43",
        })
      ).status,
    ).toBe(200);

    const outbound = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "discord",
        sessionKey: "dc:dm:42",
        to: "user:43",
        raw: {
          discord: {
            send: {
              text: "prefer exact session binding",
            },
          },
        },
      }),
    });

    expect(outbound.status).toBe(200);
    expect(await outbound.json()).toMatchObject({
      ok: true,
      messageId: "7009",
      channelId: "2001",
      rawPassthrough: true,
    });
    expect(discordRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "POST",
          url: "/users/@me/channels",
          body: { recipient_id: "42" },
        }),
        expect.objectContaining({
          method: "POST",
          url: "/channels/2001/messages",
          body: { content: "prefer exact session binding" },
        }),
      ]),
    );
    expect(discordRequests).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "POST",
          url: "/channels/2002/messages",
        }),
      ]),
    );
  });

  test("discord outbound prefers explicit request target in target-first mode when legacy binding conflicts", async () => {
    const discordRequests: Array<{
      method: string;
      url: string;
      body: Record<string, unknown>;
    }> = [];
    const discordApi = await h.startHttpServer(async (req, res) => {
      const url = req.url ?? "";
      if (req.method === "POST" && url === "/users/@me/channels") {
        const body = await h.readJsonBody(req);
        discordRequests.push({
          method: "POST",
          url,
          body,
        });
        if (body.recipient_id === "42") {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ id: "2001" }));
          return;
        }
        if (body.recipient_id === "43") {
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ id: "2002" }));
          return;
        }
      }
      if (req.method === "POST" && url === "/channels/2001/messages") {
        discordRequests.push({
          method: "POST",
          url,
          body: await h.readJsonBody(req),
        });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ id: "7011", channel_id: "2001" }));
        return;
      }
      if (req.method === "POST" && url === "/channels/2002/messages") {
        discordRequests.push({
          method: "POST",
          url,
          body: await h.readJsonBody(req),
        });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ id: "7012", channel_id: "2002" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-DISCORD-TARGET-1",
          channel: "discord",
          routeKey: "discord:default:dm:user:42",
          scope: "dm",
        },
        {
          code: "PAIR-DISCORD-TARGET-2",
          channel: "discord",
          routeKey: "discord:default:dm:user:43",
          scope: "dm",
        },
      ]),
      extraEnv: {
        MUX_DISCORD_API_BASE_URL: discordApi.url,
        MUX_OUTBOUND_RESOLUTION_MODE: "target-first",
      },
    });

    expect(
      (
        await h.claimPairing({
          port: server.port,
          apiKey: "tenant-a-key",
          code: "PAIR-DISCORD-TARGET-1",
          sessionKey: "dc:dm:42",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await h.claimPairing({
          port: server.port,
          apiKey: "tenant-a-key",
          code: "PAIR-DISCORD-TARGET-2",
          sessionKey: "dc:dm:43",
        })
      ).status,
    ).toBe(200);

    const outbound = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "discord",
        sessionKey: "dc:dm:42",
        to: "user:43",
        raw: {
          discord: {
            send: {
              text: "prefer explicit target",
            },
          },
        },
      }),
    });

    expect(outbound.status).toBe(200);
    expect(await outbound.json()).toMatchObject({
      ok: true,
      messageId: "7012",
      channelId: "2002",
      rawPassthrough: true,
    });
    expect(discordRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "POST",
          url: "/users/@me/channels",
          body: { recipient_id: "43" },
        }),
        expect.objectContaining({
          method: "POST",
          url: "/channels/2002/messages",
          body: { content: "prefer explicit target" },
        }),
      ]),
    );
    expect(discordRequests).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "POST",
          url: "/channels/2001/messages",
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

    const discordApi = await h.startHttpServer(async (req, res) => {
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
        const body = await h.readJsonBody(req);
        discordRequests.push({ method, url, authorization, body });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ id: "7001", channel_id: "2001" }));
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const server = await h.startServer({
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

    const claim = await h.claimPairing({
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
        raw: {
          discord: {
            send: {
              text: "hello discord",
            },
          },
        },
      }),
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({
      ok: true,
      messageId: "7001",
      channelId: "2001",
      providerMessageIds: ["7001"],
      rawPassthrough: true,
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
        raw: {
          discord: {
            send: {
              text: "should fail",
            },
          },
        },
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
  }, 10_000);

  test("sends discord outbound through dm-bound route", async () => {
    const discordRequests: Array<{
      method: string;
      url: string;
      body?: Record<string, unknown>;
    }> = [];
    const discordApi = await h.startHttpServer(async (req, res) => {
      const method = req.method ?? "GET";
      const url = req.url ?? "/";
      if (method === "POST" && url === "/users/@me/channels") {
        const body = await h.readJsonBody(req);
        discordRequests.push({ method, url, body });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ id: "3001" }));
        return;
      }
      if (method === "POST" && url === "/channels/3001/messages") {
        const body = await h.readJsonBody(req);
        discordRequests.push({ method, url, body });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ id: "8001", channel_id: "3001" }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    const server = await h.startServer({
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

    const claim = await h.claimPairing({
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
        raw: {
          discord: {
            send: {
              text: "hello dm",
            },
          },
        },
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      messageId: "8001",
      channelId: "3001",
      providerMessageIds: ["8001"],
      rawPassthrough: true,
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

  test("whatsapp outbound accepts legacy text envelope", async () => {
    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-WA-RAW-REQUIRED",
          channel: "whatsapp",
          routeKey: "whatsapp:default:chat:15550001111@s.whatsapp.net",
          scope: "chat",
        },
      ]),
    });

    const claim = await h.claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-WA-RAW-REQUIRED",
      sessionKey: "agent:main:whatsapp:direct:+15550001111",
    });
    expect(claim.status).toBe(200);

    const outbound = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "whatsapp",
        sessionKey: "agent:main:whatsapp:direct:+15550001111",
        text: "hello without raw",
      }),
    });
    expect(outbound.status).toBe(502);
    expect(await outbound.json()).toMatchObject({
      ok: false,
      error: "whatsapp send failed",
    });
  });

  test("whatsapp outbound falls back to the request target for canonical sessions", async () => {
    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-WA-COMPAT",
          channel: "whatsapp",
          routeKey: "whatsapp:default:chat:15550001111@s.whatsapp.net",
          scope: "chat",
        },
      ]),
    });

    expect(
      (
        await h.claimPairing({
          port: server.port,
          apiKey: "tenant-a-key",
          code: "PAIR-WA-COMPAT",
          sessionKey: "agent:main:whatsapp:direct:+15550001111",
        })
      ).status,
    ).toBe(200);

    const response = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "whatsapp",
        sessionKey: "agent:main:main",
        to: "15550001111@s.whatsapp.net",
        raw: {
          whatsapp: {
            send: {
              text: "hello wa from canonical session",
            },
          },
        },
      }),
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "whatsapp send failed",
    });
  });

  test("whatsapp canonical outbound without explicit target returns route not bound", async () => {
    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-WA-NO-TARGET",
          channel: "whatsapp",
          routeKey: "whatsapp:default:chat:15550001111@s.whatsapp.net",
          scope: "chat",
        },
      ]),
    });

    expect(
      (
        await h.claimPairing({
          port: server.port,
          apiKey: "tenant-a-key",
          code: "PAIR-WA-NO-TARGET",
          sessionKey: "agent:main:whatsapp:direct:+15550001111",
        })
      ).status,
    ).toBe(200);

    const response = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "whatsapp",
        sessionKey: "agent:main:main",
        raw: {
          whatsapp: {
            send: {
              text: "missing explicit whatsapp target",
            },
          },
        },
      }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      ok: false,
      error: "route not bound",
      code: "ROUTE_NOT_BOUND",
    });
  });

  test("whatsapp canonical fallback rejects explicit chat targets with no bound route", async () => {
    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-WA-WRONG-TARGET",
          channel: "whatsapp",
          routeKey: "whatsapp:default:chat:15550001111@s.whatsapp.net",
          scope: "chat",
        },
      ]),
    });

    expect(
      (
        await h.claimPairing({
          port: server.port,
          apiKey: "tenant-a-key",
          code: "PAIR-WA-WRONG-TARGET",
          sessionKey: "agent:main:whatsapp:direct:+15550001111",
        })
      ).status,
    ).toBe(200);

    const response = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "whatsapp",
        sessionKey: "agent:main:main",
        to: "+15550009999",
        raw: {
          whatsapp: {
            send: {
              text: "wrong explicit whatsapp target",
            },
          },
        },
      }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      ok: false,
      error: "route not bound",
      code: "ROUTE_NOT_BOUND",
    });
  });

  test("whatsapp canonical fallback rejects conflicting explicit targets even when both chats are bound", async () => {
    const server = await h.startServer({
      tenantsJson: JSON.stringify([{ id: "tenant-a", name: "Tenant A", apiKey: "tenant-a-key" }]),
      pairingCodesJson: JSON.stringify([
        {
          code: "PAIR-WA-CONFLICT-A",
          channel: "whatsapp",
          routeKey: "whatsapp:default:chat:15550001111@s.whatsapp.net",
          scope: "chat",
        },
        {
          code: "PAIR-WA-CONFLICT-B",
          channel: "whatsapp",
          routeKey: "whatsapp:default:chat:15550002222@s.whatsapp.net",
          scope: "chat",
        },
      ]),
    });

    expect(
      (
        await h.claimPairing({
          port: server.port,
          apiKey: "tenant-a-key",
          code: "PAIR-WA-CONFLICT-A",
          sessionKey: "agent:main:whatsapp:direct:+15550001111",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await h.claimPairing({
          port: server.port,
          apiKey: "tenant-a-key",
          code: "PAIR-WA-CONFLICT-B",
          sessionKey: "agent:main:whatsapp:direct:+15550002222",
        })
      ).status,
    ).toBe(200);

    const response = await fetch(`http://127.0.0.1:${server.port}/v1/mux/outbound/send`, {
      method: "POST",
      headers: {
        Authorization: "Bearer tenant-a-key",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "whatsapp",
        sessionKey: "agent:main:main",
        to: "15550001111@s.whatsapp.net",
        accountId: "mux",
        raw: {
          whatsapp: {
            send: {
              to: "15550002222@s.whatsapp.net",
              text: "conflicting explicit whatsapp targets",
            },
          },
        },
      }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      ok: false,
      error: "route not bound",
      code: "ROUTE_NOT_BOUND",
    });
  });

  test("whatsapp outbound returns 502 when no active listener is available", async () => {
    const server = await h.startServer({
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

    const claim = await h.claimPairing({
      port: server.port,
      apiKey: "tenant-a-key",
      code: "PAIR-WA-1",
      sessionKey: "agent:main:whatsapp:direct:+15550001111",
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
        sessionKey: "agent:main:whatsapp:direct:+15550001111",
        raw: {
          whatsapp: {
            send: {
              text: "hello wa",
            },
          },
        },
      }),
    });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "whatsapp send failed",
    });
  });
});
