import type { MentatClient } from "../client.js";

type PluginApi = {
  on: (
    hookName: string,
    handler: (event: MessageReceivedEvent, ctx: MessageContext) => Promise<void> | void,
  ) => void;
  logger: { debug?: (msg: string) => void };
};

type MessageReceivedEvent = {
  from: string;
  content: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
};

type MessageContext = {
  channelId: string;
  accountId?: string;
  conversationId?: string;
};

/** Match <file name="..." mime="...">content</file> blocks injected by media pipeline. */
const FILE_BLOCK_RE = /<file\s+name="([^"]+)"\s+mime="([^"]+)">\n?([\s\S]*?)\n?<\/file>/g;

/** Content too short or placeholder — not worth indexing. */
const SKIP_PATTERNS = [/^\[No extractable text\]$/, /^\[PDF content rendered to images/];

type ExtractedFileBlock = {
  name: string;
  mime: string;
  content: string;
};

function extractFileBlocks(body: string): ExtractedFileBlock[] {
  const blocks: ExtractedFileBlock[] = [];
  for (const match of body.matchAll(FILE_BLOCK_RE)) {
    const [, name, mime, content] = match;
    if (!content || content.length < 100) continue;
    if (SKIP_PATTERNS.some((p) => p.test(content))) continue;
    blocks.push({ name, mime, content });
  }
  return blocks;
}

/** Map MIME type to Mentat content_type hint. */
function mimeToContentType(mime: string): string {
  if (mime.includes("json")) return "application/json";
  if (mime.includes("html") || mime.includes("xml")) return "text/html";
  if (mime.includes("csv") || mime.includes("tab-separated")) return "text/csv";
  if (mime.includes("markdown")) return "text/markdown";
  return "text/plain";
}

export function registerMessageReceivedHook(api: PluginApi, client: MentatClient) {
  api.on("message_received", async (event, ctx) => {
    if (!client.isHealthy()) return;
    if (!event.content || event.content.length < 50) return;

    const blocks = extractFileBlocks(event.content);
    if (blocks.length === 0) return;

    const source = `channel:${ctx.channelId}`;

    for (const block of blocks) {
      client.indexContentAsync({
        content: block.content,
        filename: block.name,
        source,
        content_type: mimeToContentType(block.mime),
      });
      api.logger.debug?.(
        `mentat-bridge: indexed channel attachment: ${block.name} (${block.mime}) from ${ctx.channelId}`,
      );
    }
  });
}
