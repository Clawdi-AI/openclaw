import type {
  CollectionCreateOpts,
  CollectionInfo,
  DocMeta,
  HealthResponse,
  IndexContentRequest,
  IndexFileRequest,
  IndexResponse,
  MentatDocResult,
  MentatSearchResult,
  ProcessingStatus,
  ReadSegmentRequest,
  ReadSegmentResponse,
  SearchGroupedResponse,
  SearchRequest,
  SearchResponse,
  SkillResponse,
  StatsResponse,
} from "./types.js";

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
};

const HEALTH_CHECK_INTERVAL_MS = 30_000;

export class MentatClient {
  private healthy = false;
  private started = false;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private skillPromptCache: string | null = null;
  private readonly logger: Logger;

  constructor(
    private readonly baseUrl: string,
    logger?: Logger,
  ) {
    this.logger = logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
    };
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  /** Start health checking. Idempotent — safe to call multiple times. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.checkHealth();
    this.healthCheckTimer = setInterval(() => {
      this.checkHealth().catch(() => {});
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  /** Ensure the client is started. Call from hooks that may run before service start. */
  async ensureStarted(): Promise<void> {
    if (!this.started) await this.start();
  }

  stop(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  // ── Health ───────────────────────────────────────────────────────

  async checkHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      const wasHealthy = this.healthy;
      this.healthy = res.ok;
      if (!wasHealthy && this.healthy) {
        this.logger.info("mentat-bridge: server is healthy");
      }
      return this.healthy;
    } catch {
      if (this.healthy) {
        this.logger.warn("mentat-bridge: server became unreachable");
      }
      this.healthy = false;
      return false;
    }
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  // ── Index ────────────────────────────────────────────────────────

  async indexFile(req: IndexFileRequest): Promise<IndexResponse | null> {
    return this.request<IndexResponse>("POST", "/index", req);
  }

  /** Fire-and-forget index — does not await response. */
  indexFileAsync(req: IndexFileRequest): void {
    if (!this.healthy) return;
    fetch(`${this.baseUrl}/index`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => {});
  }

  async indexContent(req: IndexContentRequest): Promise<IndexResponse | null> {
    return this.request<IndexResponse>("POST", "/index-content", req);
  }

  /** Fire-and-forget content index. */
  indexContentAsync(req: IndexContentRequest): void {
    if (!this.healthy) return;
    fetch(`${this.baseUrl}/index-content`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => {});
  }

  // ── Search ───────────────────────────────────────────────────────

  async search(req: SearchRequest): Promise<MentatSearchResult[] | null> {
    const res = await this.request<SearchResponse>("POST", "/search", req);
    return res?.results ?? null;
  }

  async searchGrouped(req: SearchRequest): Promise<MentatDocResult[] | null> {
    const res = await this.request<SearchGroupedResponse>("POST", "/search-grouped", req);
    return res?.results ?? null;
  }

  // ── Document ─────────────────────────────────────────────────────

  async getDocMeta(docId: string): Promise<DocMeta | null> {
    return this.request<DocMeta>("GET", `/doc-meta/${encodeURIComponent(docId)}`);
  }

  async readSegment(req: ReadSegmentRequest): Promise<ReadSegmentResponse | null> {
    return this.request<ReadSegmentResponse>("POST", "/read-segment", req);
  }

  async getStatus(docId: string): Promise<ProcessingStatus | null> {
    return this.request<ProcessingStatus>("GET", `/status/${encodeURIComponent(docId)}`);
  }

  // ── Skill ────────────────────────────────────────────────────────

  async getSkillPrompt(): Promise<string | null> {
    if (this.skillPromptCache) return this.skillPromptCache;
    const skill = await this.request<SkillResponse>("GET", "/skill");
    if (skill?.system_prompt) {
      this.skillPromptCache = skill.system_prompt;
    }
    return this.skillPromptCache;
  }

  // ── Collections ──────────────────────────────────────────────────

  async createCollection(
    name: string,
    opts?: CollectionCreateOpts,
  ): Promise<CollectionInfo | null> {
    return this.request<CollectionInfo>(
      "POST",
      `/collections/${encodeURIComponent(name)}`,
      opts ?? {},
    );
  }

  async getCollection(name: string): Promise<CollectionInfo | null> {
    return this.request<CollectionInfo>("GET", `/collections/${encodeURIComponent(name)}`);
  }

  async deleteCollection(name: string): Promise<boolean> {
    const res = await this.request<{ deleted: string }>(
      "DELETE",
      `/collections/${encodeURIComponent(name)}`,
    );
    return res?.deleted != null;
  }

  async listCollections(): Promise<CollectionInfo[] | null> {
    const res = await this.request<{ collections: CollectionInfo[] } | CollectionInfo[]>(
      "GET",
      "/collections",
    );
    if (!res) return null;
    // Server may return { collections: [...] } or [...] directly
    return Array.isArray(res) ? res : (res.collections ?? null);
  }

  async triggerGc(): Promise<{ deleted: string[] } | null> {
    return this.request<{ deleted: string[] }>("POST", "/collections/gc");
  }

  /** Remove a document from all collections (makes it unsearchable in scoped queries). */
  async removeDocFromCollections(docId: string): Promise<boolean> {
    // Mentat doesn't have a single "delete doc" endpoint.
    // We remove it from every collection that contains it.
    const collections = await this.listCollections();
    if (!collections) return false;
    for (const coll of collections) {
      // Use the collection-level remove endpoint if available,
      // otherwise this is a no-op for collections that don't contain the doc.
      await this.request(
        "DELETE",
        `/collections/${encodeURIComponent(coll.name)}/docs/${encodeURIComponent(docId)}`,
      );
    }
    return true;
  }

  // ── Stats ────────────────────────────────────────────────────────

  async getStats(): Promise<StatsResponse | null> {
    return this.request<StatsResponse>("GET", "/stats");
  }

  // ── Internal ─────────────────────────────────────────────────────

  private async request<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    if (!this.healthy) return null;
    try {
      const opts: RequestInit = {
        method,
        signal: AbortSignal.timeout(30_000),
      };
      if (body !== undefined && method !== "GET") {
        opts.headers = { "Content-Type": "application/json" };
        opts.body = JSON.stringify(body);
      }
      const res = await fetch(`${this.baseUrl}${path}`, opts);
      if (!res.ok) {
        this.logger.debug?.(`mentat-bridge: ${method} ${path} → ${res.status}`);
        return null;
      }
      return (await res.json()) as T;
    } catch (err) {
      this.logger.debug?.(`mentat-bridge: ${method} ${path} failed: ${String(err)}`);
      return null;
    }
  }
}
