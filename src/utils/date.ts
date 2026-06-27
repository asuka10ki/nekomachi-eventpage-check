import { toHalfWidthDigits } from "./normalize.js";

export function extractDeadlineTimeFromNotice(text: string): string | null {
  const normalized = toHalfWidthDigits(text).replace(/：/g, ":");
  const match = normalized.match(/(?:(?:\d{4}\/)?\d{1,2}\/\d{1,2}\s+)?(\d{1,2}):(\d{2})\s*までに/);
  if (match) return `${match[1].padStart(2, "0")}:${match[2]}`;
  const japaneseMatch = normalized.match(/(?:(?:\d{4}\/)?\d{1,2}\/\d{1,2}\s+)?(\d{1,2})時\s*(\d{2})分?\s*までに/);
  if (japaneseMatch) return `${japaneseMatch[1].padStart(2, "0")}:${japaneseMatch[2]}`;
  return null;
}

export function isDeadlineFiveMinutesBeforeStart(startAt: Date, deadlineText: string): boolean {
  const deadline = extractDeadlineTimeFromNotice(deadlineText);
  if (!deadline) return false;
  const expected = new Date(startAt.getTime() - 5 * 60 * 1000);
  return deadline === formatHourMinute(expected);
}

export function formatHourMinute(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function parseJapaneseDateTime(text: string): Date | null {
  const normalized = toHalfWidthDigits(text).replace(/：/g, ":");
  const isoLocalMatch = normalized.match(/(\d{4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{2})/);
  if (isoLocalMatch) {
    const [, year, month, day, hour, minute] = isoLocalMatch;
    return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  }
  const match = normalized.match(/(\d{4})[\/年.-]\s*(\d{1,2})[\/月.-]\s*(\d{1,2})日?\s*(?:\([^)]*\))?\s*(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const [, year, month, day, hour, minute] = match;
  return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
}
