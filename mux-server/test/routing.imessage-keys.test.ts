import { describe, expect, test } from "vitest";
import { buildIMessageRawSend } from "../../src/channels/plugins/mux-envelope.js";
import { listIMessageOutboundRouteKeys } from "../src/routing/keys.js";

describe("buildIMessageRawSend", () => {
  test("omits attachments key when none provided", () => {
    const env = buildIMessageRawSend({ text: "hi" });
    expect(env).toEqual({ send: { text: "hi" } });
  });

  test("includes attachments when provided", () => {
    const env = buildIMessageRawSend({
      text: "",
      attachments: [{ filename: "pic.jpg", contentType: "image/jpeg", dataBase64: "AAA" }],
    });
    expect(env.send.attachments).toEqual([
      { filename: "pic.jpg", contentType: "image/jpeg", dataBase64: "AAA" },
    ]);
  });

  test("mediaUrl and attachments can coexist", () => {
    const env = buildIMessageRawSend({
      text: "both",
      mediaUrl: "https://example/image.png",
      attachments: [{ filename: "x.pdf", contentType: "application/pdf", dataBase64: "BB" }],
    });
    expect(env.send.mediaUrl).toBe("https://example/image.png");
    expect(env.send.attachments).toHaveLength(1);
  });
});

describe("listIMessageOutboundRouteKeys", () => {
  test("returns empty for missing target", () => {
    expect(listIMessageOutboundRouteKeys({})).toEqual([]);
    expect(listIMessageOutboundRouteKeys({ requestedTo: "" })).toEqual([]);
  });

  test("full chat_guid stays canonical", () => {
    expect(
      listIMessageOutboundRouteKeys({
        requestedTo: "imessage:any;-;+15551234567",
      }),
    ).toEqual(["imessage:direct:any;-;+15551234567"]);
  });

  test("group chat_guid routes as group", () => {
    expect(
      listIMessageOutboundRouteKeys({
        requestedTo: "imessage:chat123;+;alice,bob",
      }),
    ).toEqual(["imessage:group:chat123;+;alice,bob"]);
  });

  // Bare handles (phone, email) are what openclaw actually sends when it
  // forwards agent replies — it normalizes "imessage:+15551234567" but
  // doesn't know to expand to the BlueBubbles chat_guid format. Without
  // this fallback every outbound hits 403 ROUTE_NOT_BOUND because pairing
  // stored "imessage:direct:any;-;+15551234567" as the binding key.
  test("bare phone yields both plain and any;-; chat_guid variants", () => {
    expect(
      listIMessageOutboundRouteKeys({
        requestedTo: "imessage:+15551234567",
      }),
    ).toEqual(["imessage:direct:+15551234567", "imessage:direct:any;-;+15551234567"]);
  });

  test("bare email yields both plain and any;-; chat_guid variants", () => {
    expect(
      listIMessageOutboundRouteKeys({
        requestedTo: "user@example.com",
      }),
    ).toEqual(["imessage:direct:user@example.com", "imessage:direct:any;-;user@example.com"]);
  });

  test("mismatched outer and inner guid returns empty", () => {
    expect(
      listIMessageOutboundRouteKeys({
        requestedTo: "imessage:+15551234567",
        rawSend: { to: "imessage:+14155550100" },
      }),
    ).toEqual([]);
  });

  test("rawSend chatGuid is honored when to is absent", () => {
    expect(
      listIMessageOutboundRouteKeys({
        rawSend: { chatGuid: "any;-;+15551234567" },
      }),
    ).toEqual(["imessage:direct:any;-;+15551234567"]);
  });
});
