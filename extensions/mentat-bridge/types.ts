// Mentat HTTP API request/response types.
// These mirror the FastAPI models in mentat/server.py.

// ── Index ────────────────────────────────────────────────────────────

export type IndexFileRequest = {
  path: string;
  source?: string;
  collection?: string;
  metadata?: Record<string, unknown>;
  force?: boolean;
  wait?: boolean;
};

export type IndexContentRequest = {
  content: string;
  filename: string;
  content_type?: string;
  source?: string;
  collection?: string;
  metadata?: Record<string, unknown>;
};

export type IndexResponse = {
  doc_id: string;
  filename: string;
  status: string;
  cached?: boolean;
};

// ── Search ───────────────────────────────────────────────────────────

export type SearchRequest = {
  query: string;
  top_k?: number;
  toc_only?: boolean;
  hybrid?: boolean;
  grouped?: boolean;
  collection?: string;
  collections?: string[];
  source?: string;
  metadata_filter?: Record<string, unknown>;
};

export type MentatChunkResult = {
  chunk_id: string;
  section: string;
  content: string;
  summary?: string;
  score: number;
};

export type MentatSearchResult = {
  doc_id: string;
  chunk_id?: string;
  filename: string;
  section?: string;
  content?: string;
  summary?: string;
  brief_intro?: string;
  instructions?: string;
  score: number;
  source?: string;
  metadata?: Record<string, unknown>;
};

export type MentatDocResult = {
  doc_id: string;
  filename: string;
  brief_intro?: string;
  instructions?: string;
  source?: string;
  metadata?: Record<string, unknown>;
  chunks: MentatChunkResult[];
};

export type SearchResponse = {
  results: MentatSearchResult[];
};

export type SearchGroupedResponse = {
  results: MentatDocResult[];
};

// ── Document Meta ────────────────────────────────────────────────────

export type TocEntry = {
  level: number;
  title: string;
  page?: number | null;
  preview?: string;
  annotation?: string;
};

export type DocMeta = {
  doc_id: string;
  filename: string;
  brief_intro?: string;
  toc_entries?: TocEntry[];
  instructions?: string;
  token_estimate?: number;
  source?: string;
  processing_status?: string;
  metadata?: Record<string, unknown>;
};

/** Extract flat section title list from toc_entries. */
export function tocTitles(meta: DocMeta): string[] {
  return (meta.toc_entries ?? []).map((e) => e.title);
}

// ── Read Segment ─────────────────────────────────────────────────────

export type ReadSegmentRequest = {
  doc_id: string;
  section_path: string;
  include_summary?: boolean;
};

export type ReadSegmentChunk = {
  chunk_id: string;
  section: string;
  content: string;
  summary?: string;
};

export type ReadSegmentResponse = {
  doc_id: string;
  filename: string;
  section_path: string;
  chunks: ReadSegmentChunk[];
  toc_context: TocEntry[];
  token_estimate: number;
  expanded: boolean;
  note?: string;
};

// ── Collections ──────────────────────────────────────────────────────

export type CollectionCreateOpts = {
  metadata?: Record<string, unknown>;
  watch_paths?: string[];
  watch_ignore?: string[];
  auto_add_sources?: string[];
};

export type CollectionInfo = {
  name: string;
  doc_count: number;
  metadata?: Record<string, unknown>;
  watch_paths?: string[];
  auto_add_sources?: string[];
  created_at?: string;
};

// ── Status ───────────────────────────────────────────────────────────

export type ProcessingStatus = {
  doc_id: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress?: number;
  error?: string;
};

// ── Skill ────────────────────────────────────────────────────────────

export type SkillResponse = {
  tools: unknown[];
  system_prompt: string;
  version: string;
  protocol: string;
};

// ── Health ────────────────────────────────────────────────────────────

export type HealthResponse = {
  status: string;
  version?: string;
};

// ── Stats ────────────────────────────────────────────────────────────

export type StatsResponse = {
  docs_indexed: number;
  chunks_stored: number;
  cached_hashes: number;
  storage_size_bytes: number;
  collections: number;
  access_tracker?: Record<string, unknown>;
  section_heat?: Record<string, unknown>;
};
