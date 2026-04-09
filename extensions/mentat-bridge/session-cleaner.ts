/**
 * Session Cleaner — pre-processes raw OpenClaw session JSONL files into
 * a cleaned `.indexed/` shadow directory that Mentat indexes directly.
 *
 * Indexed files are retained after raw transcripts are reset/archived so
 * historical chat search/read tools can continue to resolve old session IDs.
 *
 * Cleaning rules (all filtering/stripping lives here, not in Mentat's probe):
 *   - Keep: user messages (text stripped of injected metadata preambles)
 *   - Keep: assistant messages that are regular text responses
 *   - Skip: non-message records (session, model_change, etc.)
 *   - Skip: toolResult messages
 *   - Skip: all assistant messages inside a "tool turn" (from the first
 *     tool_use until the next user message) — this eliminates search-echo
 *     pollution where tool summaries get indexed and drown real answers
 *
 * Output format (one record per line):
 *   {"role":"user","text":"cleaned text","ts":"2026-03-30T07:36:00.000Z"}
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join, basename } from "node:path";

// ── Strip patterns ────────────────────────────────────────────────────
// These must stay in sync with the templates that inject this metadata.
// Tests in index.test.ts verify this correspondence.

export const STRIP_PATTERNS: { name: string; pattern: RegExp }[] = [
  {
    name: "relevant-memories",
    pattern: /<relevant-memories>[\s\S]*?<\/relevant-memories>\s*/g,
  },
  {
    name: "conversation-info",
    pattern: /Conversation info \(untrusted metadata\):\s*```json\s*\{[\s\S]*?\}\s*```\s*/g,
  },
  {
    name: "sender-info",
    pattern: /Sender \(untrusted metadata\):\s*```json\s*\{[\s\S]*?\}\s*```\s*/g,
  },
  {
    name: "timestamp-line",
    pattern: /\[\w{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2} \w+\]\s*/g,
  },
  {
    name: "search-results",
    pattern: /Found \d+ conversation\(s\) from past sessions:[\s\S]*/g,
  },
  {
    name: "no-results",
    pattern: /No matching conversations found in past sessions[^.]*.?\s*/g,
  },
];

// ── Types ─────────────────────────────────────────────────────────────

type CleanedRecord = { role: "user" | "assistant"; text: string; ts: string };

/** Per-file processing state, persisted across restarts. */
type FileState = {
  offset: number;
  /**
   * True while inside a "tool turn" — started by an assistant message with
   * tool_use, ended by the next user message.  All assistant text messages
   * within a tool turn are skipped (they are summaries/echoes of tool
   * results and pollute search with feedback loops).
   */
  inToolTurn: boolean;
};

type PersistedOffsets = Record<string, FileState>;

const OFFSETS_FILE = "_offsets.json";
const POLL_INTERVAL_MS = 2000;

// Ignore patterns matching watcher.py conventions
const IGNORE_PATTERNS = [
  "sessions.json",
  "sessions.json.bak.*",
  "*.reset.*",
  "*.deleted.*",
  "*.lock",
];

function matchesIgnore(filename: string): boolean {
  for (const pattern of IGNORE_PATTERNS) {
    if (pattern.includes("*")) {
      const re = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
      if (re.test(filename)) return true;
    } else if (filename === pattern) {
      return true;
    }
  }
  return false;
}

// ── Text extraction & cleaning ────────────────────────────────────────

/**
 * Extract text content from an OpenClaw message content field.
 * Returns the joined text blocks, or empty string if none found.
 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as Record<string, unknown>).type === "text"
    ) {
      const text = (block as Record<string, unknown>).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n");
}

/** Returns true if content array contains a tool_use or tool_call block. */
function hasToolUse(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  for (const block of content) {
    if (typeof block === "object" && block !== null) {
      const type = (block as Record<string, unknown>).type;
      if (type === "tool_use" || type === "toolCall" || type === "tool_call") return true;
    }
  }
  return false;
}

/** Apply all strip patterns to text. */
export function stripMetadata(text: string): string {
  let result = text;
  for (const { pattern } of STRIP_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    result = result.replace(pattern, "");
  }
  return result.trim();
}

// ── Core cleaning logic ───────────────────────────────────────────────

/**
 * Process raw JSONL lines and return cleaned records.
 * Updates `state.inToolTurn` as a side-effect for cross-batch continuity.
 */
export function cleanLines(lines: string[], state: { inToolTurn: boolean }): CleanedRecord[] {
  const cleaned: CleanedRecord[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }

    // Only process message records
    if (rec.type !== "message") continue;

    const msg = rec.message as Record<string, unknown> | undefined;
    if (!msg) continue;

    const role = msg.role as string;
    const content = msg.content;
    const ts = (rec.timestamp as string) ?? "";

    // toolResult — skip (stay in tool turn)
    if (role === "toolResult" || role === "tool_result") {
      continue;
    }

    // assistant
    if (role === "assistant") {
      // Tool-call message → enter tool turn, skip
      if (hasToolUse(content)) {
        state.inToolTurn = true;
        continue;
      }
      // Inside a tool turn → skip (this is the echo/summary)
      if (state.inToolTurn) {
        continue;
      }

      const text = extractText(content);
      if (!text.trim()) continue;

      cleaned.push({ role: "assistant", text, ts });
      continue;
    }

    // user — ends any tool turn
    if (role === "user") {
      state.inToolTurn = false;

      let text = extractText(content);
      text = stripMetadata(text);
      if (!text) continue;

      cleaned.push({ role: "user", text, ts });
      continue;
    }
  }

  return cleaned;
}

// ── SessionCleaner class ──────────────────────────────────────────────

export class SessionCleaner {
  readonly rawDir: string;
  readonly indexedDir: string;
  private offsets: PersistedOffsets = {};
  private timer: ReturnType<typeof setInterval> | null = null;
  private logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };

  constructor(
    rawDir: string,
    logger?: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
  ) {
    this.rawDir = rawDir;
    this.indexedDir = join(rawDir, ".indexed");
    this.logger = logger ?? { info: () => {}, warn: () => {} };
  }

  async start(): Promise<void> {
    mkdirSync(this.indexedDir, { recursive: true });
    this.loadOffsets();
    await this.scanAll();
    this.timer = setInterval(() => void this.scanAll(), POLL_INTERVAL_MS);
    this.logger.info(
      `session-cleaner: started (polling ${POLL_INTERVAL_MS}ms) → ${this.indexedDir}`,
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.saveOffsets();
    this.logger.info("session-cleaner: stopped");
  }

  // ── Offset persistence ────────────────────────────────────────────

  private offsetsPath(): string {
    return join(this.indexedDir, OFFSETS_FILE);
  }

  private loadOffsets(): void {
    const p = this.offsetsPath();
    if (existsSync(p)) {
      try {
        this.offsets = JSON.parse(readFileSync(p, "utf-8"));
      } catch {
        this.logger.warn("session-cleaner: failed to load offsets, starting fresh");
        this.offsets = {};
      }
    }
  }

  private saveOffsets(): void {
    try {
      writeFileSync(this.offsetsPath(), JSON.stringify(this.offsets, null, 2));
    } catch {
      this.logger.warn("session-cleaner: failed to save offsets");
    }
  }

  // ── Scanning ──────────────────────────────────────────────────────

  private async scanAll(): Promise<void> {
    if (!existsSync(this.rawDir)) return;

    let entries: string[];
    try {
      entries = readdirSync(this.rawDir);
    } catch {
      return;
    }

    let anyProcessed = false;
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      if (matchesIgnore(entry)) continue;

      const rawPath = join(this.rawDir, entry);
      try {
        const processed = await this.processFile(rawPath);
        if (processed) anyProcessed = true;
      } catch (err) {
        this.logger.warn(`session-cleaner: failed to process ${entry}: ${err}`);
      }
    }

    if (anyProcessed) {
      this.saveOffsets();
    }
  }

  /** Process new bytes from a raw session file. Returns true if new content was written. */
  private async processFile(rawPath: string): Promise<boolean> {
    let fileSize: number;
    try {
      fileSize = statSync(rawPath).size;
    } catch {
      return false;
    }

    const key = rawPath;
    const state = this.offsets[key] ?? { offset: 0, inToolTurn: false };

    // File truncated or unchanged
    if (fileSize <= state.offset) {
      if (fileSize < state.offset) {
        // File was truncated — reset
        state.offset = 0;
        state.inToolTurn = false;
        this.offsets[key] = state;
      }
      return false;
    }

    // Read new bytes
    const fd = readFileSync(rawPath);
    const newBytes = fd.subarray(state.offset, fileSize);
    const newText = newBytes.toString("utf-8");

    // Find last complete line
    const lastNewline = newText.lastIndexOf("\n");
    if (lastNewline === -1) return false;

    const completeText = newText.substring(0, lastNewline + 1);
    const actualEnd = state.offset + Buffer.byteLength(completeText, "utf-8");

    const lines = completeText.split("\n").filter((l) => l.trim());
    if (lines.length === 0) {
      state.offset = actualEnd;
      this.offsets[key] = state;
      return false;
    }

    // Clean
    const mutState = { inToolTurn: state.inToolTurn };
    const cleaned = cleanLines(lines, mutState);

    // Update state
    state.offset = actualEnd;
    state.inToolTurn = mutState.inToolTurn;
    this.offsets[key] = state;

    if (cleaned.length === 0) return false;

    // Write cleaned records
    const outPath = join(this.indexedDir, basename(rawPath));
    const outLines = cleaned.map((r) => JSON.stringify(r)).join("\n") + "\n";
    await appendFile(outPath, outLines, "utf-8");

    return true;
  }
}
