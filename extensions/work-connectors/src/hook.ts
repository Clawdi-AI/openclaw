import fs from "node:fs/promises";

export type Connector = {
  backend: string;
  ref: string;
};

export type ConnectorMap = Record<string, Connector>;

/**
 * Reads and parses a connectors.json file.
 * Returns an empty object if the file is missing or invalid.
 */
export async function loadConnectors(filePath: string): Promise<ConnectorMap> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return (parsed?.connectors as ConnectorMap) ?? {};
  } catch {
    return {};
  }
}

/**
 * Formats a connector map into a prompt block for injection.
 * Returns empty string if connectors is empty, null, or undefined.
 */
export function formatConnectorsPrompt(
  connectors: ConnectorMap | null | undefined,
  connectorsFilePath?: string,
): string {
  if (!connectors || Object.keys(connectors).length === 0) {
    return "";
  }

  const lines = Object.entries(connectors).map(([category, connector]) => {
    if (connector.backend === "skill") {
      return `- ${category}: use the ${connector.ref} skill`;
    }
    return `- ${category}: use ${connector.backend} (${connector.ref})`;
  });

  const fileLine = connectorsFilePath
    ? `\nConnector config file: ${connectorsFilePath}\nTo change a connector, edit the JSON entry in that file (backend: "composio"|"mcporter"|"skill", ref: the server/skill name). Restart the gateway after editing.`
    : "";

  return `## Connector Resolution
When a skill references a ~~category, use this mapping:
${lines.join("\n")}
If a connector is listed as "skill:<name>", use that OpenClaw skill's actions directly.
If a connector is listed as "mcporter", use: mcporter call <ref>.<tool_name> key=value
If a connector is listed as "composio", use the composio skill workflow (search -> connect -> execute).
If a ~~category has no mapping configured, tell the user what to add to connectors.json.${fileLine}`;
}
