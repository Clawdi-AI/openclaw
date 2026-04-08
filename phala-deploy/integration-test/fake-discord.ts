import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { closeHttpServer, getFreePort, readJsonBody, waitForCondition } from "./test-utils.js";

export type FakeDiscordRequest =
  | {
      kind: "createDmChannel";
      userId: string;
      body: Record<string, unknown>;
    }
  | {
      kind: "typing";
      channelId: string;
    }
  | {
      kind: "sendMessage";
      channelId: string;
      body: Record<string, unknown>;
    };

type FakeDiscordInboundMessage = {
  id: string;
  channel_id: string;
  content: string;
  timestamp: string;
  author: {
    id: string;
    bot: false;
    username?: string;
  };
  attachments: unknown[];
  mentions: unknown[];
  mention_roles: unknown[];
  guild_id?: string;
  type?: number;
  thread?: {
    id: string;
    parent_id: string;
  };
};

type FakeDiscordChannel = {
  id: string;
  guildId?: string;
  parentId?: string;
  type: number;
};

function toStringId(value: unknown): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}

export class FakeDiscordApi {
  readonly requests: FakeDiscordRequest[] = [];
  /** Bot's own user ID, included in the gateway READY payload. */
  readonly botUserId = "999888777";

  private readonly pendingMessagesByChannel = new Map<string, FakeDiscordInboundMessage[]>();
  private readonly dmChannelsByUser = new Map<string, string>();
  private readonly channels = new Map<string, FakeDiscordChannel>();
  private readonly gatewayFrames: Array<Record<string, unknown>> = [];
  private gatewaySocket: WebSocket | null = null;
  private gatewayIdentified = false;
  private gatewaySequence = 1;
  private nextMessageId = 8_000;

  private constructor(
    readonly server: http.Server,
    readonly gatewayServer: WebSocketServer,
    readonly url: string,
  ) {}

  static async start(): Promise<FakeDiscordApi> {
    const port = await getFreePort();
    const gatewayServer = new WebSocketServer({ noServer: true });
    let instance: FakeDiscordApi;
    const server = http.createServer(async (req, res) => {
      await instance.handleRequest(req, res);
    });
    server.on("upgrade", (req, socket, head) => {
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname !== "/gateway") {
        socket.destroy();
        return;
      }
      gatewayServer.handleUpgrade(req, socket, head, (ws) => {
        gatewayServer.emit("connection", ws, req);
      });
    });
    instance = new FakeDiscordApi(server, gatewayServer, `http://127.0.0.1:${port}`);
    instance.configureGatewayServer();
    await new Promise<void>((resolveServer, reject) => {
      instance.server.once("error", reject);
      instance.server.listen(port, "127.0.0.1", () => {
        instance.server.off("error", reject);
        resolveServer();
      });
    });
    return instance;
  }

  registerDmChannel(userId: string, channelId: string): void {
    this.dmChannelsByUser.set(userId, channelId);
  }

  registerGuildChannel(params: { guildId: string; channelId: string }): void {
    this.channels.set(params.channelId, {
      id: params.channelId,
      guildId: params.guildId,
      type: 0,
    });
  }

  registerThread(params: { guildId: string; threadId: string; parentId: string }): void {
    this.channels.set(params.threadId, {
      id: params.threadId,
      guildId: params.guildId,
      parentId: params.parentId,
      type: 11,
    });
  }

  enqueueDmMessage(params: {
    userId: string;
    channelId?: string;
    messageId: string;
    content: string;
    timestamp?: string;
    username?: string;
  }): void {
    const channelId = params.channelId ?? this.dmChannelsByUser.get(params.userId) ?? "3001";
    this.dmChannelsByUser.set(params.userId, channelId);
    const message: FakeDiscordInboundMessage = {
      id: params.messageId,
      channel_id: channelId,
      content: params.content,
      timestamp: params.timestamp ?? "2026-01-01T00:00:00.000Z",
      author: {
        id: params.userId,
        bot: false,
        ...(params.username ? { username: params.username } : {}),
      },
      attachments: [],
      mentions: [],
      mention_roles: [],
    };
    const current = this.pendingMessagesByChannel.get(channelId) ?? [];
    current.push(message);
    current.sort((left, right) => Number(left.id) - Number(right.id));
    this.pendingMessagesByChannel.set(channelId, current);
  }

  enqueueGuildMessage(params: {
    guildId: string;
    channelId: string;
    messageId: string;
    content: string;
    authorId: string;
    timestamp?: string;
    username?: string;
    mentions?: Array<{ id: string; username?: string; bot?: boolean }>;
  }): void {
    const channel = this.channels.get(params.channelId);
    const thread =
      channel?.type === 11 && channel.parentId
        ? { id: params.channelId, parent_id: channel.parentId }
        : undefined;
    this.gatewayFrames.push({
      op: 0,
      t: "MESSAGE_CREATE",
      s: this.gatewaySequence++,
      d: {
        id: params.messageId,
        channel_id: params.channelId,
        guild_id: params.guildId,
        type: 0,
        content: params.content,
        author: {
          id: params.authorId,
          bot: false,
          ...(params.username ? { username: params.username } : {}),
        },
        ...(thread ? { thread } : {}),
        attachments: [],
        mentions: params.mentions ?? [],
        mention_roles: [],
        timestamp: params.timestamp ?? "2026-01-01T00:00:00.000Z",
      },
    });
    this.flushGatewayFrames();
  }

  async waitForRequest(
    predicate: (request: FakeDiscordRequest) => boolean,
    timeoutMs = 10_000,
  ): Promise<FakeDiscordRequest> {
    return await waitForCondition(
      () => this.requests.find(predicate),
      timeoutMs,
      "timed out waiting for fake Discord request",
    );
  }

  async close(): Promise<void> {
    this.gatewayServer.clients.forEach((client) => {
      try {
        client.close();
      } catch {
        // Ignore shutdown errors in tests.
      }
    });
    await new Promise<void>((resolveClose) => {
      this.gatewayServer.close(() => resolveClose());
    });
    await closeHttpServer(this.server);
  }

  private configureGatewayServer(): void {
    this.gatewayServer.on("connection", (socket) => {
      this.gatewaySocket = socket;
      this.gatewayIdentified = false;
      socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }));
      socket.on("message", (raw) => {
        const text =
          typeof raw === "string"
            ? raw
            : Buffer.isBuffer(raw)
              ? raw.toString("utf8")
              : Array.isArray(raw)
                ? Buffer.concat(raw).toString("utf8")
                : Buffer.from(raw).toString("utf8");
        const payload = JSON.parse(text) as { op?: unknown };
        if (Number(payload.op) !== 2) {
          return;
        }
        this.gatewayIdentified = true;
        socket.send(
          JSON.stringify({
            op: 0,
            t: "READY",
            s: 1,
            d: {
              session_id: "fake-discord-session",
              user: { id: this.botUserId, username: "integration-bot", bot: true },
            },
          }),
        );
        this.flushGatewayFrames();
      });
      socket.on("close", () => {
        if (this.gatewaySocket === socket) {
          this.gatewaySocket = null;
        }
        this.gatewayIdentified = false;
      });
    });
  }

  private flushGatewayFrames(): void {
    if (!this.gatewayIdentified || !this.gatewaySocket || this.gatewaySocket.readyState !== 1) {
      return;
    }
    while (this.gatewayFrames.length > 0) {
      const frame = this.gatewayFrames.shift();
      if (!frame) {
        break;
      }
      this.gatewaySocket.send(JSON.stringify(frame));
    }
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");

    if (method === "GET" && requestUrl.pathname === "/gateway/bot") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ url: this.url.replace(/^http/i, "ws") + "/gateway" }));
      return;
    }

    if (method === "GET" && requestUrl.pathname === "/users/@me") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ id: this.botUserId, username: "integration-bot", bot: true }));
      return;
    }

    if (method === "POST" && requestUrl.pathname === "/users/@me/channels") {
      const body = await readJsonBody(req);
      const userId = toStringId(body.recipient_id);
      const channelId = this.dmChannelsByUser.get(userId) ?? "3001";
      this.dmChannelsByUser.set(userId, channelId);
      this.requests.push({
        kind: "createDmChannel",
        userId,
        body,
      });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ id: channelId }));
      return;
    }

    const channelMatch = requestUrl.pathname.match(/^\/channels\/([^/]+)$/);
    if (channelMatch && method === "GET") {
      const channelId = channelMatch[1] ?? "";
      const channel = this.channels.get(channelId);
      if (!channel) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          id: channel.id,
          ...(channel.guildId ? { guild_id: channel.guildId } : {}),
          ...(channel.parentId ? { parent_id: channel.parentId } : {}),
          type: channel.type,
        }),
      );
      return;
    }

    const messagesMatch = requestUrl.pathname.match(/^\/channels\/([^/]+)\/messages$/);
    if (messagesMatch && method === "GET") {
      const channelId = messagesMatch[1] ?? "";
      const after = requestUrl.searchParams.get("after");
      const pending = this.pendingMessagesByChannel.get(channelId) ?? [];
      const delivered = pending.filter((message) => {
        if (after == null) {
          return true;
        }
        return BigInt(message.id) > BigInt(after);
      });
      if (delivered.length > 0) {
        const maxDelivered = BigInt(delivered[delivered.length - 1]?.id ?? "0");
        this.pendingMessagesByChannel.set(
          channelId,
          pending.filter((message) => BigInt(message.id) > maxDelivered),
        );
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(delivered));
      return;
    }

    if (messagesMatch && method === "POST") {
      const channelId = messagesMatch[1] ?? "";
      const body = await readJsonBody(req);
      this.requests.push({
        kind: "sendMessage",
        channelId,
        body,
      });
      const messageId = String(this.nextMessageId++);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ id: messageId, channel_id: channelId }));
      return;
    }

    const typingMatch = requestUrl.pathname.match(/^\/channels\/([^/]+)\/typing$/);
    if (typingMatch && method === "POST") {
      const channelId = typingMatch[1] ?? "";
      this.requests.push({
        kind: "typing",
        channelId,
      });
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(404);
    res.end();
  }
}
