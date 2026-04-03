import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MentatClient } from "../client.js";
import type {
  ActiveSessionTracker,
  ContinuationBriefStore,
  SessionReadTracker,
} from "../session-state.js";

type PluginApi = {
  on: (
    hookName: string,
    handler: (event: unknown, ctx: unknown) => unknown,
    opts?: { priority?: number },
  ) => void;
  logger: { info: (msg: string) => void; debug?: (msg: string) => void };
};

type SessionStartEvent = {
  sessionId: string;
  sessionKey?: string;
  resumedFrom?: string;
};

type SessionEndEvent = {
  sessionId: string;
  sessionKey?: string;
  messageCount: number;
  durationMs?: number;
};

type SubagentSpawningEvent = {
  childSessionKey: string;
  agentId: string;
  label?: string;
  mode: "run" | "session";
};

type SubagentContext = {
  runId?: string;
  childSessionKey?: string;
  requesterSessionKey?: string;
};

const CONTINUATION_BRIEF_LINES = 10;

/** Read the last N lines from an indexed session JSONL file. */
function readLastMessages(indexedDir: string, sessionId: string, lastN: number): string | null {
  const filePath = join(indexedDir, `${sessionId}.jsonl`);
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }

  const lines = content.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return null;

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
  return messages.length > 0 ? messages.join("\n\n") : null;
}

export function registerSessionLifecycleHooks(
  api: PluginApi,
  client: MentatClient,
  readTracker: SessionReadTracker,
  activeSessionTracker: ActiveSessionTracker,
  continuationStore: ContinuationBriefStore,
  indexedDir: string,
) {
  // session_start: create ephemeral session collection + track active session
  api.on("session_start", async (event, _ctx) => {
    const ev = event as SessionStartEvent;
    if (!ev.sessionId) return;

    // Track active session for chat history scope
    activeSessionTracker.set(ev.sessionId, ev.sessionKey);

    // Detect session reset: if resumedFrom is set, this session continues
    // a previous one (daily/idle reset). Read the previous session's last
    // messages and store as a continuation brief for before_prompt_build.
    if (ev.resumedFrom && ev.sessionKey) {
      const brief = readLastMessages(indexedDir, ev.resumedFrom, CONTINUATION_BRIEF_LINES);
      if (brief) {
        continuationStore.set(ev.sessionKey, brief, ev.resumedFrom);
        api.logger.info(
          `mentat-bridge: continuation brief stored for ${ev.sessionKey} (resumed from ${ev.resumedFrom.slice(0, 8)}…)`,
        );
      }
    }

    await client.ensureStarted();
    if (!client.isHealthy()) return;

    const collName = `ses_${ev.sessionId}`;
    await client.createCollection(collName, {
      metadata: {
        type: "session",
        ttl: 86400, // 24h
        sessionKey: ev.sessionKey,
      },
    });
    api.logger.debug?.(`mentat-bridge: created session collection ${collName}`);
  });

  // session_end: trigger GC and clean up read tracker
  api.on("session_end", async (event, _ctx) => {
    const ev = event as SessionEndEvent;

    // Clean up in-memory state
    activeSessionTracker.clear(ev.sessionKey);
    if (ev.sessionKey) {
      readTracker.clearSession(ev.sessionKey);
    }

    // Trigger async GC (fire-and-forget)
    if (client.isHealthy()) {
      client.triggerGc().catch(() => {});
    }

    api.logger.debug?.(`mentat-bridge: session ended (${ev.messageCount} messages)`);
  });

  // subagent_spawning: create child collection
  api.on("subagent_spawning", async (event, ctx) => {
    const ev = event as SubagentSpawningEvent;
    const subCtx = ctx as SubagentContext;

    await client.ensureStarted();
    if (!client.isHealthy()) {
      return { status: "ok" as const };
    }

    const childCollName = `ses_${ev.childSessionKey}`;
    await client.createCollection(childCollName, {
      metadata: {
        type: "session",
        ttl: 3600, // 1h for subagents
        parentSession: subCtx.requesterSessionKey,
        agentId: ev.agentId,
      },
    });

    api.logger.debug?.(
      `mentat-bridge: created subagent collection ${childCollName} (parent: ${subCtx.requesterSessionKey ?? "none"})`,
    );

    return { status: "ok" as const };
  });
}
