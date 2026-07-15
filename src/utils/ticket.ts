import type { TicketInfo, TicketRule } from "../types.js";
import { normalizeCommonText, normalizeTicketText, normalizeTitleText } from "./normalize.js";

export function extractBookTitle(text: string): string | null {
  const normalized = normalizeTitleText(text);
  const bracketPattern = /[『「《〈]([^』」》〉]+)[』」》〉]/g;
  const candidates = [...normalized.matchAll(bracketPattern)]
    .map((match) => normalizeCommonText(match[1]))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (candidates[0]) return candidates[0];

  const cleaned = normalized
    .replace(/[『』「」《》〈〉]/g, "")
    .replace(/読書会|イベント|参加チケット|チケット/g, "")
    .trim();
  return cleaned || null;
}

export function classifyTicketRulesByInfo(ticket: TicketInfo, rules: TicketRule[]): TicketRule[] {
  const text = normalizeTicketText(ticket.name);
  const matches = rules.filter((rule) => {
    if (!containsAllTags(ticket.visibilityTags, rule.visibilityTags)) return false;

    if (rule.note === "1回目") {
      return text.includes("1回目");
    }
    if (rule.note === "2回目以降") {
      return text.includes("2回目以降") || text.includes("2回目");
    }

    return true;
  });

  return matches;
}

export function validateTicketNameBookTitle(eventName: string, ticketName: string): string | null {
  const eventBook = extractBookTitle(eventName);
  const ticketBook = extractBracketedBookTitle(ticketName);
  if (!eventBook) return null;
  if (!ticketBook) return null;
  if (ticketBook && normalizeCommonText(ticketBook) === normalizeCommonText(eventBook)) return null;

  return `別の本のタイトルが入っています。イベント: 『${eventBook}』 / チケット: 『${ticketBook}』`;
}

export function validateTicketNameMemberLabel(rule: TicketRule, ticketName: string): string | null {
  const text = normalizeTicketText(ticketName);
  const memberLabels = ["オンライン会員", "地域会員", "ハイブリッド会員", "非会員"];
  const includedLabels = memberLabels.filter((label) => text.includes(label));
  const invalidLabels = includedLabels.filter((label) => !rule.name.includes(label));
  if (invalidLabels.length === 0) return null;
  return `チケット名の会員名が閲覧権限と一致していません。期待: ${rule.name} / チケット名: ${invalidLabels.join(",")}`;
}

export function sameTagSet(expected: string[], actual: string[]): boolean {
  const a = [...expected].sort().join(",");
  const b = [...actual].sort().join(",");
  return a === b;
}

export function containsAllTags(actual: string[], expected: string[]): boolean {
  return expected.every((tag) => actual.includes(tag));
}

function extractBracketedBookTitle(text: string): string | null {
  const normalized = normalizeTitleText(text);
  const bracketPattern = /[『「《〈]([^』」》〉]+)[』」》〉]/g;
  const candidates = [...normalized.matchAll(bracketPattern)]
    .map((match) => normalizeCommonText(match[1]))
    .filter((title) => !isNonBookTitleLabel(title))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  return candidates[0] ?? null;
}

function isNonBookTitleLabel(title: string): boolean {
  return ["読書会なし", "読書会セット"].includes(title);
}
