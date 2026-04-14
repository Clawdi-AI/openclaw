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
  on: (hookName: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) => void;
  logger: { info?: (msg: string) => void; debug?: (msg: string) => void };
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
    const toolEvent = event as AfterToolCallEvent;
    const toolCtx = ctx as ToolContext;

    if (toolEvent.error) return;

    // Lazy-start: the [plugins] subsystem may register hooks before service start
    await client.ensureStarted?.();
    if (!client.isHealthy()) return;

    const source = toolToSource(toolEvent.toolName);
    const sessionCollection = toolCtx.sessionId ? `ses_${toolCtx.sessionId}` : undefined;

    // File reads: index by path (fire-and-forget)
    if (isFileReadTool(toolEvent.toolName) && typeof toolEvent.params.path === "string") {
      const filePath = toolEvent.params.path;
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
          if (meta && toolCtx.sessionKey) {
            docMetaCache.set(filePath, meta);
            readTracker.trackRead(toolCtx.sessionKey, meta.doc_id);
          }
        })
        .catch(() => {});

      api.logger.info?.(`mentat-bridge: indexed file read → ${filePath}`);
      return;
    }

    // Web fetches: handled by transform_tool_result hook (runs synchronously
    // within tool execution, before the result reaches the agent framework).
    // See hooks/transform-tool-result.ts.
    if (isWebFetchTool(toolEvent.toolName)) return;

    // Composio tools: index content with stable filename for dedup
    if (isComposioTool(toolEvent.toolName)) {
      const content = extractContentFromResult(toolEvent.result);
      if (content && content.length > 200) {
        client.indexContentAsync({
          content,
          filename: composioFilename(toolEvent.toolName, toolEvent.params, toolEvent.toolCallId),
          source,
          collection: sessionCollection,
        });
        api.logger.info?.(`mentat-bridge: indexed composio result → ${toolEvent.toolName}`);
      }
    }
  });
}
