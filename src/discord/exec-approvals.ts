import type { ReplyPayload } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveEffectiveExecApprovalApprovers } from "../infra/exec-approval-approvers.js";
import { getExecApprovalReplyMetadata } from "../infra/exec-approval-reply.js";
import { normalizeAccountId } from "../routing/session-key.js";
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
  turnSourceChannel?: string | null;
  turnSourceTo?: string | null;
  turnSourceAccountId?: string | null;
}): boolean {
  const config = resolveDiscordAccount(params).config.execApprovals;
  if (!config?.enabled) {
    return false;
  }
  if (getDiscordExecApprovalApprovers(params).length > 0) {
    return true;
  }
  const target = config.target ?? "dm";
  if (target !== "dm" && target !== "both") {
    return false;
  }
  return resolveDiscordExecApprovalSourceUserId(params) !== null;
}

export function resolveDiscordExecApprovalSourceUserId(params: {
  accountId?: string | null;
  turnSourceChannel?: string | null;
  turnSourceTo?: string | null;
  turnSourceAccountId?: string | null;
}): string | null {
  if (params.turnSourceChannel?.trim().toLowerCase() !== "discord") {
    return null;
  }
  const turnSourceAccountId = params.turnSourceAccountId?.trim();
  if (
    turnSourceAccountId &&
    normalizeAccountId(turnSourceAccountId) !== normalizeAccountId(params.accountId)
  ) {
    return null;
  }
  const target = params.turnSourceTo?.trim() ?? "";
  const userTarget = target.match(/^user:(.+)$/i)?.[1]?.trim();
  return userTarget || null;
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
