import { resolveAgentDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { buildCommandsMessagePaginated } from "../auto-reply/commands-list.js";
import {
  buildModelsProviderData,
  formatModelsAvailableHeader,
} from "../auto-reply/reply/commands-models.js";
import { buildCommandsPaginationKeyboard } from "../auto-reply/reply/commands-pagination.js";
import { resolveStoredModelOverride } from "../auto-reply/reply/model-selection.js";
import { listSkillCommandsForAgents } from "../auto-reply/skill-commands.js";
import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore, resolveStorePath, updateSessionStore } from "../config/sessions.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import { resolveThreadSessionKeys } from "../routing/session-key.js";
import { applyModelOverrideToSessionEntry } from "../sessions/model-overrides.js";
import { buildTelegramGroupPeerId, resolveTelegramForumThreadId } from "./bot/helpers.js";
import {
  buildModelsKeyboard,
  buildProviderKeyboard,
  calculateTotalPages,
  getModelsPageSize,
  parseModelCallbackData,
  resolveModelSelection,
  type ProviderInfo,
} from "./model-buttons.js";

export type TelegramCallbackButton = { text: string; callback_data: string };
export type TelegramCallbackButtons = Array<Array<TelegramCallbackButton>>;

export type TelegramCallbackAction =
  | { kind: "noop" }
  | { kind: "edit"; text: string; buttons: TelegramCallbackButtons }
  | { kind: "forward"; text: string };

export type ResolveTelegramCallbackActionParams = {
  cfg: OpenClawConfig;
  accountId?: string;
  data: string;
  chatId: number | string;
  isGroup: boolean;
  isForum: boolean;
  messageThreadId?: number;
  resolvedThreadId?: number;
};

function resolveTelegramSessionState(params: ResolveTelegramCallbackActionParams): {
  agentId: string;
  sessionEntry: ReturnType<typeof loadSessionStore>[string] | undefined;
  sessionKey: string;
  model?: string;
} {
  const resolvedThreadId =
    params.resolvedThreadId ??
    resolveTelegramForumThreadId({
      isForum: params.isForum,
      messageThreadId: params.messageThreadId,
    });
  const peerId = params.isGroup
    ? buildTelegramGroupPeerId(params.chatId, resolvedThreadId)
    : String(params.chatId);
  const route = resolveAgentRoute({
    cfg: params.cfg,
    channel: "telegram",
    accountId: params.accountId,
    peer: {
      kind: params.isGroup ? "group" : "direct",
      id: peerId,
    },
  });
  const baseSessionKey = route.sessionKey;
  const dmThreadId = !params.isGroup ? params.messageThreadId : undefined;
  const threadKeys =
    dmThreadId != null
      ? resolveThreadSessionKeys({ baseSessionKey, threadId: String(dmThreadId) })
      : null;
  const sessionKey = threadKeys?.sessionKey ?? baseSessionKey;
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId: route.agentId });
  const store = loadSessionStore(storePath);
  const entry = store[sessionKey];
  const storedOverride = resolveStoredModelOverride({
    sessionEntry: entry,
    sessionStore: store,
    sessionKey,
  });
  if (storedOverride) {
    return {
      agentId: route.agentId,
      sessionEntry: entry,
      sessionKey,
      model: storedOverride.provider
        ? `${storedOverride.provider}/${storedOverride.model}`
        : storedOverride.model,
    };
  }
  const provider = entry?.modelProvider?.trim();
  const model = entry?.model?.trim();
  if (provider && model) {
    return {
      agentId: route.agentId,
      sessionEntry: entry,
      sessionKey,
      model: `${provider}/${model}`,
    };
  }
  const modelCfg = params.cfg.agents?.defaults?.model;
  return {
    agentId: route.agentId,
    sessionEntry: entry,
    sessionKey,
    model: typeof modelCfg === "string" ? modelCfg : modelCfg?.primary,
  };
}

export async function resolveTelegramCallbackAction(
  params: ResolveTelegramCallbackActionParams,
): Promise<TelegramCallbackAction> {
  const data = params.data.trim();
  if (!data) {
    return { kind: "noop" };
  }

  const paginationMatch = data.match(/^commands_page_(\d+|noop)(?::(.+))?$/);
  if (paginationMatch) {
    const pageValue = paginationMatch[1];
    if (pageValue === "noop") {
      return { kind: "noop" };
    }

    const page = Number.parseInt(pageValue, 10);
    if (Number.isNaN(page) || page < 1) {
      return { kind: "noop" };
    }

    const agentId = paginationMatch[2]?.trim() || resolveDefaultAgentId(params.cfg);
    const skillCommands = listSkillCommandsForAgents({
      cfg: params.cfg,
      agentIds: [agentId],
    });
    const result = buildCommandsMessagePaginated(params.cfg, skillCommands, {
      page,
      surface: "telegram",
    });
    return {
      kind: "edit",
      text: result.text,
      buttons:
        result.totalPages > 1
          ? buildCommandsPaginationKeyboard(result.currentPage, result.totalPages, agentId)
          : [],
    };
  }

  const modelCallback = parseModelCallbackData(data);
  if (!modelCallback) {
    return { kind: "forward", text: data };
  }

  const sessionState = resolveTelegramSessionState(params);
  const modelData = await buildModelsProviderData(params.cfg, sessionState.agentId);
  const { byProvider, providers } = modelData;

  if (modelCallback.type === "providers" || modelCallback.type === "back") {
    if (providers.length === 0) {
      return { kind: "edit", text: "No providers available.", buttons: [] };
    }
    const providerInfos: ProviderInfo[] = providers.map((providerId) => ({
      id: providerId,
      count: byProvider.get(providerId)?.size ?? 0,
    }));
    return {
      kind: "edit",
      text: "Select a provider:",
      buttons: buildProviderKeyboard(providerInfos),
    };
  }

  if (modelCallback.type === "list") {
    const { provider, page } = modelCallback;
    const modelSet = byProvider.get(provider);
    if (!modelSet || modelSet.size === 0) {
      const providerInfos: ProviderInfo[] = providers.map((providerId) => ({
        id: providerId,
        count: byProvider.get(providerId)?.size ?? 0,
      }));
      return {
        kind: "edit",
        text: `Unknown provider: ${provider}\n\nSelect a provider:`,
        buttons: buildProviderKeyboard(providerInfos),
      };
    }

    const models = [...modelSet].toSorted();
    const pageSize = getModelsPageSize();
    const totalPages = calculateTotalPages(models.length, pageSize);
    const safePage = Math.max(1, Math.min(page, totalPages));
    const buttons = buildModelsKeyboard({
      provider,
      models,
      currentModel: sessionState.model,
      currentPage: safePage,
      totalPages,
      pageSize,
    });
    const text = formatModelsAvailableHeader({
      provider,
      total: models.length,
      cfg: params.cfg,
      agentDir: resolveAgentDir(params.cfg, sessionState.agentId),
      sessionEntry: sessionState.sessionEntry,
    });
    return { kind: "edit", text, buttons };
  }

  const selection = resolveModelSelection({
    callback: modelCallback,
    providers,
    byProvider,
  });
  if (selection.kind !== "resolved") {
    const providerInfos: ProviderInfo[] = providers.map((providerId) => ({
      id: providerId,
      count: byProvider.get(providerId)?.size ?? 0,
    }));
    return {
      kind: "edit",
      text: `Could not resolve model "${selection.model}".\n\nSelect a provider:`,
      buttons: buildProviderKeyboard(providerInfos),
    };
  }

  const modelSet = byProvider.get(selection.provider);
  if (!modelSet?.has(selection.model)) {
    return {
      kind: "edit",
      text: `❌ Model "${selection.provider}/${selection.model}" is not allowed.`,
      buttons: [],
    };
  }

  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: sessionState.agentId,
  });
  const resolvedDefault = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: sessionState.agentId,
  });
  const isDefaultSelection =
    selection.provider === resolvedDefault.provider && selection.model === resolvedDefault.model;

  try {
    await updateSessionStore(storePath, (store) => {
      const entry = store[sessionState.sessionKey] ?? {};
      store[sessionState.sessionKey] = entry;
      applyModelOverrideToSessionEntry({
        entry,
        selection: {
          provider: selection.provider,
          model: selection.model,
          isDefault: isDefaultSelection,
        },
      });
    });
  } catch (err) {
    return {
      kind: "edit",
      text: `❌ Failed to change model: ${String(err)}`,
      buttons: [],
    };
  }

  const actionText = isDefaultSelection
    ? "reset to default"
    : `changed to **${selection.provider}/${selection.model}**`;
  return {
    kind: "edit",
    text: `✅ Model ${actionText}\n\nThis model will be used for your next message.`,
    buttons: [],
  };
}
