import { toHalfWidthDigits } from "./normalize.js";

export function extractDeadlineTimeFromNotice(text: string): string | null {
  const normalized = toHalfWidthDigits(text).replace(/：/g, ":");
  const match = normalized.match(/(?:(?:\d{4}\/)?\d{1,2}\/\d{1,2}\s+)?(\d{1,2}):(\d{2})\s*までに/);
  if (match) return `${match[1].padStart(2, "0")}:${match[2]}`;
  const japaneseMatch = normalized.match(/(?:(?:\d{4}\/)?\d{1,2}\/\d{1,2}\s+)?(\d{1,2})時\s*(\d{2})分?\s*までに/);
  if (japaneseMatch) return `${japaneseMatch[1].padStart(2, "0")}:${japaneseMatch[2]}`;
  return null;
}

export function extractReceptionStartTimeFromBody(text: string): string | null {
  const normalized = normalizeTimeText(text);
  return extractExplicitReceptionStartTime(normalized, true);
}

export function extractReceptionStartTimeFromNotice(text: string, eventStartAt: Date | null): string | null {
  const normalized = normalizeTimeText(text);
  const explicit = extractExplicitReceptionStartTime(normalized, false);
  if (explicit) return explicit;

  const relativeMatch = normalized.match(/(?:読書会|イベント)?\s*(?:スタート|開始)\s*(\d{1,3})\s*分前\s*から\s*受付/);
  if (!relativeMatch || !eventStartAt) return null;

  const receptionStart = new Date(eventStartAt.getTime() - Number(relativeMatch[1]) * 60 * 1000);
  return formatHourMinute(receptionStart);
}

export function isDeadlineFiveMinutesBeforeStart(startAt: Date, deadlineText: string): boolean {
  const deadline = extractDeadlineTimeFromNotice(deadlineText);
  if (!deadline) return false;
  const expected = new Date(startAt.getTime() - 5 * 60 * 1000);
  return deadline === formatHourMinute(expected);
}

export function parseApplicationDeadlineDate(text: string, eventStartAt: Date): Date | null {
  const normalized = toHalfWidthDigits(text).replace(/：/g, ":");
  const match = normalized.match(/(?:(\d{4})[\/年.-]\s*)?(\d{1,2})[\/月.-]\s*(\d{1,2})日?/);
  if (!match) return null;
  const [, year, month, day] = match;
  return new Date(year ? Number(year) : eventStartAt.getFullYear(), Number(month) - 1, Number(day));
}

export function isApplicationDeadlineWithinEventRange(eventStartAt: Date, deadlineText: string): boolean {
  const deadline = parseApplicationDeadlineDate(deadlineText, eventStartAt);
  if (!deadline) return false;

  const eventDate = startOfLocalDate(eventStartAt);
  const earliest = new Date(eventDate);
  earliest.setDate(earliest.getDate() - 3);
  const deadlineDate = startOfLocalDate(deadline);
  return deadlineDate.getTime() >= earliest.getTime() && deadlineDate.getTime() <= eventDate.getTime();
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

function startOfLocalDate(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function normalizeTimeText(text: string): string {
  return toHalfWidthDigits(text).replace(/：/g, ":").replace(/\s+/g, " ");
}

function extractExplicitReceptionStartTime(text: string, allowPlainStart: boolean): string | null {
  const patterns = allowPlainStart
    ? [
        /(\d{1,2}):(\d{2})\s*(?:受付\s*開始|受付開始)/,
        /(\d{1,2})時\s*(\d{1,2})?\s*分?\s*(?:受付\s*開始|受付開始)/,
        /(?:受付\s*開始|受付開始)\s*[:：]?\s*(\d{1,2}):(\d{2})/,
        /(?:受付\s*開始|受付開始)\s*[:：]?\s*(\d{1,2})時\s*(\d{1,2})?\s*分?/
      ]
    : [
        /(\d{1,2}):(\d{2})\s*(?:から|より)\s*受付(?:を)?(?:開始|オープン)?/,
        /(\d{1,2})時\s*(\d{1,2})?\s*分?\s*(?:から|より)\s*受付(?:を)?(?:開始|オープン)?/,
        /(\d{1,2}):(\d{2})\s*受付(?:を)?(?:開始|オープン)/,
        /(\d{1,2})時\s*(\d{1,2})?\s*分?\s*受付(?:を)?(?:開始|オープン)/,
        /(?:受付(?:を)?(?:開始|オープン)|受付\s*開始|受付開始)\s*[:：]?\s*(\d{1,2}):(\d{2})/,
        /(?:受付(?:を)?(?:開始|オープン)|受付\s*開始|受付開始)\s*[:：]?\s*(\d{1,2})時\s*(\d{1,2})?\s*分?/
      ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return `${match[1].padStart(2, "0")}:${(match[2] ?? "0").padStart(2, "0")}`;
  }
  return null;
}
