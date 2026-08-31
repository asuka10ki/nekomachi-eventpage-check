import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sendSlackMessages, type SlackRetryOptions, type SlackTransport } from "./slack-client.js";
import type { NotificationOutcome } from "../run/model.js";

export const SLACK_PROGRESS_PATH = path.join("logs", "slack-notification-progress.json");

export type PlannedSlackMessage = { id: string; text: string };
type PersistedMessage = {
  id: string;
  textHash: string;
  status: "unsent" | "sending" | "sent";
  /** 再起動後の再送に必要な未送信本文だけを保持する。送信後は削除する。 */
  text?: string;
  slackTs?: string;
};
export type SlackProgressState = {
  version: 1;
  planId: string;
  targetHash: string;
  messages: PersistedMessage[];
  updatedAt: string;
};

export type SlackProgressFileSystem = {
  readFile(filePath: string, encoding: "utf8"): Promise<string>;
  mkdir(directoryPath: string, options: { recursive: true }): Promise<unknown>;
  writeFile(filePath: string, data: string, encoding: "utf8"): Promise<unknown>;
  rename(oldPath: string, newPath: string): Promise<unknown>;
  rm(filePath: string, options: { force: true }): Promise<unknown>;
};

export class SlackProgressError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SlackProgressError";
  }
}

const nodeFileSystem: SlackProgressFileSystem = {
  readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
  mkdir: (directoryPath, options) => fs.mkdir(directoryPath, options),
  writeFile: (filePath, data, encoding) => fs.writeFile(filePath, data, encoding),
  rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
  rm: (filePath, options) => fs.rm(filePath, options)
};

export function createPlannedSlackMessages(texts: string[]): PlannedSlackMessage[] {
  return texts.map((text, index) => ({ id: `message-${index + 1}-${hash(text).slice(0, 12)}`, text }));
}

export function createSlackProgressState(channel: string, messages: PlannedSlackMessage[], now = new Date()): SlackProgressState {
  const targetHash = hash(channel.trim());
  const persistedMessages = messages.map((message): PersistedMessage => ({
    id: message.id,
    textHash: hash(message.text),
    status: "unsent",
    text: message.text
  }));
  const planId = hash(JSON.stringify({ targetHash, messages: persistedMessages.map(({ id, textHash }) => ({ id, textHash })) }));
  return { version: 1, planId, targetHash, messages: persistedMessages, updatedAt: now.toISOString() };
}

export async function loadSlackProgress(
  filePath = SLACK_PROGRESS_PATH,
  fileSystem: SlackProgressFileSystem = nodeFileSystem
): Promise<SlackProgressState | null> {
  let raw: string;
  try {
    raw = await fileSystem.readFile(path.resolve(filePath), "utf8");
  } catch (error) {
    if (isFileNotFound(error)) return null;
    throw new SlackProgressError("Slack送信進捗ファイルを読み取れませんでした。", { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new SlackProgressError("Slack送信進捗ファイルが破損しています。重複送信を防ぐため送信を中止します。", { cause: error });
  }
  if (!isSlackProgressState(parsed)) {
    throw new SlackProgressError("Slack送信進捗ファイルの内容が不正です。重複送信を防ぐため送信を中止します。");
  }
  if (parsed.messages.some((message) => message.status === "sending")) {
    throw new SlackProgressError("Slack送信結果が不明なメッセージがあります。重複送信を防ぐため自動再送を中止します。");
  }
  return parsed;
}

export async function saveSlackProgress(
  state: SlackProgressState,
  filePath = SLACK_PROGRESS_PATH,
  fileSystem: SlackProgressFileSystem = nodeFileSystem
): Promise<void> {
  const resolved = path.resolve(filePath);
  const temporary = `${resolved}.tmp-${process.pid}`;
  const backup = `${resolved}.bak-${process.pid}`;
  let oldMoved = false;
  try {
    await fileSystem.mkdir(path.dirname(resolved), { recursive: true });
    await fileSystem.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    try {
      await fileSystem.rename(resolved, backup);
      oldMoved = true;
    } catch (error) {
      if (!isFileNotFound(error)) throw error;
    }
    await fileSystem.rename(temporary, resolved);
    if (oldMoved) await fileSystem.rm(backup, { force: true });
  } catch (error) {
    await fileSystem.rm(temporary, { force: true }).catch(() => undefined);
    if (oldMoved) await fileSystem.rename(backup, resolved).catch(() => undefined);
    throw new SlackProgressError("Slack送信進捗ファイルを保存できませんでした。", { cause: error });
  }
}

export async function sendSlackMessagesWithPersistentProgress(
  transport: SlackTransport,
  channel: string,
  messages: PlannedSlackMessage[],
  options: SlackRetryOptions & {
    statePath?: string;
    fileSystem?: SlackProgressFileSystem;
    now?: () => Date;
  } = {}
): Promise<NotificationOutcome> {
  const statePath = options.statePath ?? SLACK_PROGRESS_PATH;
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const now = options.now ?? (() => new Date());
  const planned = createSlackProgressState(channel, messages, now());
  const existing = await loadSlackProgress(statePath, fileSystem);
  const hasPendingPreviousPlan = existing?.messages.some((message) => message.status === "unsent") ?? false;
  // 前回の分割送信が未完了なら、今回の本文が変わっていても前回の未送信分を先に完了する。
  // これにより実行日時を含む本文が再起動時に変化しても、送信済み分を再投稿しない。
  const resumePreviousPlan = Boolean(existing && existing.planId !== planned.planId && hasPendingPreviousPlan);
  const state = existing?.planId === planned.planId || resumePreviousPlan ? existing as SlackProgressState : planned;
  if (!existing || (!resumePreviousPlan && existing.planId !== planned.planId)) {
    await saveSlackProgress(state, statePath, fileSystem);
  }

  const deliveryMessages = resumePreviousPlan
    ? state.messages.map((message): PlannedSlackMessage => ({ id: message.id, text: message.text ?? "" }))
    : messages;

  const sent = state.messages.filter((message) => message.status === "sent").map((message) => message.id);
  const slackIds = Object.fromEntries(state.messages.flatMap((message) => message.status === "sent" && message.slackTs ? [[message.id, message.slackTs]] : []));
  return sendSlackMessages(transport, channel, deliveryMessages, {
    ...options,
    previouslySentMessageIds: sent,
    previouslySentSlackMessageIds: slackIds,
    onMessageSending: async (messageId) => {
      const message = state.messages.find((entry) => entry.id === messageId);
      if (!message) throw new SlackProgressError("送信計画に存在しないメッセージの進捗です。");
      message.status = "sending";
      state.updatedAt = now().toISOString();
      await saveSlackProgress(state, statePath, fileSystem);
    },
    onMessageSent: async (messageId, slackTs) => {
      const message = state.messages.find((entry) => entry.id === messageId);
      if (!message) throw new SlackProgressError("送信計画に存在しないメッセージの進捗です。");
      message.status = "sent";
      delete message.text;
      if (slackTs) message.slackTs = slackTs;
      state.updatedAt = now().toISOString();
      await saveSlackProgress(state, statePath, fileSystem);
    },
    onMessageFailed: async (messageId) => {
      const message = state.messages.find((entry) => entry.id === messageId);
      if (!message) throw new SlackProgressError("送信計画に存在しないメッセージの進捗です。");
      message.status = "unsent";
      state.updatedAt = now().toISOString();
      await saveSlackProgress(state, statePath, fileSystem);
    }
  });
}

function isSlackProgressState(value: unknown): value is SlackProgressState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<SlackProgressState>;
  return state.version === 1 && typeof state.planId === "string" && state.planId.length > 0
    && typeof state.targetHash === "string" && state.targetHash.length > 0
    && typeof state.updatedAt === "string" && Array.isArray(state.messages)
    && state.messages.every((message) => message && typeof message.id === "string" && typeof message.textHash === "string"
      && (message.status === "unsent" || message.status === "sending" || message.status === "sent")
      && (message.status === "sent" || (typeof message.text === "string" && hash(message.text) === message.textHash))
      && (message.text === undefined || typeof message.text === "string")
      && (message.slackTs === undefined || typeof message.slackTs === "string"));
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
