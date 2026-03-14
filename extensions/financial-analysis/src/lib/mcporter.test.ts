import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnState = vi.hoisted(() => ({
  queue: [] as Array<{
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    error?: Error;
  }>,
  spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnState.spawn(...args),
}));

describe("mcporter client", () => {
  beforeEach(() => {
    spawnState.queue.length = 0;
    spawnState.spawn.mockReset();
    spawnState.spawn.mockImplementation(
      (_command: string, _args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
        const next = spawnState.queue.shift() ?? {};
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const child = new EventEmitter() as EventEmitter & {
          stdout: PassThrough;
          stderr: PassThrough;
          kill: (signal?: string) => boolean;
        };
        child.stdout = stdout;
        child.stderr = stderr;
        child.kill = () => true;

        setImmediate(() => {
          if (next.error) {
            child.emit("error", next.error);
            return;
          }
          stdout.end(next.stdout ?? "");
          stderr.end(next.stderr ?? "");
          child.emit("exit", next.exitCode ?? 0);
        });

        return child;
      },
    );
  });

  it("lists tools from an ad-hoc HTTP MCP endpoint via a temp mcporter config", async () => {
    const { createMcporterClient } = await import("./mcporter.js");
    spawnState.queue.push({
      stdout: JSON.stringify({
        server: "connector",
        tools: [{ name: "search_company", description: "Search companies" }],
      }),
    });

    const client = createMcporterClient();
    const result = await client.listTools({
      serverName: "connector",
      baseUrl: "https://example.com/mcp",
      headers: {
        Authorization: "Bearer secret-token",
      },
    });

    expect(result).toMatchObject({
      server: "connector",
      tools: [{ name: "search_company" }],
    });
    const [command, args, options] = spawnState.spawn.mock.calls[0] ?? [];
    expect(command).toBe("mcporter");
    expect(args).toEqual(["list", "connector", "--json", "--config", expect.any(String)]);
    expect(options.env.MCPORTER_HEADER_CONNECTOR_AUTHORIZATION).toBe("Bearer secret-token");
  });

  it("calls a tool with JSON args through mcporter", async () => {
    const { createMcporterClient } = await import("./mcporter.js");
    spawnState.queue.push({
      stdout: JSON.stringify({
        content: [{ type: "text", text: "ok" }],
      }),
    });

    const client = createMcporterClient({ mcporterPath: "/usr/local/bin/mcporter" });
    const result = await client.callTool({
      serverName: "connector",
      baseUrl: "https://example.com/mcp",
      headers: {
        "x-api-key": "abc123",
      },
      toolName: "search_company",
      args: {
        ticker: "MSFT",
      },
    });

    expect(result).toMatchObject({
      content: [{ type: "text", text: "ok" }],
    });
    const [command, args] = spawnState.spawn.mock.calls[0] ?? [];
    expect(command).toBe("/usr/local/bin/mcporter");
    expect(args).toEqual([
      "call",
      "connector.search_company",
      "--args",
      '{"ticker":"MSFT"}',
      "--config",
      expect.any(String),
      "--output",
      "json",
    ]);
  });

  it("uses an existing named mcporter server when no ad-hoc endpoint is provided", async () => {
    const { createMcporterClient } = await import("./mcporter.js");
    spawnState.queue.push({
      stdout: JSON.stringify({
        server: "factset-prod",
        tools: [{ name: "screen_equities" }],
      }),
    });

    const client = createMcporterClient();
    const result = await client.listTools({
      serverName: "factset-prod",
    });

    expect(result).toMatchObject({
      server: "factset-prod",
      tools: [{ name: "screen_equities" }],
    });
    const [command, args] = spawnState.spawn.mock.calls[0] ?? [];
    expect(command).toBe("mcporter");
    expect(args).toEqual(["list", "factset-prod", "--json"]);
  });

  it("reports a missing mcporter binary clearly", async () => {
    const { createMcporterClient } = await import("./mcporter.js");
    const err = new Error("spawn mcporter ENOENT") as Error & { code?: string };
    err.code = "ENOENT";
    spawnState.queue.push({ error: err });

    const client = createMcporterClient();
    await expect(
      client.listTools({
        serverName: "connector",
        baseUrl: "https://example.com/mcp",
      }),
    ).rejects.toThrow(/mcporter binary not found/i);
  });

  it("surfaces non-zero mcporter exits with stderr context", async () => {
    const { createMcporterClient } = await import("./mcporter.js");
    spawnState.queue.push({
      stderr: "authentication failed",
      exitCode: 2,
    });

    const client = createMcporterClient();
    await expect(
      client.listTools({
        serverName: "connector",
        baseUrl: "https://example.com/mcp",
      }),
    ).rejects.toThrow(/exit code 2/i);
  });

  it("rejects invalid JSON output", async () => {
    const { createMcporterClient } = await import("./mcporter.js");
    spawnState.queue.push({
      stdout: "not-json",
    });

    const client = createMcporterClient();
    await expect(
      client.listTools({
        serverName: "connector",
        baseUrl: "https://example.com/mcp",
      }),
    ).rejects.toThrow(/invalid JSON/i);
  });
});
