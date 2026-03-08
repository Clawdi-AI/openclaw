#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const port = Number(process.env.TELEGRAM_CAPTURE_PORT || 18990);
const captureDir = path.resolve(process.env.TELEGRAM_CAPTURE_DIR || "./state/telegram-capture");
const upstreamBaseUrl =
  process.env.TELEGRAM_CAPTURE_UPSTREAM_BASE_URL || "https://api.telegram.org";
const captureLogPath = path.join(captureDir, "captures.ndjson");

fs.mkdirSync(captureDir, { recursive: true });

function nowIso() {
  return new Date().toISOString();
}

function createRequestId() {
  return `${Date.now()}-${crypto.randomUUID()}`;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    request.on("error", reject);
  });
}

function redactTelegramPath(rawPath) {
  return rawPath
    .replace(/\/bot[^/]+/g, "/bot<TOKEN>")
    .replace(/\/file\/bot[^/]+/g, "/file/bot<TOKEN>");
}

function normalizeHeaders(headers) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      normalized[key] = value.join(", ");
      continue;
    }
    normalized[key] =
      typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
  }
  return normalized;
}

function decodeBody(body, contentType) {
  if (!body || body.length === 0) {
    return { kind: "empty" };
  }
  if (contentType.includes("application/json")) {
    const text = body.toString("utf8");
    try {
      return {
        kind: "json",
        json: JSON.parse(text),
      };
    } catch {
      return {
        kind: "text",
        text,
      };
    }
  }
  if (
    contentType.startsWith("text/") ||
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("application/javascript") ||
    contentType.includes("application/xml")
  ) {
    return {
      kind: "text",
      text: body.toString("utf8"),
    };
  }
  return {
    kind: "binary",
    sizeBytes: body.length,
    sha256: crypto.createHash("sha256").update(body).digest("hex"),
  };
}

function formatPayload(decoded) {
  if (decoded.kind === "json") {
    return { json: decoded.json };
  }
  if (decoded.kind === "text") {
    return { text: decoded.text };
  }
  if (decoded.kind === "binary") {
    return {
      binary: {
        sizeBytes: decoded.sizeBytes,
        sha256: decoded.sha256,
      },
    };
  }
  return {};
}

function appendCapture(entry) {
  fs.appendFileSync(captureLogPath, `${JSON.stringify(entry)}\n`, "utf8");
}

const server = http.createServer(async (request, response) => {
  if (!request.url) {
    response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: false, error: "missing request url" }));
    return;
  }

  if (request.method === "GET" && request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true, upstreamBaseUrl }));
    return;
  }

  const requestId = createRequestId();
  const capturedAt = nowIso();
  const requestBody = await readBody(request);
  const upstreamUrl = new URL(request.url, upstreamBaseUrl);
  const requestHeaders = normalizeHeaders(request.headers);
  delete requestHeaders.host;
  const requestContentType = requestHeaders["content-type"] || "";
  const decodedRequestBody = decodeBody(requestBody, requestContentType);

  let upstreamResponse;
  let responseBody;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method: request.method,
      headers: requestHeaders,
      body:
        request.method && ["GET", "HEAD"].includes(request.method.toUpperCase())
          ? undefined
          : requestBody,
      duplex: "half",
    });
    responseBody = Buffer.from(await upstreamResponse.arrayBuffer());
  } catch (error) {
    appendCapture({
      requestId,
      capturedAt,
      request: {
        method: request.method || "GET",
        path: redactTelegramPath(request.url),
        headers: requestHeaders,
        ...formatPayload(decodedRequestBody),
      },
      error: String(error),
    });
    response.writeHead(502, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: false, error: "telegram upstream request failed" }));
    return;
  }

  const responseHeaders = normalizeHeaders(Object.fromEntries(upstreamResponse.headers.entries()));
  const responseContentType = responseHeaders["content-type"] || "";
  const decodedResponseBody = decodeBody(responseBody, responseContentType);

  appendCapture({
    requestId,
    capturedAt,
    request: {
      method: request.method || "GET",
      path: redactTelegramPath(request.url),
      headers: requestHeaders,
      ...formatPayload(decodedRequestBody),
    },
    response: {
      status: upstreamResponse.status,
      headers: responseHeaders,
      ...formatPayload(decodedResponseBody),
    },
  });

  response.writeHead(upstreamResponse.status, responseHeaders);
  response.end(responseBody);
});

server.listen(port, "0.0.0.0", () => {
  console.log(
    JSON.stringify({
      type: "telegram_capture_proxy_ready",
      port,
      captureLogPath,
      upstreamBaseUrl,
    }),
  );
});
