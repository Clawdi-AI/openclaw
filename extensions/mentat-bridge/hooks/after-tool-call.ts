import type { MentatClient } from "../client.js";
import type { DocMetaCache, SessionReadTracker } from "../session-state.js";
import {
  composioFilename,
  extractContentFromResult,
  isComposioTool,
  isFileReadTool,
  isWebFetchTool,
  toolToSource,
} from "../source-map.js";

type PluginApi = {
  on: (
    hookName: string,
    handler: (event: AfterToolCallEvent, ctx: ToolContext) => Promise<void> | void,
  ) => void;
  logger: { info: (msg: string) => void; debug?: (msg: string) => void };
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

      api.logger.info(`mentat-bridge: indexed file read → ${filePath}`);
      return;
    }

    // Web fetches: handled by transform_tool_result hook (runs synchronously
    // within tool execution, before the result reaches the agent framework).
    // See hooks/transform-tool-result.ts.
    if (isWebFetchTool(event.toolName)) return;

    // Composio tools: index content with stable filename for dedup
    if (isComposioTool(event.toolName)) {
      const content = extractContentFromResult(event.result);
      if (content && content.length > 200) {
        client.indexContentAsync({
          content,
          filename: composioFilename(event.toolName, event.params, event.toolCallId),
          source,
          collection: sessionCollection,
        });
        api.logger.info(`mentat-bridge: indexed composio result → ${event.toolName}`);
      }
    }
  });
}
