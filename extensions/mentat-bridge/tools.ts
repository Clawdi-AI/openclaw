import { readFileSync, statSync } from "node:fs";
import { Type } from "@sinclair/typebox";
import type { MentatClient } from "./client.js";
import type { MentatBridgeConfig } from "./config.js";
import { summarizeDiscordMessages, type DiscrawlDiscordHistoryBridge } from "./discord-history.js";
import type { ActiveSessionTracker } from "./session-state.js";

type PluginApi = {
  registerTool: (tool: unknown, opts?: { name?: string }) => void;
  logger: { info: (msg: string) => void; warn: (msg: string) => void };
};

function unhealthyResult(toolName: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: `Mentat server is not available. ${toolName} is temporarily unavailable.`,
      },
    ],
    details: { error: "mentat_unavailable" },
  };
}

export function registerMentatTools(
  api: PluginApi,
  client: MentatClient,
  _cfg: MentatBridgeConfig,
  activeSessionTracker: ActiveSessionTracker,
  indexedDir: string,
  discordHistory?: DiscrawlDiscordHistoryBridge,
) {
  // 1. search_memory — unified search (replaces memory_recall + memory_search + memory_get)
  api.registerTool(
    {
      name: "search_memory",
      label: "Search Memory",
      description:
        "Search indexed documents and memories. With toc_only=true, returns doc_ids and section names for two-step retrieval. Without toc_only, returns full content like standard RAG. Use grouped=true to group results by document.",
      parameters: Type.Object({
        query: Type.String({ description: "Natural language search query" }),
        top_k: Type.Optional(Type.Number({ description: "Maximum results (default: 5)" })),
        toc_only: Type.Optional(
          Type.Boolean({
            description: "Return only doc_ids and section names (two-step protocol step 1)",
          }),
        ),
        grouped: Type.Optional(
          Type.Boolean({ description: "Group results by document (each doc appears once)" }),
        ),
        hybrid: Type.Optional(
          Type.Boolean({ description: "Combine vector + keyword matching for better recall" }),
        ),
        collection: Type.Optional(Type.String({ description: "Collection name to scope search" })),
        source: Type.Optional(
          Type.String({ description: "Filter by source (e.g. 'web_fetch', 'composio:gmail')" }),
        ),
      }),
      async execute(
        _toolCallId: string,
        params: {
          query: string;
          top_k?: number;
          toc_only?: boolean;
          grouped?: boolean;
          hybrid?: boolean;
          collection?: string;
          source?: string;
        },
      ) {
        if (!client.isHealthy()) return unhealthyResult("search_memory");

        const { grouped, ...searchParams } = params;

        if (grouped) {
          const results = await client.searchGrouped(searchParams);
          if (!results || results.length === 0) {
            return {
              content: [{ type: "text" as const, text: "No results found." }],
              details: { count: 0 },
            };
          }
          const text = results
            .map((doc) => {
              const intro = doc.brief_intro ? `\n  ${doc.brief_intro}` : "";
              const chunks = doc.chunks
                .map((c) => `  - [${c.section}] ${c.content?.slice(0, 200) ?? c.summary ?? ""}`)
                .join("\n");
              return `📄 ${doc.filename} (${doc.doc_id})${intro}\n${chunks}`;
            })
            .join("\n\n");
          return {
            content: [{ type: "text" as const, text }],
            details: { count: results.length, results },
          };
        }

        const results = await client.search(searchParams);
        if (!results || results.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No results found." }],
            details: { count: 0 },
          };
        }

        const text = results
          .map((r, i) => {
            if (params.toc_only) {
              return `${i + 1}. [${r.doc_id}] ${r.filename} — ${r.section ?? "full doc"}`;
            }
            const snippet = r.content ?? r.summary ?? "";
            return `${i + 1}. [${r.doc_id}] ${r.filename}${r.section ? ` > ${r.section}` : ""}\n   ${snippet}`;
          })
          .join("\n");

        return {
          content: [{ type: "text" as const, text: `Found ${results.length} results:\n\n${text}` }],
          details: { count: results.length, results },
        };
      },
    },
    { name: "search_memory" },
  );

  // 2. memory_store — store text in memory (replaces memory-lancedb memory_store)
  api.registerTool(
    {
      name: "memory_store",
      label: "Memory Store",
      description:
        "Save important information in long-term memory. Use for preferences, facts, decisions, or anything the user wants to remember.",
      parameters: Type.Object({
        text: Type.String({ description: "Information to remember" }),
        filename: Type.Optional(
          Type.String({ description: "Logical filename (default: auto-generated)" }),
        ),
        collection: Type.Optional(
          Type.String({ description: "Collection to store in (default: 'memory')" }),
        ),
      }),
      async execute(
        _toolCallId: string,
        params: { text: string; filename?: string; collection?: string },
      ) {
        if (!client.isHealthy()) return unhealthyResult("memory_store");

        const filename = params.filename ?? `memory-${Date.now()}.md`;
        const result = await client.indexContent({
          content: params.text,
          filename,
          source: "openclaw:memory_store",
          collection: params.collection ?? "memory",
        });

        if (!result) {
          return {
            content: [{ type: "text" as const, text: "Failed to store memory." }],
            details: { error: "store_failed" },
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Stored: "${params.text.slice(0, 100)}${params.text.length > 100 ? "..." : ""}"`,
            },
          ],
          details: { action: "created", doc_id: result.doc_id },
        };
      },
    },
    { name: "memory_store" },
  );

  // 3. memory_forget — remove a document from all collections
  api.registerTool(
    {
      name: "memory_forget",
      label: "Memory Forget",
      description:
        "Remove a memory or document from the memory system. Provide either a doc_id (from search results) or a query to find and remove.",
      parameters: Type.Object({
        doc_id: Type.Optional(Type.String({ description: "Document ID to forget" })),
        query: Type.Optional(Type.String({ description: "Search query to find memory to forget" })),
      }),
      async execute(_toolCallId: string, params: { doc_id?: string; query?: string }) {
        if (!client.isHealthy()) return unhealthyResult("memory_forget");

        if (params.doc_id) {
          const ok = await client.removeDocFromCollections(params.doc_id);
          return ok
            ? {
                content: [{ type: "text" as const, text: `Forgotten: document ${params.doc_id}` }],
                details: { action: "deleted", doc_id: params.doc_id },
              }
            : {
                content: [{ type: "text" as const, text: "Failed to forget document." }],
                details: { error: "forget_failed" },
              };
        }

        if (params.query) {
          const results = await client.search({ query: params.query, top_k: 5 });
          if (!results || results.length === 0) {
            return {
              content: [{ type: "text" as const, text: "No matching memories found." }],
              details: { found: 0 },
            };
          }

          // If there's a single high-confidence match, auto-delete
          if (results.length === 1 || (results[0].score > 0.9 && results.length > 0)) {
            const target = results[0];
            const ok = await client.removeDocFromCollections(target.doc_id);
            return ok
              ? {
                  content: [
                    {
                      type: "text" as const,
                      text: `Forgotten: "${target.filename}" (${target.doc_id})`,
                    },
                  ],
                  details: { action: "deleted", doc_id: target.doc_id },
                }
              : {
                  content: [{ type: "text" as const, text: "Failed to forget document." }],
                  details: { error: "forget_failed" },
                };
          }

          const list = results
            .map(
              (r) =>
                `- [${r.doc_id.slice(0, 12)}] ${r.filename} — ${r.content?.slice(0, 60) ?? ""}`,
            )
            .join("\n");
          return {
            content: [
              {
                type: "text" as const,
                text: `Found ${results.length} candidates. Specify doc_id:\n${list}`,
              },
            ],
            details: {
              action: "candidates",
              candidates: results.map((r) => ({
                doc_id: r.doc_id,
                filename: r.filename,
                score: r.score,
              })),
            },
          };
        }

        return {
          content: [{ type: "text" as const, text: "Provide doc_id or query." }],
          details: { error: "missing_param" },
        };
      },
    },
    { name: "memory_forget" },
  );

  // 4. get_doc_meta — inspect document structure
  api.registerTool(
    {
      name: "get_doc_meta",
      label: "Get Document Meta",
      description:
        "Get a document's metadata: brief intro, table of contents, instructions, and status. Use after search to understand document structure (two-step protocol step 1b).",
      parameters: Type.Object({
        doc_id: Type.String({ description: "Document ID from search results" }),
      }),
      async execute(_toolCallId: string, params: { doc_id: string }) {
        if (!client.isHealthy()) return unhealthyResult("get_doc_meta");

        const meta = await client.getDocMeta(params.doc_id);
        if (!meta) {
          return {
            content: [{ type: "text" as const, text: `Document ${params.doc_id} not found.` }],
            details: { error: "not_found" },
          };
        }

        const parts: string[] = [`Document: ${meta.filename} (${meta.doc_id})`];
        if (meta.brief_intro) parts.push(`\nBrief: ${meta.brief_intro}`);
        const toc = (meta.toc_entries ?? []).map((e) => e.title);
        if (toc.length > 0) {
          parts.push(`\nSections:\n${toc.map((s) => `  - ${s}`).join("\n")}`);
        }
        if (meta.instructions) parts.push(`\nInstructions: ${meta.instructions}`);
        if (meta.processing_status) parts.push(`\nStatus: ${meta.processing_status}`);

        return {
          content: [{ type: "text" as const, text: parts.join("") }],
          details: meta,
        };
      },
    },
    { name: "get_doc_meta" },
  );

  // 5. read_segment — read a specific section from a document
  api.registerTool(
    {
      name: "read_segment",
      label: "Read Segment",
      description:
        "Read a specific section from an indexed document (two-step protocol step 2). Use section names from get_doc_meta's ToC. Parent sections include child content.",
      parameters: Type.Object({
        doc_id: Type.String({ description: "Document ID" }),
        section_path: Type.String({ description: "Section name from ToC (case-insensitive)" }),
        include_summary: Type.Optional(
          Type.Boolean({
            description: "Include chunk summaries alongside content (default: true)",
          }),
        ),
      }),
      async execute(
        _toolCallId: string,
        params: { doc_id: string; section_path: string; include_summary?: boolean },
      ) {
        if (!client.isHealthy()) return unhealthyResult("read_segment");

        const segment = await client.readSegment({
          doc_id: params.doc_id,
          section_path: params.section_path,
          include_summary: params.include_summary,
        });

        if (!segment) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Section "${params.section_path}" not found in document ${params.doc_id}.`,
              },
            ],
            details: { error: "not_found" },
          };
        }

        // Build text from chunks + toc_context
        const parts: string[] = [];
        if (segment.toc_context && segment.toc_context.length > 0) {
          for (const entry of segment.toc_context) {
            parts.push(`${"#".repeat(entry.level)} ${entry.title}`);
            if (entry.preview) parts.push(entry.preview);
          }
        }
        for (const chunk of segment.chunks) {
          if (chunk.summary) parts.push(`Summary: ${chunk.summary}`);
          if (chunk.content) parts.push(chunk.content);
        }
        if (segment.note) parts.push(`\n_${segment.note}_`);

        const text = parts.join("\n\n") || `No content for section "${params.section_path}".`;

        return {
          content: [{ type: "text" as const, text }],
          details: segment,
        };
      },
    },
    { name: "read_segment" },
  );

  // 6. index_file — explicitly index a file or content
  api.registerTool(
    {
      name: "index_file",
      label: "Index File",
      description:
        "Index a file or raw content into the memory system. Processing happens in the background; use memory_status to check progress.",
      parameters: Type.Object({
        path: Type.Optional(Type.String({ description: "File path to index" })),
        content: Type.Optional(
          Type.String({ description: "Raw text content (use with filename)" }),
        ),
        filename: Type.Optional(
          Type.String({ description: "Filename for content (required with content)" }),
        ),
        content_type: Type.Optional(
          Type.String({ description: "MIME type hint (e.g. 'text/markdown')" }),
        ),
        collection: Type.Optional(Type.String({ description: "Collection to add to" })),
        source: Type.Optional(Type.String({ description: "Source tag for provenance" })),
      }),
      async execute(
        _toolCallId: string,
        params: {
          path?: string;
          content?: string;
          filename?: string;
          content_type?: string;
          collection?: string;
          source?: string;
        },
      ) {
        if (!client.isHealthy()) return unhealthyResult("index_file");

        if (params.path) {
          const result = await client.indexFile({
            path: params.path,
            source: params.source ?? "openclaw:index_file",
            collection: params.collection,
          });
          if (!result) {
            return {
              content: [{ type: "text" as const, text: "Failed to index file." }],
              details: { error: "index_failed" },
            };
          }
          return {
            content: [
              {
                type: "text" as const,
                text: `Indexed: ${result.filename} (${result.doc_id}) — status: ${result.status}`,
              },
            ],
            details: result,
          };
        }

        if (params.content && params.filename) {
          const result = await client.indexContent({
            content: params.content,
            filename: params.filename,
            content_type: params.content_type,
            source: params.source ?? "openclaw:index_file",
            collection: params.collection,
          });
          if (!result) {
            return {
              content: [{ type: "text" as const, text: "Failed to index content." }],
              details: { error: "index_failed" },
            };
          }
          return {
            content: [
              {
                type: "text" as const,
                text: `Indexed: ${result.filename} (${result.doc_id}) — status: ${result.status}`,
              },
            ],
            details: result,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: "Provide either 'path' or both 'content' and 'filename'.",
            },
          ],
          details: { error: "missing_param" },
        };
      },
    },
    { name: "index_file" },
  );

  // 7. memory_status — check processing status
  api.registerTool(
    {
      name: "memory_status",
      label: "Memory Status",
      description: "Check the processing status of an indexed document.",
      parameters: Type.Object({
        doc_id: Type.String({ description: "Document ID to check" }),
      }),
      async execute(_toolCallId: string, params: { doc_id: string }) {
        if (!client.isHealthy()) return unhealthyResult("memory_status");

        const status = await client.getStatus(params.doc_id);
        if (!status) {
          return {
            content: [{ type: "text" as const, text: `Status unavailable for ${params.doc_id}.` }],
            details: { error: "not_found" },
          };
        }

        let text = `Document ${status.doc_id}: ${status.status}`;
        if (status.progress != null) text += ` (${Math.round(status.progress * 100)}%)`;
        if (status.error) text += ` — error: ${status.error}`;

        return {
          content: [{ type: "text" as const, text }],
          details: status,
        };
      },
    },
    { name: "memory_status" },
  );

  // 8. search_chat_history — search past conversations
  // Registered as a tool factory so each agent run receives its own ctx.sessionId,
  // avoiding the singleton ActiveSessionTracker which breaks with concurrent sessions.
  api.registerTool(
    (ctx: { sessionId?: string }) => ({
      name: "search_chat_history",
      label: "Search Chat History",
      description:
        "Search past conversations from other sessions (current session is excluded since it is already in context). Returns doc_ids — use get_doc_meta / read_segment for full content.",
      parameters: Type.Object({
        query: Type.String({ description: "Natural language search query" }),
        top_k: Type.Optional(Type.Number({ description: "Maximum results (default: 5)" })),
      }),
      async execute(_toolCallId: string, params: { query: string; top_k?: number }) {
        if (!client.isHealthy()) return unhealthyResult("search_chat_history");

        const topK = params.top_k ?? 5;
        // Prefer per-run ctx.sessionId (accurate for concurrent sessions);
        // fall back to singleton tracker for backward compat.
        const currentSessionId = ctx.sessionId ?? activeSessionTracker.get();

        api.logger.info(
          `search_chat_history: currentSessionId=${currentSessionId ?? "NULL"} (ctx=${ctx.sessionId ?? "NULL"}, tracker=${activeSessionTracker.get() ?? "NULL"}), query="${params.query.slice(0, 50)}"`,
        );

        const searchReq: {
          query: string;
          top_k: number;
          collection: string;
          hybrid: boolean;
          metadata_filter?: Record<string, unknown>;
        } = {
          query: params.query,
          top_k: topK,
          collection: "chat_history",
          hybrid: true,
        };

        // Exclude current session — it's already in the LLM context
        if (currentSessionId) {
          searchReq.metadata_filter = {
            session_id: { op: "neq", value: currentSessionId },
          };
        } else {
          api.logger.warn(
            "search_chat_history: no active session ID — cannot exclude current session!",
          );
        }

        api.logger.info(`search_chat_history: searchReq=${JSON.stringify(searchReq)}`);

        const rawResults = await client.search(searchReq);
        if (!rawResults || rawResults.length === 0) {
          return {
            content: [
              { type: "text" as const, text: "No matching conversations found in past sessions." },
            ],
            details: { count: 0 },
          };
        }

        // Filter out low-relevance results.  With hybrid search the best
        // hits have score ≈ 0; pure-vector scores use cosine distance (0–2).
        // A threshold of 1.5 drops clearly irrelevant noise while keeping
        // borderline matches for the LLM to judge.
        const SCORE_THRESHOLD = 1.5;
        const results = rawResults.filter((r) => r.score <= SCORE_THRESHOLD);

        if (results.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No matching conversations found in past sessions (results below relevance threshold).",
              },
            ],
            details: { count: 0 },
          };
        }

        // Log result session_ids for debugging exclusion
        const resultSessionIds = results.map(
          (r) => r.session_id ?? r.metadata?.session_id ?? "no-session-id",
        );
        api.logger.info(
          `search_chat_history: ${rawResults.length} raw → ${results.length} after threshold, session_ids=${JSON.stringify(resultSessionIds)}, currentSessionId=${currentSessionId ?? "NULL"}`,
        );

        const text = results
          .map((r, i) => {
            // Extract session ID from filename like "abc-123.jsonl@4581"
            const fnMatch = r.filename?.match(/^([^.]+)\.jsonl@?(\d*)$/);
            const sessionId = fnMatch?.[1] ?? r.filename ?? "unknown";
            const shortSession = sessionId.slice(0, 8);
            const snippet = r.content ?? r.summary ?? "";
            return `${i + 1}. session:${shortSession}… (doc: ${r.doc_id.slice(0, 12)}) [score: ${r.score.toFixed(4)}]\n${snippet}`;
          })
          .join("\n\n");

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${results.length} conversation(s) from past sessions:\n\n${text}`,
            },
          ],
          details: { count: results.length, results },
        };
      },
    }),
    { name: "search_chat_history" },
  );

  // 9. read_chat_history — read raw messages from a past session
  api.registerTool(
    {
      name: "read_chat_history",
      label: "Read Chat History",
      description:
        "Read messages from a past session's chat history. Returns the last N messages (user + assistant) in chronological order. Use search_chat_history first to find relevant session IDs.",
      parameters: Type.Object({
        session_id: Type.String({
          description:
            "Session ID (from search_chat_history results, e.g. '61d0ad51-2b14-4796-8238-5f6f7dfcfbb7')",
        }),
        last_n: Type.Optional(
          Type.Number({
            description: "Number of recent messages to return (default: 50, max: 200)",
          }),
        ),
      }),
      async execute(_toolCallId: string, params: { session_id: string; last_n?: number }) {
        const lastN = Math.min(Math.max(params.last_n ?? 50, 1), 200);
        const filePath = `${indexedDir}/${params.session_id}.jsonl`;

        let content: string;
        try {
          const stat = statSync(filePath);
          if (!stat.isFile()) {
            return {
              content: [{ type: "text" as const, text: `Session ${params.session_id} not found.` }],
              details: { error: "not_found" },
            };
          }
          content = readFileSync(filePath, "utf-8");
        } catch {
          return {
            content: [{ type: "text" as const, text: `Session ${params.session_id} not found.` }],
            details: { error: "not_found" },
          };
        }

        const lines = content.split("\n").filter((l) => l.trim());
        const total = lines.length;
        const selected = lines.slice(-lastN);

        const messages: string[] = [];
        for (const line of selected) {
          try {
            const rec = JSON.parse(line) as { role: string; text: string; ts: string };
            const time = rec.ts ? new Date(rec.ts).toLocaleString() : "";
            messages.push(`[${rec.role}] ${time}\n${rec.text}`);
          } catch {
            // skip malformed lines
          }
        }

        if (messages.length === 0) {
          return {
            content: [
              { type: "text" as const, text: `Session ${params.session_id} has no messages.` },
            ],
            details: { total: 0 },
          };
        }

        const header =
          selected.length < total
            ? `Showing last ${selected.length} of ${total} messages:`
            : `All ${total} messages:`;

        return {
          content: [{ type: "text" as const, text: `${header}\n\n${messages.join("\n\n")}` }],
          details: { total, returned: selected.length },
        };
      },
    },
    { name: "read_chat_history" },
  );

  // 10. search_discord_history — search discrawl-backed Discord archive
  api.registerTool(
    {
      name: "search_discord_history",
      label: "Search Discord History",
      description:
        "Search the connected Discord server history mirrored by discrawl and indexed into Mentat. This covers overall guild chat history, not just the current agent session.",
      parameters: Type.Object({
        query: Type.String({ description: "Natural language search query" }),
        top_k: Type.Optional(Type.Number({ description: "Maximum results (default: 5)" })),
        channel: Type.Optional(
          Type.String({
            description:
              "Optional channel name/id hint; applied as a lightweight post-filter on search results",
          }),
        ),
      }),
      async execute(
        _toolCallId: string,
        params: { query: string; top_k?: number; channel?: string },
      ) {
        if (!discordHistory?.isAvailable()) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  discordHistory?.describeAvailability() ??
                  "Discord history archive is not configured.",
              },
            ],
            details: { error: "discord_history_unavailable" },
          };
        }
        if (!client.isHealthy()) return unhealthyResult("search_discord_history");

        const channelHint = params.channel?.trim().toLowerCase();
        const rawResults = await client.search({
          query: params.query,
          top_k: Math.max(params.top_k ?? 5, 1),
          collection: discordHistory.collectionName,
          hybrid: true,
        });
        if (!rawResults || rawResults.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No matching Discord history found." }],
            details: { count: 0 },
          };
        }

        const filtered = channelHint
          ? rawResults.filter((result) => {
              const haystack =
                `${result.filename ?? ""}\n${result.content ?? ""}\n${result.summary ?? ""}`.toLowerCase();
              return haystack.includes(channelHint);
            })
          : rawResults;

        if (filtered.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No Discord history matched channel hint "${params.channel}".`,
              },
            ],
            details: { count: 0 },
          };
        }

        const text = filtered
          .map((result, index) => {
            const snippet = result.content ?? result.summary ?? "";
            return `${index + 1}. ${result.filename} [score: ${result.score.toFixed(4)}]\n${snippet}`;
          })
          .join("\n\n");

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${filtered.length} Discord history result(s):\n\n${text}`,
            },
          ],
          details: { count: filtered.length, results: filtered },
        };
      },
    },
    { name: "search_discord_history" },
  );

  // 11. read_discord_history — read exact messages from discrawl SQLite
  api.registerTool(
    {
      name: "read_discord_history",
      label: "Read Discord History",
      description:
        "Read exact messages from the discrawl Discord archive by channel, author, or recent time window. Useful after search_discord_history when you need raw surrounding chat.",
      parameters: Type.Object({
        channel: Type.Optional(
          Type.String({
            description: "Channel id or name (for example 'test' or '1489512128640585728')",
          }),
        ),
        author: Type.Optional(
          Type.String({ description: "Optional author id or display name filter" }),
        ),
        last_n: Type.Optional(
          Type.Number({ description: "Number of messages to return (default: 50, max: 200)" }),
        ),
        since: Type.Optional(
          Type.String({ description: "RFC3339 timestamp lower bound, e.g. 2026-04-01T00:00:00Z" }),
        ),
        hours: Type.Optional(
          Type.Number({ description: "Shortcut for messages from the last N hours" }),
        ),
        days: Type.Optional(
          Type.Number({ description: "Shortcut for messages from the last N days" }),
        ),
      }),
      async execute(
        _toolCallId: string,
        params: {
          channel?: string;
          author?: string;
          last_n?: number;
          since?: string;
          hours?: number;
          days?: number;
        },
      ) {
        if (!discordHistory) {
          return {
            content: [
              { type: "text" as const, text: "Discord history archive is not configured." },
            ],
            details: { error: "discord_history_unavailable" },
          };
        }

        const result = await discordHistory.readHistory(params);
        if (!result.available) {
          return {
            content: [
              { type: "text" as const, text: result.error ?? "Discord history is unavailable." },
            ],
            details: { error: "discord_history_unavailable" },
          };
        }
        if (!result.messages || result.messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "No Discord messages matched that request." }],
            details: { count: 0 },
          };
        }

        return {
          content: [{ type: "text" as const, text: summarizeDiscordMessages(result.messages) }],
          details: {
            count: result.messages.length,
            total: result.total,
            messages: result.messages,
          },
        };
      },
    },
    { name: "read_discord_history" },
  );

  // 12. read_wiki_link — resolve a Mentat wiki URL and read its content
  api.registerTool(
    {
      name: "read_wiki_link",
      label: "Read Wiki Link",
      description:
        "Read content from a Mentat wiki URL the user pasted. Resolves the URL to the indexed source document and (optionally) the specific section, then returns the content. Accepts full URLs (http://localhost:7832/wiki/pages/<id>#section), path-only (/wiki/pages/<id>#section), or short form (<id>#section).",
      parameters: Type.Object({
        url: Type.String({ description: "Wiki URL or page id (with optional #section anchor)" }),
      }),
      async execute(_toolCallId: string, params: { url: string }) {
        if (!client.isHealthy()) return unhealthyResult("read_wiki_link");

        const resolved = await client.resolveWikiUrl(params.url);
        if (!resolved) {
          const wikiText = await client.fetchWikiText(params.url);
          if (wikiText) {
            return {
              content: [{ type: "text" as const, text: wikiText }],
              details: { mode: "wiki_html_fallback", url: params.url },
            };
          }
          return {
            content: [
              {
                type: "text" as const,
                text: `Could not resolve wiki URL: ${params.url}`,
              },
            ],
            details: { error: "resolve_failed" },
          };
        }

        // If no section, fall back to doc meta + brief overview
        if (!resolved.section_path) {
          const meta = await client.getDocMeta(resolved.doc_id);
          if (!meta) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Resolved to ${resolved.filename} (${resolved.doc_id}) but document metadata is unavailable.`,
                },
              ],
              details: { resolved },
            };
          }
          const tocList = (meta.toc_entries ?? []).map((e) => `  - ${e.title}`).join("\n");
          const text = `Wiki page: ${meta.filename} (${resolved.doc_id})\n\n${meta.brief_intro ?? ""}\n\nSections:\n${tocList || "  (none)"}\n\nUse \`read_segment\` with a section name to read content.`;
          return {
            content: [{ type: "text" as const, text }],
            details: { resolved, meta },
          };
        }

        // Section specified — read it directly
        const segment = await client.readSegment({
          doc_id: resolved.doc_id,
          section_path: resolved.section_path,
        });

        if (!segment) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Resolved to ${resolved.filename} > ${resolved.section_path}, but section read failed.`,
              },
            ],
            details: { resolved, error: "read_segment_failed" },
          };
        }

        const parts: string[] = [`Wiki: ${resolved.filename} > ${resolved.section_path}`, ""];
        for (const chunk of segment.chunks) {
          if (chunk.content) parts.push(chunk.content);
        }
        if (segment.note) parts.push(`\n_${segment.note}_`);

        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
          details: { resolved, segment },
        };
      },
    },
    { name: "read_wiki_link" },
  );
}
