import type { ReplyPayload } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveEffectiveExecApprovalApprovers } from "../infra/exec-approval-approvers.js";
import { getExecApprovalReplyMetadata } from "../infra/exec-approval-reply.js";
import { resolveDiscordAccount } from "./accounts.js";

export function getDiscordExecApprovalApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  return resolveEffectiveExecApprovalApprovers({
    channel: "discord",
    accountId: params.accountId,
    configuredApprovers: resolveDiscordAccount(params).config.execApprovals?.approvers,
  });
}

export function isDiscordExecApprovalClientEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  const config = resolveDiscordAccount(params).config.execApprovals;
  return Boolean(config?.enabled && getDiscordExecApprovalApprovers(params).length > 0);
}

export function shouldSuppressLocalDiscordExecApprovalPrompt(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: ReplyPayload;
}): boolean {
  return (
    isDiscordExecApprovalClientEnabled(params) &&
    getExecApprovalReplyMetadata(params.payload) !== null
  );
}
