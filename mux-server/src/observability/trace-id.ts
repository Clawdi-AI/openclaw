import { createHash } from "node:crypto";

type TracePart = string | number | null | undefined;

function normalizePart(value: TracePart): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed;
  }
  return "";
}

export function createTraceId(parts: TracePart[]): string {
  const joined = parts
    .map((part) => normalizePart(part))
    .filter((part) => part.length > 0)
    .join("|");
  const seed = joined || `fallback|${Date.now()}`;
  const digest = createHash("sha256").update(seed).digest("hex").slice(0, 20);
  return `mux_${digest}`;
}

export function createInboundTraceId(params: {
  channel: "telegram" | "discord" | "whatsapp";
  tenantId?: string;
  routeKey?: string;
  updateId?: number;
  messageId?: string;
}): string {
  return createTraceId([
    "inbound",
    params.channel,
    params.tenantId,
    params.routeKey,
    params.updateId,
    params.messageId,
  ]);
}
