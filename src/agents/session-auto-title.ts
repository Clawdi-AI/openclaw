import type { OpenClawConfig } from "../config/config.js";
import { callGateway } from "../gateway/call.js";
import { loadSessionEntry } from "../gateway/session-utils.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isSubagentSessionKey } from "../sessions/session-key-utils.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import { extractAssistantText } from "./pi-embedded-utils.js";
import {
  prepareSimpleCompletionModelForAgent,
  completeWithPreparedSimpleCompletionModel,
} from "./simple-completion-runtime.js";

const log = createSubsystemLogger("session-auto-title");

const TITLE_MAX_LENGTH = 50;
const PROMPT_MAX_CHARS = 1500;
const TITLE_TIMEOUT_MS = 10_000;

const TITLE_SYSTEM_PROMPT =
  "Generate a concise title (3-8 words, max 50 characters) for this conversation. " +
  "Use the same language as the user's message. " +
  "Return ONLY the title text, no quotes, no explanation, no punctuation wrapping.";

export function shouldGenerateTitle(params: {
  success: boolean;
  trigger: string | undefined;
  sessionKey: string;
  messages: unknown[];
  existingLabel: string | undefined;
}): boolean {
  if (!params.success) {
    return false;
  }
  if (params.trigger !== "user") {
    return false;
  }
  if (!params.sessionKey) {
    return false;
  }
  if (isSubagentSessionKey(params.sessionKey)) {
    return false;
  }
  if (params.sessionKey.startsWith("temp:")) {
    return false;
  }
  if (params.existingLabel?.trim()) {
    return false;
  }

  const assistantCount = params.messages.filter(
    (m) =>
      typeof m === "object" && m !== null && (m as Record<string, unknown>).role === "assistant",
  ).length;

  return assistantCount === 1;
}

export function buildTitlePrompt(messages: unknown[]): string {
  const parts: string[] = [];
  let totalLen = 0;

  for (const msg of messages) {
    if (typeof msg !== "object" || msg === null) {
      continue;
    }
    const m = msg as Record<string, unknown>;
    const role = m.role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }

    const content = extractTextFromChatContent(m.content)?.trim() ?? "";
    if (!content) {
      continue;
    }

    const remaining = PROMPT_MAX_CHARS - totalLen;
    if (remaining <= 0) {
      break;
    }

    const truncated = content.length > remaining ? content.slice(0, remaining) + "..." : content;
    parts.push(`${role}: ${truncated}`);
    totalLen += truncated.length;
  }

  return parts.join("\n\n");
}

export function cleanGeneratedTitle(raw: string): string | null {
  let cleaned = raw.trim();
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  if (!cleaned) {
    return null;
  }
  if (cleaned.length > TITLE_MAX_LENGTH) {
    cleaned = cleaned.slice(0, TITLE_MAX_LENGTH).trim();
  }
  return cleaned || null;
}

export async function maybeGenerateSessionTitle(params: {
  success: boolean;
  trigger: string | undefined;
  sessionKey: string;
  sessionId: string;
  agentId: string;
  messages: unknown[];
  config: OpenClawConfig;
}): Promise<void> {
  let existingLabel: string | undefined;
  try {
    const { entry } = loadSessionEntry(params.sessionKey);
    existingLabel = entry?.label;
    if (entry?.sessionId && entry.sessionId !== params.sessionId) {
      return;
    }
  } catch {
    return;
  }

  if (
    !shouldGenerateTitle({
      success: params.success,
      trigger: params.trigger,
      sessionKey: params.sessionKey,
      messages: params.messages,
      existingLabel,
    })
  ) {
    return;
  }

  const conversationText = buildTitlePrompt(params.messages);
  if (!conversationText) {
    return;
  }

  const prepared = await prepareSimpleCompletionModelForAgent({
    cfg: params.config,
    agentId: params.agentId,
  });
  if ("error" in prepared) {
    log.debug(`model prep failed: ${prepared.error}`);
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS);
  let title: string | null = null;
  try {
    const response = await completeWithPreparedSimpleCompletionModel({
      model: prepared.model,
      auth: prepared.auth,
      context: {
        systemPrompt: TITLE_SYSTEM_PROMPT,
        messages: [{ role: "user" as const, content: conversationText, timestamp: Date.now() }],
      },
      options: { maxTokens: 30, signal: controller.signal },
    });

    title = cleanGeneratedTitle(extractAssistantText(response));
    if (!title) {
      return;
    }

    await callGateway({
      method: "sessions.patch",
      params: { key: params.sessionKey, label: title },
      timeoutMs: 5_000,
    });
    log.debug(`auto-title set: "${title}" for ${params.sessionKey}`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes("label already in use") && title) {
      const now = new Date();
      const suffix = ` (${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")})`;
      const base = title.slice(0, TITLE_MAX_LENGTH - suffix.length);
      const fallback = base ? `${base}${suffix}` : null;
      if (fallback) {
        try {
          await callGateway({
            method: "sessions.patch",
            params: { key: params.sessionKey, label: fallback },
            timeoutMs: 5_000,
          });
        } catch {
          // Give up silently
        }
      }
    } else {
      log.debug(`auto-title failed: ${errMsg}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
