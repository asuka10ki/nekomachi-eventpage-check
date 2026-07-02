import type { BrowserContext, Locator, Page } from "playwright";
import type { EventInfo, EventListItem, TicketInfo } from "./types.js";
import { classifyEventByName } from "./utils/classify.js";
import { normalizePriceText, normalizeVisibilityTags } from "./utils/normalize.js";
import { parseJapaneseDateTime } from "./utils/date.js";

type RawAdminEventFormData = {
  title: string | null;
  startAtText: string | null;
  endAtText: string | null;
  venue: string | null;
  tickets: {
    name: string;
    priceText: string;
    visibility: string | null;
    onlineEnabled: boolean | null;
    onlineUrl: string | null;
    organizerNotice: string | null;
  }[];
};

export async function collectEventList(page: Page, listUrl: string): Promise<EventListItem[]> {
  await page.goto(listUrl, { waitUntil: "domcontentloaded" });
  const items = await collectCurrentPageEvents(page);
  return dedupeByUrl(items);
}

export async function collectEventListWithPagination(page: Page, listUrl: string): Promise<EventListItem[]> {
  await page.goto(listUrl, { waitUntil: "domcontentloaded" });
  const all: EventListItem[] = [];
  for (let i = 0; i < 20; i += 1) {
    all.push(...(await collectCurrentPageEvents(page)));
    const next = page.getByRole("link", { name: /次へ|Next/i }).or(page.getByRole("button", { name: /次へ|Next/i }));
    if ((await next.count()) === 0 || !(await next.first().isEnabled().catch(() => false))) break;
    await Promise.all([page.waitForLoadState("domcontentloaded"), next.first().click()]);
  }
  return dedupeByUrl(all);
}

export async function collectEventListsWithPagination(page: Page, listUrls: string[]): Promise<EventListItem[]> {
  const all: EventListItem[] = [];
  for (const listUrl of listUrls) {
    all.push(...(await collectEventListWithPagination(page, listUrl)));
  }
  return dedupeByUrl(all);
}

export async function fetchEventInfo(context: BrowserContext, item: EventListItem): Promise<EventInfo> {
  const page = await context.newPage();
  try {
    await page.goto(item.detailUrl, { waitUntil: "networkidle", timeout: 60000 });
    await page.locator("#title, [name='event_ticket_name']").first().waitFor({ state: "attached", timeout: 15000 }).catch(() => undefined);

    const formData = await extractAdminEventFormData(page);
    const name = formData.name || (await getFieldText(page, ["イベント名", "タイトル"])) || item.name;
    const startText = formData.startAtText || (await getFieldText(page, ["開始日時", "開始日", "開催日時"]));
    const endText = formData.endAtText || (await getFieldText(page, ["終了日時", "終了日"]));
    const tickets = formData.tickets.length > 0 ? formData.tickets : await collectTickets(page);
    return {
      name,
      kind: classifyEventByName(name || item.name),
      detailUrl: item.detailUrl,
      startAt: startText ? parseJapaneseDateTime(startText) : null,
      endAt: endText ? parseJapaneseDateTime(endText) : null,
      venue: formData.venue || await getFieldText(page, ["会場"]),
      tickets
    };
  } finally {
    await page.close();
  }
}

async function extractAdminEventFormData(page: Page): Promise<{
  name: string | null;
  startAtText: string | null;
  endAtText: string | null;
  venue: string | null;
  tickets: TicketInfo[];
}> {
  const raw = await page.evaluate(`(() => {
    const controls = Array.from(document.querySelectorAll("input, textarea, select"));
    const valueOf = (el) => {
      if (el instanceof HTMLSelectElement) return Array.from(el.selectedOptions).map((option) => option.textContent?.trim() ?? "").join(",");
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
      return "";
    };
    const controlInfo = controls.map((el, index) => ({
      index,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") ?? "",
      name: el.getAttribute("name") ?? "",
      id: el.getAttribute("id") ?? "",
      placeholder: el.getAttribute("placeholder") ?? "",
      value: valueOf(el),
      checked: el instanceof HTMLInputElement ? el.checked : false
    }));

    const title = controlInfo.find((control) => control.id === "title")?.value ?? null;
    const datetimes = controlInfo.filter((control) => control.type === "datetime-local").map((control) => control.value);
    const venue = controlInfo.find((control) => control.id === "editEvent_venue")?.value ?? null;
    const ticketNameIndexes = controlInfo
      .filter((control) => control.name === "event_ticket_name")
      .map((control) => control.index);

    const tickets = ticketNameIndexes.map((startIndex, ticketIndex) => {
      const endIndex = ticketNameIndexes[ticketIndex + 1] ?? Number.POSITIVE_INFINITY;
      const group = controlInfo.filter((control) => control.index >= startIndex && control.index < endIndex);
      const name = group.find((control) => control.name === "event_ticket_name")?.value ?? "";
      const payment = group.find((control) => control.tag === "select" && /無料|事前決済/.test(control.value))?.value ?? "";
      const priceControl = group.find((control) => control.placeholder === "半角、コンマなし");
      const onlineControl = group.find((control) => control.id.startsWith("is_online_"));
      const onlineUrl = group.find((control) => control.placeholder.includes("YouTubeライブ") || control.placeholder.includes("Zoom"))?.value ?? null;
      const organizerNotice = group.find((control) => control.tag === "textarea" && control.placeholder.includes("参加方法"))?.value ?? null;
      const visibility = group.find((control) => control.tag === "select" && !/無料|事前決済|アンケート/.test(control.value))?.value ?? null;

      return {
        name,
        priceText: priceControl?.value ?? (payment === "無料" ? "0" : ""),
        visibility,
        onlineEnabled: onlineControl ? onlineControl.checked : null,
        onlineUrl,
        organizerNotice
      };
    });

    return {
      title,
      startAtText: datetimes[0] ?? null,
      endAtText: datetimes[1] ?? null,
      venue,
      tickets
    };
  })()`) as RawAdminEventFormData;

  return {
    name: raw.title,
    startAtText: raw.startAtText,
    endAtText: raw.endAtText,
    venue: raw.venue,
    tickets: raw.tickets.map((ticket) => ({
      name: ticket.name,
      price: normalizePriceText(ticket.priceText),
      visibility: ticket.visibility,
      visibilityTags: normalizeVisibilityTags(ticket.visibility ? [ticket.visibility] : []),
      onlineEnabled: ticket.onlineEnabled,
      onlineUrl: ticket.onlineUrl,
      organizerNotice: ticket.organizerNotice
    }))
  };
}

export async function collectCurrentPageEvents(page: Page): Promise<EventListItem[]> {
  return dedupeByUrl(await findEventLinksInScope(page, page.url()));
}

async function collectTickets(page: Page): Promise<TicketInfo[]> {
  const cards = await findTicketCards(page);
  const tickets: TicketInfo[] = [];
  const count = await cards.count();
  for (let i = 0; i < count; i += 1) {
    const card = cards.nth(i);
    tickets.push({
      name: (await getFieldText(card, ["チケット名"])) ?? "",
      price: normalizePriceText((await getFieldText(card, ["金額（税込）", "金額", "価格"])) ?? ""),
      visibility: await getFieldText(card, ["販売対象者"]),
      visibilityTags: normalizeVisibilityTags(await getVisibilityTexts(card)),
      onlineEnabled: await getBooleanField(card, ["オンライン開催する"]),
      onlineUrl: await getFieldText(card, ["オンライン参加URL", "参加URL", "Zoom URL"]),
      organizerNotice: await getFieldText(card, ["主催者からのお知らせ", "お知らせ"])
    });
  }
  return tickets;
}

async function findTicketCards(page: Page): Promise<Locator> {
  const candidates = [
    page.locator("section:has-text('チケット名')"),
    page.locator("div:has-text('チケット名')").filter({ has: page.getByText("販売対象者") }),
    page.locator("fieldset:has-text('チケット名')")
  ];
  for (const candidate of candidates) {
    if ((await candidate.count()) > 0) return candidate;
  }
  return page.locator("text=チケット名").locator("xpath=ancestor::*[self::section or self::div or self::fieldset][1]");
}

async function getFieldText(scope: Page | Locator, labels: string[]): Promise<string | null> {
  for (const label of labels) {
    const byLabel = scope.getByLabel(label).first();
    const value = await inputValue(byLabel);
    if (value) return value;

    const labelNode = scope.getByText(label, { exact: false }).first();
    if ((await labelNode.count()) === 0) continue;
    const container = labelNode.locator("xpath=ancestor::*[self::label or self::dt or self::div or self::tr][1]");
    const nearbyInput = container.locator("input, textarea, select").first();
    const nearbyValue = await inputValue(nearbyInput);
    if (nearbyValue) return nearbyValue;

    const text = clean(await container.innerText().catch(() => ""));
    const withoutLabel = clean(text.replace(label, ""));
    if (withoutLabel) return withoutLabel;
  }
  return null;
}

async function getBooleanField(scope: Locator, labels: string[]): Promise<boolean | null> {
  for (const label of labels) {
    const labelNode = scope.getByText(label, { exact: false }).first();
    if ((await labelNode.count()) === 0) continue;
    const container = labelNode.locator("xpath=ancestor::*[self::label or self::div or self::tr][1]");
    const checkbox = container.locator("input[type='checkbox']").first();
    if ((await checkbox.count()) > 0) return checkbox.isChecked();
    const text = clean(await container.innerText().catch(() => ""));
    if (/ON|オン|有効|する/.test(text)) return true;
    if (/OFF|オフ|無効|しない/.test(text)) return false;
  }
  return null;
}

async function getVisibilityTexts(card: Locator): Promise<string[]> {
  const raw = await getFieldText(card, ["販売対象者"]);
  const tagTexts = await card
    .locator("[aria-selected='true'], [class*='tag'], [class*='chip'], [class*='badge']")
    .allInnerTexts()
    .catch(() => []);
  return [raw, ...tagTexts].filter((value): value is string => Boolean(value));
}

async function inputValue(locator: Locator): Promise<string | null> {
  if ((await locator.count()) === 0) return null;
  const tag = await locator.evaluate((node) => node.tagName.toLowerCase()).catch(() => "");
  if (tag === "select") {
    return clean(await locator.locator("option:checked").innerText().catch(() => ""));
  }
  const value = await locator.inputValue().catch(() => "");
  return clean(value) || null;
}

function dedupeByUrl(items: EventListItem[]): EventListItem[] {
  const byUrl = new Map<string, EventListItem>();
  for (const item of items) {
    const current = byUrl.get(item.detailUrl);
    if (!current || scoreEventLink(item) > scoreEventLink(current)) {
      byUrl.set(item.detailUrl, item);
    }
  }
  return [...byUrl.values()];
}

async function findEventLinksInScope(scope: Page | Locator, baseUrl: string): Promise<EventListItem[]> {
  const links = scope.locator("a[href*='/admin_events/'], a[href*='/admin/events/'], a[href*='/events/']");
  const candidates: EventListItem[] = [];
  const linkCount = await links.count();
  for (let i = 0; i < linkCount; i += 1) {
    const link = links.nth(i);
    const name = clean(await link.innerText().catch(() => ""));
    const href = await link.getAttribute("href");
    if (!name || !href) continue;
    if (isActionLink(name)) continue;
    if (isDangerousActionLink(name)) continue;
    if (!looksLikeEventDetailUrl(href)) continue;
    candidates.push({ name, detailUrl: new URL(href, baseUrl).toString() });
  }
  return candidates;
}

function isDangerousActionLink(text: string): boolean {
  return /^(削除する|非公開にする|複製する)$/.test(clean(text));
}

function isActionLink(text: string): boolean {
  return /^(編集する|参加者|分析|チケット|有料チケット一覧|新規作成\(管理者用\))$/.test(clean(text));
}

function looksLikeEventDetailUrl(href: string): boolean {
  if (/delete|destroy|duplicate|copy|clone|private|unpublish|publish|members|analysis|event_tickets|payment_event_tickets/i.test(href)) {
    return false;
  }
  return /\/admin_events\/[^/?#]+\/edit(?:$|[?#])/.test(href);
}

function scoreEventLink(item: EventListItem): number {
  let score = 0;
  if (/[『「《〈【〖]/.test(item.name)) score += 4;
  if (/読書会|イベント|講座|会/.test(item.name)) score += 2;
  if (/\/admin_events\/[^/?#]+\/edit/.test(item.detailUrl)) score += 4;
  return score - Math.min(item.name.length, 20) / 100;
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
