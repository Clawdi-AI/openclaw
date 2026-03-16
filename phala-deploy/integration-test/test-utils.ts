import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import net from "node:net";

export async function getFreePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to reserve test port"));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePort(port);
      });
    });
  });
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export async function waitForCondition<T>(
  condition: () => T | undefined | null | false,
  timeoutMs: number,
  errorMessage: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = condition();
    if (result) {
      return result;
    }
    await sleep(50);
  }
  throw new Error(errorMessage);
}

export async function readRequestBuffer(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const raw = (await readRequestBuffer(req)).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

export async function listenOnLoopback(server: http.Server, port: number): Promise<http.Server> {
  await new Promise<void>((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolveServer();
    });
  });
  return server;
}

export async function closeHttpServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolveServer) => {
    server.close(() => resolveServer());
  });
}

export class AsyncCleanupStack {
  private readonly cleanups: Array<() => Promise<void> | void> = [];
  private closed = false;

  defer(cleanup: () => Promise<void> | void): void {
    this.cleanups.push(cleanup);
  }

  use<T extends { close: () => Promise<void> | void }>(resource: T): T {
    this.defer(() => resource.close());
    return resource;
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    const errors: unknown[] = [];
    while (this.cleanups.length > 0) {
      const cleanup = this.cleanups.pop();
      if (!cleanup) {
        continue;
      }
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, "integration test cleanup failed");
    }
  }
}

export type StartedNodeProcess = {
  process: ChildProcessWithoutNullStreams;
  logs: string[];
};

export async function stopChildProcess(child?: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child || child.exitCode !== null || child.killed) {
    return;
  }
  child.kill("SIGINT");
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    (async () => {
      await sleep(3_000);
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGKILL");
      }
    })(),
  ]);
}

export function startNodeTsxProcess(params: {
  cwd: string;
  entrypoint: string;
  args?: string[];
  env?: Record<string, string | undefined>;
}): StartedNodeProcess {
  const logs: string[] = [];
  const process = spawn(
    globalThis.process.execPath,
    ["--import", "tsx", params.entrypoint, ...(params.args ?? [])],
    {
      cwd: params.cwd,
      env: {
        ...globalThis.process.env,
        ...params.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  process.stdout.on("data", (chunk) => {
    logs.push(Buffer.from(chunk).toString("utf8"));
  });
  process.stderr.on("data", (chunk) => {
    logs.push(Buffer.from(chunk).toString("utf8"));
  });
  return { process, logs };
}

export async function waitForHttpOk(params: {
  url: string;
  timeoutMs: number;
  onTick?: () => void;
  errorMessage: () => string;
}): Promise<void> {
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    params.onTick?.();
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    try {
      const response = await fetch(params.url, {
        signal: AbortSignal.timeout(Math.min(remainingMs, 1_000)),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Still starting.
    }
    await sleep(100);
  }
  throw new Error(params.errorMessage());
}
