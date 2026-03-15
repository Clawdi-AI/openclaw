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

export type DocMeta = {
  doc_id: string;
  filename: string;
  brief_intro?: string;
  toc?: string[];
  instructions?: string;
  token_estimate?: number;
  source?: string;
  status?: string;
  metadata?: Record<string, unknown>;
};

// ── Read Segment ─────────────────────────────────────────────────────

export type ReadSegmentRequest = {
  doc_id: string;
  section_path: string;
  include_summary?: boolean;
};

export type ReadSegmentResponse = {
  doc_id: string;
  section_path: string;
  content: string;
  summary?: string;
  children?: string[];
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
  total_docs: number;
  total_chunks: number;
  total_collections: number;
  pending_tasks?: number;
};
