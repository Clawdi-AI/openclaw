import type { AnyMessageContent } from "@whiskeysockets/baileys";
import type { NormalizedLocation } from "../../channels/location.js";

export type WebListenerCloseReason = {
  status?: number;
  isLoggedOut: boolean;
  error?: unknown;
};

export type WebInboundMessage = {
  id?: string;
  from: string; // conversation id: E.164 for direct chats, group JID for groups
  conversationId: string; // alias for clarity (same as from)
  to: string;
  accountId: string;
  body: string;
  pushName?: string;
  timestamp?: number;
  chatType: "direct" | "group";
  /**
   * Canonical chat identifier used by the rest of the pipeline.
   *
   * For DMs, this is the resolved canonical JID form `<e164-digits>@s.whatsapp.net`
   * derived from `inbound.from` (which the bridge already resolves via
   * `resolveJidToE164`, consulting the Baileys `lidMapping` when the WhatsApp
   * side addressed the peer by LID). When resolution is unavailable (stale
   * lidMapping, unknown peer) we fall back to the raw `remoteJid` so the
   * downstream pipeline still carries *something* to route on.
   *
   * For groups, this is the `@g.us` group JID — groups never have a LID form.
   *
   * The raw unresolved JID is separately exposed as `remoteJidRaw` so
   * consumers that still need the original addressing form (e.g. the
   * mux-server's legacy-binding fallback lookup) can see it explicitly
   * without mucking with `chatId`.
   */
  chatId: string;
  /**
   * The raw `remoteJid` emitted by Baileys, before any LID→E164 resolution.
   * Equals `chatId` for any peer WhatsApp already addresses by phone JID or
   * group JID; for LID peers this is the `<lid>@lid` form. Consumers
   * **should prefer `chatId`** — this field is for legacy-binding fallback
   * paths only.
   */
  remoteJidRaw?: string;
  senderJid?: string;
  senderE164?: string;
  senderName?: string;
  replyToId?: string;
  replyToBody?: string;
  replyToSender?: string;
  replyToSenderJid?: string;
  replyToSenderE164?: string;
  groupSubject?: string;
  groupParticipants?: string[];
  mentionedJids?: string[];
  selfJid?: string | null;
  selfE164?: string | null;
  fromMe?: boolean;
  location?: NormalizedLocation;
  sendComposing: () => Promise<void>;
  reply: (text: string) => Promise<void>;
  sendMedia: (payload: AnyMessageContent) => Promise<void>;
  mediaPath?: string;
  mediaType?: string;
  mediaFileName?: string;
  mediaUrl?: string;
  wasMentioned?: boolean;
};
