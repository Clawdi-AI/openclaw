import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type CaptureEntry = {
  request?: {
    method?: string;
    path?: string;
  };
  response?: {
    status?: number;
    json?: unknown;
  };
};

type TelegramUpdate = Record<string, unknown>;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
const defaultCapturePath = path.resolve(scriptDir, "../state/telegram-capture/captures.ndjson");
const defaultOutputDir = path.resolve(
  repoRoot,
  "phala-deploy/integration-test/fixtures/telegram/golden",
);

function parseArgs() {
  const args = process.argv.slice(2);
  let capturePath = defaultCapturePath;
  let outputDir = defaultOutputDir;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--capture-path" && args[index + 1]) {
      capturePath = path.resolve(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--output-dir" && args[index + 1]) {
      outputDir = path.resolve(args[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--help") {
      console.log(`Usage: node --import tsx phala-deploy/local-mux-e2e/scripts/export-telegram-fixtures.ts
  [--capture-path <captures.ndjson>]
  [--output-dir <fixture-dir>]`);
      process.exit(0);
    }
  }
  return { capturePath, outputDir };
}

function readNdjson(filePath: string): CaptureEntry[] {
  const raw = fs.readFileSync(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as CaptureEntry);
}

function collectTelegramUpdates(entries: CaptureEntry[]): TelegramUpdate[] {
  const updates: TelegramUpdate[] = [];
  for (const entry of entries) {
    if (entry.request?.path !== "/bot<TOKEN>/getUpdates" || entry.response?.status !== 200) {
      continue;
    }
    const responseJson =
      entry.response?.json && typeof entry.response.json === "object"
        ? (entry.response.json as Record<string, unknown>)
        : null;
    const result = Array.isArray(responseJson?.result) ? responseJson.result : [];
    for (const update of result) {
      if (update && typeof update === "object") {
        updates.push(structuredClone(update as TelegramUpdate));
      }
    }
  }
  return updates;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function sanitizeUser(
  user: Record<string, unknown>,
  params: { id: number; firstName: string; username: string; isBot?: boolean },
) {
  user.id = params.id;
  user.first_name = params.firstName;
  user.username = params.username;
  if (params.isBot !== undefined) {
    user.is_bot = params.isBot;
  }
  delete user.last_name;
  user.language_code = "en";
}

function sanitizeDmText(update: TelegramUpdate): TelegramUpdate {
  const message = asRecord(update.message);
  const chat = asRecord(message?.chat);
  const from = asRecord(message?.from);
  if (!message || !chat || !from) {
    throw new Error("dm-text fixture missing message/chat/from");
  }
  update.update_id = 700001;
  message.message_id = 900001;
  message.date = 1700000000;
  message.text = "hello from telegram fixture";
  delete message.entities;
  sanitizeUser(from, { id: 424242, firstName: "Mux", username: "mux_user", isBot: false });
  chat.id = 424242;
  chat.type = "private";
  chat.first_name = "Mux";
  chat.username = "mux_user";
  delete chat.last_name;
  return update;
}

function sanitizeGroupText(update: TelegramUpdate): TelegramUpdate {
  const message = asRecord(update.message);
  const chat = asRecord(message?.chat);
  const from = asRecord(message?.from);
  if (!message || !chat || !from) {
    throw new Error("group-text fixture missing message/chat/from");
  }
  update.update_id = 700101;
  message.message_id = 900101;
  message.date = 1700000001;
  message.text = "hello from telegram group fixture";
  delete message.entities;
  sanitizeUser(from, { id: 424242, firstName: "Mux", username: "mux_user", isBot: false });
  chat.id = -555001;
  chat.type = "group";
  chat.title = "Integration Group";
  delete chat.first_name;
  delete chat.last_name;
  delete chat.username;
  delete chat.is_forum;
  return update;
}

function sanitizeForumTopicText(update: TelegramUpdate): TelegramUpdate {
  const message = asRecord(update.message);
  const chat = asRecord(message?.chat);
  const from = asRecord(message?.from);
  if (!message || !chat || !from) {
    throw new Error("forum-topic fixture missing message/chat/from");
  }
  update.update_id = 700201;
  message.message_id = 900201;
  message.message_thread_id = 2;
  message.date = 1700000002;
  message.text = "hello from telegram forum fixture";
  delete message.entities;
  sanitizeUser(from, { id: 424242, firstName: "Mux", username: "mux_user", isBot: false });
  chat.id = -100777;
  chat.type = "supergroup";
  chat.title = "Integration Forum";
  chat.is_forum = true;
  delete chat.first_name;
  delete chat.last_name;
  delete chat.username;
  const replyToMessage = asRecord(message.reply_to_message);
  const replyToFrom = asRecord(replyToMessage?.from);
  const replyToChat = asRecord(replyToMessage?.chat);
  if (replyToMessage && replyToFrom && replyToChat) {
    replyToMessage.message_id = 14;
    replyToMessage.date = 1700000001;
    replyToMessage.message_thread_id = 2;
    sanitizeUser(replyToFrom, { id: 424242, firstName: "Mux", username: "mux_user", isBot: false });
    replyToChat.id = -100777;
    replyToChat.title = "Integration Forum";
    replyToChat.is_forum = true;
    replyToChat.type = "supergroup";
    delete replyToChat.first_name;
    delete replyToChat.last_name;
    delete replyToChat.username;
    const forumTopicCreated = asRecord(replyToMessage.forum_topic_created);
    if (forumTopicCreated) {
      forumTopicCreated.name = "Topic1";
      forumTopicCreated.icon_color = 16749490;
    }
  }
  return update;
}

function sanitizeCallbackQuery(update: TelegramUpdate): TelegramUpdate {
  const callback = asRecord(update.callback_query);
  const from = asRecord(callback?.from);
  const message = asRecord(callback?.message);
  const chat = asRecord(message?.chat);
  const botUser = asRecord(message?.from);
  if (!callback || !from || !message || !chat || !botUser) {
    throw new Error("callback-query fixture missing callback_query/message/chat/from");
  }
  update.update_id = 700002;
  callback.id = "cbq-900010";
  callback.data = "mdl_prov";
  sanitizeUser(from, {
    id: 424242,
    firstName: "Integration",
    username: "integration_user",
    isBot: false,
  });
  message.message_id = 900010;
  message.date = 1700000000;
  message.text = "Browse providers";
  sanitizeUser(botUser, {
    id: 999001,
    firstName: "Integration Bot",
    username: "integration_bot",
    isBot: true,
  });
  chat.id = 424242;
  chat.type = "private";
  chat.first_name = "Integration";
  chat.username = "integration_user";
  delete chat.last_name;
  return update;
}

function sanitizeMediaMessage(
  update: TelegramUpdate,
  params: {
    updateId: number;
    messageId: number;
    date: number;
    text?: string;
  },
): TelegramUpdate {
  const message = asRecord(update.message);
  const chat = asRecord(message?.chat);
  const from = asRecord(message?.from);
  if (!message || !chat || !from) {
    throw new Error("media fixture missing message/chat/from");
  }
  update.update_id = params.updateId;
  message.message_id = params.messageId;
  message.date = params.date;
  if (params.text !== undefined) {
    message.caption = params.text;
  }
  sanitizeUser(from, { id: 424242, firstName: "Mux", username: "mux_user", isBot: false });
  chat.id = 424242;
  chat.type = "private";
  chat.first_name = "Mux";
  chat.username = "mux_user";
  delete chat.last_name;
  return update;
}

function writeFixture(outputDir: string, fileName: string, update: TelegramUpdate) {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, fileName), `${JSON.stringify(update, null, 2)}\n`, "utf8");
}

function findUpdate(
  updates: TelegramUpdate[],
  predicate: (update: TelegramUpdate) => boolean,
): TelegramUpdate | null {
  const match = updates.find(predicate);
  if (!match) {
    return null;
  }
  return structuredClone(match);
}

function hasTextMessage(update: TelegramUpdate): boolean {
  const message = asRecord(update.message);
  return typeof message?.text === "string";
}

function hasBotCommandEntity(update: TelegramUpdate): boolean {
  const message = asRecord(update.message);
  const entities = Array.isArray(message?.entities) ? message.entities : [];
  return entities.some((entity) => {
    const record = asRecord(entity);
    return record?.type === "bot_command";
  });
}

function main() {
  const { capturePath, outputDir } = parseArgs();
  const entries = readNdjson(capturePath);
  const updates = collectTelegramUpdates(entries);
  if (updates.length === 0) {
    throw new Error(`no Telegram updates found in ${capturePath}`);
  }

  const writtenFixtures: string[] = [];
  const missingFixtures: string[] = [];
  const maybeWriteFixture = (
    fileName: string,
    update: TelegramUpdate | null,
    sanitize: (captured: TelegramUpdate) => TelegramUpdate,
  ) => {
    const outputPath = path.join(outputDir, fileName);
    if (!update) {
      missingFixtures.push(fileName);
      if (fs.existsSync(outputPath)) {
        fs.rmSync(outputPath);
      }
      return;
    }
    writeFixture(outputDir, fileName, sanitize(update));
    writtenFixtures.push(fileName);
  };

  maybeWriteFixture(
    "dm-text.sample.json",
    findUpdate(updates, (update) => {
      const message = asRecord(update.message);
      const chat = asRecord(message?.chat);
      return chat?.type === "private" && hasTextMessage(update) && !hasBotCommandEntity(update);
    }),
    sanitizeDmText,
  );

  maybeWriteFixture(
    "group-text.sample.json",
    findUpdate(updates, (update) => {
      const message = asRecord(update.message);
      const chat = asRecord(message?.chat);
      return (
        (chat?.type === "group" || chat?.type === "supergroup") &&
        chat.is_forum !== true &&
        hasTextMessage(update) &&
        !hasBotCommandEntity(update)
      );
    }),
    sanitizeGroupText,
  );

  maybeWriteFixture(
    "forum-topic-text.sample.json",
    findUpdate(updates, (update) => {
      const message = asRecord(update.message);
      const chat = asRecord(message?.chat);
      return (
        chat?.type === "supergroup" &&
        chat.is_forum === true &&
        typeof message?.message_thread_id === "number" &&
        Number(message.message_thread_id) > 1 &&
        hasTextMessage(update) &&
        !hasBotCommandEntity(update)
      );
    }),
    sanitizeForumTopicText,
  );

  maybeWriteFixture(
    "callback-query.sample.json",
    findUpdate(updates, (update) => asRecord(update.callback_query) !== null),
    sanitizeCallbackQuery,
  );

  maybeWriteFixture(
    "photo.sample.json",
    findUpdate(updates, (update) => {
      const message = asRecord(update.message);
      return Array.isArray(message?.photo);
    }),
    (update) =>
      sanitizeMediaMessage(update, {
        updateId: 700301,
        messageId: 900301,
        date: 1700000003,
        text: "photo fixture caption",
      }),
  );

  maybeWriteFixture(
    "document.sample.json",
    findUpdate(updates, (update) => {
      const message = asRecord(update.message);
      return asRecord(message?.document) !== null;
    }),
    (update) =>
      sanitizeMediaMessage(update, {
        updateId: 700401,
        messageId: 900401,
        date: 1700000004,
        text: "document fixture caption",
      }),
  );

  maybeWriteFixture(
    "voice.sample.json",
    findUpdate(updates, (update) => {
      const message = asRecord(update.message);
      return asRecord(message?.voice) !== null;
    }),
    (update) =>
      sanitizeMediaMessage(update, {
        updateId: 700501,
        messageId: 900501,
        date: 1700000005,
      }),
  );

  console.log(
    JSON.stringify({
      ok: true,
      capturePath,
      outputDir,
      updatesScanned: updates.length,
      writtenFixtures,
      missingFixtures,
    }),
  );
}

main();
