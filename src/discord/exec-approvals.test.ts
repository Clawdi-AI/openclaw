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

  it("includes paired identities in effective approvers", () => {
    resolveEffectiveExecApprovalApproversMock.mockReturnValueOnce(["4242"]);
    resolveEffectiveExecApprovalApproversMock.mockReturnValueOnce(["4242"]);

    const cfg = buildConfig({ enabled: true, approvers: [] });
    expect(isDiscordExecApprovalClientEnabled({ cfg })).toBe(true);
    expect(getDiscordExecApprovalApprovers({ cfg })).toEqual(["4242"]);
  });
});
