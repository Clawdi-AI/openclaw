import type { MentatBridgeConfig } from "../config.js";
import type { DocMetaCache } from "../session-state.js";
import { isFileReadTool, isWebFetchTool } from "../source-map.js";
import type { DocMeta } from "../types.js";

type PluginApi = {
  on: (
    hookName: string,
    handler: (
      event: ToolResultPersistEvent,
      ctx: ToolResultPersistContext,
    ) => ToolResultPersistResult | void,
  ) => void;
  logger: { info: (msg: string) => void; debug?: (msg: string) => void };
};

type AgentMessage = {
  role?: string;
  content?: unknown;
  [key: string]: unknown;
};

type ToolResultPersistEvent = {
  toolName?: string;
  toolCallId?: string;
  message: AgentMessage;
  isSynthetic?: boolean;
};

type ToolResultPersistContext = {
  agentId?: string;
  sessionKey?: string;
  toolName?: string;
  toolCallId?: string;
};

type ToolResultPersistResult = {
  message?: AgentMessage;
};

/** Rough token estimate: ~4 chars per token. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Extract text content from an AgentMessage. */
function extractTextFromMessage(message: AgentMessage): string | null {
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as Record<string, unknown>).type === "text" &&
        typeof (block as Record<string, unknown>).text === "string"
      ) {
        texts.push((block as Record<string, unknown>).text as string);
      }
    }
    return texts.length > 0 ? texts.join("\n") : null;
  }
  return null;
}

/** Extract file path from an AgentMessage's text content. */
function extractPathFromMessage(message: AgentMessage): string | null {
  const text = extractTextFromMessage(message);
  if (!text) return null;
  // Look for common file path patterns in tool results
  // The path is typically the first line or embedded in the content
  const pathMatch = text.match(/^(?:File: |Reading |Content of )?(\/.+?)(?:\n|$)/);
  return pathMatch?.[1] ?? null;
}

/** Build a compressed replacement for a large tool result. */
function compressToolResultMessage(message: AgentMessage, meta: DocMeta): AgentMessage {
  const parts: string[] = [`<mentat-indexed doc_id="${meta.doc_id}" filename="${meta.filename}">`];

  if (meta.brief_intro) {
    parts.push(`Brief: ${meta.brief_intro}`);
  }

  const toc = (meta.toc_entries ?? []).map((e) => e.title);
  if (toc.length > 0) {
    parts.push(`Sections: ${toc.join(", ")}`);
  }

  parts.push("Use read_segment(doc_id, section_name) to read specific sections.");
  parts.push("</mentat-indexed>");

  const compressedText = parts.join("\n");

  // Preserve message structure, replace content
  return {
    ...message,
    content: [{ type: "text", text: compressedText }],
  };
}

export function registerToolResultPersistHook(
  api: PluginApi,
  client: { isHealthy(): boolean },
  cfg: MentatBridgeConfig,
  docMetaCache: DocMetaCache,
) {
  // This hook is SYNCHRONOUS — cannot await any async operations.
  // Doc metadata must be pre-cached by after_tool_call.
  api.on("tool_result_persist", (event, _ctx) => {
    if (!client.isHealthy()) return;
    const toolName = event.toolName ?? "";
    if (!isFileReadTool(toolName) && !isWebFetchTool(toolName)) return;
    if (event.isSynthetic) return;

    const content = extractTextFromMessage(event.message);
    if (!content) return;

    const tokens = estimateTokens(content);
    if (tokens < cfg.compressThresholdTokens) return;

    // Try to find cached doc meta — keyed by file path (reads) or toolCallId (web fetch)
    let meta: DocMeta | undefined;
    if (isWebFetchTool(toolName) && event.toolCallId) {
      meta = docMetaCache.get(`__toolcall__:${event.toolCallId}`);
    } else {
      const filePath = extractPathFromMessage(event.message);
      meta = filePath ? docMetaCache.get(filePath) : undefined;
    }
    if (!meta) {
      api.logger.debug?.(
        `mentat-bridge: compress skipped (no cached meta) for ${toolName} (~${tokens} tokens)`,
      );
      return;
    }

    const compressed = compressToolResultMessage(event.message, meta);
    const compressedTokens = estimateTokens(
      typeof compressed.content === "string"
        ? compressed.content
        : JSON.stringify(compressed.content),
    );
    api.logger.info(
      `mentat-bridge: compressed ${toolName} result → ${meta.filename} (~${tokens} → ~${compressedTokens} tokens)`,
    );

    return { message: compressed };
  });
}
