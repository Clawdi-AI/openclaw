import type { MentatClient } from "../client.js";
import type { MentatBridgeConfig } from "../config.js";
import type { DocMetaCache, SessionReadTracker } from "../session-state.js";
import { isWebFetchTool, urlToFilename } from "../source-map.js";
import { buildCompressedSummary, estimateTokens } from "./util.js";

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
    handler: (
      event: TransformToolResultEvent,
      ctx: ToolContext,
    ) => Promise<TransformToolResultResult | void>,
  ) => void;
  logger: { info: (msg: string) => void; debug?: (msg: string) => void };
};

type ToolResultContent = { type: string; text: string }[];

type ToolResult = {
  content: ToolResultContent;
  details?: unknown;
};

type TransformToolResultEvent = {
  toolName: string;
  params: Record<string, unknown>;
  toolCallId?: string;
  result: ToolResult;
};

type ToolContext = {
  toolName: string;
  toolCallId?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
};

type TransformToolResultResult = {
  result?: ToolResult;
};

export function registerTransformToolResultHook(
  api: PluginApi,
  client: MentatClient,
  cfg: MentatBridgeConfig,
  readTracker: SessionReadTracker,
  docMetaCache: DocMetaCache,
) {
  api.logger.info(`mentat-bridge: transform_tool_result hook registered`);

  api.on("transform_tool_result", async (event, ctx) => {
    api.logger.info(
      `mentat-bridge: transform_tool_result fired for ${event.toolName} (healthy=${client.isHealthy()})`,
    );

    if (!isWebFetchTool(event.toolName)) return;
    if (!client.isHealthy()) return;

    const url = (event.params.url as string) || "";
    if (!url) {
      api.logger.info(`mentat-bridge: transform_tool_result skipped — no url`);
      return;
    }

    // For web fetches we always index — the raw HTML has far more content than
    // the extracted markdown returned by the tool, so token-based gating on the
    // tool result would almost always skip.  The compressThresholdTokens gate
    // remains for file reads in tool_result_persist.
    const resultText =
      event.result.content?.map((b) => (b.type === "text" ? b.text : "")).join("\n") ?? "";
    const tokens = estimateTokens(resultText);
    api.logger.info(`mentat-bridge: transform_tool_result web_fetch url=${url} tokens=${tokens}`);

    // Re-fetch raw HTML — the tool result only has extracted markdown
    const html = await fetchRawHtml(url);
    if (!html || html.length <= 50) return;

    const sessionCollection = ctx.sessionId ? `ses_${ctx.sessionId}` : undefined;
    const indexRes = await client.indexContent({
      content: html,
      filename: urlToFilename(url),
      source: "web_fetch",
      collection: sessionCollection,
      content_type: "text/html",
    });

    if (!indexRes?.doc_id) {
      api.logger.info(`mentat-bridge: web fetch indexing returned no doc_id for ${url}`);
      return;
    }

    api.logger.info(
      `mentat-bridge: indexed web fetch → ${urlToFilename(url)} (doc_id: ${indexRes.doc_id})`,
    );

    // Fetch doc meta for compressed summary
    let meta;
    try {
      meta = await client.getDocMeta(indexRes.doc_id);
    } catch (err) {
      api.logger.debug?.(`mentat-bridge: getDocMeta failed for ${indexRes.doc_id}: ${String(err)}`);
    }

    if (!meta) return;

    // Track read for hot context injection
    if (ctx.sessionKey) {
      readTracker.trackRead(ctx.sessionKey, meta.doc_id);
    }

    // Cache for any downstream hooks that may still reference it
    if (event.toolCallId) {
      docMetaCache.set(`__toolcall__:${event.toolCallId}`, meta);
    }

    // Build compressed replacement result
    const compressedText = buildCompressedSummary(meta);
    const compressedTokens = estimateTokens(compressedText);
    api.logger.info(
      `mentat-bridge: compressed ${event.toolName} result → ${meta.filename} (~${tokens} → ~${compressedTokens} tokens)`,
    );

    return {
      result: {
        content: [{ type: "text", text: compressedText }],
        details: event.result.details,
      },
    };
  });
}
