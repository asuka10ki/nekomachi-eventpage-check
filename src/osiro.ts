import type { BrowserContext, Locator, Page } from "playwright";
import type { EventInfo, EventListItem, TicketInfo } from "./types.js";
import { normalizePriceText, normalizeVisibilityTags } from "./utils/normalize.js";
import { matchedExcludedEventNameMarkers } from "./domain/eligibility.js";
import { parseJapaneseDateTime } from "./utils/date.js";
import {
  AcquisitionError,
  assertAdminEventDetailPageState,
  assertAdminEventListPageState,
  assertAdminSessionIsValid,
  assertPageLimitNotExceeded,
  assertPaginationAdvanced,
  assertSuccessfulHttpResponse
} from "./acquisition/quality.js";

export {
  assertCollectedEventsExist,
  assertAdminEventDetailPageState,
  assertAdminEventListPageState,
  assertAdminSessionIsValid,
  assertPageLimitNotExceeded,
  assertPaginationAdvanced,
  assertSuccessfulHttpResponse
} from "./acquisition/quality.js";

export type RawAdminEventFormData = {
  title: string | null;
  startAtText: string | null;
  endAtText: string | null;
  venue: string | null;
  bodyText: string | null;
  applicationDeadlineEnabled: boolean | null;
  applicationDeadline: string | null;
  availability: Record<string, boolean>;
  tickets: {
    name: string;
    priceText: string;
    visibility: string | null;
    onlineEnabled: boolean | null;
    onlineUrl: string | null;
    organizerNotice: string | null;
    availability: Record<string, boolean>;
  }[];
};

export async function collectEventList(page: Page, listUrl: string): Promise<EventListItem[]> {
  const response = await page.goto(listUrl, { waitUntil: "domcontentloaded" });
  assertSuccessfulHttpResponse(page.url(), response?.status() ?? null, response?.ok() ?? false);
  assertAdminSessionIsValid(page.url());
  await assertAdminEventListPage(page);
  const items = await collectCurrentPageEvents(page);
  return dedupeByUrl(items);
}

export async function collectEventListWithPagination(page: Page, listUrl: string, maxPages = 20): Promise<EventListItem[]> {
  const response = await page.goto(listUrl, { waitUntil: "domcontentloaded" });
  assertSuccessfulHttpResponse(page.url(), response?.status() ?? null, response?.ok() ?? false);
  assertAdminSessionIsValid(page.url());
  const all: EventListItem[] = [];
  const visitedPages = new Set<string>();
  for (let pageIndex = 1; ; pageIndex += 1) {
    await assertAdminEventListPage(page);
    const currentPageUrl = canonicalPageUrl(page.url());
    if (visitedPages.has(currentPageUrl)) {
      throw new AcquisitionError("QUAL-LIST-004", "OSIROのイベント一覧でページングの循環を検出しました。");
    }
    visitedPages.add(currentPageUrl);
    all.push(...(await collectCurrentPageEvents(page)));
    const next = page.getByRole("link", { name: /次へ|Next/i }).or(page.getByRole("button", { name: /次へ|Next/i }));
    if ((await next.count()) === 0 || !(await next.first().isEnabled())) break;
    assertPageLimitNotExceeded(pageIndex, maxPages);

    const previousUrl = page.url();
    const nextHref = await next.first().getAttribute("href");
    if (nextHref && visitedPages.has(canonicalPageUrl(new URL(nextHref, previousUrl).toString()))) {
      throw new AcquisitionError("QUAL-LIST-004", "OSIROのイベント一覧で同じ次ページURLが再指定されました。");
    }
    const navigationResponse = nextHref
      ? await page.goto(new URL(nextHref, previousUrl).toString(), { waitUntil: "domcontentloaded", timeout: 30000 })
      : (await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }),
        next.first().click()
      ]))[0];
    assertSuccessfulHttpResponse(page.url(), navigationResponse?.status() ?? null, navigationResponse?.ok() ?? false);
    assertAdminSessionIsValid(page.url());
    assertPaginationAdvanced(previousUrl, page.url());
  }
  return dedupeByUrl(all);
}

export async function collectEventListsWithPagination(page: Page, listUrl: string, maxPages = 20): Promise<EventListItem[]> {
  return collectEventListWithPagination(page, listUrl, maxPages);
}

export async function fetchEventInfo(context: BrowserContext, item: EventListItem): Promise<EventInfo> {
  const page = await context.newPage();
  try {
    return await fetchEventInfoFromPage(page, item);
  } finally {
    await page.close();
  }
}

export type DetailWaitOptions = {
  navigationTimeoutMs?: number;
  domTimeoutMs?: number;
};

export async function fetchEventInfoFromPage(page: Page, item: EventListItem, options: DetailWaitOptions = {}): Promise<EventInfo> {
    const navigationTimeoutMs = options.navigationTimeoutMs ?? 30000;
    const domTimeoutMs = options.domTimeoutMs ?? 15000;
    const response = await page.goto(item.detailUrl, { waitUntil: "domcontentloaded", timeout: navigationTimeoutMs });
    assertSuccessfulHttpResponse(page.url(), response?.status() ?? null, response?.ok() ?? false, "event");
    assertAdminSessionIsValid(page.url(), "event");
    await waitForAdminEventDetailIdentity(page, domTimeoutMs);

    const detailTitle = await page.locator("#title").inputValue().catch(() => "");
    const normalizedTitle = detailTitle.trim();
    if (!normalizedTitle || matchedExcludedEventNameMarkers(normalizedTitle).length > 0) {
      return {
        name: normalizedTitle,
        detailUrl: item.detailUrl,
        startAt: null,
        endAt: null,
        venue: null,
        bodyText: undefined,
        applicationDeadlineEnabled: undefined,
        applicationDeadline: undefined,
        tickets: [],
        fieldAvailability: {
          startAt: false,
          endAt: false,
          venue: false,
          bodyText: false,
          applicationDeadlineEnabled: false,
          applicationDeadline: false,
          tickets: false
        }
      };
    }

    await waitForAdminEventForm(page, domTimeoutMs);
    await waitForTicketRegion(page, domTimeoutMs);

    const formData = await extractEventFormDataWithTicketFallback(page);
    const name = formData.name ?? item.name;
    const startText = formData.startAtText;
    const endText = formData.endAtText;
    const tickets = formData.tickets;
    const venue = formData.venue;
    const applicationDeadlineEnabled = formData.applicationDeadlineEnabled;
    const applicationDeadline = formData.applicationDeadline;
    return {
      name,
      detailUrl: item.detailUrl,
      startAt: startText ? parseJapaneseDateTime(startText) : null,
      endAt: endText ? parseJapaneseDateTime(endText) : null,
      venue,
      bodyText: formData.bodyText,
      applicationDeadlineEnabled,
      applicationDeadline,
      tickets,
      fieldAvailability: {
        startAt: formData.availability.startAt,
        endAt: formData.availability.endAt,
        venue: formData.availability.venue,
        bodyText: formData.availability.bodyText,
        applicationDeadlineEnabled: formData.availability.applicationDeadlineEnabled,
        applicationDeadline: formData.availability.applicationDeadline,
        tickets: formData.availability.tickets
      }
    };
}

async function assertAdminEventListPage(page: Page): Promise<void> {
  const eventIndex = page.locator("#eventIndex");
  await eventIndex.waitFor({ state: "attached", timeout: 15000 }).catch(() => undefined);
  assertAdminEventListPageState(page.url(), (await eventIndex.count()) > 0);
}

async function waitForAdminEventDetailIdentity(page: Page, timeoutMs: number): Promise<void> {
  const title = page.locator("#title");
  let ready = false;
  try {
    await title.waitFor({ state: "attached", timeout: timeoutMs });
    await page.waitForFunction(() => {
      const control = document.querySelector("#title");
      return (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) && control.value.trim().length > 0;
    }, undefined, { timeout: timeoutMs });
    ready = true;
  } catch {
    // 下の品質判定へ集約し、ログイン切れと必須DOM変更を同じ空データにしない。
  }
  assertAdminEventDetailPageState(page.url(), ready);
}

async function waitForAdminEventForm(page: Page, timeoutMs: number): Promise<void> {
  // OSIROの編集画面は、入力欄一式を必ずしも<form>要素で囲まない。
  // 抽出処理が実際に必要とするコントロールと値を、イベント設定領域の描画完了条件とする。
  try {
    await page.waitForFunction(() => {
      const datetimes = Array.from(document.querySelectorAll("input[type='datetime-local']"));
      const firstTwoDatesReady = datetimes.length >= 2 && datetimes.slice(0, 2).every((control) => control instanceof HTMLInputElement && control.value.trim().length > 0);
      return firstTwoDatesReady
        && document.querySelector("#editEvent_venue") !== null
        && document.querySelector("textarea[name='body'], textarea[name='content'], input[name='body'], input[name='content']") !== null;
    }, undefined, { timeout: timeoutMs });
  } catch {
    throw new AcquisitionError(
      "QUAL-DETAIL-004",
      `OSIROのイベント詳細画面でイベントフォームが${timeoutMs}ms以内に表示されませんでした。`,
      "event"
    );
  }
}

async function waitForTicketRegion(page: Page, timeoutMs: number): Promise<void> {
  const ticketRegion = page.locator(
    "#event_tickets, #eventTickets, [data-ticket-container], .event-tickets, [data-testid='event-tickets'], input[name='event_ticket_name']"
  ).first();
  try {
    await ticketRegion.waitFor({ state: "attached", timeout: timeoutMs });
  } catch {
    throw new AcquisitionError(
      "QUAL-DETAIL-005",
      `OSIROのイベント詳細画面でチケット領域が${timeoutMs}ms以内に表示されませんでした。`,
      "event"
    );
  }

  try {
    await page.waitForFunction(() => {
      const controls = Array.from(document.querySelectorAll("input, textarea, select"));
      const ticketIndexes = controls
        .map((control, index) => ({ control, index }))
        .filter(({ control }) => control.getAttribute("name") === "event_ticket_name")
        .map(({ index }) => index);
      if (ticketIndexes.length === 0) return false;

      return ticketIndexes.every((startIndex, ticketIndex) => {
        const endIndex = ticketIndexes[ticketIndex + 1] ?? Number.POSITIVE_INFINITY;
        const group = controls.slice(startIndex, endIndex);
        const name = group.find((control) => control.getAttribute("name") === "event_ticket_name");
        const nameReady = (name instanceof HTMLInputElement || name instanceof HTMLTextAreaElement) && name.value.trim().length > 0;
        const paymentSelect = group.find((control) => control instanceof HTMLSelectElement && /無料|事前決済/.test(Array.from(control.selectedOptions).map((option) => option.textContent ?? "").join(",")));
        const priceReady = group.some((control) => control.getAttribute("placeholder") === "半角、コンマなし") || paymentSelect !== undefined;
        const onlineReady = group.some((control) => control.id.startsWith("is_online_"));
        const visibilityReady = group.some((control) => control instanceof HTMLSelectElement
          && control !== paymentSelect
          && !/アンケート/.test(Array.from(control.selectedOptions).map((option) => option.textContent ?? "").join(","))
          && Array.from(control.selectedOptions).some((option) => (option.textContent ?? "").trim().length > 0));
        return nameReady && priceReady && onlineReady && visibilityReady;
      });
    }, undefined, { timeout: timeoutMs });
  } catch {
    throw new AcquisitionError(
      "QUAL-DETAIL-006",
      `OSIROのイベント詳細画面でチケットの必須項目が${timeoutMs}ms以内に取得可能になりませんでした。`,
      "event"
    );
  }
}

export const ADMIN_EVENT_FORM_EVALUATION_SCRIPT = `(() => {
    const controls = Array.from(document.querySelectorAll("input, textarea, select"));
    const valueOf = (el) => {
      if (el instanceof HTMLSelectElement) return Array.from(el.selectedOptions).map((option) => option.textContent?.trim() ?? "").join(",");
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
      return "";
    };
    const labelTextOf = (el) => {
      const id = el.getAttribute("id") ?? "";
      const explicitLabel = id ? document.querySelector(\`label[for="\${CSS.escape(id)}"]\`) : null;
      return (el.closest("label, tr")?.textContent ?? explicitLabel?.textContent ?? "").trim();
    };
    const controlInfo = controls.map((el, index) => ({
      index,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") ?? "",
      name: el.getAttribute("name") ?? "",
      id: el.getAttribute("id") ?? "",
      placeholder: el.getAttribute("placeholder") ?? "",
      value: valueOf(el),
      labelText: labelTextOf(el),
      checked: el instanceof HTMLInputElement ? el.checked : false
    }));

    const titleControl = controlInfo.find((control) => control.id === "title");
    const title = titleControl?.value ?? null;
    const datetimeControls = controlInfo.filter((control) => control.type === "datetime-local");
    const datetimes = datetimeControls.map((control) => control.value);
    const venueControl = controlInfo.find((control) => control.id === "editEvent_venue");
    const venue = venueControl?.value ?? null;
    const htmlToText = (html) => {
      const container = document.createElement("div");
      container.innerHTML = String(html)
        .replace(/<br\\s*\\/?>/gi, "\\n")
        .replace(/<\\/(p|div|li|h[1-6]|tr)>/gi, "\\n");
      return (container.textContent ?? "")
        .replace(/\\u00a0/g, " ")
        .replace(/[ \\t\\f\\v]+/g, " ")
        .replace(/\\n\\s*\\n+/g, "\\n")
        .trim();
    };
    const bodyControl = controlInfo.find((control) => control.name === "body") ?? controlInfo.find((control) => control.name === "content");
    const bodyHtml = bodyControl?.value ?? null;
    const bodyText = bodyHtml === null ? null : htmlToText(bodyHtml);
    const deadlineEnabledControl = controlInfo.find((control) => control.id === "editEvent_reservation");
    const applicationDeadlineEnabled = deadlineEnabledControl?.checked ?? null;
    const deadlineControl = controlInfo.find((control) => /申込締切|申し込み締切|申込み締切/.test([control.name, control.id, control.placeholder, control.labelText].join(" ")));
    const applicationDeadline = deadlineControl?.value ?? datetimes[2] ?? null;
    const ticketNameIndexes = controlInfo
      .filter((control) => control.name === "event_ticket_name")
      .map((control) => control.index);
    const ticketContainerAvailable = ticketNameIndexes.length > 0 || Boolean(
      document.querySelector("#event_tickets, #eventTickets, [data-ticket-container], .event-tickets, [data-testid='event-tickets']")
    );

    const tickets = ticketNameIndexes.map((startIndex, ticketIndex) => {
      const endIndex = ticketNameIndexes[ticketIndex + 1] ?? Number.POSITIVE_INFINITY;
      const group = controlInfo.filter((control) => control.index >= startIndex && control.index < endIndex);
      const nameControl = group.find((control) => control.name === "event_ticket_name");
      const name = nameControl?.value ?? "";
      const payment = group.find((control) => control.tag === "select" && /無料|事前決済/.test(control.value))?.value ?? "";
      const priceControl = group.find((control) => control.placeholder === "半角、コンマなし");
      const onlineControl = group.find((control) => control.id.startsWith("is_online_"));
      const onlineUrlControl = group.find((control) => control.placeholder.includes("YouTubeライブ") || control.placeholder.includes("Zoom"));
      const organizerNoticeControl = group.find((control) => control.tag === "textarea" && control.placeholder.includes("参加方法"));
      const visibilityControl = group.find((control) => control.tag === "select" && !/無料|事前決済|アンケート/.test(control.value));
      const onlineUrl = onlineUrlControl?.value ?? null;
      const organizerNotice = organizerNoticeControl?.value ?? null;
      const visibility = visibilityControl?.value ?? null;

      return {
        name,
        priceText: priceControl?.value ?? (payment === "無料" ? "0" : ""),
        visibility,
        onlineEnabled: onlineControl ? onlineControl.checked : null,
        onlineUrl,
        organizerNotice,
        availability: {
          name: Boolean(nameControl),
          price: Boolean(priceControl) || payment === "無料",
          visibility: Boolean(visibilityControl),
          onlineEnabled: Boolean(onlineControl),
          onlineUrl: Boolean(onlineUrlControl),
          organizerNotice: Boolean(organizerNoticeControl)
        }
      };
    });

    return {
      title,
      startAtText: datetimes[0] ?? null,
      endAtText: datetimes[1] ?? null,
      venue,
      bodyText,
      applicationDeadlineEnabled,
      applicationDeadline,
      availability: {
        title: Boolean(titleControl),
        startAt: datetimeControls.length >= 1,
        endAt: datetimeControls.length >= 2,
        venue: Boolean(venueControl),
        bodyText: Boolean(bodyControl),
        applicationDeadlineEnabled: Boolean(deadlineEnabledControl),
        applicationDeadline: Boolean(deadlineControl) || datetimeControls.length >= 3,
        tickets: ticketContainerAvailable
      },
      tickets
    };
  })()`;

export type ExtractedAdminEventFormData = {
  name: string | null;
  startAtText: string | null;
  endAtText: string | null;
  venue: string | null;
  bodyText: string | null;
  applicationDeadlineEnabled: boolean | null;
  applicationDeadline: string | null;
  tickets: TicketInfo[];
  availability: Record<string, boolean>;
};

export async function extractAdminEventFormData(page: Page): Promise<ExtractedAdminEventFormData> {
  const raw = await page.evaluate(ADMIN_EVENT_FORM_EVALUATION_SCRIPT) as RawAdminEventFormData;

  return {
    name: raw.title,
    startAtText: raw.startAtText,
    endAtText: raw.endAtText,
    venue: raw.venue,
    bodyText: raw.bodyText,
    applicationDeadlineEnabled: raw.applicationDeadlineEnabled,
    applicationDeadline: raw.applicationDeadline,
    availability: raw.availability,
    tickets: raw.tickets.map((ticket) => ({
      name: ticket.name,
      price: normalizePriceText(ticket.priceText),
      visibility: ticket.visibility,
      visibilityTags: normalizeVisibilityTags(ticket.visibility ? [ticket.visibility] : []),
      onlineEnabled: ticket.onlineEnabled,
      onlineUrl: ticket.onlineUrl,
      organizerNotice: ticket.organizerNotice,
      fieldAvailability: {
        name: ticket.availability.name,
        price: ticket.availability.price,
        visibility: ticket.availability.visibility,
        onlineEnabled: ticket.availability.onlineEnabled,
        onlineUrl: ticket.availability.onlineUrl,
        organizerNotice: ticket.availability.organizerNotice
      }
    }))
  };
}

export async function extractEventFormDataWithTicketFallback(page: Page): Promise<ExtractedAdminEventFormData> {
  const primary = await extractAdminEventFormData(page);
  if (primary.tickets.length > 0) return { ...primary, availability: { ...primary.availability, tickets: true } };

  const fallback = await collectTickets(page);
  if (fallback.tickets.length > 0) {
    return { ...primary, tickets: fallback.tickets, availability: { ...primary.availability, tickets: true } };
  }
  return {
    ...primary,
    tickets: [],
    availability: { ...primary.availability, tickets: Boolean(primary.availability.tickets || fallback.containerAvailable) }
  };
}

export async function collectCurrentPageEvents(page: Page): Promise<EventListItem[]> {
  return dedupeByUrl(await findEventLinksInScope(page, page.url()));
}

async function collectTickets(page: Page): Promise<{ tickets: TicketInfo[]; containerAvailable: boolean }> {
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
      organizerNotice: await getFieldText(card, ["主催者からのお知らせ", "お知らせ"]),
      fieldAvailability: {
        name: (await card.getByText("チケット名", { exact: false }).count()) > 0,
        price: (await card.getByText(/金額|価格/, { exact: false }).count()) > 0,
        visibility: (await card.getByText("販売対象者", { exact: false }).count()) > 0,
        onlineEnabled: (await card.getByText("オンライン開催する", { exact: false }).count()) > 0,
        onlineUrl: (await card.getByText(/オンライン参加URL|参加URL|Zoom URL/, { exact: false }).count()) > 0,
        organizerNotice: (await card.getByText(/主催者からのお知らせ|お知らせ/, { exact: false }).count()) > 0
      }
    });
  }
  return { tickets, containerAvailable: count > 0 };
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

async function getBooleanField(scope: Page | Locator, labels: string[]): Promise<boolean | null> {
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
    const key = canonicalEventUrl(item.detailUrl);
    const current = byUrl.get(key);
    if (!current || scoreEventLink(item) > scoreEventLink(current)) {
      byUrl.set(key, { ...item, detailUrl: key });
    }
  }
  return [...byUrl.values()];
}

function canonicalEventUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  return url.toString();
}

function canonicalPageUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  const entries = [...url.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
    leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
  );
  url.search = "";
  for (const [key, entryValue] of entries) url.searchParams.append(key, entryValue);
  return url.toString();
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
