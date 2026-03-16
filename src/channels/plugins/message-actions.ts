import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../../config/config.js";
import { discordMessageActions } from "./actions/discord.js";
import { signalMessageActions } from "./actions/signal.js";
import { telegramMessageActions } from "./actions/telegram.js";
import { getChannelPlugin, listChannelPlugins } from "./index.js";
import { createSlackActions } from "./slack.actions.js";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelMessageActionName,
} from "./types.js";

const trustedRequesterRequiredByChannel: Readonly<
  Partial<Record<string, ReadonlySet<ChannelMessageActionName>>>
> = {
  discord: new Set<ChannelMessageActionName>(["timeout", "kick", "ban"]),
};

type ChannelActions = NonNullable<NonNullable<ReturnType<typeof getChannelPlugin>>["actions"]>;

const BUILTIN_MESSAGE_ACTION_ADAPTERS: ReadonlyArray<
  readonly [string, ChannelMessageActionAdapter]
> = [
  ["discord", discordMessageActions],
  ["telegram", telegramMessageActions],
  ["signal", signalMessageActions],
  ["slack", createSlackActions("slack")],
];

function resolveChannelMessageActionAdapters(): Map<string, ChannelActions> {
  const fromRegistry = listChannelPlugins()
    .map((plugin) => (plugin.actions ? ([plugin.id, plugin.actions] as const) : null))
    .filter((entry): entry is readonly [string, ChannelActions] => Boolean(entry));

  // Fall back to built-in action adapters to keep message tool discovery and dispatch working
  // when the runtime plugin registry is not populated yet.
  return new Map<string, ChannelActions>([...BUILTIN_MESSAGE_ACTION_ADAPTERS, ...fromRegistry]);
}

export function getChannelMessageActionsAdapter(channel?: string): ChannelActions | undefined {
  const trimmed = channel?.trim();
  if (!trimmed) {
    return undefined;
  }
  return resolveChannelMessageActionAdapters().get(trimmed);
}

export function listChannelMessageActionAdapters(): Array<readonly [string, ChannelActions]> {
  return Array.from(resolveChannelMessageActionAdapters().entries());
}

function requiresTrustedRequesterSender(ctx: ChannelMessageActionContext): boolean {
  const actions = trustedRequesterRequiredByChannel[ctx.channel];
  return Boolean(actions?.has(ctx.action) && ctx.toolContext);
}

export function listChannelMessageActions(cfg: OpenClawConfig): ChannelMessageActionName[] {
  const actions = new Set<ChannelMessageActionName>(["send", "broadcast"]);
  for (const [, adapter] of listChannelMessageActionAdapters()) {
    const list = adapter.listActions?.({ cfg });
    if (!list) {
      continue;
    }
    for (const action of list) {
      actions.add(action);
    }
  }
  return Array.from(actions);
}

export function supportsChannelMessageButtons(cfg: OpenClawConfig): boolean {
  return supportsMessageFeature(cfg, (actions) => actions?.supportsButtons?.({ cfg }) === true);
}

export function supportsChannelMessageButtonsForChannel(params: {
  cfg: OpenClawConfig;
  channel?: string;
}): boolean {
  return supportsMessageFeatureForChannel(
    params,
    (actions) => actions.supportsButtons?.(params) === true,
  );
}

export function supportsChannelMessageCards(cfg: OpenClawConfig): boolean {
  return supportsMessageFeature(cfg, (actions) => actions?.supportsCards?.({ cfg }) === true);
}

export function supportsChannelMessageCardsForChannel(params: {
  cfg: OpenClawConfig;
  channel?: string;
}): boolean {
  return supportsMessageFeatureForChannel(
    params,
    (actions) => actions.supportsCards?.(params) === true,
  );
}

function supportsMessageFeature(
  cfg: OpenClawConfig,
  check: (actions: ChannelActions) => boolean,
): boolean {
  for (const [, adapter] of listChannelMessageActionAdapters()) {
    if (check(adapter)) {
      return true;
    }
  }
  return false;
}

function supportsMessageFeatureForChannel(
  params: {
    cfg: OpenClawConfig;
    channel?: string;
  },
  check: (actions: ChannelActions) => boolean,
): boolean {
  const adapter = getChannelMessageActionsAdapter(params.channel);
  return adapter ? check(adapter) : false;
}

export async function dispatchChannelMessageAction(
  ctx: ChannelMessageActionContext,
): Promise<AgentToolResult<unknown> | null> {
  if (requiresTrustedRequesterSender(ctx) && !ctx.requesterSenderId?.trim()) {
    throw new Error(
      `Trusted sender identity is required for ${ctx.channel}:${ctx.action} in tool-driven contexts.`,
    );
  }
  const adapter = getChannelMessageActionsAdapter(ctx.channel);
  if (!adapter?.handleAction) {
    return null;
  }
  if (adapter.supportsAction && !adapter.supportsAction({ action: ctx.action })) {
    return null;
  }
  return await adapter.handleAction(ctx);
}
