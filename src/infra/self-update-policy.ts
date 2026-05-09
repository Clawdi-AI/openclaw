export type SelfUpdatePolicy = {
  enabled?: boolean;
  reason?: string;
};

const DEFAULT_SELF_UPDATE_DISABLED_REASON =
  "Self-update is disabled for this deployment. Update it through the external deployment workflow instead of running OpenClaw's in-place updater.";

export function isSelfUpdateDisabled(policy?: SelfUpdatePolicy): boolean {
  return policy?.enabled === false;
}

export function resolveSelfUpdateDisabledReason(policy?: SelfUpdatePolicy): string {
  const reason = policy?.reason?.trim();
  if (!reason) {
    return DEFAULT_SELF_UPDATE_DISABLED_REASON;
  }
  return `Self-update is disabled: ${reason}`;
}
