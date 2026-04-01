/** Per-session state tracking for read history, doc-meta cache, and active session. */

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
