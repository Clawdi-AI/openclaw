import {
  firstDefined,
  isSenderIdAllowed,
  mergeDmAllowFromSources,
} from "../channels/allow-from.js";
import type { AllowlistMatch } from "../channels/allowlist-match.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

export type NormalizedAllowFrom = {
  entries: string[];
  usernames: string[];
  hasWildcard: boolean;
  hasEntries: boolean;
  invalidEntries: string[];
};

export type AllowFromMatch = AllowlistMatch<"wildcard" | "id" | "username">;

const warnedInvalidEntries = new Set<string>();
const log = createSubsystemLogger("telegram/bot-access");

function warnInvalidAllowFromEntries(entries: string[]) {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return;
  }
  for (const entry of entries) {
    if (warnedInvalidEntries.has(entry)) {
      continue;
    }
    warnedInvalidEntries.add(entry);
    log.warn(
      [
        "Invalid allowFrom entry:",
        JSON.stringify(entry),
        "- allowFrom/groupAllowFrom authorization expects Telegram sender user IDs or @usernames.",
        'To allow a Telegram group or supergroup, add its negative chat ID under "channels.telegram.groups" instead.',
      ].join(" "),
    );
  }
}

export const normalizeAllowFrom = (list?: Array<string | number>): NormalizedAllowFrom => {
  const entries = (list ?? []).map((value) => String(value).trim()).filter(Boolean);
  const hasWildcard = entries.includes("*");
  const normalized = entries
    .filter((value) => value !== "*")
    .map((value) => value.replace(/^(telegram|tg):/i, "").replace(/^@/, ""));
  const invalidEntries = normalized.filter((value) => /^-\d+$/.test(value));
  if (invalidEntries.length > 0) {
    warnInvalidAllowFromEntries([...new Set(invalidEntries)]);
  }
  const ids = normalized.filter((value) => /^\d+$/.test(value));
  const usernames = normalized
    .filter((value) => !/^\d+$/.test(value) && !/^-\d+$/.test(value))
    .map((value) => value.toLowerCase());
  return {
    entries: ids,
    usernames,
    hasWildcard,
    hasEntries: entries.length > 0,
    invalidEntries,
  };
};

export const normalizeDmAllowFromWithStore = (params: {
  allowFrom?: Array<string | number>;
  storeAllowFrom?: string[];
  dmPolicy?: string;
}): NormalizedAllowFrom => normalizeAllowFrom(mergeDmAllowFromSources(params));

export const normalizeAllowFromWithStore = (params: {
  allowFrom?: Array<string | number>;
  storeAllowFrom?: Array<string | number>;
}): NormalizedAllowFrom =>
  normalizeAllowFrom([...(params.allowFrom ?? []), ...(params.storeAllowFrom ?? [])]);

export const isSenderAllowed = (params: {
  allow: NormalizedAllowFrom;
  senderId?: string;
  senderUsername?: string;
}) => {
  const { allow, senderId, senderUsername } = params;
  if (isSenderIdAllowed(allow, senderId, true)) {
    return true;
  }
  return Boolean(senderUsername && allow.usernames.includes(senderUsername.toLowerCase()));
};

export { firstDefined };

export const resolveSenderAllowMatch = (params: {
  allow: NormalizedAllowFrom;
  senderId?: string;
  senderUsername?: string;
}): AllowFromMatch => {
  const { allow, senderId, senderUsername } = params;
  if (allow.hasWildcard) {
    return { allowed: true, matchKey: "*", matchSource: "wildcard" };
  }
  if (!allow.hasEntries) {
    return { allowed: false };
  }
  if (senderId && allow.entries.includes(senderId)) {
    return { allowed: true, matchKey: senderId, matchSource: "id" };
  }
  if (senderUsername && allow.usernames.includes(senderUsername.toLowerCase())) {
    return { allowed: true, matchKey: senderUsername, matchSource: "username" };
  }
  return { allowed: false };
};
