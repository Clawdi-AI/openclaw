import { describe, expect, it, vi, beforeEach } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  shouldGenerateTitle,
  buildTitlePrompt,
  cleanGeneratedTitle,
} from "./session-auto-title.js";

describe("shouldGenerateTitle", () => {
  const base = {
    success: true,
    trigger: "user" as string | undefined,
    sessionKey: "agent:main:main",
    messages: [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there!" },
    ],
    existingLabel: undefined as string | undefined,
  };

  it("returns true for first successful user exchange without label", () => {
    expect(shouldGenerateTitle(base)).toBe(true);
  });

  it("returns false when success is false", () => {
    expect(shouldGenerateTitle({ ...base, success: false })).toBe(false);
  });

  it("returns false for non-user triggers", () => {
    for (const trigger of ["cron", "heartbeat", "memory", "manual", "overflow"]) {
      expect(shouldGenerateTitle({ ...base, trigger })).toBe(false);
    }
  });

  it("returns false for subagent sessions", () => {
    expect(shouldGenerateTitle({ ...base, sessionKey: "agent:main:subagent:task1" })).toBe(false);
  });

  it("returns false for temp sessions", () => {
    expect(shouldGenerateTitle({ ...base, sessionKey: "temp:slug-gen" })).toBe(false);
  });

  it("returns false when session already has a label", () => {
    expect(shouldGenerateTitle({ ...base, existingLabel: "My Topic" })).toBe(false);
  });

  it("returns false when multiple assistant messages exist", () => {
    expect(
      shouldGenerateTitle({
        ...base,
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hi!" },
          { role: "user", content: "More" },
          { role: "assistant", content: "Sure" },
        ],
      }),
    ).toBe(false);
  });

  it("returns false when no assistant message exists", () => {
    expect(shouldGenerateTitle({ ...base, messages: [{ role: "user", content: "Hello" }] })).toBe(
      false,
    );
  });

  it("returns false when sessionKey is falsy", () => {
    expect(shouldGenerateTitle({ ...base, sessionKey: "" })).toBe(false);
  });
});

describe("buildTitlePrompt", () => {
  it("extracts user and assistant content", () => {
    const prompt = buildTitlePrompt([
      { role: "user", content: "How do I set up a Telegram bot?" },
      { role: "assistant", content: "Talk to BotFather first." },
    ]);
    expect(prompt).toContain("How do I set up a Telegram bot?");
    expect(prompt).toContain("Talk to BotFather");
  });

  it("truncates long content", () => {
    const prompt = buildTitlePrompt([
      { role: "user", content: "x".repeat(2000) },
      { role: "assistant", content: "y".repeat(2000) },
    ]);
    expect(prompt.length).toBeLessThan(2000);
  });

  it("skips tool messages", () => {
    const prompt = buildTitlePrompt([
      { role: "user", content: "Search for X" },
      { role: "tool", content: "result data" },
      { role: "assistant", content: "I found X." },
    ]);
    expect(prompt).not.toContain("result data");
    expect(prompt).toContain("Search for X");
  });

  it("handles structured content blocks", () => {
    const prompt = buildTitlePrompt([
      { role: "user", content: [{ type: "text", text: "Structured message" }] },
      { role: "assistant", content: "Reply" },
    ]);
    expect(prompt).toContain("Structured message");
  });
});

describe("cleanGeneratedTitle", () => {
  it("strips surrounding quotes", () => {
    expect(cleanGeneratedTitle('"API Design"')).toBe("API Design");
    expect(cleanGeneratedTitle("'Bot Setup'")).toBe("Bot Setup");
  });

  it("truncates to 50 chars", () => {
    expect(cleanGeneratedTitle("A".repeat(80))!.length).toBeLessThanOrEqual(50);
  });

  it("trims whitespace", () => {
    expect(cleanGeneratedTitle("  Hello World  ")).toBe("Hello World");
  });

  it("returns null for empty input", () => {
    expect(cleanGeneratedTitle("")).toBeNull();
    expect(cleanGeneratedTitle("   ")).toBeNull();
  });
});

// Integration test for maybeGenerateSessionTitle
vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn().mockResolvedValue({}),
}));

vi.mock("../gateway/session-utils.js", () => ({
  loadSessionEntry: vi.fn().mockReturnValue({
    entry: { sessionId: "sess-1", label: undefined },
  }),
}));

vi.mock("./simple-completion-runtime.js", () => ({
  prepareSimpleCompletionModelForAgent: vi.fn().mockResolvedValue({
    selection: { provider: "anthropic", modelId: "claude-sonnet-4-6", agentDir: "/tmp" },
    model: { provider: "anthropic", id: "claude-sonnet-4-6" },
    auth: { apiKey: "sk-test", source: "env", mode: "api-key" },
  }),
  completeWithPreparedSimpleCompletionModel: vi.fn().mockResolvedValue({
    role: "assistant",
    content: [{ type: "text", text: "Telegram Bot Setup" }],
  }),
}));

vi.mock("./pi-embedded-utils.js", () => ({
  extractAssistantText: vi.fn().mockReturnValue("Telegram Bot Setup"),
}));

describe("maybeGenerateSessionTitle", () => {
  let maybeGenerateSessionTitle: typeof import("./session-auto-title.js").maybeGenerateSessionTitle;
  let callGatewayMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    ({ maybeGenerateSessionTitle } = await import("./session-auto-title.js"));
    const mod = await import("../gateway/call.js");
    callGatewayMock = mod.callGateway as unknown as ReturnType<typeof vi.fn>;
  });

  it("generates and patches label on first exchange", async () => {
    await maybeGenerateSessionTitle({
      success: true,
      trigger: "user",
      sessionKey: "agent:main:main",
      sessionId: "sess-1",
      agentId: "main",
      messages: [
        { role: "user", content: "How do I set up a Telegram bot?" },
        { role: "assistant", content: "Talk to BotFather first." },
      ],
      config: {} as unknown as OpenClawConfig,
    });

    expect(callGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "sessions.patch",
        params: expect.objectContaining({
          key: "agent:main:main",
          label: "Telegram Bot Setup",
        }),
      }),
    );
  });

  it("skips when trigger is not user", async () => {
    await maybeGenerateSessionTitle({
      success: true,
      trigger: "heartbeat",
      sessionKey: "agent:main:main",
      sessionId: "sess-1",
      agentId: "main",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi!" },
      ],
      config: {} as unknown as OpenClawConfig,
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("skips when session already has a label", async () => {
    const { loadSessionEntry } = await import("../gateway/session-utils.js");
    (loadSessionEntry as ReturnType<typeof vi.fn>).mockReturnValue({
      entry: { sessionId: "sess-1", label: "Existing" },
    });

    await maybeGenerateSessionTitle({
      success: true,
      trigger: "user",
      sessionKey: "agent:main:main",
      sessionId: "sess-1",
      agentId: "main",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi!" },
      ],
      config: {} as unknown as OpenClawConfig,
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("skips when loadSessionEntry throws", async () => {
    const { loadSessionEntry } = await import("../gateway/session-utils.js");
    (loadSessionEntry as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("store not found");
    });

    await maybeGenerateSessionTitle({
      success: true,
      trigger: "user",
      sessionKey: "agent:main:main",
      sessionId: "sess-1",
      agentId: "main",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi!" },
      ],
      config: {} as unknown as OpenClawConfig,
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("skips when sessionId changed (reset race)", async () => {
    const { loadSessionEntry } = await import("../gateway/session-utils.js");
    (loadSessionEntry as ReturnType<typeof vi.fn>).mockReturnValue({
      entry: { sessionId: "old-sess", label: undefined },
    });

    await maybeGenerateSessionTitle({
      success: true,
      trigger: "user",
      sessionKey: "agent:main:main",
      sessionId: "new-sess",
      agentId: "main",
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi!" },
      ],
      config: {} as unknown as OpenClawConfig,
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("retries with time suffix on label collision", async () => {
    const { loadSessionEntry } = await import("../gateway/session-utils.js");
    (loadSessionEntry as ReturnType<typeof vi.fn>).mockReturnValue({
      entry: { sessionId: "sess-1", label: undefined },
    });
    callGatewayMock
      .mockRejectedValueOnce(new Error("label already in use: Telegram Bot Setup"))
      .mockResolvedValueOnce({});

    await maybeGenerateSessionTitle({
      success: true,
      trigger: "user",
      sessionKey: "agent:main:main",
      sessionId: "sess-1",
      agentId: "main",
      messages: [
        { role: "user", content: "How do I set up a Telegram bot?" },
        { role: "assistant", content: "Talk to BotFather first." },
      ],
      config: {} as unknown as OpenClawConfig,
    });

    expect(callGatewayMock).toHaveBeenCalledTimes(2);
    const retryLabel = callGatewayMock.mock.calls[1][0].params.label;
    expect(retryLabel).toMatch(/^Telegram Bot Setup \(\d{2}:\d{2}\)$/);
  });
});
