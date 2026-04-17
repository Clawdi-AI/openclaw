// iMessage API service wrapping the Photon Advanced iMessage Kit SDK.
// SDK types are declared manually because the package does not ship typings.

export type IMessageSdkInstance = {
  messages: {
    sendMessage: (opts: { chatGuid: string; message: string }) => Promise<{ guid?: string }>;
  };
  attachments: {
    sendAttachment: (opts: { chatGuid: string; filePath: string }) => Promise<{ guid?: string }>;
    downloadAttachment: (guid: string) => Promise<Buffer>;
  };
  connect: () => Promise<void>;
  close: () => Promise<void>;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
  off: (event: string, listener: (...args: unknown[]) => void) => void;
};

export type IMessageHealth = {
  connected: boolean;
  loopStartedAtMs: number | null;
  lastSdkConnectedAtMs: number | null;
  lastSdkClosedAtMs: number | null;
  lastSdkErrorAtMs: number | null;
  lastSdkError: string | null;
  lastInboundSeenAtMs: number | null;
};

export function isIMessageSdkInstance(value: unknown): value is IMessageSdkInstance {
  return (
    typeof value === "object" &&
    value !== null &&
    "connect" in value &&
    "close" in value &&
    "messages" in value &&
    "attachments" in value &&
    "on" in value &&
    "off" in value
  );
}

export function createIMessageApiService(deps: {
  serverUrl: string;
  apiKey: string | null;
  log: (entry: Record<string, unknown>) => void;
  loadSdkFactory: () => Promise<
    (opts: { serverUrl: string; apiKey?: string; logLevel?: string }) => unknown
  >;
}) {
  const health: IMessageHealth = {
    connected: false,
    loopStartedAtMs: null,
    lastSdkConnectedAtMs: null,
    lastSdkClosedAtMs: null,
    lastSdkErrorAtMs: null,
    lastSdkError: null,
    lastInboundSeenAtMs: null,
  };

  let sdk: IMessageSdkInstance | null = null;

  function getSdk(): IMessageSdkInstance | null {
    return sdk;
  }

  function setSdk(next: IMessageSdkInstance | null): void {
    sdk = next;
  }

  function getHealth(): IMessageHealth {
    return health;
  }

  function markConnected(): void {
    health.connected = true;
    health.lastSdkConnectedAtMs = Date.now();
    health.lastSdkError = null;
    health.lastSdkErrorAtMs = null;
  }

  function markDisconnected(): void {
    health.connected = false;
    health.lastSdkClosedAtMs = Date.now();
  }

  function markError(error: unknown): void {
    health.connected = false;
    health.lastSdkError = String(error);
    health.lastSdkErrorAtMs = Date.now();
  }

  function markInboundSeen(): void {
    health.lastInboundSeenAtMs = Date.now();
  }

  async function createSdk(): Promise<IMessageSdkInstance> {
    const factory = await deps.loadSdkFactory();
    const sdkCandidate = factory({
      serverUrl: deps.serverUrl,
      ...(deps.apiKey ? { apiKey: deps.apiKey } : {}),
      logLevel: "info",
    });
    if (!isIMessageSdkInstance(sdkCandidate)) {
      throw new Error("Photon iMessage SDK returned unexpected shape");
    }
    return sdkCandidate;
  }

  async function sendMessage(params: {
    chatGuid: string;
    message: string;
  }): Promise<{ guid: string | null }> {
    const current = sdk;
    if (!current) {
      throw new Error("iMessage SDK not connected");
    }
    try {
      const result = await current.messages.sendMessage({
        chatGuid: params.chatGuid,
        message: params.message,
      });
      return { guid: typeof result?.guid === "string" ? result.guid : null };
    } catch (error) {
      deps.log({
        type: "imessage_send_message_error",
        chatGuid: params.chatGuid,
        error: String(error),
      });
      throw new Error("iMessage send failed", { cause: error });
    }
  }

  async function sendAttachment(params: {
    chatGuid: string;
    filePath: string;
  }): Promise<{ guid: string | null }> {
    const current = sdk;
    if (!current) {
      throw new Error("iMessage SDK not connected");
    }
    // HTTPS-only validation — prevents path traversal, SSRF, and local file injection.
    if (!params.filePath.toLowerCase().startsWith("https://")) {
      deps.log({
        type: "imessage_outbound_media_rejected",
        chatGuid: params.chatGuid,
        url: params.filePath,
        reason: "not https",
      });
      throw new Error("iMessage attachment URL must be https://");
    }
    try {
      const result = await current.attachments.sendAttachment({
        chatGuid: params.chatGuid,
        filePath: params.filePath,
      });
      return { guid: typeof result?.guid === "string" ? result.guid : null };
    } catch (error) {
      deps.log({
        type: "imessage_send_attachment_error",
        chatGuid: params.chatGuid,
        error: String(error),
      });
      throw new Error("iMessage attachment send failed", { cause: error });
    }
  }

  async function downloadAttachment(guid: string): Promise<Buffer | null> {
    const current = sdk;
    if (!current) {
      return null;
    }
    return downloadAttachmentWith(current, guid);
  }

  // Download attachment using a caller-provided SDK reference. Prefer this in
  // inbound handlers that captured the SDK BEFORE any await so that a concurrent
  // reconnect (setSdk(null)) does not silently drop attachment content mid-flight.
  async function downloadAttachmentWith(
    activeSdk: IMessageSdkInstance,
    guid: string,
  ): Promise<Buffer | null> {
    try {
      const buffer = await activeSdk.attachments.downloadAttachment(guid);
      return Buffer.isBuffer(buffer) ? buffer : null;
    } catch (error) {
      deps.log({ type: "imessage_attachment_download_error", guid, error: String(error) });
      return null;
    }
  }

  // Send the pairing notice through the current SDK. Throws on failure so the
  // caller can log full context (tenantId, chatGuid, phase). Mirrors
  // sendWhatsAppPairingNotice / discord notice semantics.
  async function sendPairingNotice(params: { chatGuid: string; text: string }): Promise<void> {
    try {
      await sendMessage({ chatGuid: params.chatGuid, message: params.text });
    } catch (error) {
      deps.log({
        type: "imessage_pairing_notice_failed",
        chatGuid: params.chatGuid,
        error: String(error),
      });
      throw error instanceof Error
        ? error
        : new Error("iMessage pairing notice failed", { cause: error });
    }
  }

  return {
    getSdk,
    setSdk,
    createSdk,
    getHealth,
    markConnected,
    markDisconnected,
    markError,
    markInboundSeen,
    sendMessage,
    sendAttachment,
    downloadAttachment,
    downloadAttachmentWith,
    sendPairingNotice,
  };
}
