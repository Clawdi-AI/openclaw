import { describe, expect, it } from "vitest";
import { resolveLastChannelRaw, resolveLastToRaw } from "./session-delivery.js";

describe("inter-session lastRoute preservation (fixes #54441)", () => {
  it("inter-session message does NOT overwrite established Discord lastChannel", () => {
    expect(
      resolveLastChannelRaw({
        originatingChannelRaw: "webchat",
        persistedLastChannel: "discord",
        sessionKey: "agent:samantha:main",
        isInterSession: true,
      }),
    ).toBe("discord");
  });

  it("inter-session message does NOT overwrite established Telegram lastChannel", () => {
    expect(
      resolveLastChannelRaw({
        originatingChannelRaw: "webchat",
        persistedLastChannel: "telegram",
        sessionKey: "agent:main:telegram:direct:123456",
        isInterSession: true,
      }),
    ).toBe("telegram");
  });

  it("inter-session message does NOT overwrite established external lastTo", () => {
    expect(
      resolveLastToRaw({
        originatingChannelRaw: "webchat",
        originatingToRaw: "session:somekey",
        toRaw: "session:somekey",
        persistedLastTo: "channel:1234567890",
        persistedLastChannel: "discord",
        sessionKey: "agent:samantha:main",
        isInterSession: true,
      }),
    ).toBe("channel:1234567890");
  });

  it("regular Discord user message DOES update lastChannel normally", () => {
    expect(
      resolveLastChannelRaw({
        originatingChannelRaw: "discord",
        persistedLastChannel: "discord",
        sessionKey: "agent:main:discord:channel:123",
        isInterSession: false,
      }),
    ).toBe("discord");
  });

  it("inter-session on a NEW session (no persisted external route) may set webchat", () => {
    // When there is no established external route, inter-session should not
    // forcefully block the update — the session has no external route to protect.
    const result = resolveLastChannelRaw({
      originatingChannelRaw: "webchat",
      persistedLastChannel: undefined,
      sessionKey: "agent:samantha:main",
      isInterSession: true,
    });
    // No external route existed — falls through to normal resolution (webchat or undefined).
    expect(["webchat", undefined]).toContain(result);
  });

  it("inter-session on session with no persisted lastTo preserves session route", () => {
    const result = resolveLastToRaw({
      originatingChannelRaw: "webchat",
      originatingToRaw: "session:somekey",
      toRaw: "session:somekey",
      persistedLastTo: undefined,
      persistedLastChannel: undefined,
      sessionKey: "agent:samantha:main",
      isInterSession: true,
    });
    // No external route — falls through to normal resolution
    expect(["session:somekey", undefined]).toContain(result);
  });
});

describe("session delivery preserves whatsapp chatJid", () => {
  // Regression: msg-router (and the legacy mux-server it replaces) bind
  // by chatJid (e.g. Baileys JIDs like `15105989468:0@s.whatsapp.net`).
  // Any rewrite of originatingTo or persistedLastTo along the reply /
  // cron path produces a mismatched chatJid and a 403 "route not bound".

  const baileysJid = "whatsapp:15105989468:0@s.whatsapp.net";

  it("preserves a fresh inbound whatsapp JID for the reply path", () => {
    expect(
      resolveLastToRaw({
        originatingChannelRaw: "whatsapp",
        originatingToRaw: baileysJid,
        persistedLastChannel: "whatsapp",
        persistedLastTo: undefined,
        sessionKey: "agent:main:main",
      }),
    ).toBe(baileysJid);
  });

  it("preserves a persisted whatsapp JID for the cron path (no fresh inbound)", () => {
    expect(
      resolveLastToRaw({
        originatingChannelRaw: undefined,
        originatingToRaw: undefined,
        persistedLastChannel: "whatsapp",
        persistedLastTo: baileysJid,
        sessionKey: "agent:main:cron:job-1",
      }),
    ).toBe(baileysJid);
  });

  it("preserves a persisted whatsapp JID when a cron turn's internal origin is webchat", () => {
    // Cron jobs often run with an internal/webchat-like origin for the
    // current turn, but should still deliver back over the previously
    // known external whatsapp route without rewriting the chatJid.
    expect(
      resolveLastToRaw({
        originatingChannelRaw: "webchat",
        originatingToRaw: "session:dashboard",
        persistedLastChannel: "whatsapp",
        persistedLastTo: baileysJid,
        sessionKey: "agent:main:cron:job-1",
      }),
    ).toBe(baileysJid);
  });
});

describe("session delivery direct-session routing overrides", () => {
  it.each([
    "agent:main:direct:user-1",
    "agent:main:telegram:direct:123456",
    "agent:main:telegram:account-a:direct:123456",
    "agent:main:telegram:dm:123456",
    "agent:main:telegram:direct:123456:thread:99",
    "agent:main:telegram:account-a:direct:123456:topic:ops",
  ])(
    "preserves persisted external route when webchat accesses channel-peer session %s (fixes #47745)",
    (sessionKey) => {
      // Webchat/dashboard viewing an external-channel session must not overwrite
      // the delivery route — subagents must still deliver to the original channel.
      expect(
        resolveLastChannelRaw({
          originatingChannelRaw: "webchat",
          persistedLastChannel: "telegram",
          sessionKey,
        }),
      ).toBe("telegram");
      expect(
        resolveLastToRaw({
          originatingChannelRaw: "webchat",
          originatingToRaw: "session:dashboard",
          persistedLastChannel: "telegram",
          persistedLastTo: "123456",
          sessionKey,
        }),
      ).toBe("123456");
    },
  );

  it.each([
    "agent:main:main:direct",
    "agent:main:cron:job-1:dm",
    "agent:main:subagent:worker:direct:user-1",
    "agent:main:telegram:channel:direct",
    "agent:main:telegram:account-a:direct",
    "agent:main:telegram:direct:123456:cron:job-1",
  ])("keeps persisted external routes for malformed direct-like key %s", (sessionKey) => {
    expect(
      resolveLastChannelRaw({
        originatingChannelRaw: "webchat",
        persistedLastChannel: "telegram",
        sessionKey,
      }),
    ).toBe("telegram");
    expect(
      resolveLastToRaw({
        originatingChannelRaw: "webchat",
        originatingToRaw: "session:dashboard",
        persistedLastChannel: "telegram",
        persistedLastTo: "group:12345",
        sessionKey,
      }),
    ).toBe("group:12345");
  });
});
