import path from "node:path";
import {
  buildAccountScopedDmSecurityPolicy,
  collectAllowlistProviderRestrictSendersWarnings,
} from "openclaw/plugin-sdk/compat";
import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  buildIMessageRawSend,
  collectStatusIssuesFromLastError,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatTrimmedAllowFromEntries,
  getChatChannelMeta,
  type IMessageInlineAttachment,
  imessageOnboardingAdapter,
  IMessageConfigSchema,
  listIMessageAccountIds,
  loadWebMediaRaw,
  looksLikeIMessageTargetId,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  normalizeIMessageMessagingTarget,
  PAIRING_APPROVED_MESSAGE,
  resolveChannelMediaMaxBytes,
  resolveDefaultIMessageAccountId,
  resolveIMessageAccount,
  resolveIMessageConfigAllowFrom,
  resolveIMessageConfigDefaultTo,
  resolveIMessageGroupRequireMention,
  resolveIMessageGroupToolPolicy,
  isMuxEnabled,
  sendViaMux,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
  type ResolvedIMessageAccount,
} from "openclaw/plugin-sdk/imessage";
import { buildPassiveProbedChannelStatusSummary } from "../../shared/channel-status-summary.js";
import { getIMessageRuntime } from "./runtime.js";

const meta = getChatChannelMeta("imessage");

function buildIMessageSetupPatch(input: {
  cliPath?: string;
  dbPath?: string;
  service?: string;
  region?: string;
}) {
  return {
    ...(input.cliPath ? { cliPath: input.cliPath } : {}),
    ...(input.dbPath ? { dbPath: input.dbPath } : {}),
    ...(input.service ? { service: input.service } : {}),
    ...(input.region ? { region: input.region } : {}),
  };
}

type IMessageSendFn = ReturnType<
  typeof getIMessageRuntime
>["channel"]["imessage"]["sendMessageIMessage"];

async function sendIMessageOutbound(params: {
  cfg: Parameters<typeof resolveIMessageAccount>[0]["cfg"];
  to: string;
  text: string;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  accountId?: string;
  deps?: { sendIMessage?: IMessageSendFn };
  replyToId?: string;
}) {
  const send =
    params.deps?.sendIMessage ?? getIMessageRuntime().channel.imessage.sendMessageIMessage;
  const maxBytes = resolveChannelMediaMaxBytes({
    cfg: params.cfg,
    resolveChannelLimitMb: ({ cfg, accountId }) =>
      cfg.channels?.imessage?.accounts?.[accountId]?.mediaMaxMb ??
      cfg.channels?.imessage?.mediaMaxMb,
    accountId: params.accountId,
  });
  return await send(params.to, params.text, {
    config: params.cfg,
    ...(params.mediaUrl ? { mediaUrl: params.mediaUrl } : {}),
    ...(params.mediaLocalRoots?.length ? { mediaLocalRoots: params.mediaLocalRoots } : {}),
    maxBytes,
    accountId: params.accountId ?? undefined,
    replyToId: params.replyToId ?? undefined,
  });
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function deriveAttachmentFilename(mediaUrl: string): string {
  // `new URL()` throws on plain filesystem paths; fall through to a
  // direct path.basename in that case.
  const source = (() => {
    try {
      return new URL(mediaUrl).pathname;
    } catch {
      return mediaUrl;
    }
  })();
  const base = path.basename(source);
  return base && base !== "/" ? base : "attachment";
}

// Convert a non-http media reference (local filesystem path, file:// URL,
// data: URL) into an inline base64 attachment the mux-server can post
// straight to Photon's multipart endpoint. Photon rejects bare URLs unless
// they are reachable over public HTTPS; rather than forcing every call site
// to stage media on a CDN, we let openclaw load bytes from its own sandbox
// and ship them through the raw.imessage.send.attachments envelope.

// Hard ceiling enforced by mux-server's parseInlineAttachments —
// IMESSAGE_ATTACHMENT_MAX_BYTES in mux-server/src/channels/imessage/api.ts.
// Clamping here means a deployment misconfigured with a higher channel-level
// mediaMaxMb still fails fast with a readable "exceeds ... bytes" error from
// loadWebMediaRaw instead of a cryptic "estimated X bytes" 400 after the
// file is already on disk and base64-encoded in memory.
const IMESSAGE_MUX_INLINE_MAX_BYTES = 100 * 1024 * 1024;

async function loadInlineAttachment(params: {
  mediaUrl: string;
  maxBytes?: number;
  mediaLocalRoots?: readonly string[];
}): Promise<IMessageInlineAttachment> {
  const effectiveMax = Math.min(
    params.maxBytes ?? IMESSAGE_MUX_INLINE_MAX_BYTES,
    IMESSAGE_MUX_INLINE_MAX_BYTES,
  );
  const media = await loadWebMediaRaw(params.mediaUrl, {
    maxBytes: effectiveMax,
    optimizeImages: false,
    localRoots: params.mediaLocalRoots?.length ? params.mediaLocalRoots : undefined,
  });
  return {
    filename: media.fileName ?? deriveAttachmentFilename(params.mediaUrl),
    contentType: media.contentType ?? "application/octet-stream",
    dataBase64: media.buffer.toString("base64"),
  };
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export const imessagePlugin: ChannelPlugin<ResolvedIMessageAccount> = {
  id: "imessage",
  meta: {
    ...meta,
    aliases: ["imsg"],
    showConfigured: false,
  },
  onboarding: imessageOnboardingAdapter,
  pairing: {
    idLabel: "imessageSenderId",
    notifyApproval: async ({ id }) => {
      await getIMessageRuntime().channel.imessage.sendMessageIMessage(id, PAIRING_APPROVED_MESSAGE);
    },
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
  },
  reload: { configPrefixes: ["channels.imessage"] },
  configSchema: buildChannelConfigSchema(IMessageConfigSchema),
  config: {
    listAccountIds: (cfg) => listIMessageAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveIMessageAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultIMessageAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "imessage",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "imessage",
        accountId,
        clearBaseFields: ["cliPath", "dbPath", "service", "region", "name"],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),
    resolveAllowFrom: ({ cfg, accountId }) => resolveIMessageConfigAllowFrom({ cfg, accountId }),
    formatAllowFrom: ({ allowFrom }) => formatTrimmedAllowFromEntries(allowFrom),
    resolveDefaultTo: ({ cfg, accountId }) => resolveIMessageConfigDefaultTo({ cfg, accountId }),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      return buildAccountScopedDmSecurityPolicy({
        cfg,
        channelKey: "imessage",
        accountId,
        fallbackAccountId: account.accountId ?? DEFAULT_ACCOUNT_ID,
        policy: account.config.dmPolicy,
        allowFrom: account.config.allowFrom ?? [],
        policyPathSuffix: "dmPolicy",
      });
    },
    collectWarnings: ({ account, cfg }) => {
      return collectAllowlistProviderRestrictSendersWarnings({
        cfg,
        providerConfigPresent: cfg.channels?.imessage !== undefined,
        configuredGroupPolicy: account.config.groupPolicy,
        surface: "iMessage groups",
        openScope: "any member",
        groupPolicyPath: "channels.imessage.groupPolicy",
        groupAllowFromPath: "channels.imessage.groupAllowFrom",
        mentionGated: false,
      });
    },
  },
  groups: {
    resolveRequireMention: resolveIMessageGroupRequireMention,
    resolveToolPolicy: resolveIMessageGroupToolPolicy,
  },
  messaging: {
    normalizeTarget: normalizeIMessageMessagingTarget,
    targetResolver: {
      looksLikeId: looksLikeIMessageTargetId,
      hint: "<handle|chat_id:ID>",
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "imessage",
        accountId,
        name,
      }),
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "imessage",
        accountId,
        name: input.name,
      });
      const next = (
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "imessage",
            })
          : namedConfig
      ) as typeof cfg;
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            imessage: {
              ...next.channels?.imessage,
              enabled: true,
              ...buildIMessageSetupPatch(input),
            },
          },
        } as typeof cfg;
      }
      return {
        ...next,
        channels: {
          ...next.channels,
          imessage: {
            ...next.channels?.imessage,
            enabled: true,
            accounts: {
              ...next.channels?.imessage?.accounts,
              [accountId]: {
                ...next.channels?.imessage?.accounts?.[accountId],
                enabled: true,
                ...buildIMessageSetupPatch(input),
              },
            },
          },
        },
      } as typeof cfg;
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getIMessageRuntime().channel.text.chunkText(text, limit),
    chunkerMode: "text",
    textChunkLimit: 4000,
    sendText: async ({ cfg, to, text, accountId, deps, replyToId, sessionKey }) => {
      if (isMuxEnabled({ cfg, channel: "imessage", accountId: accountId ?? undefined })) {
        const result = await sendViaMux({
          cfg,
          channel: "imessage",
          accountId: accountId ?? undefined,
          sessionKey,
          to,
          text,
          replyToId,
          raw: {
            imessage: buildIMessageRawSend({ text }),
          },
        });
        return { channel: "imessage", ...result };
      }
      const result = await sendIMessageOutbound({
        cfg,
        to,
        text,
        accountId: accountId ?? undefined,
        deps,
        replyToId: replyToId ?? undefined,
      });
      return { channel: "imessage", ...result };
    },
    sendMedia: async ({
      cfg,
      to,
      text,
      mediaUrl,
      mediaLocalRoots,
      accountId,
      deps,
      replyToId,
      sessionKey,
    }) => {
      if (isMuxEnabled({ cfg, channel: "imessage", accountId: accountId ?? undefined })) {
        // Photon's attachment endpoint expects either a reachable https URL
        // (mux fetches then re-posts) or raw multipart bytes. Local paths
        // and file:/data:/blob: URLs are unreachable from mux-server's
        // network namespace; inline them as base64 so Photon still gets
        // raw bytes, gated by the channel's configured media size limit.
        let rawMediaUrl: string | undefined = mediaUrl;
        let inlineAttachments: IMessageInlineAttachment[] | undefined;
        if (mediaUrl && !isHttpUrl(mediaUrl)) {
          const maxBytes = resolveChannelMediaMaxBytes({
            cfg,
            resolveChannelLimitMb: ({ cfg: inner, accountId: innerAccount }) =>
              inner.channels?.imessage?.accounts?.[innerAccount]?.mediaMaxMb ??
              inner.channels?.imessage?.mediaMaxMb,
            accountId: accountId ?? undefined,
          });
          const attachment = await loadInlineAttachment({
            mediaUrl,
            maxBytes,
            mediaLocalRoots,
          });
          inlineAttachments = [attachment];
          rawMediaUrl = undefined;
        }
        const result = await sendViaMux({
          cfg,
          channel: "imessage",
          accountId: accountId ?? undefined,
          sessionKey,
          to,
          text,
          ...(rawMediaUrl ? { mediaUrl: rawMediaUrl } : {}),
          replyToId,
          raw: {
            imessage: buildIMessageRawSend({
              text,
              ...(rawMediaUrl ? { mediaUrl: rawMediaUrl } : {}),
              ...(inlineAttachments ? { attachments: inlineAttachments } : {}),
            }),
          },
        });
        return { channel: "imessage", ...result };
      }
      const result = await sendIMessageOutbound({
        cfg,
        to,
        text,
        mediaUrl,
        mediaLocalRoots,
        accountId: accountId ?? undefined,
        deps,
        replyToId: replyToId ?? undefined,
      });
      return { channel: "imessage", ...result };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      cliPath: null,
      dbPath: null,
    },
    collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("imessage", accounts),
    buildChannelSummary: ({ snapshot }) =>
      buildPassiveProbedChannelStatusSummary(snapshot, {
        cliPath: snapshot.cliPath ?? null,
        dbPath: snapshot.dbPath ?? null,
      }),
    probeAccount: async ({ timeoutMs }) =>
      getIMessageRuntime().channel.imessage.probeIMessage(timeoutMs),
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      cliPath: runtime?.cliPath ?? account.config.cliPath ?? null,
      dbPath: runtime?.dbPath ?? account.config.dbPath ?? null,
      probe,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
    resolveAccountState: ({ enabled }) => (enabled ? "enabled" : "disabled"),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      if (isMuxEnabled({ cfg: ctx.cfg, channel: "imessage", accountId: account.accountId })) {
        ctx.log?.info(`[${account.accountId}] mux enabled; skipping native provider startup`);
        return await waitForAbort(ctx.abortSignal);
      }
      const cliPath = account.config.cliPath?.trim() || "imsg";
      const dbPath = account.config.dbPath?.trim();
      ctx.setStatus({
        accountId: account.accountId,
        cliPath,
        dbPath: dbPath ?? null,
      });
      ctx.log?.info(
        `[${account.accountId}] starting provider (${cliPath}${dbPath ? ` db=${dbPath}` : ""})`,
      );
      return getIMessageRuntime().channel.imessage.monitorIMessageProvider({
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
      });
    },
  },
};
