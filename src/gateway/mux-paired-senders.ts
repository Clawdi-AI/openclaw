import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveOAuthDir, resolveStateDir } from "../config/paths.js";
import { withFileLock as withPathLock } from "../infra/file-lock.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { writeJsonFileAtomically, readJsonFileWithFallback } from "../plugin-sdk/json-store.js";
import { normalizeAccountId } from "../routing/session-key.js";

type MuxPairingChannel = "telegram" | "discord" | "whatsapp";

type MuxPairedSendersStore = {
  version: 1;
  routes: Record<string, string[]>;
};

const LOCK_OPTIONS = {
  retries: {
    retries: 10,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 10_000,
    randomize: true,
  },
  stale: 30_000,
} as const;

function safeToken(value: string): string {
  const raw = value.trim().toLowerCase();
  if (!raw) {
    throw new Error("invalid mux sender store token");
  }
  const safe = raw.replace(/[\\/:*?"<>|]/g, "_").replace(/\.\./g, "_");
  if (!safe || safe === "_") {
    throw new Error("invalid mux sender store token");
  }
  return safe;
}

function resolveCredentialsDir(env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = resolveStateDir(env, () => resolveRequiredHomeDir(env, os.homedir));
  return resolveOAuthDir(env, stateDir);
}

function resolveStorePath(
  channel: MuxPairingChannel,
  accountId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(
    resolveCredentialsDir(env),
    `${safeToken(channel)}-${safeToken(accountId)}-mux-paired-senders.json`,
  );
}

async function ensureJsonFile(filePath: string) {
  try {
    await fs.access(filePath);
  } catch {
    await writeJsonFileAtomically(filePath, {
      version: 1,
      routes: {},
    } satisfies MuxPairedSendersStore);
  }
}

async function withStoreLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  await ensureJsonFile(filePath);
  return await withPathLock(filePath, LOCK_OPTIONS, fn);
}

async function readStore(filePath: string): Promise<MuxPairedSendersStore> {
  const { value } = await readJsonFileWithFallback<MuxPairedSendersStore>(filePath, {
    version: 1,
    routes: {},
  });
  return value;
}

function normalizeRouteKey(routeKey: string): string {
  return routeKey.trim();
}

function normalizeSenderId(senderId: string): string {
  return senderId.trim();
}

export function resolveMuxPairingAnchorRouteKey(routeKey: string): string {
  const raw = normalizeRouteKey(routeKey);
  // Telegram pairing is chat-scoped, so any topic-specific route collapses to the parent chat.
  const telegram = raw.match(/^(telegram:[^:]+:chat:[^:]+)(?::topic:\d+)?$/i);
  if (telegram?.[1]) {
    return telegram[1];
  }
  // Discord guild pairing is guild-scoped, so channel/thread routes collapse to the guild anchor.
  const discordGuild = raw.match(
    /^discord:[^:]+:guild:[^:]+(?::channel:[^:]+)?(?::thread:[^:]+)?$/i,
  );
  if (discordGuild) {
    const guildOnly = raw.match(/^(discord:[^:]+:guild:[^:]+)/i);
    return guildOnly?.[1] ?? raw;
  }
  return raw;
}

export async function addMuxPairedSender(params: {
  channel: MuxPairingChannel;
  accountId?: string | null;
  routeKey: string;
  senderId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ changed: boolean; senders: string[] }> {
  const routeKey = resolveMuxPairingAnchorRouteKey(params.routeKey);
  const senderId = normalizeSenderId(params.senderId);
  if (!routeKey || !senderId) {
    return { changed: false, senders: [] };
  }
  const accountId = normalizeAccountId(params.accountId);
  const filePath = resolveStorePath(params.channel, accountId, params.env);
  return await withStoreLock(filePath, async () => {
    const store = await readStore(filePath);
    const current = store.routes[routeKey] ?? [];
    if (current.includes(senderId)) {
      return { changed: false, senders: current };
    }
    const next = [...current, senderId];
    store.routes[routeKey] = next;
    await writeJsonFileAtomically(filePath, store);
    return { changed: true, senders: next };
  });
}

export async function readMuxPairedSenders(params: {
  channel: MuxPairingChannel;
  accountId?: string | null;
  routeKey: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string[]> {
  const routeKey = resolveMuxPairingAnchorRouteKey(params.routeKey);
  if (!routeKey) {
    return [];
  }
  const accountId = normalizeAccountId(params.accountId);
  const filePath = resolveStorePath(params.channel, accountId, params.env);
  return await withStoreLock(filePath, async () => {
    const store = await readStore(filePath);
    return store.routes[routeKey] ?? [];
  });
}
