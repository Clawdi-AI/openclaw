import { homedir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/mentat-bridge";
import { registerMentatCli } from "./cli.js";
import { MentatClient } from "./client.js";
import { mentatBridgeConfigSchema } from "./config.js";
import { registerAfterToolCallHook } from "./hooks/after-tool-call.js";
import { registerAgentEndHook } from "./hooks/agent-end.js";
import { registerCompactionHooks } from "./hooks/compaction.js";
import { registerMediaFileTransformHook } from "./hooks/media-file-transform.js";
import { registerMessageReceivedHook } from "./hooks/message-received.js";
import { registerSessionLifecycleHooks } from "./hooks/session-lifecycle.js";
import { registerToolResultPersistHook } from "./hooks/tool-result-persist.js";
import {
  escapeMemoryForPrompt,
  fetchSkillPrompt,
  formatHotContext,
  formatRelevantMemoriesContext,
} from "./prompt.js";
import { DocMetaCache, SessionReadTracker } from "./session-state.js";
import { registerMentatTools } from "./tools.js";

async function ensureDefaultCollections(client: MentatClient) {
  // memory: auto-collect memory_store + memory file changes
  await client.createCollection("memory", {
    metadata: { type: "system", description: "Long-term memory" },
    watch_paths: [join(homedir(), ".openclaw", "memory")],
    auto_add_sources: ["openclaw:memory_store", "openclaw:memory", "openclaw:auto_capture"],
  });

  // files: auto-collect all agent file reads
  await client.createCollection("files", {
    metadata: { type: "system", description: "Agent-read files" },
    auto_add_sources: ["openclaw:*"],
  });
}

const mentatBridgePlugin = {
  id: "mentat-bridge",
  name: "Mentat Bridge",
  description: "Semantic RAG bridge — replaces memory-core and memory-lancedb with Mentat",
  kind: "memory" as const,
  configSchema: mentatBridgeConfigSchema,

  register(api: OpenClawPluginApi) {
    const cfg = mentatBridgeConfigSchema.parse(api.pluginConfig);
    if (!cfg.enabled) {
      api.logger.info("mentat-bridge: disabled by config");
      return;
    }

    const client = new MentatClient(cfg.mentatUrl, api.logger);
    const readTracker = new SessionReadTracker();
    const docMetaCache = new DocMetaCache();

    // ── Service lifecycle ──────────────────────────────────────────

    api.registerService({
      id: "mentat-bridge",
      async start() {
        await client.start();
        if (client.isHealthy()) {
          await ensureDefaultCollections(client);
          api.logger.info(`mentat-bridge: started (url: ${cfg.mentatUrl})`);
        } else {
          api.logger.warn(`mentat-bridge: started but server unreachable (url: ${cfg.mentatUrl})`);
        }
      },
      stop() {
        client.stop();
        api.logger.info("mentat-bridge: stopped");
      },
    });

    // ── Hook: before_prompt_build (priority 50) ────────────────────

    api.on(
      "before_prompt_build",
      async (event, ctx) => {
        if (!client.isHealthy()) return;

        // Static: Mentat two-step retrieval protocol instructions (cached by providers)
        const skillPrompt = await fetchSkillPrompt(client);

        // Dynamic: auto-recall relevant memories for current prompt
        let prependContext: string | undefined;

        if (cfg.autoRecall && event.prompt && event.prompt.length >= 5) {
          const results = await client.search({
            query: event.prompt,
            top_k: 3,
            collection: "memory",
          });
          if (results && results.length > 0) {
            prependContext = formatRelevantMemoriesContext(
              results.map((r) => ({
                text: r.content ?? r.summary ?? r.filename,
                source: r.source,
                score: r.score,
              })),
            );
          }
        }

        // Dynamic: hot context for previously read docs (especially after compaction)
        if (ctx.sessionKey && readTracker.hasReads(ctx.sessionKey)) {
          const docIds = readTracker.getReadDocIds(ctx.sessionKey);
          const hotDocs = [];
          for (const docId of docIds.slice(0, 10)) {
            const meta = await client.getDocMeta(docId);
            if (meta) hotDocs.push(meta);
          }
          if (hotDocs.length > 0) {
            const hotCtx = formatHotContext(hotDocs);
            prependContext = prependContext ? `${prependContext}\n\n${hotCtx}` : hotCtx;
          }
        }

        return {
          ...(skillPrompt ? { appendSystemContext: skillPrompt } : {}),
          ...(prependContext ? { prependContext } : {}),
        };
      },
      { priority: 50 },
    );

    // ── Tools (7 tools) ────────────────────────────────────────────

    registerMentatTools(api as Parameters<typeof registerMentatTools>[0], client, cfg);

    // ── CLI ─────────────────────────────────────────────────────────

    registerMentatCli(api as Parameters<typeof registerMentatCli>[0], client);

    // ── Hook: after_tool_call (auto-indexing) ──────────────────────

    if (cfg.autoIndex) {
      registerAfterToolCallHook(
        api as Parameters<typeof registerAfterToolCallHook>[0],
        client,
        readTracker,
        docMetaCache,
      );

      // ── Hook: message_received (channel attachment indexing) ────

      registerMessageReceivedHook(api as Parameters<typeof registerMessageReceivedHook>[0], client);
    }

    // ── Hook: tool_result_persist (token compression) ──────────────

    if (cfg.compressResults) {
      registerToolResultPersistHook(
        api as Parameters<typeof registerToolResultPersistHook>[0],
        client,
        cfg,
        docMetaCache,
      );

      // ── Hook: media_file_transform (channel attachment compression) ─

      registerMediaFileTransformHook(
        api as Parameters<typeof registerMediaFileTransformHook>[0],
        client,
        cfg,
      );
    }

    // ── Hook: agent_end (auto-capture) ─────────────────────────────

    if (cfg.autoCapture) {
      registerAgentEndHook(api as Parameters<typeof registerAgentEndHook>[0], client);
    }

    // ── Hook: compaction ───────────────────────────────────────────

    registerCompactionHooks(
      api as Parameters<typeof registerCompactionHooks>[0],
      client,
      readTracker,
    );

    // ── Hooks: session lifecycle ───────────────────────────────────

    registerSessionLifecycleHooks(
      api as Parameters<typeof registerSessionLifecycleHooks>[0],
      client,
      readTracker,
    );
  },
};

export default mentatBridgePlugin;

// Re-export for testing
export { escapeMemoryForPrompt, formatRelevantMemoriesContext } from "./prompt.js";
export { shouldCapture, looksLikePromptInjection } from "./prompt.js";
