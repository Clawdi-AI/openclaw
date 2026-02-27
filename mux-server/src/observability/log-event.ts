export type LogLevel = "info" | "warn" | "error";

export type LogEvent = Record<string, unknown> & {
  type?: unknown;
  level?: unknown;
  ts?: unknown;
  component?: unknown;
};

function inferLogLevel(type: string): LogLevel {
  const t = type.toLowerCase();
  if (t.includes("error") || t.includes("fatal") || t.includes("failed")) {
    return "error";
  }
  if (
    t.includes("warn") ||
    t.includes("invalid") ||
    t.includes("drop") ||
    t.includes("deferred") ||
    t.includes("degraded") ||
    t.includes("exhausted") ||
    t.includes("conflict")
  ) {
    return "warn";
  }
  return "info";
}

export function normalizeLogEvent(entry: Record<string, unknown>, nowMs = Date.now()): LogEvent {
  const type = typeof entry.type === "string" ? entry.type : "event";
  const ts =
    typeof entry.ts === "number" && Number.isFinite(entry.ts) ? Math.trunc(entry.ts) : nowMs;
  const level =
    entry.level === "info" || entry.level === "warn" || entry.level === "error"
      ? entry.level
      : inferLogLevel(type);

  return {
    ...entry,
    ts,
    level,
    component:
      typeof entry.component === "string" && entry.component ? entry.component : "mux-server",
  };
}

export function formatLogLine(entry: LogEvent): string {
  const ts =
    typeof entry.ts === "number" && Number.isFinite(entry.ts) ? Math.trunc(entry.ts) : Date.now();
  const payload = { ...entry, ts };
  return `${new Date(ts).toISOString()} ${JSON.stringify(payload)}\n`;
}
