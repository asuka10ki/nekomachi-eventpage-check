import fs from "node:fs/promises";
import path from "node:path";

export const CHECK_STATE_PATH = path.join("logs", "last-successful-event-count.json");
const MINIMUM_PREVIOUS_COUNT_FOR_DROP_CHECK = 10;
const MINIMUM_ALLOWED_RATIO = 0.5;

export type CheckState = {
  eventCount: number;
  updatedAt: string;
};

export type CheckStateFileSystem = {
  readFile(filePath: string, encoding: "utf8"): Promise<string>;
  mkdir(directoryPath: string, options: { recursive: true }): Promise<unknown>;
  createFile(filePath: string): Promise<unknown>;
  writeFile(filePath: string, data: string, encoding: "utf8"): Promise<unknown>;
  rename(oldPath: string, newPath: string): Promise<unknown>;
  rm(filePath: string, options: { force: true }): Promise<unknown>;
};

export class CheckStateError extends Error {
  constructor(
    readonly operation: "read" | "parse" | "validate" | "prepare" | "create" | "write" | "replace",
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "CheckStateError";
  }
}

const nodeFileSystem: CheckStateFileSystem = {
  readFile: (filePath, encoding) => fs.readFile(filePath, encoding),
  mkdir: (directoryPath, options) => fs.mkdir(directoryPath, options),
  createFile: async (filePath) => {
    const handle = await fs.open(filePath, "wx");
    await handle.close();
  },
  writeFile: (filePath, data, encoding) => fs.writeFile(filePath, data, encoding),
  rename: (oldPath, newPath) => fs.rename(oldPath, newPath),
  rm: (filePath, options) => fs.rm(filePath, options)
};

export async function loadPreviousEventCount(
  filePath = CHECK_STATE_PATH,
  fileSystem: CheckStateFileSystem = nodeFileSystem
): Promise<number | null> {
  let raw: string;
  try {
    raw = await fileSystem.readFile(path.resolve(filePath), "utf8");
  } catch (error) {
    if (isFileNotFound(error)) return null;
    throw new CheckStateError("read", "前回取得件数の状態ファイルを読み取れませんでした。", { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CheckStateError("parse", "前回取得件数の状態ファイルが正しいJSONではありません。", { cause: error });
  }
  if (!isValidCheckState(parsed)) {
    throw new CheckStateError("validate", "前回取得件数の状態ファイルに不正な値があります。");
  }
  return parsed.eventCount;
}

export function assertEventCountHasNotDroppedUnexpectedly(previousCount: number | null, currentCount: number): void {
  if (previousCount === null || previousCount < MINIMUM_PREVIOUS_COUNT_FOR_DROP_CHECK) return;
  if (currentCount < previousCount * MINIMUM_ALLOWED_RATIO) {
    throw new Error(`OSIROのイベント取得件数が前回から急減しました。前回: ${previousCount}件 / 今回: ${currentCount}件`);
  }
}

export async function saveSuccessfulEventCount(
  eventCount: number,
  filePath = CHECK_STATE_PATH,
  fileSystem: CheckStateFileSystem = nodeFileSystem,
  now: () => Date = () => new Date()
): Promise<void> {
  if (!Number.isInteger(eventCount) || eventCount < 0) {
    throw new CheckStateError("validate", "保存するイベント件数が不正です。");
  }
  const resolved = path.resolve(filePath);
  const timestamp = now();
  const nonce = `${process.pid}-${timestamp.getTime()}`;
  const temporary = `${resolved}.tmp-${nonce}`;
  const backup = `${resolved}.bak-${nonce}`;
  const state: CheckState = { eventCount, updatedAt: timestamp.toISOString() };
  let oldMoved = false;
  let replacementCompleted = false;

  try {
    await fileSystem.mkdir(path.dirname(resolved), { recursive: true });
  } catch (error) {
    throw new CheckStateError("prepare", "前回取得件数の状態保存先を準備できませんでした。", { cause: error });
  }
  try {
    await fileSystem.createFile(temporary);
  } catch (error) {
    throw new CheckStateError("create", "前回取得件数の一時状態ファイルを作成できませんでした。", { cause: error });
  }
  try {
    await fileSystem.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch (error) {
    await fileSystem.rm(temporary, { force: true }).catch(() => undefined);
    throw new CheckStateError("write", "前回取得件数の一時状態ファイルを書き込めませんでした。", { cause: error });
  }

  try {
    try {
      await fileSystem.rename(resolved, backup);
      oldMoved = true;
    } catch (error) {
      if (!isFileNotFound(error)) throw error;
    }
    await fileSystem.rename(temporary, resolved);
    replacementCompleted = true;
    if (oldMoved) await fileSystem.rm(backup, { force: true });
  } catch (error) {
    await fileSystem.rm(temporary, { force: true }).catch(() => undefined);
    if (oldMoved && !replacementCompleted) {
      await fileSystem.rename(backup, resolved).catch(() => undefined);
    }
    throw new CheckStateError("replace", "前回取得件数の状態ファイルを置換できませんでした。旧状態は維持します。", { cause: error });
  }
}

function isValidCheckState(value: unknown): value is CheckState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CheckState>;
  return Number.isInteger(candidate.eventCount) && (candidate.eventCount ?? -1) >= 0
    && typeof candidate.updatedAt === "string" && candidate.updatedAt.length > 0
    && !Number.isNaN(Date.parse(candidate.updatedAt));
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
