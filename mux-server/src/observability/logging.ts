export function normalizeObservabilityLogEvent(entry: Record<string, unknown>, nowMs = Date.now()) {
  const type = typeof entry.type === "string" ? entry.type : "event";
  const ts =
    typeof entry.ts === "number" && Number.isFinite(entry.ts) ? Math.trunc(entry.ts) : nowMs;
  const t = type.toLowerCase();
  const level =
    entry.level === "info" || entry.level === "warn" || entry.level === "error"
      ? entry.level
      : t.includes("error") || t.includes("fatal") || t.includes("failed")
        ? "error"
        : t.includes("warn") ||
            t.includes("invalid") ||
            t.includes("drop") ||
            t.includes("deferred") ||
            t.includes("degraded") ||
            t.includes("exhausted") ||
            t.includes("conflict")
          ? "warn"
          : "info";
  return {
    ...entry,
    ts,
    level,
    component:
      typeof entry.component === "string" && entry.component ? entry.component : "mux-server",
  };
}

export function formatObservabilityLogLine(entry: Record<string, unknown>) {
  const ts =
    typeof entry.ts === "number" && Number.isFinite(entry.ts) ? Math.trunc(entry.ts) : Date.now();
  return `${new Date(ts).toISOString()} ${JSON.stringify({ ...entry, ts })}\n`;
}
