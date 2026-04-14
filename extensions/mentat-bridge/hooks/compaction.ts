import type { MentatClient } from "../client.js";
import type { SessionReadTracker } from "../session-state.js";

type PluginApi = {
  on: (hookName: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) => void;
  logger: { info?: (msg: string) => void; debug?: (msg: string) => void };
};

type AgentContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
};

export function registerCompactionHooks(
  api: PluginApi,
  _client: MentatClient,
  readTracker: SessionReadTracker,
) {
  api.on("before_compaction", async (_event, ctx) => {
    const agentCtx = ctx as AgentContext;
    if (!agentCtx.sessionKey) return;
    const docIds = readTracker.getReadDocIds(agentCtx.sessionKey);
    if (docIds.length > 0) {
      api.logger.info?.(
        `mentat-bridge: before_compaction — ${docIds.length} docs tracked for session ${agentCtx.sessionKey}`,
      );
    }
    // Hot-context re-injection happens in before_prompt_build (which runs after compaction too).
    // No additional action needed here — the read tracker preserves state across compaction.
  });
}
