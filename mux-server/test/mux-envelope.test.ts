import { describe, expect, test } from "vitest";
import {
  buildTelegramCallbackInboundEnvelope,
  buildDiscordInboundEnvelope,
  buildIMessageInboundEnvelope,
  buildTelegramInboundEnvelope,
  buildWhatsAppInboundEnvelope,
  collectOutboundMediaUrls,
  normalizeMuxInboundAttachments,
  readOutboundOperation,
  readOutboundText,
} from "../src/mux-envelope.js";

describe("mux envelope helpers", () => {
  test("preserves raw outbound text", () => {
    const { text, hasText } = readOutboundText({
      text: "  /help  ",
    });
    expect(text).toBe("  /help  ");
    expect(hasText).toBe(true);
  });

  test("preserves outbound media url order and duplicates", () => {
    const mediaUrls = collectOutboundMediaUrls({
      mediaUrl: " https://one ",
      mediaUrls: ["https://two", " https://one ", "", "   ", 123],
    });
    expect(mediaUrls).toEqual([" https://one ", "https://two", " https://one "]);
  });

  test("parses outbound action envelope", () => {
    expect(readOutboundOperation({ op: "action", action: "typing" })).toEqual({
      op: "action",
      action: "typing",
    });
    expect(readOutboundOperation({ op: "typing" })).toEqual({
      op: "action",
      action: "typing",
    });
    expect(readOutboundOperation({})).toEqual({
      op: "send",
    });
  });

  test("builds telegram inbound envelope without rewriting body", () => {
    const envelope = buildTelegramInboundEnvelope({
      updateId: 42,
      sessionKey: "tg:chat:123",
      accountId: "mux",
      rawBody: "  keep this exactly  ",
      fromId: "111",
      chatId: "222",
      chatType: "direct",
      messageId: "777",
      timestampMs: 123456,
      routeKey: "telegram:default:chat:222",
      rawMessage: { id: 777 },
      rawUpdate: { update_id: 42 },
      media: [{ kind: "photo" }],
      attachments: [],
    });

    expect(envelope.body).toBe("  keep this exactly  ");
    expect(envelope.event.kind).toBe("message");
    expect((envelope.raw as { update: unknown }).update).toEqual({ update_id: 42 });
    expect(envelope.attachments).toBeUndefined();
    expect((envelope.channelData.telegram as { rawMessage: unknown }).rawMessage).toEqual({
      id: 777,
    });
  });

  test("builds telegram callback envelope with raw callback event", () => {
    const envelope = buildTelegramCallbackInboundEnvelope({
      updateId: 470,
      sessionKey: "tg:group:-100555",
      accountId: "default",
      rawBody: "commands_page_2:main",
      fromId: "1234",
      chatId: "-100555",
      chatType: "group",
      messageId: "777",
      timestampMs: 1700000001000,
      routeKey: "telegram:default:chat:-100555",
      callbackData: "commands_page_2:main",
      callbackQueryId: "cbq-1",
      rawCallbackQuery: { id: "cbq-1" },
      rawMessage: { message_id: 777 },
      rawUpdate: { update_id: 470 },
    });

    expect(envelope.eventId).toBe("tgcb:470");
    expect(envelope.event.kind).toBe("callback");
    expect(envelope.body).toBe("commands_page_2:main");
    expect((envelope.channelData.telegram as { callbackData: string }).callbackData).toBe(
      "commands_page_2:main",
    );
    expect((envelope.raw as { callbackQuery: { id: string } }).callbackQuery.id).toBe("cbq-1");
  });

  test("builds discord inbound envelope with url attachments", () => {
    const envelope = buildDiscordInboundEnvelope({
      messageId: "999",
      sessionKey: "dc:dm:42",
      accountId: "mux",
      rawBody: "",
      fromId: "42",
      channelId: "abc",
      guildId: null,
      routeKey: "discord:default:dm:user:42",
      chatType: "direct",
      timestampMs: 456789,
      rawMessage: { id: "999" },
      media: [{ id: "att1" }],
      attachments: [
        {
          type: "image",
          mimeType: "image/jpeg",
          fileName: "photo.jpg",
          url: "https://cdn.discordapp.com/attachments/123/456/photo.jpg",
        },
      ],
    });

    expect(envelope.body).toBe("");
    expect(envelope.attachments).toHaveLength(1);
    expect(envelope.attachments![0].url).toBe(
      "https://cdn.discordapp.com/attachments/123/456/photo.jpg",
    );
    expect(envelope.attachments![0].content).toBeUndefined();
    expect((envelope.channelData.discord as { rawMessage: unknown }).rawMessage).toEqual({
      id: "999",
    });
  });

  test("builds whatsapp inbound envelope without rewriting body", () => {
    const envelope = buildWhatsAppInboundEnvelope({
      messageId: "wa-1",
      sessionKey: "agent:main:whatsapp:group:120363000000@g.us",
      openclawAccountId: "mux",
      rawBody: "  /help  ",
      fromId: "15550001111",
      chatJid: "120363000000@g.us",
      routeKey: "whatsapp:default:chat:120363000000@g.us",
      accountId: "default",
      chatType: "group",
      timestampMs: 1234567,
      rawMessage: { id: "wa-1", chatId: "120363000000@g.us" },
      media: [{ mediaPath: "/tmp/cat.jpg", mediaType: "image/jpeg" }],
      attachments: [],
    });

    expect(envelope.channel).toBe("whatsapp");
    expect(envelope.body).toBe("  /help  ");
    expect(envelope.from).toBe("whatsapp:15550001111");
    expect(envelope.to).toBe("whatsapp:120363000000@g.us");
    expect((envelope.channelData.whatsapp as { rawMessage: unknown }).rawMessage).toEqual({
      id: "wa-1",
      chatId: "120363000000@g.us",
    });
  });

  test("normalizeMuxInboundAttachments accepts url-only attachments", () => {
    const result = normalizeMuxInboundAttachments([
      {
        type: "application",
        mimeType: "application/pdf",
        fileName: "report.pdf",
        url: "http://mux.local/v1/mux/files/telegram?fileId=abc",
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "application",
      mimeType: "application/pdf",
      fileName: "report.pdf",
      url: "http://mux.local/v1/mux/files/telegram?fileId=abc",
    });
    expect(result[0].content).toBeUndefined();
  });

  test("normalizeMuxInboundAttachments accepts content-only attachments", () => {
    const result = normalizeMuxInboundAttachments([
      {
        type: "image",
        mimeType: "image/png",
        fileName: "dot.png",
        content: "aWdub3Jl",
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "image",
      mimeType: "image/png",
      fileName: "dot.png",
      content: "aWdub3Jl",
    });
    expect(result[0].url).toBeUndefined();
  });

  test("normalizeMuxInboundAttachments rejects attachments with neither content nor url", () => {
    const result = normalizeMuxInboundAttachments([
      { type: "image", mimeType: "image/png", fileName: "dot.png" },
      { type: "file" },
    ]);
    expect(result).toHaveLength(0);
  });

  test("normalizeMuxInboundAttachments accepts attachments with both content and url", () => {
    const result = normalizeMuxInboundAttachments([
      {
        type: "image",
        mimeType: "image/jpeg",
        content: "aWdub3Jl",
        url: "https://example.com/img.jpg",
      },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("aWdub3Jl");
    expect(result[0].url).toBe("https://example.com/img.jpg");
  });

  test("builds imessage inbound envelope with stable eventId and route metadata", () => {
    const envelope = buildIMessageInboundEnvelope({
      messageId: "msg-abc",
      sessionKey: "agent:main:imessage:direct:CHAT-GUID",
      accountId: "default",
      body: "hello",
      from: "+14155550123",
      chatGuid: "iMessage;-;+14155550123",
      chatType: "direct",
      routeKey: "imessage:direct:iMessage;-;+14155550123",
      timestampMs: 1700000000000,
    });

    expect(envelope.eventId).toBe("imessage-msg-abc");
    expect(envelope.channel).toBe("imessage");
    expect(envelope.from).toBe("imessage:+14155550123");
    expect(envelope.to).toBe("imessage:iMessage;-;+14155550123");
    expect(envelope.sessionKey).toBe("agent:main:imessage:direct:CHAT-GUID");
    expect(envelope.chatType).toBe("direct");
    expect(envelope.attachments).toBeUndefined();
    const channelData = envelope.channelData as {
      chatGuid?: string;
      routeKey?: string;
      imessage?: { chatGuid?: string };
    };
    expect(channelData.chatGuid).toBe("iMessage;-;+14155550123");
    expect(channelData.routeKey).toBe("imessage:direct:iMessage;-;+14155550123");
    expect(channelData.imessage?.chatGuid).toBe("iMessage;-;+14155550123");
  });

  test("imessage inbound envelope preserves attachments when provided", () => {
    const envelope = buildIMessageInboundEnvelope({
      messageId: "msg-1",
      sessionKey: "agent:main:imessage:group:chat123",
      accountId: "default",
      body: "",
      from: "+1555",
      chatGuid: "chat123;+;+1234",
      chatType: "group",
      routeKey: "imessage:group:chat123;+;+1234",
      timestampMs: 42,
      media: [
        {
          type: "image",
          mimeType: "image/png",
          fileName: "photo.png",
          content: "aGVsbG8=",
        },
      ],
    });
    expect(envelope.attachments).toEqual([
      {
        type: "image",
        mimeType: "image/png",
        fileName: "photo.png",
        content: "aGVsbG8=",
      },
    ]);
    expect(envelope.chatType).toBe("group");
  });
});
