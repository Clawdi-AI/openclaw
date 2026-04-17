import path from "node:path";
import { pathToFileURL } from "node:url";
import type { RequestClient } from "@buape/carbon";

type WebInboundMessage = {
  id?: string;
  from: string;
  to: string;
  accountId: string;
  body: string;
  timestamp?: number;
  chatType: "direct" | "group";
  chatId: string;
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
  mediaPath?: string;
  mediaType?: string;
  mediaUrl?: string;
};

type WebMonitorListener = {
  close: () => Promise<void>;
  onClose: Promise<{
    status?: number;
    isLoggedOut: boolean;
    error?: unknown;
  }>;
};

export type WebRuntimeModules = {
  monitorWebInbox: (options: {
    verbose: boolean;
    accountId: string;
    authDir: string;
    onMessage: (msg: WebInboundMessage) => Promise<void>;
    resolveAccessControl?: (params: {
      accountId: string;
      from: string;
      selfE164: string | null;
      senderE164: string | null;
      group: boolean;
      pushName?: string;
      isFromMe: boolean;
      messageTimestampMs?: number;
      connectedAtMs?: number;
      sock: {
        sendMessage: (jid: string, content: { text: string }) => Promise<unknown>;
      };
      remoteJid: string;
    }) => Promise<{
      allowed: boolean;
      shouldMarkRead: boolean;
      isSelfChat: boolean;
      resolvedAccountId: string;
    }>;
    mediaMaxMb?: number;
    sendReadReceipts?: boolean;
    debounceMs?: number;
    shouldDebounce?: (msg: WebInboundMessage) => boolean;
  }) => Promise<WebMonitorListener>;
  sendMessageWhatsApp: (
    to: string,
    body: string,
    options: {
      verbose: boolean;
      mediaUrl?: string;
      gifPlayback?: boolean;
      accountId?: string;
    },
  ) => Promise<{ messageId: string; toJid: string }>;
  sendTypingWhatsApp: (to: string, options: { accountId?: string }) => Promise<void>;
  setActiveWebListener: (accountId: string | null | undefined, listener: unknown) => void;
};

export type DiscordRuntimeModules = {
  sendMessageDiscord: (
    to: string,
    text: string,
    opts: {
      token?: string;
      rest?: RequestClient;
      mediaUrl?: string;
      verbose?: boolean;
      replyTo?: string;
    },
  ) => Promise<{ messageId: string; channelId: string }>;
};

export type IMessageSdkFactory = (opts: {
  serverUrl: string;
  apiKey?: string;
  logLevel?: string;
}) => unknown;

export type IMessageRuntimeModules = {
  createSdk: IMessageSdkFactory;
};

let webRuntimeModulesPromise: Promise<WebRuntimeModules> | null = null;
let discordRuntimeModulesPromise: Promise<DiscordRuntimeModules> | null = null;
let imessageRuntimeModulesPromise: Promise<IMessageRuntimeModules> | null = null;

export async function loadWebRuntimeModules(
  readNonEmptyString: (value: unknown) => string | null,
): Promise<WebRuntimeModules> {
  if (!webRuntimeModulesPromise) {
    webRuntimeModulesPromise = (async () => {
      const runtimeOverridePath = readNonEmptyString(process.env.MUX_WEB_RUNTIME_MODULE_PATH);
      if (runtimeOverridePath) {
        const overrideHref = pathToFileURL(path.resolve(runtimeOverridePath)).href;
        const runtimeModule = (await import(overrideHref)) as {
          monitorWebInbox?: WebRuntimeModules["monitorWebInbox"];
          sendMessageWhatsApp?: WebRuntimeModules["sendMessageWhatsApp"];
          sendTypingWhatsApp?: WebRuntimeModules["sendTypingWhatsApp"];
          setActiveWebListener?: WebRuntimeModules["setActiveWebListener"];
        };
        if (
          typeof runtimeModule.monitorWebInbox !== "function" ||
          typeof runtimeModule.sendMessageWhatsApp !== "function" ||
          typeof runtimeModule.sendTypingWhatsApp !== "function" ||
          typeof runtimeModule.setActiveWebListener !== "function"
        ) {
          throw new Error("failed to load WhatsApp runtime modules from override path");
        }
        return {
          monitorWebInbox: runtimeModule.monitorWebInbox,
          sendMessageWhatsApp: runtimeModule.sendMessageWhatsApp,
          sendTypingWhatsApp: runtimeModule.sendTypingWhatsApp,
          setActiveWebListener: runtimeModule.setActiveWebListener,
        };
      }
      const inboundModulePath = "../../../src/web/inbound.js";
      const outboundModulePath = "../../../src/web/outbound.js";
      const activeListenerModulePath = "../../../src/web/active-listener.js";
      const inboundModule = (await import(inboundModulePath)) as {
        monitorWebInbox?: WebRuntimeModules["monitorWebInbox"];
      };
      const outboundModule = (await import(outboundModulePath)) as {
        sendMessageWhatsApp?: WebRuntimeModules["sendMessageWhatsApp"];
        sendTypingWhatsApp?: WebRuntimeModules["sendTypingWhatsApp"];
      };
      const activeListenerModule = (await import(activeListenerModulePath)) as {
        setActiveWebListener?: WebRuntimeModules["setActiveWebListener"];
      };
      if (
        typeof inboundModule.monitorWebInbox !== "function" ||
        typeof outboundModule.sendMessageWhatsApp !== "function" ||
        typeof outboundModule.sendTypingWhatsApp !== "function" ||
        typeof activeListenerModule.setActiveWebListener !== "function"
      ) {
        throw new Error("failed to load WhatsApp runtime modules");
      }
      return {
        monitorWebInbox: inboundModule.monitorWebInbox,
        sendMessageWhatsApp: outboundModule.sendMessageWhatsApp,
        sendTypingWhatsApp: outboundModule.sendTypingWhatsApp,
        setActiveWebListener: activeListenerModule.setActiveWebListener,
      };
    })();
  }
  return await webRuntimeModulesPromise;
}

export async function loadDiscordRuntimeModules(): Promise<DiscordRuntimeModules> {
  if (!discordRuntimeModulesPromise) {
    discordRuntimeModulesPromise = (async () => {
      const outboundModulePath = "../../../src/discord/send.outbound.js";
      const outboundModule = (await import(outboundModulePath)) as {
        sendMessageDiscord?: DiscordRuntimeModules["sendMessageDiscord"];
      };
      if (typeof outboundModule.sendMessageDiscord !== "function") {
        throw new Error("failed to load Discord runtime modules");
      }
      return {
        sendMessageDiscord: outboundModule.sendMessageDiscord,
      };
    })();
  }
  return await discordRuntimeModulesPromise;
}

export async function loadIMessageRuntimeModules(): Promise<IMessageRuntimeModules> {
  if (!imessageRuntimeModulesPromise) {
    imessageRuntimeModulesPromise = (async () => {
      // Dynamic import — the SDK is an optional peer dependency loaded only when
      // MUX_IMESSAGE_SERVER_URL is set. It has no shipped typings, so we validate the
      // factory shape at runtime.
      const sdkModule = (await import("@photon-ai/advanced-imessage-kit")) as {
        SDK?: unknown;
      };
      if (typeof sdkModule.SDK !== "function") {
        throw new Error("failed to load Photon iMessage SDK runtime module");
      }
      const factory = sdkModule.SDK as IMessageSdkFactory;
      return { createSdk: factory };
    })();
  }
  return await imessageRuntimeModulesPromise;
}
