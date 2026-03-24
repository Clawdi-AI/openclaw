import type { MentatClient } from "../client.js";
import type { DocMetaCache, SessionReadTracker } from "../session-state.js";
import {
  extractContentFromResult,
  isComposioTool,
  isFileReadTool,
  isWebFetchTool,
  toolToSource,
  urlToFilename,
} from "../source-map.js";

const FETCH_TIMEOUT_MS = 15_000;
const FETCH_MAX_BYTES = 5 * 1024 * 1024; // 5 MB

/** Fetch raw HTML from a URL. Returns null on failure. */
async function fetchRawHtml(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        Accept: "text/html, */*;q=0.1",
        "User-Agent": "Mozilla/5.0 (compatible; MentatBot/1.0)",
      },
    });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > FETCH_MAX_BYTES) return null;
    return new TextDecoder().decode(buf);
  } catch {
    return null;
  }
}

type PluginApi = {
  on: (
    hookName: string,
    handler: (event: AfterToolCallEvent, ctx: ToolContext) => Promise<void> | void,
  ) => void;
  logger: { debug?: (msg: string) => void };
};

type AfterToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  toolCallId?: string;
  result?: unknown;
  error?: string;
};

type ToolContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
};

export function registerAfterToolCallHook(
  api: PluginApi,
  client: MentatClient,
  readTracker: SessionReadTracker,
  docMetaCache: DocMetaCache,
) {
  api.on("after_tool_call", async (event, ctx) => {
    if (event.error) return;

    // Lazy-start: the [plugins] subsystem may register hooks before service start
    await client.ensureStarted();
    if (!client.isHealthy()) return;

    const source = toolToSource(event.toolName);
    const sessionCollection = ctx.sessionId ? `ses_${ctx.sessionId}` : undefined;

    // File reads: index by path (fire-and-forget)
    if (isFileReadTool(event.toolName) && typeof event.params.path === "string") {
      const filePath = event.params.path;
      client.indexFileAsync({
        path: filePath,
        source,
        collection: sessionCollection,
      });

      // Try to populate doc-meta cache for tool_result_persist
      // This is async and best-effort
      client
        .getDocMeta(filePath)
        .then((meta) => {
          if (meta && ctx.sessionKey) {
            docMetaCache.set(filePath, meta);
            readTracker.trackRead(ctx.sessionKey, meta.doc_id);
          }
        })
        .catch(() => {});

      api.logger.debug?.(`mentat-bridge: indexed file read: ${filePath}`);
      return;
    }

    // Web fetches: re-fetch raw HTML and index it directly
    if (isWebFetchTool(event.toolName)) {
      const url = (event.params.url as string) || "";
      if (!url) return;

      // Fetch raw HTML ourselves — the tool result only has extracted markdown
      fetchRawHtml(url)
        .then((html) => {
          if (html && html.length > 200) {
            client.indexContentAsync({
              content: html,
              filename: urlToFilename(url),
              source: "web_fetch",
              collection: sessionCollection,
              content_type: "text/html",
            });
            api.logger.debug?.(`mentat-bridge: indexed web fetch (raw HTML): ${url}`);
          }
        })
        .catch(() => {});
      return;
    }

    // Composio tools: index content
    if (isComposioTool(event.toolName)) {
      const content = extractContentFromResult(event.result);
      if (content && content.length > 200) {
        client.indexContentAsync({
          content,
          filename: `${event.toolName}-${event.toolCallId ?? "unknown"}.md`,
          source,
          collection: sessionCollection,
        });
        api.logger.debug?.(`mentat-bridge: indexed composio result: ${event.toolName}`);
      }
    }
  });
}
