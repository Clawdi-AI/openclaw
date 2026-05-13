import {
  SSEClientTransport,
  type SSEClientTransportOptions,
} from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike, Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadUndiciRuntimeDeps } from "../infra/net/undici-runtime.js";
import { logDebug } from "../logger.js";
import { resolveSecretInputString } from "../secrets/resolve-secret-input-string.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { isMcpConfigRecord } from "./mcp-config-shared.js";
import { OpenClawStdioClientTransport } from "./mcp-stdio-transport.js";
import { resolveMcpTransportConfig } from "./mcp-transport-config.js";

type ResolvedMcpTransport = {
  transport: Transport;
  description: string;
  transportType: "stdio" | "sse" | "streamable-http";
  connectionTimeoutMs: number;
  detachStderr?: () => void;
};

type ResolveMcpTransportOptions = {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
};

function attachStderrLogging(serverName: string, transport: OpenClawStdioClientTransport) {
  const stderr = transport.stderr;
  if (!stderr || typeof stderr.on !== "function") {
    return undefined;
  }
  const onData = (chunk: Buffer | string) => {
    const message =
      normalizeOptionalString(typeof chunk === "string" ? chunk : String(chunk)) ?? "";
    if (!message) {
      return;
    }
    for (const line of message.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) {
        logDebug(`bundle-mcp:${serverName}: ${trimmed}`);
      }
    }
  };
  stderr.on("data", onData);
  return () => {
    if (typeof stderr.off === "function") {
      stderr.off("data", onData);
    } else if (typeof stderr.removeListener === "function") {
      stderr.removeListener("data", onData);
    }
  };
}

function normalizeMcpHeaderValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

async function resolveMcpHeaderValue(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  value: unknown;
  path: string;
}): Promise<string | undefined> {
  return resolveSecretInputString({
    config: params.cfg,
    env: params.env,
    value: params.value,
    normalize: normalizeMcpHeaderValue,
    onResolveRefError: (error, ref) => {
      throw new Error(
        `${params.path}: unresolved SecretRef "${ref.source}:${ref.provider}:${ref.id}": ${String(error)}`,
      );
    },
  });
}

async function resolveMcpServerRuntimeConfig(
  serverName: string,
  rawServer: unknown,
  options?: ResolveMcpTransportOptions,
): Promise<unknown> {
  if (!options?.cfg || !isMcpConfigRecord(rawServer)) {
    return rawServer;
  }

  const next: Record<string, unknown> = { ...rawServer };
  const headers: Record<string, string> = {};
  let hasHeaders = false;
  const env = options.env ?? process.env;

  const auth = isMcpConfigRecord(rawServer.auth) ? rawServer.auth : undefined;
  if (auth && (auth.type === undefined || auth.type === "bearer") && auth.token !== undefined) {
    const token = await resolveMcpHeaderValue({
      cfg: options.cfg,
      env,
      value: auth.token,
      path: `mcp.servers.${serverName}.auth.token`,
    });
    if (token !== undefined) {
      headers.Authorization = `Bearer ${token}`;
      hasHeaders = true;
    }
  }

  if (rawServer.headers !== undefined && rawServer.headers !== null) {
    if (isMcpConfigRecord(rawServer.headers)) {
      for (const [key, value] of Object.entries(rawServer.headers)) {
        const resolved = await resolveMcpHeaderValue({
          cfg: options.cfg,
          env,
          value,
          path: `mcp.servers.${serverName}.headers.${key}`,
        });
        if (resolved !== undefined) {
          headers[key] = resolved;
          hasHeaders = true;
        }
      }
    } else {
      next.headers = rawServer.headers;
      return next;
    }
  }

  if (hasHeaders) {
    next.headers = headers;
  } else {
    delete next.headers;
  }
  return next;
}

type SseEventSourceFetch = NonNullable<
  NonNullable<SSEClientTransportOptions["eventSourceInit"]>["fetch"]
>;

const fetchWithUndici: FetchLike = async (url, init) =>
  (await loadUndiciRuntimeDeps().fetch(
    url,
    init as Parameters<ReturnType<typeof loadUndiciRuntimeDeps>["fetch"]>[1],
  )) as unknown as Response;

function buildSseEventSourceFetch(headers: Record<string, string>): SseEventSourceFetch {
  return (url: string | URL, init?: RequestInit) => {
    const sdkHeaders: Record<string, string> = {};
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((value, key) => {
          sdkHeaders[key] = value;
        });
      } else {
        Object.assign(sdkHeaders, init.headers);
      }
    }
    return fetchWithUndici(url, {
      ...(init as RequestInit),
      headers: { ...sdkHeaders, ...headers },
    }) as ReturnType<SseEventSourceFetch>;
  };
}

export async function resolveMcpTransport(
  serverName: string,
  rawServer: unknown,
  options?: ResolveMcpTransportOptions,
): Promise<ResolvedMcpTransport | null> {
  const runtimeServer = await resolveMcpServerRuntimeConfig(serverName, rawServer, options);
  const resolved = resolveMcpTransportConfig(serverName, runtimeServer);
  if (!resolved) {
    return null;
  }
  if (resolved.kind === "stdio") {
    const transport = new OpenClawStdioClientTransport({
      command: resolved.command,
      args: resolved.args,
      env: resolved.env,
      cwd: resolved.cwd,
      stderr: "pipe",
    });
    return {
      transport,
      description: resolved.description,
      transportType: "stdio",
      connectionTimeoutMs: resolved.connectionTimeoutMs,
      detachStderr: attachStderrLogging(serverName, transport),
    };
  }
  if (resolved.transportType === "streamable-http") {
    return {
      transport: new StreamableHTTPClientTransport(new URL(resolved.url), {
        requestInit: resolved.headers ? { headers: resolved.headers } : undefined,
      }),
      description: resolved.description,
      transportType: "streamable-http",
      connectionTimeoutMs: resolved.connectionTimeoutMs,
    };
  }
  const headers: Record<string, string> = {
    ...resolved.headers,
  };
  const hasHeaders = Object.keys(headers).length > 0;
  return {
    transport: new SSEClientTransport(new URL(resolved.url), {
      requestInit: hasHeaders ? { headers } : undefined,
      fetch: fetchWithUndici,
      eventSourceInit: { fetch: buildSseEventSourceFetch(headers) },
    }),
    description: resolved.description,
    transportType: "sse",
    connectionTimeoutMs: resolved.connectionTimeoutMs,
  };
}

export const __testing = {
  resolveMcpServerRuntimeConfig,
};
