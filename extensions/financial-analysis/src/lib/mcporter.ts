import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type McporterHeaders = Record<string, string>;

export type McporterServerParams = {
  serverName: string;
  baseUrl?: string;
  headers?: McporterHeaders;
};

export type McporterListToolsParams = McporterServerParams;

export type McporterCallToolParams = McporterServerParams & {
  toolName: string;
  args: unknown;
};

export type CreateMcporterClientOptions = {
  mcporterPath?: string;
};

export type McporterClient = ReturnType<typeof createMcporterClient>;

type McporterConfig = {
  mcpServers: Record<string, { baseUrl: string; headers?: McporterHeaders }>;
  imports: [];
};

function normalizeEnvToken(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function buildHeaderEnv(
  serverName: string,
  headers: McporterHeaders | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [headerName, headerValue] of Object.entries(headers ?? {})) {
    env[`MCPORTER_HEADER_${normalizeEnvToken(serverName)}_${normalizeEnvToken(headerName)}`] =
      headerValue;
  }
  return env;
}

function buildConfig(params: McporterServerParams): McporterConfig {
  if (!params.baseUrl) {
    throw new Error("baseUrl is required for ad-hoc mcporter config generation");
  }

  const serverEntry: { baseUrl: string; headers?: McporterHeaders } = {
    baseUrl: params.baseUrl,
  };
  if (params.headers && Object.keys(params.headers).length > 0) {
    serverEntry.headers = params.headers;
  }
  return {
    mcpServers: {
      [params.serverName]: serverEntry,
    },
    imports: [],
  };
}

async function withTempConfig<T>(
  params: McporterServerParams,
  fn: (configPath: string, env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  if (!params.baseUrl) {
    return await fn("", {});
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mcporter-"));
  const configPath = path.join(tempDir, "mcporter.json");

  try {
    const config = buildConfig(params);
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    return await fn(configPath, buildHeaderEnv(params.serverName, params.headers));
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function runMcporterCommand<T>(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;

    const child = spawn(executable, args, {
      env: { ...process.env, ...env },
    });

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        reject(new Error(`mcporter binary not found: ${executable}`));
        return;
      }
      reject(new Error(`Failed to start mcporter: ${error.message}`));
    });

    child.once("exit", (code) => {
      if (settled) {
        return;
      }
      settled = true;

      if (code !== 0) {
        const suffix = stderr.trim() ? `: ${stderr.trim()}` : "";
        reject(new Error(`mcporter command failed with exit code ${code}${suffix}`));
        return;
      }

      const output = stdout.trim();
      try {
        resolve((output ? JSON.parse(output) : {}) as T);
      } catch {
        reject(new Error(`Invalid JSON from mcporter: ${output || "<empty>"}`));
      }
    });
  });
}

export function createMcporterClient(options: CreateMcporterClientOptions = {}) {
  const executable = options.mcporterPath?.trim() || "mcporter";

  return {
    async listTools(params: McporterListToolsParams) {
      return await withTempConfig(
        params,
        async (configPath, env) =>
          await runMcporterCommand(
            executable,
            ["list", params.serverName, "--json", ...(configPath ? ["--config", configPath] : [])],
            env,
          ),
      );
    },

    async callTool(params: McporterCallToolParams) {
      return await withTempConfig(
        params,
        async (configPath, env) =>
          await runMcporterCommand(
            executable,
            [
              "call",
              `${params.serverName}.${params.toolName}`,
              "--args",
              JSON.stringify(params.args ?? {}),
              ...(configPath ? ["--config", configPath] : []),
              "--output",
              "json",
            ],
            env,
          ),
      );
    },
  };
}
