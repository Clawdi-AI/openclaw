import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { loadSessionEntry as loadSessionEntryType } from "./session-utils.js";

const mocks = vi.hoisted(() => ({
  deliverOutboundPayloads: vi.fn(async () => []),
}));

const buildSessionLookup = (
  sessionKey: string,
  entry: {
    sessionId?: string;
    lastChannel?: string;
    lastTo?: string;
    updatedAt?: number;
  } = {},
): ReturnType<typeof loadSessionEntryType> => ({
  cfg: { session: { mainKey: "agent:main:main" } } as OpenClawConfig,
  storePath: "/tmp/sessions.json",
  store: {} as ReturnType<typeof loadSessionEntryType>["store"],
  entry: {
    sessionId: entry.sessionId ?? `sid-${sessionKey}`,
    updatedAt: entry.updatedAt ?? Date.now(),
    lastChannel: entry.lastChannel,
    lastTo: entry.lastTo,
  },
  canonicalKey: sessionKey,
  legacyKey: undefined,
});

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: mocks.deliverOutboundPayloads,
}));

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));
vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow: vi.fn(),
}));
vi.mock("../commands/agent.js", () => ({
  agentCommand: vi.fn(),
}));
vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(() => ({ session: { mainKey: "agent:main:main" } })),
}));
vi.mock("../config/sessions.js", () => ({
  updateSessionStore: vi.fn(),
}));
vi.mock("./session-utils.js", () => ({
  loadSessionEntry: vi.fn((sessionKey: string) =>
    buildSessionLookup(sessionKey, {
      lastChannel: "telegram",
      lastTo: "123",
    }),
  ),
  pruneLegacyStoreKeys: vi.fn(),
  resolveGatewaySessionStoreTarget: vi.fn(({ key }: { key: string }) => ({
    canonicalKey: key,
    storeKeys: [key],
  })),
}));

import type { CliDeps } from "../cli/deps.js";
import { agentCommand } from "../commands/agent.js";
import { updateSessionStore } from "../config/sessions.js";
import type { NodeEventContext } from "./server-node-events-types.js";
import { handleNodeEvent } from "./server-node-events.js";

const agentCommandMock = vi.mocked(agentCommand);
const updateSessionStoreMock = vi.mocked(updateSessionStore);

function buildCtx(): NodeEventContext {
  return {
    deps: {} as CliDeps,
    broadcast: () => {},
    nodeSendToSession: () => {},
    nodeSubscribe: () => {},
    nodeUnsubscribe: () => {},
    broadcastVoiceWakeChanged: () => {},
    addChatRun: () => {},
    removeChatRun: () => undefined,
    chatAbortControllers: new Map(),
    chatAbortedRuns: new Map(),
    chatRunBuffers: new Map(),
    chatDeltaSentAt: new Map(),
    dedupe: new Map(),
    agentRunSeq: new Map(),
    getHealthCache: () => null,
    refreshHealthSnapshot: async () => ({}) as never,
    loadGatewayModelCatalog: async () => [],
    logGateway: { warn: () => {} },
  };
}

describe("agent request receipt delivery", () => {
  beforeEach(() => {
    mocks.deliverOutboundPayloads.mockReset();
    mocks.deliverOutboundPayloads.mockResolvedValue([]);
    agentCommandMock.mockReset();
    agentCommandMock.mockResolvedValue({ status: "ok" } as never);
    updateSessionStoreMock.mockReset();
    updateSessionStoreMock.mockImplementation(async (_storePath, update) => {
      update({});
    });
  });

  it("passes sessionKey through receipt delivery", async () => {
    const ctx = buildCtx();

    await handleNodeEvent(ctx, "node-1", {
      event: "agent.request",
      payloadJSON: JSON.stringify({
        message: "summarize this",
        sessionKey: "agent:main:telegram:direct:123",
        deliver: true,
        receipt: true,
      }),
    });

    await Promise.resolve();

    expect(mocks.deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:telegram:direct:123",
      }),
    );
  });
});
