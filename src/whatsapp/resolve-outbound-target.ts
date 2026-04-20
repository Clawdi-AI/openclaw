import { missingTargetError } from "../infra/outbound/target-errors.js";
import { isWhatsAppGroupJid, normalizeWhatsAppTarget } from "./normalize.js";

// LID (Linked ID) targets are opaque privacy identifiers — the digits
// carry no phone-number information, so they cannot appear in an
// allowFrom list that's expressed as E.164. When outbound delivery
// targets a LID, the mux-server (not this agent) is the source of truth
// for who may be messaged: a LID only ever reaches us via an already
// claimed mux binding, which itself gated inbound. Skipping allowFrom
// for LID here is the same trust posture we apply to group JIDs.
const WHATSAPP_LID_TARGET_RE = /@(?:lid|hosted\.lid)$/i;

export type WhatsAppOutboundTargetResolution =
  | { ok: true; to: string }
  | { ok: false; error: Error };

export function resolveWhatsAppOutboundTarget(params: {
  to: string | null | undefined;
  allowFrom: Array<string | number> | null | undefined;
  mode: string | null | undefined;
}): WhatsAppOutboundTargetResolution {
  const trimmed = params.to?.trim() ?? "";
  const allowListRaw = (params.allowFrom ?? [])
    .map((entry) => String(entry).trim())
    .filter(Boolean);
  const hasWildcard = allowListRaw.includes("*");
  const allowList = allowListRaw
    .filter((entry) => entry !== "*")
    .map((entry) => normalizeWhatsAppTarget(entry))
    .filter((entry): entry is string => Boolean(entry));

  if (trimmed) {
    const normalizedTo = normalizeWhatsAppTarget(trimmed);
    if (!normalizedTo) {
      return {
        ok: false,
        error: missingTargetError("WhatsApp", "<E.164|group JID>"),
      };
    }
    if (isWhatsAppGroupJid(normalizedTo)) {
      return { ok: true, to: normalizedTo };
    }
    // LID targets pass the same trust gate as groups — mux-server already
    // gated which LIDs can reach this agent at pairing/binding time, so
    // re-gating via an E.164 allowFrom list here would be incorrect
    // (LIDs have no E.164 representation) and blocks legitimate replies
    // and cron deliveries to paired LID peers.
    if (WHATSAPP_LID_TARGET_RE.test(normalizedTo)) {
      return { ok: true, to: normalizedTo };
    }
    // Enforce allowFrom for all direct-message send modes (including explicit).
    // Group destinations are handled by group policy and are allowed above.
    if (hasWildcard || allowList.length === 0) {
      return { ok: true, to: normalizedTo };
    }
    if (allowList.includes(normalizedTo)) {
      return { ok: true, to: normalizedTo };
    }
    return {
      ok: false,
      error: missingTargetError("WhatsApp", "<E.164|group JID>"),
    };
  }

  return {
    ok: false,
    error: missingTargetError("WhatsApp", "<E.164|group JID>"),
  };
}
