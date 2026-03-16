import { createHash } from "node:crypto";

export function createInboundTraceId(params: {
  channel: "telegram" | "discord" | "whatsapp";
  tenantId?: string;
  routeKey?: string;
  updateId?: number;
  messageId?: string;
}) {
  const seed = [
    "inbound",
    params.channel,
    params.tenantId?.trim() || "",
    params.routeKey?.trim() || "",
    typeof params.updateId === "number" && Number.isFinite(params.updateId)
      ? String(Math.trunc(params.updateId))
      : "",
    params.messageId?.trim() || "",
  ]
    .filter(Boolean)
    .join("|");
  const digest = createHash("sha256")
    .update(seed || `fallback|${Date.now()}`)
    .digest("hex")
    .slice(0, 20);
  return `mux_${digest}`;
}
