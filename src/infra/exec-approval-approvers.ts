import { listMuxPairedSendersSync } from "../gateway/mux-paired-senders.js";
import { readChannelAllowFromStoreSync } from "../pairing/pairing-store.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";

type ExecApprovalChannel = "telegram" | "discord";

function normalizeApproverId(value: string | number): string {
  return String(value).trim();
}

export function resolveEffectiveExecApprovalApprovers(params: {
  channel: ExecApprovalChannel;
  accountId?: string | null;
  configuredApprovers?: Array<string | number>;
}): string[] {
  const approvers = new Set<string>();
  const rawAccountId = params.accountId?.trim();
  const accountScopes = rawAccountId ? [rawAccountId] : [undefined, DEFAULT_ACCOUNT_ID];
  for (const value of params.configuredApprovers ?? []) {
    const normalized = normalizeApproverId(value);
    if (normalized) {
      approvers.add(normalized);
    }
  }
  for (const accountId of accountScopes) {
    for (const value of readChannelAllowFromStoreSync(params.channel, process.env, accountId)) {
      const normalized = normalizeApproverId(value);
      if (normalized) {
        approvers.add(normalized);
      }
    }
    for (const value of listMuxPairedSendersSync({
      channel: params.channel,
      accountId,
      env: process.env,
    })) {
      const normalized = normalizeApproverId(value);
      if (normalized) {
        approvers.add(normalized);
      }
    }
  }
  return [...approvers];
}
