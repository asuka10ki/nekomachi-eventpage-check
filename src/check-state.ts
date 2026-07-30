import fs from "node:fs";
import path from "node:path";

export const CHECK_STATE_PATH = path.join("logs", "last-successful-event-count.json");
const MINIMUM_PREVIOUS_COUNT_FOR_DROP_CHECK = 10;
const MINIMUM_ALLOWED_RATIO = 0.5;

type CheckState = {
  eventCount: number;
  updatedAt: string;
};

export function loadPreviousEventCount(filePath = CHECK_STATE_PATH): number | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<CheckState>;
    return Number.isInteger(parsed.eventCount) && (parsed.eventCount ?? -1) >= 0 ? parsed.eventCount! : null;
  } catch {
    return null;
  }
}

export function assertEventCountHasNotDroppedUnexpectedly(previousCount: number | null, currentCount: number): void {
  if (previousCount === null || previousCount < MINIMUM_PREVIOUS_COUNT_FOR_DROP_CHECK) return;
  if (currentCount < previousCount * MINIMUM_ALLOWED_RATIO) {
    throw new Error(`OSIROのイベント取得件数が前回から急減しました。前回: ${previousCount}件 / 今回: ${currentCount}件`);
  }
}

export function saveSuccessfulEventCount(eventCount: number, filePath = CHECK_STATE_PATH): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const state: CheckState = { eventCount, updatedAt: new Date().toISOString() };
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
