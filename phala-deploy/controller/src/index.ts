import http from "node:http";
import type { Duplex } from "node:stream";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { extractToken, timingSafeTokenEqual } from "./auth";
import { createHttpProxy, handleWsUpgrade, type ProxyTarget } from "./proxy";
import { registerFileRoutes } from "./routes/files";
import { registerHealthRoute, type ControllerStateRef } from "./routes/health";
import { registerLogRoutes } from "./routes/logs";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 18789);
const GATEWAY_AUTH_TOKEN = process.env.GATEWAY_AUTH_TOKEN;
if (!GATEWAY_AUTH_TOKEN) {
  console.error("[controller] GATEWAY_AUTH_TOKEN is required");
  process.exit(1);
}

const GATEWAY: ProxyTarget = { host: "127.0.0.1", port: 3001 };
const TTYD: ProxyTarget = { host: "127.0.0.1", port: 7681 };
const FILES_ROOT = "/data/openclaw";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const controllerState: ControllerStateRef = {
  current: { state: "starting" },
};

// ---------------------------------------------------------------------------
// Hono app + helpers
// ---------------------------------------------------------------------------

/** Convert a Node.js IncomingMessage + ServerResponse into a fetch-style handler. */
async function handleHttpRequest(
  app: Hono,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = `http://localhost:${PORT}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value) {
      headers.set(key, Array.isArray(value) ? value[0] : value);
    }
  }

  const method = (req.method ?? "GET").toUpperCase();
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = req as unknown as ReadableStream;
    init.duplex = "half";
  }

  const fetchReq = new Request(url, init);
  const fetchRes = await app.fetch(fetchReq);

  res.statusCode = fetchRes.status;
  fetchRes.headers.forEach((v, k) => res.setHeader(k, v));

  if (fetchRes.body) {
    const reader = fetchRes.body.getReader();
    const pump = async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        res.write(value);
      }
      res.end();
    };
    await pump();
  } else {
    res.end();
  }
}

// ---------------------------------------------------------------------------
// Build app
// ---------------------------------------------------------------------------

const app = new Hono();

// CORS for /_clawdi/* routes (dashboard calls from different origin)
app.use(
  "/_clawdi/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type"],
  }),
);

// Health — no auth
registerHealthRoute(app, controllerState);

// File management — auth handled inside
registerFileRoutes(app, GATEWAY_AUTH_TOKEN, FILES_ROOT);

// Log streaming — auth handled inside
registerLogRoutes(app, GATEWAY_AUTH_TOKEN);

// Catch-all proxy to gateway
app.all("*", createHttpProxy(GATEWAY));

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  void handleHttpRequest(app, req, res).catch((error) => {
    console.error("[controller] HTTP handler error:", error);
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "Internal Server Error" }));
  });
});

// ---------------------------------------------------------------------------
// WebSocket upgrade handler
// ---------------------------------------------------------------------------

const wsState = { activeConnections: 0 };

function routeWsUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
  const pathname = (req.url ?? "/").split("?")[0];

  // /_clawdi/terminal/* → proxy to ttyd (auth required)
  if (pathname.startsWith("/_clawdi/terminal")) {
    const token = extractToken(req.headers["authorization"], req.url ?? "/");
    if (!timingSafeTokenEqual(token, GATEWAY_AUTH_TOKEN!)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    // Rewrite path: /_clawdi/terminal/ws → /ws (ttyd expects root-relative paths)
    const originalUrl = req.url ?? "/";
    req.url = originalUrl.replace(/^\/_clawdi\/terminal/, "") || "/";

    handleWsUpgrade(req, socket, head, { target: TTYD, wsState });
    return;
  }

  // Everything else → proxy to gateway
  handleWsUpgrade(req, socket, head, { target: GATEWAY, wsState });
}

server.on("upgrade", (req, socket, head) => {
  routeWsUpgrade(req, socket, head);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

server.listen(PORT, "0.0.0.0", () => {
  controllerState.current = { state: "ready" };
  console.log(`[controller] Listening on :${PORT}`);
});

// Graceful shutdown
const onSignal = (signal: string) => {
  console.log(`[controller] Received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  // Force exit after 10s
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on("SIGTERM", () => onSignal("SIGTERM"));
process.on("SIGINT", () => onSignal("SIGINT"));
