import type { MentatClient } from "../client.js";
import { looksLikePromptInjection, shouldCapture } from "../prompt.js";

type PluginApi = {
  on: (
    hookName: string,
    handler: (event: AgentEndEvent, ctx: AgentContext) => Promise<void> | void,
  ) => void;
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    debug?: (msg: string) => void;
  };
};

type AgentEndEvent = {
  success?: boolean;
  messages?: unknown[];
  runId?: string;
};

type AgentContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
};

const MAX_CAPTURES_PER_CONVERSATION = 3;

/** Extract text from user messages in a conversation. */
function extractUserTexts(messages: unknown[]): string[] {
  const texts: string[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const msgObj = msg as Record<string, unknown>;
    if (msgObj.role !== "user") continue;

    const content = msgObj.content;
    if (typeof content === "string") {
      texts.push(content);
      continue;
    }
    if (Array.isArray(content)) {
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
    }
  }
  return texts;
}

export function registerAgentEndHook(api: PluginApi, client: MentatClient) {
  api.on("agent_end", async (event, _ctx) => {
    if (!client.isHealthy()) return;
    if (!event.success || !event.messages || event.messages.length === 0) return;

    try {
      const texts = extractUserTexts(event.messages);
      const toCapture = texts.filter(
        (text) => shouldCapture(text) && !looksLikePromptInjection(text),
      );
      if (toCapture.length === 0) return;

      let stored = 0;
      for (const text of toCapture.slice(0, MAX_CAPTURES_PER_CONVERSATION)) {
        await client.indexContent({
          content: text,
          filename: `auto-capture-${Date.now()}.md`,
          source: "openclaw:auto_capture",
          collection: "memory",
        });
        stored++;
      }

      if (stored > 0) {
        api.logger.info(`mentat-bridge: auto-captured ${stored} memories`);
      }
    } catch (err) {
      api.logger.warn(`mentat-bridge: auto-capture failed: ${String(err)}`);
    }
  });
}
