import fs from "node:fs/promises";
import path from "node:path";

export type StorageStateWriter = {
  storageState(options: { path: string }): Promise<unknown>;
};

export async function saveStorageStateAtomically(writer: StorageStateWriter, targetPath: string): Promise<void> {
  const resolved = path.resolve(targetPath);
  const temporary = `${resolved}.tmp-${process.pid}`;
  const backup = `${resolved}.bak-${process.pid}`;
  try {
    await writer.storageState({ path: temporary });
    const raw = await fs.readFile(temporary, "utf8");
    JSON.parse(raw);
    const targetExists = await fs.access(resolved).then(() => true, () => false);
    if (!targetExists) {
      await fs.rename(temporary, resolved);
      return;
    }
    await fs.rename(resolved, backup);
    try {
      await fs.rename(temporary, resolved);
      await fs.rm(backup, { force: true });
    } catch (error) {
      await fs.rename(backup, resolved).catch(() => undefined);
      throw error;
    }
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw new Error(`ログイン状態の保存に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
  }
}
