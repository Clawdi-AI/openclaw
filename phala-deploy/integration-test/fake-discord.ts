import http from "node:http";
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

  private readonly pendingMessagesByChannel = new Map<string, FakeDiscordInboundMessage[]>();
  private readonly dmChannelsByUser = new Map<string, string>();
  private nextMessageId = 8_000;

  private constructor(
    readonly server: http.Server,
    readonly url: string,
  ) {}

  static async start(): Promise<FakeDiscordApi> {
    const port = await getFreePort();
    let instance: FakeDiscordApi;
    instance = new FakeDiscordApi(
      http.createServer(async (req, res) => {
        await instance.handleRequest(req, res);
      }),
      `http://127.0.0.1:${port}`,
    );
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
    await closeHttpServer(this.server);
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");

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
