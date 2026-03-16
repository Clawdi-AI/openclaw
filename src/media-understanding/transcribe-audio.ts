import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { mergeInboundPathRoots } from "../media/inbound-path-policy.js";
import { runAudioTranscription } from "./audio-transcription-runner.js";
import { resolveMediaAttachmentLocalRoots } from "./runner.js";

/**
 * Transcribe an audio file using the configured media-understanding provider.
 *
 * Reads provider/model/apiKey from `tools.media.audio` in the openclaw config,
 * falling back through configured models until one succeeds.
 *
 * This is the runtime-exposed entry point for external plugins (e.g. marmot)
 * that need STT without importing internal media-understanding modules directly.
 */
export async function transcribeAudioFile(params: {
  filePath: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  mime?: string;
}): Promise<{ text: string | undefined }> {
  const ctx = {
    MediaPath: params.filePath,
    MediaType: params.mime,
  };
  const { transcript } = await runAudioTranscription({
    ctx,
    cfg: params.cfg,
    agentDir: params.agentDir,
    // The caller already provided an explicit local file path; trust that
    // parent directory in addition to the standard inbound media roots.
    localPathRoots: mergeInboundPathRoots(
      [path.dirname(path.resolve(params.filePath))],
      resolveMediaAttachmentLocalRoots({
        cfg: params.cfg,
        ctx,
      }),
    ),
  });
  return { text: transcript };
}
