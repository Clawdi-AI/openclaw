import { describe, expect, it } from "vitest";
import { resolveLastChannelRaw, resolveLastToRaw } from "./session-delivery.js";

describe("session delivery preserves whatsapp chatJid for mux routing", () => {
  // Regression: the mux-server binds by chatJid (e.g. Baileys JIDs like
  // `15105989468:0@s.whatsapp.net`). Any rewrite of originatingTo or
  // persistedLastTo along the reply / cron path produces a mismatched
  // chatJid and a 403 "route not bound".

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
  ])("lets webchat override persisted routes for strict direct key %s", (sessionKey) => {
    expect(
      resolveLastChannelRaw({
        originatingChannelRaw: "webchat",
        persistedLastChannel: "telegram",
        sessionKey,
      }),
    ).toBe("webchat");
    expect(
      resolveLastToRaw({
        originatingChannelRaw: "webchat",
        originatingToRaw: "session:dashboard",
        persistedLastChannel: "telegram",
        persistedLastTo: "123456",
        sessionKey,
      }),
    ).toBe("session:dashboard");
  });

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
