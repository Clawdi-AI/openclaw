import http from "node:http";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Context } from "hono";

export const DEFAULT_WS_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_WS_HANDSHAKE_TIMEOUT_MS = 5 * 1000;
export const DEFAULT_MAX_WS_CONNS = 100;

export type ProxyTarget = {
  host: string;
  port: number;
};

// ---------------------------------------------------------------------------
// HTTP proxy
// ---------------------------------------------------------------------------

export function createHttpProxy(target: ProxyTarget) {
  const backendOrigin = `http://${target.host}:${target.port}`;

  return async (c: Context): Promise<Response> => {
    const incomingUrl = new URL(c.req.url);
    const backendUrl = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, backendOrigin);

    const headers = new Headers(c.req.raw.headers);
    headers.set("host", `${target.host}:${target.port}`);
    // Strip forwarded headers so the gateway sees a loopback origin.
    headers.delete("x-forwarded-for");
    headers.delete("x-real-ip");
    headers.delete("x-forwarded-host");

    const method = c.req.method.toUpperCase();
    const init: RequestInit & { duplex?: "half" } = {
      method,
      headers,
      redirect: "manual",
    };

    if (method !== "GET" && method !== "HEAD") {
      init.body = c.req.raw.body;
      init.duplex = "half";
    }

    try {
      const resp = await fetch(backendUrl, init);
      return new Response(resp.body, {
        status: resp.status,
        headers: resp.headers,
      });
    } catch (error) {
      console.error("[controller] HTTP proxy error:", error);
      return c.json({ error: "Bad Gateway" }, 502);
    }
  };
}

// ---------------------------------------------------------------------------
// WebSocket proxy (raw socket tunneling)
// ---------------------------------------------------------------------------

function socketWrite(socket: Duplex, status: number, statusText: string): void {
  socket.write(`HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function setDuplexTimeout(socket: Duplex, timeoutMs: number, onTimeout: () => void): void {
  const s = socket as unknown as {
    setTimeout?: (timeout: number, cb?: () => void) => void;
  };
  s.setTimeout?.(timeoutMs, onTimeout);
}

export type WsProxyOptions = {
  target: ProxyTarget;
  wsIdleTimeoutMs?: number;
  wsHandshakeTimeoutMs?: number;
  maxWsConnections?: number;
  wsState?: { activeConnections: number };
};

export function handleWsUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options: WsProxyOptions,
): void {
  const { target } = options;
  const wsIdleTimeoutMs = options.wsIdleTimeoutMs ?? DEFAULT_WS_IDLE_TIMEOUT_MS;
  const wsHandshakeTimeoutMs = options.wsHandshakeTimeoutMs ?? DEFAULT_WS_HANDSHAKE_TIMEOUT_MS;
  const maxWsConnections = options.maxWsConnections ?? DEFAULT_MAX_WS_CONNS;
  const wsState = options.wsState ?? { activeConnections: 0 };

  if (wsState.activeConnections >= maxWsConnections) {
    socketWrite(socket, 503, "Service Unavailable");
    return;
  }

  wsState.activeConnections += 1;
  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    wsState.activeConnections = Math.max(0, wsState.activeConnections - 1);
  };

  const forwardedHeaders = { ...req.headers };
  forwardedHeaders["host"] = `${target.host}:${target.port}`;
  delete forwardedHeaders["x-forwarded-for"];
  delete forwardedHeaders["x-real-ip"];
  delete forwardedHeaders["x-forwarded-host"];

  const backendReq = http.request({
    hostname: target.host,
    port: target.port,
    path: req.url,
    method: req.method,
    headers: forwardedHeaders,
  });

  backendReq.setTimeout(wsHandshakeTimeoutMs, () => {
    socketWrite(socket, 502, "Bad Gateway");
    backendReq.destroy();
    release();
  });

  backendReq.on("upgrade", (backendRes, backendSocket, backendHead) => {
    backendReq.setTimeout(0);
    setDuplexTimeout(socket, wsIdleTimeoutMs, () => socket.destroy());
    backendSocket.setTimeout(wsIdleTimeoutMs, () => backendSocket.destroy());

    let closed = false;
    const closeTunnel = () => {
      if (closed) {
        return;
      }
      closed = true;
      socket.destroy();
      backendSocket.destroy();
      release();
    };

    // Forward the upgrade response headers to the client.
    let rawResponse = `HTTP/1.1 ${backendRes.statusCode ?? 101} ${
      backendRes.statusMessage ?? "Switching Protocols"
    }\r\n`;
    for (let i = 0; i < backendRes.rawHeaders.length; i += 2) {
      rawResponse += `${backendRes.rawHeaders[i]}: ${backendRes.rawHeaders[i + 1]}\r\n`;
    }
    rawResponse += "\r\n";
    socket.write(rawResponse);

    if (backendHead.length > 0) {
      socket.write(backendHead);
    }
    if (head.length > 0) {
      backendSocket.write(head);
    }

    socket.pipe(backendSocket);
    backendSocket.pipe(socket);

    socket.on("error", closeTunnel);
    backendSocket.on("error", closeTunnel);
    socket.on("close", closeTunnel);
    backendSocket.on("close", closeTunnel);
  });

  backendReq.on("response", (backendRes) => {
    backendReq.setTimeout(0);
    let closed = false;
    const closeResponse = () => {
      if (closed) {
        return;
      }
      closed = true;
      socket.destroy();
      release();
    };

    let rawResponse = `HTTP/1.1 ${backendRes.statusCode ?? 502} ${
      backendRes.statusMessage ?? "Bad Gateway"
    }\r\n`;
    for (let i = 0; i < backendRes.rawHeaders.length; i += 2) {
      rawResponse += `${backendRes.rawHeaders[i]}: ${backendRes.rawHeaders[i + 1]}\r\n`;
    }
    rawResponse += "\r\n";
    socket.write(rawResponse);
    backendRes.pipe(socket);
    backendRes.on("end", () => socket.end());
    backendRes.on("close", closeResponse);
    socket.on("close", closeResponse);
  });

  backendReq.on("error", (error) => {
    console.error("[controller] WS proxy error:", error);
    socketWrite(socket, 502, "Bad Gateway");
    release();
  });

  backendReq.end();
}
