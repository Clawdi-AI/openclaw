import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { requireNodeSqlite } from "../../src/memory/sqlite.js";

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  debug?: (msg: string) => void;
};

type Checkpoint = {
  lastCreatedAt: string;
  lastMessageId: string;
};

type ChannelCheckpointMap = Record<string, Checkpoint>;

type RawMessageRow = {
  message_id: string;
  guild_id: string;
  channel_id: string;
  channel_name: string;
  channel_kind: string;
  author_id: string;
  author_name: string;
  content: string;
  created_at: string;
  reply_to_message_id: string;
  has_attachments: number;
  pinned: number;
};

type ExportRecord = {
  type: "message";
  message_id: string;
  guild_id: string;
  channel_id: string;
  channel_name: string;
  channel_kind: string;
  author_id: string;
  author_name: string;
  created_at: string;
  content: string;
  reply_to_message_id?: string;
  has_attachments: boolean;
  pinned: boolean;
  search_text: string;
};

type ReadHistoryParams = {
  channel?: string;
  author?: string;
  last_n?: number;
  since?: string;
  hours?: number;
  days?: number;
};

export type ReadHistoryMessage = {
  messageId: string;
  guildId: string;
  channelId: string;
  channelName: string;
  authorId: string;
  authorName: string;
  content: string;
  createdAt: string;
  replyToMessageId?: string;
  hasAttachments: boolean;
  pinned: boolean;
};

export type ReadHistoryResult = {
  available: boolean;
  error?: string;
  messages?: ReadHistoryMessage[];
  total?: number;
};

const DEFAULT_SYNC_INTERVAL_MS = 30_000;
const CHECKPOINT_FILE = "_checkpoints.json";
const MAX_READ_MESSAGES = 200;

function sanitizeSegment(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return normalized || "unknown";
}

function normalizeChannelFilter(raw?: string): string {
  return raw?.trim().replace(/^#/, "") ?? "";
}

function buildSearchText(row: RawMessageRow): string {
  const prefix = `[${row.created_at}] #${row.channel_name || row.channel_id} ${row.author_name || row.author_id || "unknown"}`;
  const flags: string[] = [];
  if (row.has_attachments) flags.push("attachments");
  if (row.pinned) flags.push("pinned");
  const suffix = flags.length > 0 ? ` (${flags.join(", ")})` : "";
  return `${prefix}${suffix}: ${row.content}`.trim();
}

function compareCursor(aCreatedAt: string, aMessageId: string, b?: Checkpoint): number {
  if (!b) return 1;
  if (aCreatedAt > b.lastCreatedAt) return 1;
  if (aCreatedAt < b.lastCreatedAt) return -1;
  if (aMessageId > b.lastMessageId) return 1;
  if (aMessageId < b.lastMessageId) return -1;
  return 0;
}

export class DiscrawlDiscordHistoryBridge {
  readonly collectionName = "discord_history";
  private timer: ReturnType<typeof setInterval> | null = null;
  private checkpoints: ChannelCheckpointMap | null = null;
  private syncing = false;

  constructor(
    private readonly opts: {
      enabled: boolean;
      dbPath: string;
      exportDir: string;
      syncIntervalMs?: number;
    },
    private readonly logger: Logger,
  ) {}

  get exportDir(): string {
    return this.opts.exportDir;
  }

  isAvailable(): boolean {
    return this.opts.enabled && existsSync(this.opts.dbPath);
  }

  describeAvailability(): string {
    if (!this.opts.enabled) {
      return "Discord history is disabled in mentat-bridge config.";
    }
    if (!existsSync(this.opts.dbPath)) {
      return `discrawl database not found at ${this.opts.dbPath}`;
    }
    return "ok";
  }

  async start(): Promise<void> {
    if (!this.opts.enabled) return;
    await mkdir(this.opts.exportDir, { recursive: true });
    await this.syncNow();
    const intervalMs = this.opts.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
    this.timer = setInterval(() => {
      this.syncNow().catch((err) => {
        this.logger.warn(`mentat-bridge: discord history sync failed: ${String(err)}`);
      });
    }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async syncNow(): Promise<{ channels: number; messages: number }> {
    if (!this.isAvailable()) {
      return { channels: 0, messages: 0 };
    }
    if (this.syncing) {
      return { channels: 0, messages: 0 };
    }
    this.syncing = true;
    try {
      const db = this.openDb();
      try {
        const rows = db
          .prepare(
            `
              select
                m.id as message_id,
                m.guild_id as guild_id,
                m.channel_id as channel_id,
                coalesce(c.name, '') as channel_name,
                coalesce(c.kind, '') as channel_kind,
                coalesce(m.author_id, '') as author_id,
                coalesce(
                  nullif(mem.display_name, ''),
                  nullif(mem.nick, ''),
                  nullif(mem.global_name, ''),
                  nullif(mem.username, ''),
                  nullif(json_extract(m.raw_json, '$.author.global_name'), ''),
                  nullif(json_extract(m.raw_json, '$.author.username'), ''),
                  ''
                ) as author_name,
                case
                  when trim(coalesce(m.content, '')) <> '' then m.content
                  else m.normalized_content
                end as content,
                m.created_at as created_at,
                coalesce(m.reply_to_message_id, '') as reply_to_message_id,
                m.has_attachments as has_attachments,
                m.pinned as pinned
              from messages m
              left join channels c on c.id = m.channel_id
              left join members mem on mem.guild_id = m.guild_id and mem.user_id = m.author_id
              where trim(coalesce(m.normalized_content, '')) <> ''
              order by m.channel_id asc, m.created_at asc, m.id asc
            `,
          )
          .all() as RawMessageRow[];

        const checkpoints = await this.loadCheckpoints();
        const appendMap = new Map<string, string[]>();
        let exportedMessages = 0;

        for (const row of rows) {
          const current = checkpoints[row.channel_id];
          if (compareCursor(row.created_at, row.message_id, current) <= 0) {
            continue;
          }
          const record: ExportRecord = {
            type: "message",
            message_id: row.message_id,
            guild_id: row.guild_id,
            channel_id: row.channel_id,
            channel_name: row.channel_name,
            channel_kind: row.channel_kind,
            author_id: row.author_id,
            author_name: row.author_name,
            created_at: row.created_at,
            content: row.content,
            ...(row.reply_to_message_id ? { reply_to_message_id: row.reply_to_message_id } : {}),
            has_attachments: row.has_attachments === 1,
            pinned: row.pinned === 1,
            search_text: buildSearchText(row),
          };
          const filePath = this.channelFilePath(row.guild_id, row.channel_id, row.channel_name);
          const bucket = appendMap.get(filePath) ?? [];
          bucket.push(JSON.stringify(record));
          appendMap.set(filePath, bucket);
          checkpoints[row.channel_id] = {
            lastCreatedAt: row.created_at,
            lastMessageId: row.message_id,
          };
          exportedMessages += 1;
        }

        for (const [filePath, lines] of appendMap) {
          await mkdir(dirname(filePath), { recursive: true });
          await appendFile(filePath, `${lines.join("\n")}\n`, "utf8");
        }

        await this.saveCheckpoints(checkpoints);
        const channelCount = db
          .prepare(`select count(*) as count from channels where kind <> 'category'`)
          .get() as { count: number };

        if (exportedMessages > 0) {
          this.logger.info(
            `mentat-bridge: exported ${exportedMessages} Discord messages into ${appendMap.size} file(s)`,
          );
        }

        return { channels: channelCount.count, messages: exportedMessages };
      } finally {
        db.close();
      }
    } finally {
      this.syncing = false;
    }
  }

  async readHistory(params: ReadHistoryParams): Promise<ReadHistoryResult> {
    if (!this.isAvailable()) {
      return {
        available: false,
        error: this.describeAvailability(),
      };
    }

    const db = this.openDb();
    try {
      const conditions = ["trim(coalesce(m.normalized_content, '')) <> ''"];
      const values: Array<string | number> = [];

      const channel = normalizeChannelFilter(params.channel);
      if (channel) {
        conditions.push("(m.channel_id = ? or c.name = ? or c.name like ?)");
        values.push(channel, channel, `%${channel}%`);
      }

      const author = params.author?.trim();
      if (author) {
        conditions.push(
          `(m.author_id = ? or coalesce(mem.username, '') = ? or coalesce(mem.display_name, '') = ? or coalesce(mem.username, '') like ? or coalesce(mem.display_name, '') like ?)`,
        );
        values.push(author, author, author, `%${author}%`, `%${author}%`);
      }

      let since = params.since?.trim() ? new Date(params.since) : null;
      if (!since || Number.isNaN(since.getTime())) {
        since = null;
      }
      if (params.hours && params.hours > 0) {
        since = new Date(Date.now() - params.hours * 60 * 60 * 1000);
      } else if (params.days && params.days > 0) {
        since = new Date(Date.now() - params.days * 24 * 60 * 60 * 1000);
      }
      if (since) {
        conditions.push("m.created_at >= ?");
        values.push(since.toISOString());
      }

      const limit = Math.min(Math.max(params.last_n ?? 50, 1), MAX_READ_MESSAGES);
      values.push(limit, limit);

      const rows = db
        .prepare(
          `
            select * from (
              select
                m.id as message_id,
                m.guild_id as guild_id,
                m.channel_id as channel_id,
                coalesce(c.name, '') as channel_name,
                coalesce(m.author_id, '') as author_id,
                coalesce(
                  nullif(mem.display_name, ''),
                  nullif(mem.nick, ''),
                  nullif(mem.global_name, ''),
                  nullif(mem.username, ''),
                  nullif(json_extract(m.raw_json, '$.author.global_name'), ''),
                  nullif(json_extract(m.raw_json, '$.author.username'), ''),
                  ''
                ) as author_name,
                case
                  when trim(coalesce(m.content, '')) <> '' then m.content
                  else m.normalized_content
                end as content,
                m.created_at as created_at,
                coalesce(m.reply_to_message_id, '') as reply_to_message_id,
                m.has_attachments as has_attachments,
                m.pinned as pinned
              from messages m
              left join channels c on c.id = m.channel_id
              left join members mem on mem.guild_id = m.guild_id and mem.user_id = m.author_id
              where ${conditions.join(" and ")}
              order by m.created_at desc, m.id desc
              limit ?
            ) recent
            order by created_at asc, message_id asc
            limit ?
          `,
        )
        .all(...values) as Array<
        RawMessageRow & {
          channel_name: string;
        }
      >;

      return {
        available: true,
        total: rows.length,
        messages: rows.map((row) => ({
          messageId: row.message_id,
          guildId: row.guild_id,
          channelId: row.channel_id,
          channelName: row.channel_name,
          authorId: row.author_id,
          authorName: row.author_name,
          content: row.content,
          createdAt: row.created_at,
          ...(row.reply_to_message_id ? { replyToMessageId: row.reply_to_message_id } : {}),
          hasAttachments: row.has_attachments === 1,
          pinned: row.pinned === 1,
        })),
      };
    } finally {
      db.close();
    }
  }

  private openDb(): import("node:sqlite").DatabaseSync {
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(this.opts.dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 1000");
    return db;
  }

  private async loadCheckpoints(): Promise<ChannelCheckpointMap> {
    if (this.checkpoints) {
      return this.checkpoints;
    }
    const statePath = join(this.opts.exportDir, CHECKPOINT_FILE);
    try {
      const raw = await readFile(statePath, "utf8");
      this.checkpoints = JSON.parse(raw) as ChannelCheckpointMap;
    } catch {
      this.checkpoints = {};
    }
    return this.checkpoints;
  }

  private async saveCheckpoints(checkpoints: ChannelCheckpointMap): Promise<void> {
    this.checkpoints = checkpoints;
    const target = join(this.opts.exportDir, CHECKPOINT_FILE);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, JSON.stringify(checkpoints, null, 2), "utf8");
    await rename(tmp, target);
  }

  private channelFilePath(guildId: string, channelId: string, channelName: string): string {
    const filename = `channel-${channelId}-${sanitizeSegment(channelName)}.jsonl`;
    return join(this.opts.exportDir, `guild-${guildId}`, filename);
  }
}

export function buildDiscordHistoryCollectionConfig(exportDir: string) {
  return {
    metadata: {
      type: "system",
      description: "Discord guild history mirrored by discrawl",
      watch_mode: "append",
      initial_scan_recent_days: 365,
      watch_probe_config: {
        filters: [{ field: "type", op: "eq", value: "message" }],
        text_fields: ["search_text"],
        group_size: 6,
        group_separator: "\n\n",
        timestamp_field: "created_at",
      },
    },
    watch_paths: [exportDir],
    watch_ignore: [CHECKPOINT_FILE, "*.tmp"],
  };
}

export function summarizeDiscordMessages(messages: ReadHistoryMessage[]): string {
  return messages
    .map((message) => {
      const channelPrefix = `#${message.channelName || message.channelId}`;
      return `[${channelPrefix}] ${message.authorName || message.authorId} ${message.createdAt}\n${message.content}`;
    })
    .join("\n\n");
}
