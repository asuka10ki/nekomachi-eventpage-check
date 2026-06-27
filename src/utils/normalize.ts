const fullWidthDigits = "０１２３４５６７８９";

export function normalizeEventNameForClassification(eventName: string): string {
  return eventName.replaceAll("〖", "【").replaceAll("〗", "】");
}

export function normalizeTitleText(text: string): string {
  return normalizeCommonText(text)
    .replace(/[【〖](オンライン|東京|大阪|京都|福岡|名古屋|予告|一覧)[】〗]/g, "")
    .replace(/\b(オンライン|東京|大阪|京都|福岡|名古屋|予告|一覧)\b/g, "")
    .replace(/(オンライン会員|地域会員|ハイブリッド会員|非会員)/g, "")
    .replace(/(2回目以降|二回目以降|1回目|一回目|初回)/g, "")
    .replace(/[（(]?(税込)?[￥¥]?\s*[\d,]+\s*円?[）)]?/g, "")
    .trim();
}

export function normalizeTicketText(text: string): string {
  return normalizeCommonText(text)
    .replace(/二回目以降/g, "2回目以降")
    .replace(/一回目/g, "1回目")
    .replace(/初回/g, "1回目")
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/\s*・\s*/g, "・");
}

export function normalizePriceText(text: string): number | null {
  const normalized = toHalfWidthDigits(text).replace(/[,\s￥¥円税込()（）]/g, "");
  const match = normalized.match(/\d+/);
  return match ? Number(match[0]) : null;
}

export function normalizeVisibilityTags(tags: string[]): string[] {
  const normalized = tags.flatMap((tag) => {
    const text = normalizeCommonText(tag);
    const markedTags = extractMarkedVisibilityTags(text);
    if (markedTags.length > 0) return markedTags;

    const result: string[] = [];
    if (text.includes("オンライン会員") || /^オン$/.test(text)) result.push("オン");
    if (text.includes("地域会員") || /^オフ$/.test(text)) result.push("オフ");
    if (text.includes("ハイブリッド会員") || /^ハイ$/.test(text)) result.push("ハイ");
    if (text.includes("非会員") || /^外$/.test(text)) result.push("外");
    return result.length > 0 ? result : text ? [text] : [];
  });
  return [...new Set(normalized)].sort();
}

export function normalizeUrlText(text: string | null): string {
  return (text ?? "")
    .trim()
    .replace(/[\r\n]/g, "")
    .replace(/　/g, "")
    .replace(/\s+/g, " ");
}

export function normalizeNoticeText(text: string | null): string {
  return (text ?? "").trim().replace(/\r\n?/g, "\n").replace(/[　\s]+/g, " ");
}

export function normalizeCommonText(text: string): string {
  return toHalfWidthDigits(text)
    .replace(/　/g, " ")
    .replace(/\r?\n/g, "")
    .replaceAll("〖", "【")
    .replaceAll("〗", "】")
    .replace(/\s+/g, " ")
    .trim();
}

export function toHalfWidthDigits(text: string): string {
  return [...text]
    .map((char) => {
      const index = fullWidthDigits.indexOf(char);
      return index >= 0 ? String(index) : char;
    })
    .join("");
}

function extractMarkedVisibilityTags(text: string): string[] {
  const result: string[] = [];
  const markerPattern = /(オン|オフ|ハイ|外|A|U-?22|B)\s*[〇◯○]/g;
  for (const match of text.matchAll(markerPattern)) {
    result.push(normalizeVisibilityTagName(match[1]));
  }
  return result;
}

function normalizeVisibilityTagName(tag: string): string {
  return tag === "U22" ? "U-22" : tag;
}
