import { mkdtemp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MentatClient } from "../client.js";
import type { MentatBridgeConfig } from "../config.js";
import { buildCompressedSummary, estimateTokens } from "./util.js";

type PluginApi = {
  on: (
    hookName: string,
    handler: (event: MediaFileTransformEvent) => Promise<MediaFileTransformResult | undefined>,
  ) => void;
  logger: { debug?: (msg: string) => void };
};

type MediaFileTransformEvent = {
  filename: string;
  mime: string;
  content: string;
  rawBase64?: string;
  index: number;
};

type MediaFileTransformResult = {
  content?: string;
};

export function registerMediaFileTransformHook(
  api: PluginApi,
  client: MentatClient,
  cfg: MentatBridgeConfig,
) {
  api.on("media_file_transform", async (event) => {
    await client.ensureStarted();
    if (!client.isHealthy()) return undefined;

    // When raw file data is available, index the full file via indexFile
    // so mentat can parse the complete content (e.g. all PDF pages).
    if (event.rawBase64) {
      let tmpPath: string | undefined;
      try {
        const dir = await mkdtemp(join(tmpdir(), "mentat-media-"));
        tmpPath = join(dir, event.filename);
        await writeFile(tmpPath, Buffer.from(event.rawBase64, "base64"));

        const result = await client.indexFile({
          path: tmpPath,
          source: "channel:attachment",
        });
        if (!result?.doc_id) return undefined;

        const meta = await client.getDocMeta(result.doc_id);
        if (!meta) return undefined;

        const summary = buildCompressedSummary(meta, { tagStyle: "bracket" });
        api.logger.debug?.(
          `mentat-bridge: indexed full file ${event.filename} via indexFile (doc_id: ${meta.doc_id})`,
        );
        return { content: summary };
      } finally {
        if (tmpPath) {
          unlink(tmpPath).catch(() => {});
        }
      }
    }

    // Fallback: index extracted text content (for non-binary files or when rawBase64 absent)
    if (estimateTokens(event.content) < cfg.compressThresholdTokens) return undefined;

    const result = await client.indexContent({
      content: event.content,
      filename: event.filename,
      source: "channel:attachment",
      content_type: event.mime.startsWith("text/") ? event.mime : "text/plain",
    });

    if (!result?.doc_id) return undefined;

    const meta = await client.getDocMeta(result.doc_id);
    if (!meta) return undefined;

    const summary = buildCompressedSummary(meta, { tagStyle: "bracket" });
    api.logger.debug?.(
      `mentat-bridge: compressed channel attachment ${event.filename} (${estimateTokens(event.content)} → ~${estimateTokens(summary)} tokens)`,
    );
    return { content: summary };
  });
}
