import { normalizeCommonText, normalizeTitleText } from "./normalize.js";

export function extractBookTitle(text: string): string | null {
  return extractBookTitles(text).sort((a, b) => b.length - a.length)[0] ?? null;
}

export function extractBookTitles(text: string): string[] {
  const normalized = normalizeTitleText(text);
  const bracketPattern = /[『「《〈]([^』」》〉]+)[』」》〉]/g;
  return [...new Set([...normalized.matchAll(bracketPattern)]
    .map((match) => normalizeCommonText(match[1]))
    .filter((title) => Boolean(title) && !isNonBookTitleLabel(title)))];
}

export function resolveEventBookTitle(text: string):
  | { status: "none" }
  | { status: "ambiguous"; candidates: string[] }
  | { status: "determined"; value: string } {
  const candidates = extractBookTitles(text);
  if (candidates.length === 0) return { status: "none" };
  const longestLength = Math.max(...candidates.map((candidate) => candidate.length));
  const longest = candidates.filter((candidate) => candidate.length === longestLength);
  return longest.length === 1 ? { status: "determined", value: longest[0] } : { status: "ambiguous", candidates: longest };
}

export function validateTicketNameBookTitle(eventName: string, ticketName: string): string | null {
  const eventBook = resolveEventBookTitle(eventName);
  if (eventBook.status !== "determined") return null;
  const mismatches = extractBookTitles(ticketName).filter((ticketBook) => normalizeCommonText(ticketBook) !== normalizeCommonText(eventBook.value));
  return mismatches.length === 0
    ? null
    : `別の本のタイトルが入っています。イベント: 『${eventBook.value}』 / チケット: ${mismatches.map((title) => `『${title}』`).join("、")}`;
}

function isNonBookTitleLabel(title: string): boolean {
  return ["読書会なし", "読書会セット"].includes(title);
}
