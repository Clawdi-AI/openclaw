import { listMuxPairedSendersSync } from "../gateway/mux-paired-senders.js";
import { readChannelAllowFromStoreSync } from "../pairing/pairing-store.js";

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
  for (const value of params.configuredApprovers ?? []) {
    const normalized = normalizeApproverId(value);
    if (normalized) {
      approvers.add(normalized);
    }
  }
  for (const value of readChannelAllowFromStoreSync(
    params.channel,
    process.env,
    params.accountId,
  )) {
    const normalized = normalizeApproverId(value);
    if (normalized) {
      approvers.add(normalized);
    }
  }
  for (const value of listMuxPairedSendersSync({
    channel: params.channel,
    accountId: params.accountId,
    env: process.env,
  })) {
    const normalized = normalizeApproverId(value);
    if (normalized) {
      approvers.add(normalized);
    }
  }
  return [...approvers];
}
