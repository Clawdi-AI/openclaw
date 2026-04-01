import fs from "node:fs";
import path from "node:path";
import type { Context, Hono } from "hono";
import { extractToken, timingSafeTokenEqual } from "../auth";

const LOGS_DIR = "/data/openclaw/logs";

const VALID_SOURCES = new Set(["gateway", "controller", "ttyd", "supervisord", "dockerd"]);

export function registerLogRoutes(app: Hono, expectedToken: string): void {
  app.get("/_clawdi/logs", (c: Context) => {
    const token = extractToken(c.req.header("authorization"), c.req.url);
    if (!timingSafeTokenEqual(token, expectedToken)) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const source = c.req.query("source") ?? "gateway";
    if (!VALID_SOURCES.has(source)) {
      return c.json({ error: `Invalid source. Valid: ${[...VALID_SOURCES].join(", ")}` }, 400);
    }

    const lines = Number(c.req.query("lines") ?? "200");
    const logFile = path.join(LOGS_DIR, `${source}.log`);

    if (!fs.existsSync(logFile)) {
      return c.json({ error: `Log file not found: ${source}.log` }, 404);
    }

    // SSE response
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();

        const send = (data: string) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        };

        // Read last N lines as initial data
        try {
          const content = fs.readFileSync(logFile, "utf-8");
          const allLines = content.split("\n");
          const tail = allLines.slice(-lines).filter(Boolean);
          for (const line of tail) {
            send(line);
          }
        } catch {
          send(`[Error reading ${source}.log]`);
        }

        // Watch for new content
        let lastSize = 0;
        try {
          lastSize = fs.statSync(logFile).size;
        } catch {
          // ignore
        }

        const watcher = fs.watch(logFile, () => {
          try {
            const stat = fs.statSync(logFile);
            if (stat.size > lastSize) {
              // Read only the new bytes
              const fd = fs.openSync(logFile, "r");
              const buf = Buffer.alloc(stat.size - lastSize);
              fs.readSync(fd, buf, 0, buf.length, lastSize);
              fs.closeSync(fd);

              const newContent = buf.toString("utf-8");
              const newLines = newContent.split("\n").filter(Boolean);
              for (const line of newLines) {
                send(line);
              }
              lastSize = stat.size;
            } else if (stat.size < lastSize) {
              // Log was rotated — reset
              lastSize = 0;
              send(`[Log rotated: ${source}.log]`);
            }
          } catch {
            // File may be temporarily unavailable during rotation
          }
        });

        // Clean up when client disconnects
        c.req.raw.signal.addEventListener("abort", () => {
          watcher.close();
          controller.close();
        });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });
}
