/** Per-session state tracking for read history, doc-meta cache, and active session. */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DocMeta } from "./types.js";

/**
 * Tracks active session IDs (supports concurrent sessions from multiple channels).
 * Set on session_start, cleared on session_end.
 * Used by search_chat_history to scope queries to current session.
 *
 * When only one session is active, `get()` returns it deterministically.
 * With concurrent sessions, callers should prefer `ctx.sessionId` from the
 * tool factory and only fall back to this tracker.
 */
export class ActiveSessionTracker {
  private _sessions = new Map<string, string>(); // sessionKey -> sessionId

  set(sessionId: string, sessionKey?: string) {
    const key = sessionKey ?? sessionId;
    this._sessions.set(key, sessionId);
  }

  /** Get session ID by key, or return the sole active session if only one exists. */
  get(sessionKey?: string): string | null {
    if (sessionKey) {
      return this._sessions.get(sessionKey) ?? null;
    }
    // If only one session is active, return it unambiguously
    if (this._sessions.size === 1) {
      return this._sessions.values().next().value ?? null;
    }
    return null;
  }

  clear(sessionKey?: string) {
    if (sessionKey) {
      this._sessions.delete(sessionKey);
    } else {
      this._sessions.clear();
    }
  }
}

/**
 * Tracks which documents have been read during each session.
 * Used by compaction hooks to re-inject hot context after compaction.
 */
export class SessionReadTracker {
  private sessions = new Map<string, Set<string>>();

  trackRead(sessionKey: string, docId: string): void {
    let docs = this.sessions.get(sessionKey);
    if (!docs) {
      docs = new Set();
      this.sessions.set(sessionKey, docs);
    }
    docs.add(docId);
  }

  getReadDocIds(sessionKey: string): string[] {
    const docs = this.sessions.get(sessionKey);
    return docs ? [...docs] : [];
  }

  hasReads(sessionKey: string): boolean {
    const docs = this.sessions.get(sessionKey);
    return docs != null && docs.size > 0;
  }

  clearSession(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }
}

/**
 * Stores continuation briefs for sessions that were reset (daily/idle).
 * When a session starts with `resumedFrom`, the previous session's last
 * messages are stored here keyed by sessionKey. The before_prompt_build
 * hook consumes (and removes) the brief on first injection.
 *
 * Briefs are persisted to disk so they survive agent restarts.
 * Each brief is a separate file: `<dir>/<safe-key>.json`.
 */
export class ContinuationBriefStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  set(sessionKey: string, brief: string, resumedFrom: string): void {
    const filePath = this.filePath(sessionKey);
    writeFileSync(filePath, JSON.stringify({ sessionKey, brief, resumedFrom, ts: Date.now() }));
  }

  /** Consume the brief — returns it and removes from store. */
  consume(sessionKey: string): { brief: string; resumedFrom: string } | undefined {
    const filePath = this.filePath(sessionKey);
    try {
      const raw = readFileSync(filePath, "utf-8");
      unlinkSync(filePath);
      const data = JSON.parse(raw) as { brief: string; resumedFrom: string };
      return { brief: data.brief, resumedFrom: data.resumedFrom };
    } catch {
      return undefined;
    }
  }

  has(sessionKey: string): boolean {
    return existsSync(this.filePath(sessionKey));
  }

  private filePath(sessionKey: string): string {
    // Encode sessionKey to a safe filename (replace non-alphanumeric with _)
    const safe = sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.dir, `${safe}.json`);
  }
}

/**
 * Cache of doc metadata, populated by after_tool_call for use by
 * the synchronous tool_result_persist hook.
 */
export class DocMetaCache {
  private cache = new Map<string, DocMeta>();
  private maxSize = 500;

  set(key: string, meta: DocMeta): void {
    if (this.cache.size >= this.maxSize) {
      // Evict oldest entry
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(key, meta);
  }

  get(key: string): DocMeta | undefined {
    return this.cache.get(key);
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }
}
