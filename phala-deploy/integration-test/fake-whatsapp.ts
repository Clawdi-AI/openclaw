import http from "node:http";
import { closeHttpServer, getFreePort, readJsonBody, waitForCondition } from "./test-utils.js";

export type FakeWhatsAppRequest =
  | {
      kind: "typing";
      to: string;
    }
  | {
      kind: "sendMessage";
      to: string;
      text: string;
      hasMedia: boolean;
      mediaType?: string;
      options?: Record<string, unknown>;
    };

export type FakeWhatsAppInboundMessage = {
  id: string;
  from: string;
  conversationId: string;
  to: string;
  accountId: string;
  body: string;
  chatType: "direct" | "group";
  chatId: string;
  senderJid?: string;
  senderE164?: string;
  senderName?: string;
  pushName?: string;
  timestamp?: number;
  wasMentioned?: boolean;
};

export class FakeWhatsAppApi {
  readonly requests: FakeWhatsAppRequest[] = [];

  private readonly inboundQueue: FakeWhatsAppInboundMessage[] = [];
  private nextMessageId = 9_000;

  private constructor(
    readonly server: http.Server,
    readonly url: string,
  ) {}

  static async start(): Promise<FakeWhatsAppApi> {
    const port = await getFreePort();
    let instance: FakeWhatsAppApi;
    instance = new FakeWhatsAppApi(
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

  enqueueMessage(message: FakeWhatsAppInboundMessage): void {
    this.inboundQueue.push(message);
  }

  async waitForRequest(
    predicate: (request: FakeWhatsAppRequest) => boolean,
    timeoutMs = 10_000,
  ): Promise<FakeWhatsAppRequest> {
    return await waitForCondition(
      () => this.requests.find(predicate),
      timeoutMs,
      "timed out waiting for fake WhatsApp request",
    );
  }

  async close(): Promise<void> {
    await closeHttpServer(this.server);
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");

    if (method === "GET" && requestUrl.pathname === "/inbound/take") {
      const batch = this.inboundQueue.splice(0, this.inboundQueue.length);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ items: batch }));
      return;
    }

    if (method === "POST" && requestUrl.pathname === "/outbound/typing") {
      const body = await readJsonBody(req);
      const to = typeof body.to === "string" ? body.to : "";
      this.requests.push({
        kind: "typing",
        to,
      });
      res.writeHead(204);
      res.end();
      return;
    }

    if (method === "POST" && requestUrl.pathname === "/outbound/send-message") {
      const body = await readJsonBody(req);
      const to = typeof body.to === "string" ? body.to : "";
      const text = typeof body.text === "string" ? body.text : "";
      const hasMedia = body.hasMedia === true;
      const mediaType = typeof body.mediaType === "string" ? body.mediaType : undefined;
      const options =
        body.options && typeof body.options === "object"
          ? (body.options as Record<string, unknown>)
          : undefined;
      this.requests.push({
        kind: "sendMessage",
        to,
        text,
        hasMedia,
        ...(mediaType ? { mediaType } : {}),
        ...(options ? { options } : {}),
      });
      const messageId = `wa-msg-${this.nextMessageId++}`;
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ messageId, toJid: to }));
      return;
    }

    res.writeHead(404);
    res.end();
  }
}
