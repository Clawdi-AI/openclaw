import { Type } from "@sinclair/typebox";
import {
  createMcporterClient,
  type McporterCallToolParams,
  type McporterListToolsParams,
} from "./mcporter.js";

type ConnectorId =
  | "daloopa"
  | "morningstar"
  | "sp-global"
  | "factset"
  | "moodys"
  | "mtnewswire"
  | "aiera"
  | "lseg"
  | "pitchbook"
  | "chronograph"
  | "egnyte";

type RawConnectorConfig = {
  enabled?: boolean;
  baseUrl?: string;
  apiKey?: string;
  apiKeyHeader?: string;
  apiKeyPrefix?: string;
  mcporterRef?: string;
  headers?: Record<string, string>;
};

type RawPluginConfig = {
  mcporterPath?: string;
  connectors?: Partial<Record<ConnectorId, RawConnectorConfig>>;
};

type RuntimeAuthState = "configured" | "none" | "incomplete";

type RuntimeConnectorEntry = {
  id: ConnectorId;
  label: string;
  enabled: boolean;
  baseUrl: string;
  hasApiKey: boolean;
  authConfigured: boolean;
  transport: "mcp-http";
  supportLevel: "mcporter";
  notes: string[];
  headerNames: string[];
  mcporterRef?: string;
  useConfiguredServer: boolean;
  serverName: string;
  headers: Record<string, string>;
  authState: RuntimeAuthState;
};

export type ResolvedConnectorEntry = Omit<
  RuntimeConnectorEntry,
  "headers" | "authState" | "useConfiguredServer"
>;

type ConnectorSpec = {
  id: ConnectorId;
  label: string;
  defaultBaseUrl: string;
};

type ConnectorToolDeps = {
  listTools: (params: McporterListToolsParams) => Promise<unknown>;
  callTool: (params: McporterCallToolParams) => Promise<unknown>;
};

const CONNECTOR_SPECS: ConnectorSpec[] = [
  { id: "daloopa", label: "Daloopa", defaultBaseUrl: "https://mcp.daloopa.com/server/mcp" },
  { id: "morningstar", label: "Morningstar", defaultBaseUrl: "https://mcp.morningstar.com/mcp" },
  {
    id: "sp-global",
    label: "S&P Global",
    defaultBaseUrl: "https://kfinance.kensho.com/integrations/mcp",
  },
  { id: "factset", label: "FactSet", defaultBaseUrl: "https://mcp.factset.com/mcp" },
  {
    id: "moodys",
    label: "Moody's",
    defaultBaseUrl: "https://api.moodys.com/genai-ready-data/m1/mcp",
  },
  {
    id: "mtnewswire",
    label: "MT Newswires",
    defaultBaseUrl: "https://vast-mcp.blueskyapi.com/mtnewswires",
  },
  { id: "aiera", label: "Aiera", defaultBaseUrl: "https://mcp-pub.aiera.com" },
  {
    id: "lseg",
    label: "LSEG",
    defaultBaseUrl: "https://api.analytics.lseg.com/lfa/mcp",
  },
  { id: "pitchbook", label: "PitchBook", defaultBaseUrl: "https://premium.mcp.pitchbook.com/mcp" },
  { id: "chronograph", label: "Chronograph", defaultBaseUrl: "https://ai.chronograph.pe/mcp" },
  { id: "egnyte", label: "Egnyte", defaultBaseUrl: "https://mcp-server.egnyte.com/mcp" },
];

const CONNECTOR_NOTE =
  "Connector calls are routed through mcporter with an ad-hoc HTTP MCP server config.";
const MCPORTER_REF_NOTE =
  "Connector calls are routed through an existing mcporter server config instead of plugin-managed auth headers.";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readStringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const strings: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    strings[key] = trimmed;
  }

  return Object.keys(strings).length > 0 ? strings : undefined;
}

function readRawPluginConfig(pluginConfig: unknown): RawPluginConfig {
  const root = asRecord(pluginConfig);
  const rawConnectors = asRecord(root?.connectors);
  if (!rawConnectors) {
    return {
      mcporterPath: typeof root?.mcporterPath === "string" ? root.mcporterPath.trim() : undefined,
    };
  }

  const connectors: Partial<Record<ConnectorId, RawConnectorConfig>> = {};
  for (const spec of CONNECTOR_SPECS) {
    const rawEntry = asRecord(rawConnectors[spec.id]);
    if (!rawEntry) {
      continue;
    }
    const apiKeyHeader =
      typeof rawEntry.apiKeyHeader === "string" ? rawEntry.apiKeyHeader.trim() : undefined;
    const apiKeyPrefix =
      typeof rawEntry.apiKeyPrefix === "string" ? rawEntry.apiKeyPrefix : undefined;
    const mcporterRef =
      typeof rawEntry.mcporterRef === "string" ? rawEntry.mcporterRef.trim() : undefined;
    connectors[spec.id] = {
      enabled: typeof rawEntry.enabled === "boolean" ? rawEntry.enabled : undefined,
      baseUrl: typeof rawEntry.baseUrl === "string" ? rawEntry.baseUrl.trim() : undefined,
      apiKey: typeof rawEntry.apiKey === "string" ? rawEntry.apiKey.trim() : undefined,
      apiKeyHeader: apiKeyHeader || undefined,
      apiKeyPrefix,
      mcporterRef: mcporterRef || undefined,
      headers: readStringRecord(rawEntry.headers),
    };
  }

  return {
    mcporterPath: typeof root?.mcporterPath === "string" ? root.mcporterPath.trim() : undefined,
    connectors,
  };
}

function hasInlineConnectorRuntime(rawEntry: RawConnectorConfig | undefined): boolean {
  return Boolean(
    rawEntry?.baseUrl ||
    rawEntry?.apiKey ||
    rawEntry?.apiKeyHeader ||
    rawEntry?.apiKeyPrefix ||
    (rawEntry?.headers && Object.keys(rawEntry.headers).length > 0),
  );
}

function buildDerivedAuthHeader(rawEntry: RawConnectorConfig | undefined): {
  authState: RuntimeAuthState;
  header?: [string, string];
} {
  const apiKey = rawEntry?.apiKey?.trim();
  const rawHeader = rawEntry?.apiKeyHeader?.trim();
  const rawPrefix = rawEntry?.apiKeyPrefix;

  if (!apiKey) {
    if (rawHeader || rawPrefix) {
      return { authState: "incomplete" };
    }
    return { authState: "none" };
  }

  const headerName = rawHeader || "Authorization";
  const headerValue = `${rawPrefix ?? (headerName.toLowerCase() === "authorization" ? "Bearer " : "")}${apiKey}`;
  return {
    authState: "configured",
    header: [headerName, headerValue],
  };
}

function resolveConnectorRuntimeCatalog(
  pluginConfig: unknown,
): Record<ConnectorId, RuntimeConnectorEntry> {
  const rawConfig = readRawPluginConfig(pluginConfig);
  const resolved = {} as Record<ConnectorId, RuntimeConnectorEntry>;

  for (const spec of CONNECTOR_SPECS) {
    const rawEntry = rawConfig.connectors?.[spec.id];
    const mcporterRef = rawEntry?.mcporterRef?.trim();
    const usesConfiguredServer = Boolean(mcporterRef) && !hasInlineConnectorRuntime(rawEntry);
    const staticHeaders = { ...(rawEntry?.headers ?? {}) };
    const derivedAuth = buildDerivedAuthHeader(rawEntry);
    if (!usesConfiguredServer && derivedAuth.header) {
      const [headerName, headerValue] = derivedAuth.header;
      staticHeaders[headerName] = headerValue;
    }

    const notes = [usesConfiguredServer ? MCPORTER_REF_NOTE : CONNECTOR_NOTE];
    if (usesConfiguredServer && mcporterRef) {
      notes.push(`Configured mcporter server ref: ${mcporterRef}`);
    }
    if (!usesConfiguredServer && derivedAuth.authState === "incomplete") {
      notes.push(
        "Connector auth config is incomplete. Add apiKey or remove the partial auth fields.",
      );
    }

    resolved[spec.id] = {
      id: spec.id,
      label: spec.label,
      enabled: rawEntry?.enabled ?? true,
      baseUrl: rawEntry?.baseUrl || spec.defaultBaseUrl,
      hasApiKey: Boolean(rawEntry?.apiKey),
      authConfigured: usesConfiguredServer || Object.keys(staticHeaders).length > 0,
      transport: "mcp-http",
      supportLevel: "mcporter",
      notes,
      headerNames: Object.keys(staticHeaders),
      mcporterRef: mcporterRef || undefined,
      useConfiguredServer: usesConfiguredServer,
      serverName: usesConfiguredServer ? mcporterRef || spec.id : spec.id,
      headers: staticHeaders,
      authState: usesConfiguredServer
        ? "configured"
        : derivedAuth.authState === "configured"
          ? "configured"
          : Object.keys(staticHeaders).length > 0
            ? "configured"
            : derivedAuth.authState,
    };
  }

  return resolved;
}

export function resolveConnectorCatalog(
  pluginConfig: unknown,
): Record<ConnectorId, ResolvedConnectorEntry> {
  const runtimeCatalog = resolveConnectorRuntimeCatalog(pluginConfig);
  const resolved = {} as Record<ConnectorId, ResolvedConnectorEntry>;

  for (const spec of CONNECTOR_SPECS) {
    const entry = runtimeCatalog[spec.id];
    resolved[spec.id] = {
      id: entry.id,
      label: entry.label,
      enabled: entry.enabled,
      baseUrl: entry.baseUrl,
      hasApiKey: entry.hasApiKey,
      authConfigured: entry.authConfigured,
      transport: entry.transport,
      supportLevel: entry.supportLevel,
      notes: entry.notes,
      headerNames: entry.headerNames,
      mcporterRef: entry.mcporterRef,
      serverName: entry.serverName,
    };
  }

  return resolved;
}

function createStringEnum<T extends string>(values: readonly T[]) {
  return Type.Unsafe<T>({
    type: "string",
    enum: [...values],
  });
}

function summarizeConnector(entry: ResolvedConnectorEntry): string {
  return [
    `${entry.id}`,
    `- label: ${entry.label}`,
    `- enabled: ${entry.enabled}`,
    `- baseUrl: ${entry.baseUrl}`,
    `- apiKeyConfigured: ${entry.hasApiKey}`,
    `- authConfigured: ${entry.authConfigured}`,
    `- headerNames: ${entry.headerNames.length > 0 ? entry.headerNames.join(", ") : "none"}`,
    `- mcporterRef: ${entry.mcporterRef ?? "none"}`,
    `- transport: ${entry.transport}`,
    `- supportLevel: ${entry.supportLevel}`,
    ...entry.notes.map((note) => `- note: ${note}`),
  ].join("\n");
}

function formatRemoteTools(connector: string, result: unknown): string {
  const tools = Array.isArray((result as { tools?: unknown[] } | null)?.tools)
    ? ((result as { tools: Array<{ name?: string; description?: string }> }).tools ?? [])
    : [];

  const toolLines =
    tools.length > 0
      ? tools.map(
          (tool) =>
            `- ${tool.name ?? "<unnamed>"}${tool.description ? `: ${tool.description}` : ""}`,
        )
      : ["- No tools returned"];

  return [`Connector: ${connector}`, ...toolLines].join("\n");
}

function formatToolCallResult(connector: string, toolName: string, result: unknown): string {
  return [`Connector: ${connector}`, `Tool: ${toolName}`, JSON.stringify(result, null, 2)].join(
    "\n",
  );
}

function getConnectorEntry(
  catalog: Record<ConnectorId, RuntimeConnectorEntry>,
  connectorValue: string,
) {
  return catalog[connectorValue as ConnectorId];
}

function describeRunnableState(entry: RuntimeConnectorEntry | undefined) {
  if (!entry) {
    return { found: false, runnable: false as const };
  }
  if (!entry.enabled) {
    return { found: true, runnable: false as const, reason: "disabled" as const };
  }
  if (entry.authState === "incomplete") {
    return { found: true, runnable: false as const, reason: "missing_auth" as const };
  }
  return { found: true, runnable: true as const };
}

function createRuntimeDeps(pluginConfig: unknown): ConnectorToolDeps {
  const rawConfig = readRawPluginConfig(pluginConfig);
  const client = createMcporterClient({ mcporterPath: rawConfig.mcporterPath });
  return {
    listTools: client.listTools,
    callTool: client.callTool,
  };
}

export function createConnectorCatalogTool(pluginConfig: unknown, deps?: ConnectorToolDeps) {
  const runtimeDeps = deps ?? createRuntimeDeps(pluginConfig);

  return {
    name: "financial_analysis_connectors",
    label: "Financial Analysis Connectors",
    description: "Inspect and call financial data MCP connectors through mcporter.",
    parameters: Type.Object(
      {
        action: Type.Optional(
          createStringEnum([
            "list_connectors",
            "describe_connector",
            "list_tools",
            "call_tool",
          ] as const),
        ),
        connector: Type.Optional(
          Type.String({
            description: "Optional connector id such as daloopa, factset, or pitchbook.",
          }),
        ),
        toolName: Type.Optional(
          Type.String({
            description: "Remote MCP tool name to call, for example search_company.",
          }),
        ),
        argsJson: Type.Optional(
          Type.String({
            description: "JSON object string forwarded to the remote MCP tool.",
          }),
        ),
      },
      { additionalProperties: false },
    ),

    async execute(_id: string, rawParams: Record<string, unknown>) {
      const actionValue = typeof rawParams.action === "string" ? rawParams.action.trim() : "";
      const action = actionValue || "list_connectors";
      const connectorValue =
        typeof rawParams.connector === "string" ? rawParams.connector.trim().toLowerCase() : "";
      const toolName = typeof rawParams.toolName === "string" ? rawParams.toolName.trim() : "";
      const argsJson = typeof rawParams.argsJson === "string" ? rawParams.argsJson.trim() : "";
      const runtimeCatalog = resolveConnectorRuntimeCatalog(pluginConfig);
      const catalog = resolveConnectorCatalog(pluginConfig);

      if (action === "describe_connector" && connectorValue) {
        const entry = getConnectorEntry(runtimeCatalog, connectorValue);
        if (!entry) {
          return {
            content: [{ type: "text" as const, text: `Unknown connector: ${connectorValue}` }],
            details: {
              action,
              connector: connectorValue,
              found: false,
              runnable: false,
            },
          };
        }

        return {
          content: [{ type: "text" as const, text: summarizeConnector(catalog[entry.id]) }],
          details: {
            action,
            connector: connectorValue,
            found: true,
            runnable: describeRunnableState(entry).runnable,
            entry: catalog[entry.id],
          },
        };
      }

      if (action === "list_tools" || action === "call_tool") {
        const entry = getConnectorEntry(runtimeCatalog, connectorValue);
        const state = describeRunnableState(entry);
        if (!connectorValue) {
          return {
            content: [{ type: "text" as const, text: "Missing required connector id." }],
            details: {
              action,
              connector: connectorValue,
              found: false,
              runnable: false,
            },
          };
        }
        if (!entry || !state.runnable) {
          const message = !entry
            ? `Unknown connector: ${connectorValue}`
            : state.reason === "disabled"
              ? `Connector ${connectorValue} is disabled in plugin config.`
              : `Connector ${connectorValue} has incomplete auth configuration.`;
          return {
            content: [{ type: "text" as const, text: message }],
            details: {
              action,
              connector: connectorValue,
              ...state,
              entry: entry ? catalog[entry.id] : undefined,
            },
          };
        }

        if (action === "list_tools") {
          const result = await runtimeDeps.listTools({
            serverName: entry.serverName,
            baseUrl: entry.useConfiguredServer ? undefined : entry.baseUrl,
            headers: entry.useConfiguredServer ? undefined : entry.headers,
          });
          return {
            content: [{ type: "text" as const, text: formatRemoteTools(entry.id, result) }],
            details: {
              action,
              connector: entry.id,
              found: true,
              runnable: true,
              result,
            },
          };
        }

        if (!toolName) {
          return {
            content: [{ type: "text" as const, text: "Missing required toolName for call_tool." }],
            details: {
              action,
              connector: entry.id,
              found: true,
              runnable: true,
              toolName,
            },
          };
        }

        let parsedArgs: unknown = {};
        if (argsJson) {
          try {
            parsedArgs = JSON.parse(argsJson);
          } catch {
            return {
              content: [{ type: "text" as const, text: "argsJson must be valid JSON." }],
              details: {
                action,
                connector: entry.id,
                found: true,
                runnable: true,
                toolName,
                parsed: false,
              },
            };
          }
        }

        const result = await runtimeDeps.callTool({
          serverName: entry.serverName,
          baseUrl: entry.useConfiguredServer ? undefined : entry.baseUrl,
          headers: entry.useConfiguredServer ? undefined : entry.headers,
          toolName,
          args: parsedArgs,
        });
        return {
          content: [
            { type: "text" as const, text: formatToolCallResult(entry.id, toolName, result) },
          ],
          details: {
            action,
            connector: entry.id,
            found: true,
            runnable: true,
            toolName,
            result,
          },
        };
      }

      const entries = Object.values(catalog);
      const text = entries.map((entry) => summarizeConnector(entry)).join("\n\n");
      return {
        content: [{ type: "text" as const, text }],
        details: {
          action,
          connectors: catalog,
        },
      };
    },
  };
}
