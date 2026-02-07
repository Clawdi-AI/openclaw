export type ChannelMuxConfig = {
  /** Enable mux transport for this channel/account. */
  enabled?: boolean;
  /** Base URL for mux API (for example, http://mux.local:8080). */
  baseUrl?: string;
  /** Tenant-scoped API key used by OpenClaw when calling mux. */
  apiKey?: string;
  /** Request timeout in milliseconds (default: 30000). */
  timeoutMs?: number;
};
