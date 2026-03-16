import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { defaultRuntime } from "../runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  __testing,
  listAllChannelSupportedActions,
  listChannelSupportedActions,
} from "./channel-tools.js";

describe("channel tools", () => {
  const errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);

  beforeEach(() => {
    const plugin: ChannelPlugin = {
      id: "test",
      meta: {
        id: "test",
        label: "Test",
        selectionLabel: "Test",
        docsPath: "/channels/test",
        blurb: "test plugin",
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({}),
      },
      actions: {
        listActions: () => {
          throw new Error("boom");
        },
      },
    };

    __testing.resetLoggedListActionErrors();
    errorSpy.mockClear();
    setActivePluginRegistry(createTestRegistry([{ pluginId: "test", source: "test", plugin }]));
  });

  afterEach(() => {
    setActivePluginRegistry(createTestRegistry([]));
    errorSpy.mockClear();
  });

  it("skips crashing plugins and logs once", () => {
    const cfg = {} as OpenClawConfig;
    expect(listAllChannelSupportedActions({ cfg })).toEqual([]);
    expect(errorSpy).toHaveBeenCalledTimes(1);

    expect(listAllChannelSupportedActions({ cfg })).toEqual([]);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("does not infer poll actions from outbound adapters when action discovery omits them", () => {
    const plugin: ChannelPlugin = {
      id: "polltest",
      meta: {
        id: "polltest",
        label: "Poll Test",
        selectionLabel: "Poll Test",
        docsPath: "/channels/polltest",
        blurb: "poll plugin",
      },
      capabilities: { chatTypes: ["direct"], polls: true },
      config: {
        listAccountIds: () => [],
        resolveAccount: () => ({}),
      },
      actions: {
        listActions: () => [],
      },
      outbound: {
        deliveryMode: "gateway",
        sendPoll: async () => ({ channel: "polltest", messageId: "poll-1" }),
      },
    };

    setActivePluginRegistry(createTestRegistry([{ pluginId: "polltest", source: "test", plugin }]));

    const cfg = {} as OpenClawConfig;
    expect(listChannelSupportedActions({ cfg, channel: "polltest" })).toEqual([]);
    expect(listAllChannelSupportedActions({ cfg })).toEqual([]);
  });

  it("falls back to built-in telegram actions when the registry is empty", () => {
    setActivePluginRegistry(createTestRegistry([]));

    const cfg = {
      channels: {
        telegram: {
          accounts: {
            mux: {
              mux: {
                enabled: true,
                baseUrl: "http://127.0.0.1:18788",
                authToken: "test-token",
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(listChannelSupportedActions({ cfg, channel: "telegram" })).toEqual(
      expect.arrayContaining(["send", "react", "poll", "delete", "edit", "topic-create"]),
    );
    expect(listAllChannelSupportedActions({ cfg })).toEqual(
      expect.arrayContaining(["send", "react", "poll", "delete", "edit", "topic-create"]),
    );
  });
});
