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
import { registerTransformToolResultHook } from "./hooks/transform-tool-result.js";
import {
  escapeMemoryForPrompt,
  fetchSkillPrompt,
  formatHotContext,
  formatRelevantMemoriesContext,
} from "./prompt.js";
import { SessionCleaner } from "./session-cleaner.js";
import {
  ActiveSessionTracker,
  ContinuationBriefStore,
  DocMetaCache,
  SessionReadTracker,
} from "./session-state.js";
import { registerMentatTools } from "./tools.js";

async function ensureDefaultCollections(client: MentatClient, chatHistory: boolean) {
  // memory: auto-collect memory_store + memory file changes
  await client.createCollection("memory", {
    metadata: { type: "system", description: "Long-term memory" },
    watch_paths: [join(homedir(), ".openclaw", "workspace", "memory")],
    auto_add_sources: ["openclaw:memory_store", "openclaw:memory", "openclaw:auto_capture"],
  });

  // files: auto-collect all agent file reads
  await client.createCollection("files", {
    metadata: { type: "system", description: "Agent-read files" },
    auto_add_sources: ["openclaw:*"],
  });

  // chat_history: append-mode watch on pre-cleaned session JSONL files.
  // Raw sessions are cleaned by SessionCleaner into .indexed/ — Mentat
  // only sees simplified {"role","text","ts"} records, no filtering or
  // strip patterns needed on the Mentat side.
  if (chatHistory) {
    const indexedDir = join(homedir(), ".openclaw", "agents", "main", "sessions", ".indexed");
    await client.createCollection("chat_history", {
      metadata: {
        type: "system",
        description: "Agent chat history",
        watch_mode: "append",
        initial_scan_recent_days: 7,
        watch_probe_config: {
          text_fields: ["text"],
          label_field: "role",
          group_size: 2,
          timestamp_field: "ts",
        },
      },
      watch_paths: [indexedDir],
      watch_ignore: ["_offsets.json"],
    });
  }
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
    const activeSessionTracker = new ActiveSessionTracker();
    const sessionsDir = join(homedir(), ".openclaw", "agents", "main", "sessions");
    const continuationStore = new ContinuationBriefStore(join(sessionsDir, ".continuation"));
    const sessionCleaner = new SessionCleaner(sessionsDir, api.logger);

    // ── Service lifecycle ──────────────────────────────────────────

    api.registerService({
      id: "mentat-bridge",
      async start() {
        await client.start();
        if (client.isHealthy()) {
          await ensureDefaultCollections(client, cfg.chatHistory);
          if (cfg.chatHistory) {
            await sessionCleaner.start();
          }
          api.logger.info(`mentat-bridge: started (url: ${cfg.mentatUrl})`);
        } else {
          api.logger.warn(`mentat-bridge: started but server unreachable (url: ${cfg.mentatUrl})`);
        }
      },
      stop() {
        sessionCleaner.stop();
        client.stop();
        api.logger.info("mentat-bridge: stopped");
      },
    });

    // ── Hook: before_prompt_build (priority 50) ────────────────────

    api.on(
      "before_prompt_build",
      async (event, ctx) => {
        await client.ensureStarted();
        if (!client.isHealthy()) return;

        // Static: Mentat two-step retrieval protocol instructions (cached by providers)
        const skillPrompt = await fetchSkillPrompt(client);

        // Dynamic: session continuation context (injected once after reset)
        let prependContext: string | undefined;

        if (ctx.sessionKey && continuationStore.has(ctx.sessionKey)) {
          const continuation = continuationStore.consume(ctx.sessionKey);
          if (continuation) {
            prependContext = [
              "<session-continuation>",
              `This session continues a previous conversation (session ID: ${continuation.resumedFrom}) in this channel/thread that was reset.`,
              "Here are the last messages from the previous session for context:",
              "",
              continuation.brief,
              "",
              `Use \`search_chat_history\` and \`read_chat_history\` (session_id="${continuation.resumedFrom}") tools to look up more context from the previous session if needed.`,
              "</session-continuation>",
            ].join("\n");
            api.logger.info(`mentat-bridge: injected continuation context for ${ctx.sessionKey}`);
          }
        }

        // Dynamic: auto-recall relevant memories for current prompt

        if (cfg.autoRecall && event.prompt && event.prompt.length >= 5) {
          const results = await client.search({
            query: event.prompt,
            top_k: 3,
            collection: "memory",
          });
          if (results && results.length > 0) {
            const memoriesCtx = formatRelevantMemoriesContext(
              results.map((r) => ({
                text: r.content ?? r.summary ?? r.filename,
                source: r.source,
                score: r.score,
              })),
            );
            prependContext = prependContext ? `${prependContext}\n\n${memoriesCtx}` : memoriesCtx;
            api.logger.info(
              `mentat-bridge: auto-recall → ${results.length} memories (scores: ${results.map((r) => r.score.toFixed(2)).join(", ")})`,
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
            api.logger.info(
              `mentat-bridge: hot context → ${hotDocs.length} docs (${hotDocs.map((d) => d.filename).join(", ")})`,
            );
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

    const indexedDir = join(sessionsDir, ".indexed");

    registerMentatTools(
      api as Parameters<typeof registerMentatTools>[0],
      client,
      cfg,
      activeSessionTracker,
      indexedDir,
    );

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

    // ── Hook: transform_tool_result (mentat indexing + compression) ─

    if (cfg.autoIndex && cfg.compressResults) {
      registerTransformToolResultHook(
        api as Parameters<typeof registerTransformToolResultHook>[0],
        client,
        cfg,
        readTracker,
        docMetaCache,
      );
    }

    // ── Hook: tool_result_persist (token compression for file reads) ─

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
      activeSessionTracker,
      continuationStore,
      indexedDir,
    );
  },
};

export default mentatBridgePlugin;

// Re-export for testing
export { escapeMemoryForPrompt, formatRelevantMemoriesContext } from "./prompt.js";
export { shouldCapture, looksLikePromptInjection } from "./prompt.js";
