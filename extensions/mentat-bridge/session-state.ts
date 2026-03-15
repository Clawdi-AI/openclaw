/** Per-session state tracking for read history and doc-meta cache. */

import type { DocMeta } from "./types.js";

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
