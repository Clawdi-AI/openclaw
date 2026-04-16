export type TenantSeed = {
  id: string;
  name: string;
  apiKey: string;
  inboundUrl?: string;
  inboundTimeoutMs: number;
};

export type TenantIdentity = {
  id: string;
  name: string;
  authToken: string;
  authKind: "api-key" | "runtime-jwt" | "admin";
};

export type PairingTokenRow = {
  tenant_id: string;
  session_key: string | null;
};

export type ExistingBindingRow = {
  binding_id: string;
  status?: string;
};

export type SessionRouteBindingRow = {
  binding_id: string;
  route_key: string;
  channel_context_json?: string | null;
};

export type SessionRouteByBindingRow = {
  session_key?: unknown;
  channel_context_json?: unknown;
};

export type ActiveBindingLookupRow = {
  tenant_id: string;
  binding_id: string;
};

export type LiveBindingLookupRow = {
  tenant_id: string;
  binding_id: string;
  status: string;
};

export type TelegramBoundRoute = {
  chatId: string;
  topicId?: number;
};

export type DiscordBoundRoute =
  | {
      kind: "dm";
      userId: string;
    }
  | {
      kind: "guild";
      guildId: string;
      channelId?: string;
      threadId?: string;
    };

export type DiscordOutboundTarget =
  | {
      kind: "user";
      id: string;
    }
  | {
      kind: "channel";
      id: string;
    };

export type WhatsAppBoundRoute = {
  accountId: string;
  chatJid: string;
};

export type ResolvedBoundRoute<T> = {
  route: T;
  routeKey: string;
  via: "session" | "route";
};

export type OutboundResolutionMode = "session-first" | "target-first";

export type TenantInboundTarget = {
  url: string;
  timeoutMs: number;
  openclawId: string;
  updatedAtMs: number | null;
};

export type NoticeChannel = "telegram" | "discord" | "whatsapp";

export type StyledNotice = {
  text: string;
  parseMode?: "HTML";
};

export type ClaimType = "fresh" | "repaired" | "takeover";

export type ClaimResult = {
  tenantId: string;
  bindingId: string;
  routeKey: string;
  sessionKey: string;
  claimType: ClaimType;
  previousTenantId?: string;
};
