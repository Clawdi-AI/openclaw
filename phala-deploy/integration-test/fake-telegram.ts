import http from "node:http";
import {
  closeHttpServer,
  getFreePort,
  readJsonBody,
  readRequestBuffer,
  waitForCondition,
} from "./test-utils.js";

export type FakeTelegramRequest = {
  method: string;
  body: Record<string, unknown>;
};

type FakeTelegramFailure = {
  status: number;
  body?: Record<string, unknown>;
};

type FakeTelegramFile = {
  path: string;
  contentType: string;
  body: Buffer;
};

function readHeaderString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

function toScalarString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return undefined;
}

function parseMultipartField(raw: string, fieldName: string): string | undefined {
  const escapedFieldName = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = raw.match(
    new RegExp(
      `name="${escapedFieldName}"(?:; filename="[^"]+")?\\r\\n(?:Content-Type:[^\\r\\n]+\\r\\n)?\\r\\n([\\s\\S]*?)\\r\\n--`,
      "m",
    ),
  );
  const value = match?.[1]?.trim();
  return value || undefined;
}

async function readTelegramBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = readHeaderString(req.headers["content-type"]).toLowerCase();
  if (!contentType || contentType.includes("application/json")) {
    return await readJsonBody(req);
  }
  const rawBuffer = await readRequestBuffer(req);
  const rawText = rawBuffer.toString("utf8");
  if (!contentType.includes("multipart/form-data")) {
    return {
      __contentType: contentType,
      __rawBody: rawText,
    };
  }
  const body: Record<string, unknown> = {
    __contentType: contentType,
    __rawBody: rawText,
  };
  for (const fieldName of [
    "chat_id",
    "message_thread_id",
    "reply_to_message_id",
    "text",
    "caption",
    "parse_mode",
  ]) {
    const value = parseMultipartField(rawText, fieldName);
    if (value) {
      body[fieldName] = value;
    }
  }
  for (const fileField of ["document", "photo", "video", "audio", "voice"]) {
    if (rawText.includes(`name="${fileField}"; filename="`)) {
      body[fileField] = "<<multipart-file>>";
    }
  }
  return body;
}

function toTelegramChatId(value: unknown): number | string {
  const asString = toScalarString(value) ?? "0";
  const asNumber = Number(asString);
  return Number.isFinite(asNumber) ? asNumber : asString;
}

export class FakeTelegramApi {
  readonly requests: FakeTelegramRequest[] = [];

  private readonly updates: Array<Record<string, unknown>> = [];
  private readonly files = new Map<string, FakeTelegramFile>();
  private readonly failures = new Map<string, FakeTelegramFailure[]>();
  private readonly stickyFailures = new Map<string, FakeTelegramFailure>();
  private nextMessageId = 1_000;

  private constructor(
    readonly server: http.Server,
    readonly token: string,
    readonly url: string,
  ) {}

  static async start(params?: { token?: string }): Promise<FakeTelegramApi> {
    const token = params?.token ?? "dummy-token";
    const port = await getFreePort();
    let instance: FakeTelegramApi;
    instance = new FakeTelegramApi(
      http.createServer(async (req, res) => {
        await instance.handleRequest(req, res);
      }),
      token,
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

  enqueueUpdate(update: Record<string, unknown>): void {
    this.updates.push(update);
    this.updates.sort((left, right) => {
      const leftId = Number((left as { update_id?: unknown }).update_id ?? 0);
      const rightId = Number((right as { update_id?: unknown }).update_id ?? 0);
      return leftId - rightId;
    });
  }

  registerFile(fileId: string, file: FakeTelegramFile): void {
    this.files.set(fileId, file);
  }

  getMethodCalls(method: string): FakeTelegramRequest[] {
    return this.requests.filter((request) => request.method === method);
  }

  failNextMethod(method: string, failure: FakeTelegramFailure): void {
    const pending = this.failures.get(method) ?? [];
    pending.push(failure);
    this.failures.set(method, pending);
  }

  setMethodFailure(method: string, failure: FakeTelegramFailure | null): void {
    if (!failure) {
      this.stickyFailures.delete(method);
      return;
    }
    this.stickyFailures.set(method, failure);
  }

  async waitForMethodCall(
    method: string,
    predicate?: (request: FakeTelegramRequest) => boolean,
    timeoutMs = 10_000,
  ): Promise<FakeTelegramRequest> {
    return await waitForCondition(
      () =>
        this.requests.find(
          (request) => request.method === method && (predicate?.(request) ?? true),
        ),
      timeoutMs,
      `timed out waiting for fake Telegram ${method}`,
    );
  }

  async close(): Promise<void> {
    await closeHttpServer(this.server);
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url ?? "/";
    if (req.method === "GET" && url.startsWith(`/file/bot${this.token}/`)) {
      const filePath = url.slice(`/file/bot${this.token}/`.length);
      const file = Array.from(this.files.values()).find((entry) => entry.path === filePath);
      if (!file) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        "content-type": file.contentType,
        "content-length": String(file.body.byteLength),
      });
      res.end(file.body);
      return;
    }

    const match = url.match(new RegExp(`^/bot${this.token}/([^/?]+)$`));
    if (req.method !== "POST" || !match) {
      res.writeHead(404);
      res.end();
      return;
    }

    const method = match[1] ?? "";
    const body = await readTelegramBody(req);
    this.requests.push({ method, body });

    const stickyFailure = this.stickyFailures.get(method);
    if (stickyFailure) {
      res.writeHead(stickyFailure.status, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify(
          stickyFailure.body ?? {
            ok: false,
            description: `forced fake Telegram failure for ${method}`,
          },
        ),
      );
      return;
    }

    const queuedFailure = this.failures.get(method)?.shift();
    if (queuedFailure) {
      const remaining = this.failures.get(method) ?? [];
      if (remaining.length === 0) {
        this.failures.delete(method);
      }
      res.writeHead(queuedFailure.status, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify(
          queuedFailure.body ?? {
            ok: false,
            description: `forced fake Telegram failure for ${method}`,
          },
        ),
      );
      return;
    }

    if (method === "getUpdates") {
      const offset = Number(body.offset ?? 0);
      const result = this.updates.filter((update) => {
        const updateId = Number((update as { update_id?: unknown }).update_id ?? 0);
        return !Number.isFinite(offset) || updateId >= offset;
      });
      if (result.length > 0) {
        const highestDelivered = Math.max(
          ...result.map((update) => Number((update as { update_id?: unknown }).update_id ?? 0)),
        );
        const remaining = this.updates.filter((update) => {
          const updateId = Number((update as { update_id?: unknown }).update_id ?? 0);
          return updateId > highestDelivered;
        });
        this.updates.splice(0, this.updates.length, ...remaining);
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, result }));
      return;
    }

    if (method === "getFile") {
      const fileId = toScalarString(body.file_id);
      const file = fileId ? this.files.get(fileId) : undefined;
      if (!file) {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, description: "file not found" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, result: { file_path: file.path } }));
      return;
    }

    if (
      method === "answerCallbackQuery" ||
      method === "deleteMessage" ||
      method === "setMessageReaction" ||
      method === "sendChatAction"
    ) {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, result: true }));
      return;
    }

    if (method === "createForumTopic") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: true,
          result: {
            message_thread_id: 777,
            name: toScalarString(body.name) ?? "Topic",
          },
        }),
      );
      return;
    }

    if (
      method === "sendMessage" ||
      method === "editMessageText" ||
      method === "sendDocument" ||
      method === "sendPhoto" ||
      method === "sendVoice" ||
      method === "sendAudio" ||
      method === "sendVideo" ||
      method === "sendVideoNote" ||
      method === "sendPoll"
    ) {
      const chatId = toTelegramChatId(body.chat_id);
      const messageId =
        method === "editMessageText"
          ? Number(toScalarString(body.message_id) ?? this.nextMessageId)
          : this.nextMessageId++;
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          ok: true,
          result: {
            message_id: messageId,
            chat: { id: chatId },
            ...(method === "sendPoll"
              ? {
                  poll: {
                    id: `poll_${messageId}`,
                    question: toScalarString(body.question) ?? "",
                  },
                }
              : {}),
            ...(body.message_thread_id
              ? { message_thread_id: Number(body.message_thread_id) }
              : {}),
          },
        }),
      );
      return;
    }

    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({ ok: false, description: `unsupported fake Telegram method ${method}` }),
    );
  }
}
