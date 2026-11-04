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

/**
 * Extracts every business-significant title component enclosed in a supported
 * pair of Japanese brackets. Operational labels such as 【オンライン】 are not
 * title components, while series names such as 【村上春樹三連発】 are.
 */
export function extractTitleComponents(text: string): string[] {
  return [...new Set(readTitleComponents(text).map((component) => component.value))];
}

type TitleComponent = { value: string; canOmitSubtitle: boolean };

function readTitleComponents(text: string): TitleComponent[] {
  const bracketPattern = /【([^】]+)】|『([^』]+)』|「([^」]+)」|《([^》]+)》|〈([^〉]+)〉/g;
  return [...text.matchAll(bracketPattern)].flatMap((match) => {
    const value = normalizeCommonText(match.slice(1).find((entry) => entry !== undefined) ?? "");
    if (!value || isNonTitleComponent(value)) return [];
    // シリーズ名（【】）と巻・部・章・回の番号は、副題省略で緩和しない。
    const numbered = /^第[0-9一二三四五六七八九十百千]+(?:部|巻|章|回)|^[上中下]巻/.test(value);
    return [{ value, canOmitSubtitle: match[1] === undefined && !numbered }];
  });
}

export function validateTicketNameTitleComponents(eventName: string, ticketName: string): string | null {
  const expected = readTitleComponents(eventName);
  const actual = readTitleComponents(ticketName);
  if (actual.length === 0) return null;
  const unexpected = [...new Set(actual.filter((component) => !expected.some((eventComponent) => matchesTitleComponent(eventComponent, component)))
    .map((component) => component.value))];
  return unexpected.length === 0
    ? null
    : `イベント名にないタイトル要素があります: ${unexpected.map(formatTitleComponent).join("、")}`;
}

function matchesTitleComponent(event: TitleComponent, ticket: TitleComponent): boolean {
  if (event.value === ticket.value) return true;
  if (!event.canOmitSubtitle || !ticket.canOmitSubtitle || !event.value.startsWith(ticket.value)) return false;
  // 単語途中の切り詰めや文字列途中の一致は許可しない。
  return /^(?:\s+|[：:―—–－-])\s*\S/.test(event.value.slice(ticket.value.length));
}

function isNonBookTitleLabel(title: string): boolean {
  return ["読書会なし", "読書会セット"].includes(title);
}

function isNonTitleComponent(component: string): boolean {
  if (isNonBookTitleLabel(component)) return true;
  const operationalLabels = new Set([
    "オンライン",
    "オフライン",
    "ハイブリッド",
    "初心者",
    "初心者限定",
    "ビギナー限定",
    "東京",
    "大阪",
    "京都",
    "福岡",
    "名古屋",
    "愛知",
    "予告",
    "一覧"
  ]);
  const labels = component.split(/[・/／\s]+/).filter(Boolean);
  return labels.length > 0 && labels.every((label) => operationalLabels.has(label));
}

function formatTitleComponent(component: string): string {
  return `〈${component}〉`;
}
