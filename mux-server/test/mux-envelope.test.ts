import { describe, expect, test } from "vitest";
import {
  buildDiscordInboundEnvelope,
  buildTelegramInboundEnvelope,
  buildWhatsAppInboundEnvelope,
  collectOutboundMediaUrls,
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
    expect(envelope.attachments).toBeUndefined();
    expect((envelope.channelData.telegram as { rawMessage: unknown }).rawMessage).toEqual({
      id: 777,
    });
  });

  test("builds discord inbound envelope with optional attachments", () => {
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
          content: "ZmFrZQ==",
        },
      ],
    });

    expect(envelope.body).toBe("");
    expect(envelope.attachments).toHaveLength(1);
    expect((envelope.channelData.discord as { rawMessage: unknown }).rawMessage).toEqual({
      id: "999",
    });
  });

  test("builds whatsapp inbound envelope without rewriting body", () => {
    const envelope = buildWhatsAppInboundEnvelope({
      messageId: "wa-1",
      sessionKey: "wa:chat:120363000000@g.us",
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
});
