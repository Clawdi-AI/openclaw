import type { DocMeta, TocEntry } from "../types.js";

// ── Shared types for hook handlers ──────────────────────────────────

export type HookLogger = {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  debug?: (msg: string) => void;
};

// ── Token estimation ────────────────────────────────────────────────

/** Rough token estimate: ~4 chars per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── TOC rendering ───────────────────────────────────────────────────

/**
 * Render toc_entries as an indented tree string.
 *
 * Example output:
 *   - Introduction
 *   - API Reference
 *     - Authentication
 *     - Endpoints
 *       - GET /users
 */
export function renderToc(entries: TocEntry[]): string {
  if (entries.length === 0) return "";
  const lines: string[] = [];
  for (const e of entries) {
    const indent = "  ".repeat(Math.max(0, e.level - 1));
    lines.push(`${indent}- ${e.title}`);
  }
  return lines.join("\n");
}

// ── Compressed summary builder ──────────────────────────────────────

/**
 * Build a compressed `<mentat-indexed>` summary block from doc metadata.
 * Used by tool-result-persist, transform-tool-result, and media-file-transform
 * to replace large content with a small pointer + TOC.
 */
export function buildCompressedSummary(
  meta: DocMeta,
  opts?: { tagStyle?: "xml" | "bracket" },
): string {
  const style = opts?.tagStyle ?? "xml";
  const parts: string[] = [];

  if (style === "xml") {
    parts.push(`<mentat-indexed doc_id="${meta.doc_id}" filename="${meta.filename}">`);
  } else {
    parts.push(`[Indexed in Mentat — doc_id: ${meta.doc_id}]`);
  }

  if (meta.brief_intro) {
    parts.push(`Brief: ${meta.brief_intro}`);
  }

  const toc = meta.toc_entries ?? [];
  if (toc.length > 0) {
    parts.push(`Sections:\n${renderToc(toc)}`);
  }

  parts.push(
    "Use read_segment(doc_id, section_name) to read specific sections. Reading a parent section returns all nested child content.",
  );

  if (style === "xml") {
    parts.push("</mentat-indexed>");
  }

  return parts.join("\n");
}
