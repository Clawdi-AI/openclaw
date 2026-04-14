export type MentatBridgeConfig = {
  mentatUrl: string;
  enabled: boolean;
  autoIndex: boolean;
  autoRecall: boolean;
  autoCapture: boolean;
  compressResults: boolean;
  compressThresholdTokens: number;
  chatHistory: boolean;
  discordHistory: boolean;
  discrawlDbPath: string;
  discordHistoryExportDir: string;
};

const DEFAULTS: MentatBridgeConfig = {
  mentatUrl: "http://127.0.0.1:7832",
  enabled: true,
  autoIndex: true,
  autoRecall: true,
  autoCapture: false,
  compressResults: true,
  compressThresholdTokens: 2000,
  chatHistory: true,
  discordHistory: false,
  discrawlDbPath: "~/.discrawl/discrawl.db",
  discordHistoryExportDir: "~/.openclaw/mentat/discord-history",
};

const ALLOWED_KEYS = [
  "mentatUrl",
  "enabled",
  "autoIndex",
  "autoRecall",
  "autoCapture",
  "compressResults",
  "compressThresholdTokens",
  "chatHistory",
  "discordHistory",
  "discrawlDbPath",
  "discordHistoryExportDir",
] as const;

function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
) {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
  }
}

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

function expandHome(value: string): string {
  if (value === "~") return process.env.HOME ?? value;
  if (value.startsWith("~/")) {
    const home = process.env.HOME;
    return home ? `${home}/${value.slice(2)}` : value;
  }
  return value;
}

export const mentatBridgeConfigSchema = {
  parse(value: unknown): MentatBridgeConfig {
    const defaultDiscrawlDbPath = expandHome(DEFAULTS.discrawlDbPath);
    const defaultDiscordHistoryExportDir = expandHome(DEFAULTS.discordHistoryExportDir);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      // No config provided — use all defaults
      return {
        ...DEFAULTS,
        discrawlDbPath: defaultDiscrawlDbPath,
        discordHistoryExportDir: defaultDiscordHistoryExportDir,
      };
    }
    const cfg = value as Record<string, unknown>;
    assertAllowedKeys(cfg, ALLOWED_KEYS, "mentat-bridge config");

    const mentatUrl =
      typeof cfg.mentatUrl === "string" ? resolveEnvVars(cfg.mentatUrl) : DEFAULTS.mentatUrl;
    const discrawlDbPath =
      typeof cfg.discrawlDbPath === "string"
        ? expandHome(resolveEnvVars(cfg.discrawlDbPath))
        : defaultDiscrawlDbPath;
    const discordHistoryExportDir =
      typeof cfg.discordHistoryExportDir === "string"
        ? expandHome(resolveEnvVars(cfg.discordHistoryExportDir))
        : defaultDiscordHistoryExportDir;

    const compressThresholdTokens =
      typeof cfg.compressThresholdTokens === "number"
        ? Math.floor(cfg.compressThresholdTokens)
        : DEFAULTS.compressThresholdTokens;
    if (compressThresholdTokens < 500 || compressThresholdTokens > 50000) {
      throw new Error("compressThresholdTokens must be between 500 and 50000");
    }

    return {
      mentatUrl,
      enabled: typeof cfg.enabled === "boolean" ? cfg.enabled : DEFAULTS.enabled,
      autoIndex: typeof cfg.autoIndex === "boolean" ? cfg.autoIndex : DEFAULTS.autoIndex,
      autoRecall: typeof cfg.autoRecall === "boolean" ? cfg.autoRecall : DEFAULTS.autoRecall,
      autoCapture: typeof cfg.autoCapture === "boolean" ? cfg.autoCapture : DEFAULTS.autoCapture,
      compressResults:
        typeof cfg.compressResults === "boolean" ? cfg.compressResults : DEFAULTS.compressResults,
      compressThresholdTokens,
      chatHistory: typeof cfg.chatHistory === "boolean" ? cfg.chatHistory : DEFAULTS.chatHistory,
      discordHistory:
        typeof cfg.discordHistory === "boolean" ? cfg.discordHistory : DEFAULTS.discordHistory,
      discrawlDbPath,
      discordHistoryExportDir,
    };
  },
  uiHints: {
    mentatUrl: {
      label: "Mentat Server URL",
      placeholder: "http://127.0.0.1:7832",
      help: "HTTP endpoint for the Mentat server (use ${MENTAT_URL} for env var)",
    },
    enabled: {
      label: "Enable Mentat Bridge",
      help: "Toggle the Mentat RAG integration on/off",
    },
    autoIndex: {
      label: "Auto-Index Tool Results",
      help: "Automatically index file reads and web fetches into Mentat",
    },
    autoRecall: {
      label: "Auto-Recall",
      help: "Automatically inject relevant memories into agent context before each run",
    },
    autoCapture: {
      label: "Auto-Capture",
      help: "Automatically capture important information from user messages",
    },
    compressResults: {
      label: "Compress Large Results",
      help: "Replace large file tool results with ToC + brief intro (saves tokens)",
    },
    compressThresholdTokens: {
      label: "Compression Threshold (tokens)",
      placeholder: "2000",
      help: "Files smaller than this are kept as-is",
      advanced: true,
    },
    discordHistory: {
      label: "Enable Discord History",
      help: "Index discrawl's mirrored Discord archive into a Mentat collection for agent search",
    },
    discrawlDbPath: {
      label: "discrawl DB Path",
      placeholder: "~/.discrawl/discrawl.db",
      help: "Path to the discrawl SQLite database to mirror into Mentat",
      advanced: true,
    },
    discordHistoryExportDir: {
      label: "Discord Export Dir",
      placeholder: "~/.openclaw/mentat/discord-history",
      help: "Directory where mentat-bridge writes append-only JSONL files for Mentat watcher",
      advanced: true,
    },
  },
};
