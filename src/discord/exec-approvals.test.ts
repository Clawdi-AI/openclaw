import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const resolveEffectiveExecApprovalApproversMock = vi.hoisted(() => vi.fn());

vi.mock("../infra/exec-approval-approvers.js", () => ({
  resolveEffectiveExecApprovalApprovers: (...args: unknown[]) =>
    resolveEffectiveExecApprovalApproversMock(...args),
}));

import {
  getDiscordExecApprovalApprovers,
  isDiscordExecApprovalClientEnabled,
  resolveDiscordExecApprovalSourceUserId,
} from "./exec-approvals.js";

function buildConfig(
  execApprovals?: NonNullable<NonNullable<OpenClawConfig["channels"]>["discord"]>["execApprovals"],
): OpenClawConfig {
  return {
    channels: {
      discord: {
        token: "tok",
        execApprovals,
      },
    },
  } as OpenClawConfig;
}

describe("discord exec approvals", () => {
  beforeEach(() => {
    resolveEffectiveExecApprovalApproversMock.mockReset();
    resolveEffectiveExecApprovalApproversMock.mockImplementation(
      (params: { configuredApprovers?: Array<string | number> }) =>
        (params.configuredApprovers ?? []).map(String),
    );
  });

  it("requires enablement and at least one effective approver", () => {
    expect(isDiscordExecApprovalClientEnabled({ cfg: buildConfig() })).toBe(false);
    expect(
      isDiscordExecApprovalClientEnabled({
        cfg: buildConfig({ enabled: true, approvers: [] }),
      }),
    ).toBe(false);
    expect(
      isDiscordExecApprovalClientEnabled({
        cfg: buildConfig({ enabled: true, approvers: ["123"] }),
      }),
    ).toBe(true);
  });

  it("treats the active discord DM as an approval client when dm delivery is enabled", () => {
    expect(
      isDiscordExecApprovalClientEnabled({
        cfg: buildConfig({ enabled: true, approvers: [], target: "dm" }),
        accountId: "default",
        turnSourceChannel: "discord",
        turnSourceTo: "user:4242",
        turnSourceAccountId: "default",
      }),
    ).toBe(true);
    expect(
      isDiscordExecApprovalClientEnabled({
        cfg: buildConfig({ enabled: true, approvers: [], target: "channel" }),
        accountId: "default",
        turnSourceChannel: "discord",
        turnSourceTo: "user:4242",
        turnSourceAccountId: "default",
      }),
    ).toBe(false);
  });

  it("includes paired identities in effective approvers", () => {
    resolveEffectiveExecApprovalApproversMock.mockReturnValueOnce(["4242"]);
    resolveEffectiveExecApprovalApproversMock.mockReturnValueOnce(["4242"]);

    const cfg = buildConfig({ enabled: true, approvers: [] });
    expect(isDiscordExecApprovalClientEnabled({ cfg })).toBe(true);
    expect(getDiscordExecApprovalApprovers({ cfg })).toEqual(["4242"]);
  });

  it("extracts the discord source user only for matching discord accounts", () => {
    expect(
      resolveDiscordExecApprovalSourceUserId({
        accountId: "default",
        turnSourceChannel: "discord",
        turnSourceTo: "user:4242",
        turnSourceAccountId: "default",
      }),
    ).toBe("4242");
    expect(
      resolveDiscordExecApprovalSourceUserId({
        accountId: "default",
        turnSourceChannel: "discord",
        turnSourceTo: "user:4242",
        turnSourceAccountId: "other",
      }),
    ).toBeNull();
    expect(
      resolveDiscordExecApprovalSourceUserId({
        accountId: "default",
        turnSourceChannel: "telegram",
        turnSourceTo: "user:4242",
        turnSourceAccountId: "default",
      }),
    ).toBeNull();
  });
});
