import {
  createActionGate,
  jsonResult,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "../../../agents/tools/common.js";
import type { ChannelMessageActionAdapter, ChannelMessageActionName } from "../types.js";

const providerId = "whatsapp";

export const whatsappMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    if (!cfg.channels?.whatsapp) {
      return [];
    }
    const gate = createActionGate(cfg.channels.whatsapp.actions);
    const actions = new Set<ChannelMessageActionName>();
    if (gate("reactions")) {
      actions.add("react");
    }
    if (gate("polls")) {
      actions.add("poll");
    }
    return Array.from(actions);
  },
  supportsAction: ({ action }) => action === "react" || action === "poll",
  handleAction: async ({ action, params, cfg, accountId }) => {
    const resolvedAccountId = accountId ?? readStringParam(params, "accountId");

    if (action === "react") {
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      const emoji = readStringParam(params, "emoji", { allowEmpty: true });
      const remove = typeof params.remove === "boolean" ? params.remove : undefined;

      const { handleWhatsAppAction } = await import("../../../agents/tools/whatsapp-actions.js");
      return await handleWhatsAppAction(
        {
          action: "react",
          chatJid:
            readStringParam(params, "chatJid") ?? readStringParam(params, "to", { required: true }),
          messageId,
          emoji,
          remove,
          participant: readStringParam(params, "participant"),
          accountId: resolvedAccountId ?? undefined,
          fromMe: typeof params.fromMe === "boolean" ? params.fromMe : undefined,
        },
        cfg,
      );
    }

    if (action === "poll") {
      const to = readStringParam(params, "to", { required: true });
      const question = readStringParam(params, "pollQuestion", { required: true });
      const options = readStringArrayParam(params, "pollOption", { required: true }) ?? [];
      const allowMultiselect = typeof params.pollMulti === "boolean" ? params.pollMulti : false;
      const durationHours = readNumberParam(params, "pollDurationHours", { integer: true });

      const { sendPollWhatsApp } = await import("../../../web/outbound.js");
      const result = await sendPollWhatsApp(
        to,
        {
          question,
          options,
          maxSelections: allowMultiselect ? options.length : 1,
          durationHours: durationHours ?? undefined,
        },
        {
          verbose: false,
          accountId: resolvedAccountId ?? undefined,
        },
      );
      return jsonResult({
        ok: true,
        ...result,
      });
    }

    throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
  },
};
