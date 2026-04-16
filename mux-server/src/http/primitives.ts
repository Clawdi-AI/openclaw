import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpBodyError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.name = "HttpBodyError";
  }
}

export function sendJson(res: ServerResponse, statusCode: number, payload: unknown): string {
  const bodyText = JSON.stringify(payload);
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(bodyText);
  return bodyText;
}

export async function readBody<T extends object>(
  req: IncomingMessage,
  requestBodyMaxBytes: number,
): Promise<T> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += chunkBuffer.length;
    if (totalBytes > requestBodyMaxBytes) {
      tooLarge = true;
      continue;
    }
    chunks.push(chunkBuffer);
  }
  if (tooLarge) {
    throw new HttpBodyError(413, "payload too large");
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) {
    return {} as T;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpBodyError(400, "invalid JSON body");
  }
}
