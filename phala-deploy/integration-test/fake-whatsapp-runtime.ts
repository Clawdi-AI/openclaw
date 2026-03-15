import type { PollInput } from "../../src/polls.js";
import type { ActiveWebListener, ActiveWebSendOptions } from "../../src/web/active-listener.js";
import { setActiveWebListener as setRealActiveWebListener } from "../../src/web/active-listener.js";
import type { WebInboundMessage, WebListenerCloseReason } from "../../src/web/inbound/types.js";

const controlUrl = process.env.MUX_FAKE_WHATSAPP_CONTROL_URL?.trim();
const pollIntervalMs = Number(process.env.MUX_FAKE_WHATSAPP_POLL_INTERVAL_MS || 50);

if (!controlUrl) {
  throw new Error("MUX_FAKE_WHATSAPP_CONTROL_URL is required for fake WhatsApp runtime");
}

type FakeInboundBatch = {
  items?: WebInboundMessage[];
};

async function postJson(path: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${controlUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`fake WhatsApp control POST ${path} failed (${response.status})`);
  }
}

async function takeInboundBatch(): Promise<WebInboundMessage[]> {
  const response = await fetch(`${controlUrl}/inbound/take`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`fake WhatsApp control GET /inbound/take failed (${response.status})`);
  }
  const body = (await response.json()) as FakeInboundBatch;
  return Array.isArray(body.items) ? body.items : [];
}

function createFakeListener(accountId: string): ActiveWebListener {
  return {
    sendMessage: async (
      to: string,
      text: string,
      mediaBuffer?: Buffer,
      mediaType?: string,
      options?: ActiveWebSendOptions,
    ) => {
      await postJson("/outbound/send-message", {
        accountId,
        to,
        text,
        hasMedia: Boolean(mediaBuffer),
        ...(mediaType ? { mediaType } : {}),
        ...(options ? { options } : {}),
      });
      return { messageId: `wa-out-${Date.now()}` };
    },
    sendPoll: async (to: string, poll: PollInput) => {
      await postJson("/outbound/send-message", {
        accountId,
        to,
        text: poll.question,
        hasMedia: false,
        options: { poll },
      });
      return { messageId: `wa-poll-${Date.now()}` };
    },
    sendReaction: async () => {},
    sendComposingTo: async (to: string) => {
      await postJson("/outbound/typing", { accountId, to });
    },
  };
}

export async function monitorWebInbox(options: {
  accountId: string;
  onMessage: (msg: WebInboundMessage) => Promise<void>;
}): Promise<
  ActiveWebListener & {
    close: () => Promise<void>;
    onClose: Promise<WebListenerCloseReason>;
    signalClose: (reason?: WebListenerCloseReason) => void;
  }
> {
  let closed = false;
  let interval: NodeJS.Timeout | undefined;
  let onCloseResolve: ((reason: WebListenerCloseReason) => void) | null = null;
  const onClose = new Promise<WebListenerCloseReason>((resolve) => {
    onCloseResolve = resolve;
  });
  const resolveClose = (reason: WebListenerCloseReason) => {
    if (!onCloseResolve) {
      return;
    }
    const resolver = onCloseResolve;
    onCloseResolve = null;
    resolver(reason);
  };

  const listener = createFakeListener(options.accountId);
  setRealActiveWebListener(options.accountId, listener);

  const poll = async () => {
    if (closed) {
      return;
    }
    const items = await takeInboundBatch();
    for (const message of items) {
      if (closed) {
        return;
      }
      await options.onMessage({
        ...message,
        sendComposing: async () => {
          await listener.sendComposingTo(message.from);
        },
        reply: async (text: string) => {
          await listener.sendMessage(message.from, text);
        },
        sendMedia: async () => {},
      });
    }
  };

  interval = setInterval(
    () => {
      void poll().catch((error) => {
        resolveClose({ isLoggedOut: false, error });
      });
    },
    Math.max(25, pollIntervalMs),
  );
  await poll();

  return {
    ...listener,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      if (interval) {
        clearInterval(interval);
        interval = undefined;
      }
      setRealActiveWebListener(options.accountId, null);
      resolveClose({ isLoggedOut: false });
    },
    onClose,
    signalClose: (reason?: WebListenerCloseReason) => {
      resolveClose(reason ?? { isLoggedOut: false });
    },
  };
}

export async function sendMessageWhatsApp(
  to: string,
  body: string,
  options: {
    mediaUrl?: string;
    accountId?: string;
  },
): Promise<{ messageId: string; toJid: string }> {
  const accountId = options.accountId?.trim() || "default";
  await postJson("/outbound/send-message", {
    accountId,
    to,
    text: body,
    hasMedia: Boolean(options.mediaUrl),
  });
  return { messageId: `wa-out-${Date.now()}`, toJid: to };
}

export async function sendTypingWhatsApp(
  to: string,
  options: { accountId?: string },
): Promise<void> {
  await postJson("/outbound/typing", {
    accountId: options.accountId?.trim() || "default",
    to,
  });
}

export function setActiveWebListener(
  accountId: string | null | undefined,
  listener: ActiveWebListener | null,
): void {
  setRealActiveWebListener(accountId, listener);
}
