/** Map OpenClaw tool names to Mentat source tags for provenance tracking. */
export function toolToSource(toolName: string): string {
  if (toolName === "WebFetch" || toolName === "web_fetch") return "web_fetch";
  if (toolName.startsWith("composio:")) {
    // composio:gmail:send_email → composio:gmail
    const parts = toolName.split(":");
    return parts.length >= 2 ? `composio:${parts[1]}` : toolName;
  }
  return `openclaw:${toolName}`;
}

const FILE_READ_TOOLS = new Set(["Read", "read_file", "file_read", "ReadFile", "cat"]);

export function isFileReadTool(toolName: string): boolean {
  return FILE_READ_TOOLS.has(toolName);
}

export function isWebFetchTool(toolName: string): boolean {
  return toolName === "WebFetch" || toolName === "web_fetch";
}

export function isComposioTool(toolName: string): boolean {
  return toolName.startsWith("composio:");
}

/** Extract text content from a tool result. Handles both string and structured results. */
export function extractContentFromResult(result: unknown): string | null {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return null;

  const obj = result as Record<string, unknown>;

  // { content: [{ type: "text", text: "..." }] }
  if (Array.isArray(obj.content)) {
    const texts: string[] = [];
    for (const block of obj.content) {
      if (
        block &&
        typeof block === "object" &&
        (block as Record<string, unknown>).type === "text" &&
        typeof (block as Record<string, unknown>).text === "string"
      ) {
        texts.push((block as Record<string, unknown>).text as string);
      }
    }
    if (texts.length > 0) return texts.join("\n");
  }

  // { text: "..." }
  if (typeof obj.text === "string") return obj.text;

  // { result: "..." }
  if (typeof obj.result === "string") return obj.result;

  return null;
}

/** Convert a URL to a filename-safe string. */
export function urlToFilename(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/\./g, "_");
    const path = parsed.pathname.replace(/[^a-zA-Z0-9-_]/g, "_").slice(0, 60);
    return `${host}${path}.html`;
  } catch {
    return `web_${Date.now()}.html`;
  }
}
