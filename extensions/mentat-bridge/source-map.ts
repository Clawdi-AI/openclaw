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

const FILE_READ_TOOLS = new Set(["Read", "read", "read_file", "file_read", "ReadFile", "cat"]);

export function isFileReadTool(toolName: string): boolean {
  return FILE_READ_TOOLS.has(toolName);
}

export function isWebFetchTool(toolName: string): boolean {
  return toolName === "WebFetch" || toolName === "web_fetch";
}

export function isComposioTool(toolName: string): boolean {
  return toolName.startsWith("composio:");
}

/**
 * Try to unwrap a JSON string into its nested text content.
 * Tool results like WebFetch arrive as `{ content: [{ type: "text", text: JSON.stringify(payload) }] }`
 * where the inner text is a serialized object with a `.text` field holding the actual page content.
 * Returns null if the string is not JSON or has no extractable text.
 */
function tryUnwrapJsonText(str: string): string | null {
  if (!str.startsWith("{") && !str.startsWith("[")) return null;
  try {
    const parsed: unknown = JSON.parse(str);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      // Prefer .text (WebFetch result shape)
      if (typeof obj.text === "string") return obj.text;
      // Fallback to .result
      if (typeof obj.result === "string") return obj.result;
    }
  } catch {
    // Not valid JSON
  }
  return null;
}

/** Extract text content from a tool result. Handles both string and structured results. */
export function extractContentFromResult(result: unknown): string | null {
  if (typeof result === "string") {
    return tryUnwrapJsonText(result) ?? result;
  }
  if (!result || typeof result !== "object") return null;

  const obj = result as Record<string, unknown>;

  // jsonResult() produces { content: [...], details: payload }.
  // Prefer details.text directly — avoids re-parsing the stringified JSON in content blocks.
  if (obj.details && typeof obj.details === "object") {
    const details = obj.details as Record<string, unknown>;
    if (typeof details.text === "string") return details.text;
    if (typeof details.result === "string") return details.result;
  }

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
    if (texts.length > 0) {
      const joined = texts.join("\n");
      // The text inside content blocks may itself be serialized JSON (e.g. jsonResult wrapper)
      return tryUnwrapJsonText(joined) ?? joined;
    }
  }

  // { text: "..." }
  if (typeof obj.text === "string") return obj.text;

  // { result: "..." }
  if (typeof obj.result === "string") return obj.result;

  return null;
}

/** Simple FNV-1a hash returning a hex string. */
function fnv1aHex(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

/**
 * Generate a stable filename for composio tool results.
 * Uses resource ID params when available, falls back to param hash, then toolCallId.
 */
export function composioFilename(
  toolName: string,
  params: Record<string, unknown>,
  toolCallId: string | undefined,
): string {
  const base = toolName.replace(/:/g, "_");

  // Look for a param that represents a resource ID (e.g. message_id, id, fileId)
  const idKey = Object.keys(params).find(
    (k) => k === "id" || k.endsWith("_id") || k.endsWith("Id"),
  );
  if (idKey != null && params[idKey] != null) {
    return `${base}-${String(params[idKey])}.md`;
  }

  // Hash scalar params for a stable name
  const scalars = Object.entries(params)
    .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    .sort(([a], [b]) => a.localeCompare(b));
  if (scalars.length > 0) {
    return `${base}-${fnv1aHex(JSON.stringify(scalars))}.md`;
  }

  // Fallback to toolCallId
  return `${base}-${toolCallId ?? "unknown"}.md`;
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
