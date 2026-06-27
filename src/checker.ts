import fs from "node:fs/promises";
import path from "node:path";
import type { CheckResult, EventInfo, RulesConfig, TicketInfo, TicketRule } from "./types.js";
import { formatHourMinute } from "./utils/date.js";
import { extractDeadlineTimeFromNotice, isDeadlineFiveMinutesBeforeStart } from "./utils/date.js";
import { normalizeNoticeText } from "./utils/normalize.js";
import { classifyTicketRulesByInfo, containsAllTags, sameTagSet, validateTicketNameBookTitle, validateTicketNameMemberLabel } from "./utils/ticket.js";
import { normalizeOnlineUrl, safeFileName } from "./utils/url.js";

const PLAN_CHANGE_TICKET_TEXT = "プラン変更後にお申し込み下さい。プラン変更前は参加ボタンは押さないでください。";

export function checkEventInfo(event: EventInfo, rulesConfig: RulesConfig): CheckResult {
  if (event.kind === "skip") {
    return { eventName: event.name, kind: event.kind, detailUrl: event.detailUrl, startAt: event.startAt, ok: true, errors: [] };
  }

  const errors: string[] = [];
  if (event.tickets.length === 1) {
    const onlyTicket = event.tickets[0];
    if (onlyTicket.price !== 0) {
      errors.push(`チケットが1つだけのイベントは無料である必要があります。実際: ${onlyTicket.price ?? "取得できません"}円`);
    }
    return {
      eventName: event.name,
      kind: event.kind,
      detailUrl: event.detailUrl,
      startAt: event.startAt,
      ok: errors.length === 0,
      errors
    };
  }

  const rules = rulesForEvent(event, rulesConfig);
  const matches = new Map<string, TicketInfo[]>();
  const unmatched: TicketInfo[] = [];
  const planChangeTickets: TicketInfo[] = [];
  const ticketIndexes = new Map<TicketInfo, number>();
  event.tickets.forEach((ticket, index) => ticketIndexes.set(ticket, index + 1));

  if (isFixedFeeWithPlanChangeEvent(event.tickets)) {
    validateLegacyMemberDuplicates(event, errors, ticketIndexes);
    validatePlanChangeTicket(event.tickets.filter((ticket) => isPlanChangeTicket(ticket)), errors, ticketIndexes);
    validateFixedFeeTicket(event.tickets.filter((ticket) => !isPlanChangeTicket(ticket)), errors, ticketIndexes);
    return {
      eventName: event.name,
      kind: event.kind,
      detailUrl: event.detailUrl,
      startAt: event.startAt,
      ok: errors.length === 0,
      errors
    };
  }

  for (const ticket of event.tickets) {
    if (isPlanChangeTicket(ticket)) {
      planChangeTickets.push(ticket);
      continue;
    }

    const ticketRules = classifyTicketRulesByInfo(ticket, rules);
    if (ticketRules.length === 0) {
      unmatched.push(ticket);
      continue;
    }

    for (const rule of ticketRules) {
      const current = matches.get(rule.id) ?? [];
      current.push(ticket);
      matches.set(rule.id, current);
      validateTicket(ticket, rule, event.name, errors, ticketIndexes, ticketRules.length > 1);
    }
  }

  for (const rule of rules) {
    const tickets = (matches.get(rule.id) ?? []).filter((ticket) => !isExcludedFromDuplicateCheck(ticket));
    const label = ticketRuleLabel(rule);
    if (tickets.length === 0) errors.push(`期待されるチケット「${label}」が見つかりません`);
    if (tickets.length > 1 && !isAllowedDuplicateTicket(rule, tickets, event.kind)) {
      errors.push(`チケット「${label}」が複数存在します`);
    }
  }

  for (const ticket of unmatched) {
    errors.push(`${ticketPosition(ticket, ticketIndexes)}期待ルールに一致しないチケット名があります: 「${ticket.name || "(空)"}」`);
  }

  validateLegacyMemberDuplicates(event, errors, ticketIndexes);

  validatePlanChangeTicket(planChangeTickets, errors, ticketIndexes);

  if (event.kind === "online") {
    validateOnlineFields(event, errors, ticketIndexes);
  }
  if (event.kind === "offline") {
    validateOfflineParticipationTypes(event.tickets, errors);
  }

  return {
    eventName: event.name,
    kind: event.kind,
    detailUrl: event.detailUrl,
    startAt: event.startAt,
    ok: errors.length === 0,
    errors
  };
}

export async function saveFailureArtifacts(page: { screenshot(options: { path: string; fullPage: boolean }): Promise<unknown>; content(): Promise<string> }, eventName: string): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeName = safeFileName(eventName);
  const screenshotPath = path.join("artifacts", "screenshots", `${timestamp}-${safeName}.png`);
  const htmlPath = path.join("artifacts", "html", `${timestamp}-${safeName}.html`);
  await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
  await fs.mkdir(path.dirname(htmlPath), { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await fs.writeFile(htmlPath, await page.content(), "utf8");
}

function validateTicket(
  ticket: TicketInfo,
  rule: TicketRule,
  eventName: string,
  errors: string[],
  ticketIndexes: Map<TicketInfo, number>,
  allowAdditionalVisibilityTags = false
): void {
  const label = ticketRuleLabel(rule);
  const bookError = validateTicketNameBookTitle(eventName, ticket.name);
  if (bookError) errors.push(`${ticketPosition(ticket, ticketIndexes)}チケット「${label}」: ${bookError}`);
  if (!allowAdditionalVisibilityTags) {
    const memberLabelError = validateTicketNameMemberLabel(rule, ticket.name);
    if (memberLabelError) errors.push(`${ticketPosition(ticket, ticketIndexes)}チケット「${label}」: ${memberLabelError}`);
  }
  if (!isExcludedFromPriceCheck(ticket) && ticket.price !== rule.price) {
    errors.push(`${ticketPosition(ticket, ticketIndexes)}チケット「${label}」: 金額が期待値と異なります。期待: ${rule.price}円 / 実際: ${ticket.price ?? "取得できません"}`);
  }
  const visibilityOk = allowAdditionalVisibilityTags
    ? containsAllTags(ticket.visibilityTags, rule.visibilityTags)
    : sameTagSet(rule.visibilityTags, ticket.visibilityTags);
  if (!visibilityOk) {
    errors.push(`${ticketPosition(ticket, ticketIndexes)}チケット「${label}」: 販売対象者が期待値と異なります。期待: ${rule.visibilityTags.join(",")} / 実際: ${ticket.visibilityTags.join(",") || "取得できません"}`);
  }
}

function validateOnlineFields(event: EventInfo, errors: string[], ticketIndexes: Map<TicketInfo, number>): void {
  const checkableTickets = event.tickets.filter((ticket) => !isPlanChangeTicket(ticket));
  const onlineTickets = checkableTickets.filter((ticket) => ticket.onlineEnabled === true);
  const urls = onlineTickets.map((ticket) => normalizeOnlineUrl(ticket.onlineUrl)).filter(Boolean);

  for (const ticket of onlineTickets) {
    if (!normalizeOnlineUrl(ticket.onlineUrl)) {
      errors.push(`${ticketPosition(ticket, ticketIndexes)}チケット「${ticket.name}」: オンライン開催するがONですが、オンライン参加URLが空です`);
    }
  }
  if (new Set(urls).size > 1) {
    errors.push("オンライン参加URLがチケット間で一致していません");
  }

  const noticeGroups = groupTicketsByNormalizedNotice(checkableTickets);
  if (noticeGroups.length > 1) {
    const outlier = noticeGroups.length === 2 ? noticeGroups.find((group) => group.tickets.length === 1) : undefined;
    if (outlier) {
      const ticket = outlier.tickets[0];
      errors.push(`主催者からのお知らせがチケット間で一致していません。異なるチケット: ${ticketPosition(ticket, ticketIndexes)}「${ticket.name}」`);
    } else {
      errors.push("主催者からのお知らせがチケット間で一致していません");
    }
  }

  for (const ticket of checkableTickets) {
    const notice = ticket.organizerNotice ?? "";
    const actual = extractDeadlineTimeFromNotice(notice);
    if (!event.startAt) {
      errors.push(`${ticketPosition(ticket, ticketIndexes)}チケット「${ticket.name}」: 開始日時を取得できないため締切時刻を確認できません`);
      continue;
    }
    if (!actual || !isDeadlineFiveMinutesBeforeStart(event.startAt, notice)) {
      const expected = formatHourMinute(new Date(event.startAt.getTime() - 5 * 60 * 1000));
      errors.push(`${ticketPosition(ticket, ticketIndexes)}チケット「${ticket.name}」: 主催者からのお知らせの締切時刻が開始5分前ではありません。期待: ${expected} / 実際: ${actual ?? "見つかりません"}`);
    }
  }
}

function ticketRuleLabel(rule: TicketRule): string {
  return [rule.name, rule.note].filter(Boolean).join(" ");
}

function rulesForEvent(event: EventInfo, rulesConfig: RulesConfig): TicketRule[] {
  if (event.kind === "offline" && isGuestOfflineEvent(event)) {
    return [
      { id: "local_member_first", name: "地域会員", note: "1回目", price: 800, visibilityTags: ["オフ"] },
      { id: "hybrid_member_first", name: "ハイブリッド会員", note: "1回目", price: 800, visibilityTags: ["ハイ"] },
      { id: "local_member_second", name: "地域会員", note: "2回目以降", price: 3000, visibilityTags: ["オフ"] },
      { id: "hybrid_member_second", name: "ハイブリッド会員", note: "2回目以降", price: 3000, visibilityTags: ["ハイ"] },
      { id: "online_member", name: "オンライン会員", price: 3000, visibilityTags: ["オン"] },
      { id: "non_member", name: "非会員", price: 3500, visibilityTags: ["外"] }
    ];
  }

  if (event.kind === "skip") return [];
  return rulesConfig[event.kind].tickets;
}

function isGuestOfflineEvent(event: EventInfo): boolean {
  if (/ゲスト|さんと読む/.test(event.name)) return true;

  const checkableTickets = event.tickets.filter((ticket) => !isPlanChangeTicket(ticket));
  const hasGuestNonMemberPrice = checkableTickets.some((ticket) => ticket.visibilityTags.includes("外") && ticket.price === 3500);
  const hasGuestMemberPrice = checkableTickets.some((ticket) => {
    const hasMemberTag = ticket.visibilityTags.some((tag) => ["オン", "オフ", "ハイ"].includes(tag));
    return hasMemberTag && ticket.price === 3000;
  });

  return hasGuestNonMemberPrice || hasGuestMemberPrice;
}

function isPlanChangeTicket(ticket: TicketInfo): boolean {
  return /(プラン変更後|新プラン切り替え後|プラン切り替え後)にお申(?:し)?込み(?:下さい|ください)。?/.test(ticket.name);
}

function isExcludedFromDuplicateCheck(ticket: TicketInfo): boolean {
  return /お申(?:し)?込みいただいた方/.test(ticket.name);
}

function isExcludedFromPriceCheck(ticket: TicketInfo): boolean {
  return /お申(?:し)?込みいただいた方/.test(ticket.name);
}

function isFixedFeeWithPlanChangeEvent(tickets: TicketInfo[]): boolean {
  return tickets.length === 2 && tickets.some((ticket) => isPlanChangeTicket(ticket));
}

function validateFixedFeeTicket(tickets: TicketInfo[], errors: string[], ticketIndexes: Map<TicketInfo, number>): void {
  if (tickets.length !== 1) {
    errors.push("固定費イベントでは、プラン変更チケット以外のチケットが1つだけである必要があります");
    return;
  }

  const ticket = tickets[0];
  const expectedTags = ["オン", "オフ", "ハイ", "外"];
  if (!containsAllTags(ticket.visibilityTags, expectedTags)) {
    errors.push(`${ticketPosition(ticket, ticketIndexes)}固定費チケットの閲覧権限が不足しています。期待: ${expectedTags.join(",")} / 実際: ${ticket.visibilityTags.join(",") || "取得できません"}`);
  }
}

function validatePlanChangeTicket(tickets: TicketInfo[], errors: string[], ticketIndexes: Map<TicketInfo, number>): void {
  if (tickets.length === 0) {
    errors.push(`期待されるチケット「${PLAN_CHANGE_TICKET_TEXT}」が見つかりません`);
    return;
  }
  if (tickets.length > 1) {
    errors.push(`チケット「${PLAN_CHANGE_TICKET_TEXT}」が複数存在します`);
  }

  for (const ticket of tickets) {
    const expectedTags = ["A", "U-22", "B"];
    if (!containsAllTags(ticket.visibilityTags, expectedTags)) {
      errors.push(`${ticketPosition(ticket, ticketIndexes)}チケット「${PLAN_CHANGE_TICKET_TEXT}」: 閲覧権限が期待値と異なります。期待: A,U-22,B / 実際: ${ticket.visibilityTags.join(",") || ticket.visibility || "取得できません"}`);
    }
  }
}

function ticketPosition(ticket: TicketInfo, ticketIndexes: Map<TicketInfo, number>): string {
  const index = ticketIndexes.get(ticket);
  return index ? `[${index}番目] ` : "";
}

function isAllowedDuplicateTicket(rule: TicketRule, tickets: TicketInfo[], kind: EventInfo["kind"]): boolean {
  if (kind === "offline") {
    const participationTypes = tickets.map((ticket) => getOfflineParticipationType(ticket)).filter(Boolean);
    return participationTypes.includes("reading") && participationTypes.includes("afterParty");
  }

  if (rule.id !== "non_member" || tickets.length !== 2) return false;
  const hasFirstTime = tickets.some((ticket) => /初参加/.test(ticket.name));
  const hasRegular = tickets.some((ticket) => !/初参加/.test(ticket.name));
  return hasFirstTime && hasRegular;
}

function validateOfflineParticipationTypes(tickets: TicketInfo[], errors: string[]): void {
  const participationTypes = tickets.map((ticket) => getOfflineParticipationType(ticket));
  if (!participationTypes.includes("reading")) {
    errors.push("オフライン読書会には「読書会のみ参加」チケットが必要です");
  }
  if (!participationTypes.includes("afterParty")) {
    errors.push("オフライン読書会には「懇親会まで参加」チケットが必要です");
  }
}

function getOfflineParticipationType(ticket: TicketInfo): "reading" | "afterParty" | null {
  if (ticket.name.includes("読書会のみ参加")) return "reading";
  if (ticket.name.includes("懇親会まで参加")) return "afterParty";
  return null;
}

function validateLegacyMemberDuplicates(event: EventInfo, errors: string[], ticketIndexes: Map<TicketInfo, number>): void {
  const legacyTags = ["A", "U-22", "B"];
  const groups = new Map<string, TicketInfo[]>();

  for (const ticket of event.tickets) {
    if (!isPlanChangeTicket(ticket)) {
      const unexpectedLegacyTags = legacyTags.filter((tag) => ticket.visibilityTags.includes(tag));
      if (unexpectedLegacyTags.length > 0) {
        errors.push(`${ticketPosition(ticket, ticketIndexes)}旧会員 ${unexpectedLegacyTags.join(",")} はプラン変更チケット以外に入れないでください: 「${ticket.name}」`);
      }
    }
    if (isPlanChangeTicket(ticket)) continue;
    const participationType = event.kind === "offline" ? getOfflineParticipationType(ticket) ?? "other" : "default";
    for (const tag of legacyTags) {
      if (!ticket.visibilityTags.includes(tag)) continue;
      const key = `${tag}:${participationType}`;
      groups.set(key, [...(groups.get(key) ?? []), ticket]);
    }
  }

  for (const [key, tickets] of groups.entries()) {
    if (tickets.length <= 1) continue;
    const [tag, participationType] = key.split(":");
    const participationLabel = participationType === "reading"
      ? "読書会のみ参加"
      : participationType === "afterParty"
        ? "懇親会まで参加"
        : "通常";
    const ticketLabels = tickets.map((ticket) => `${ticketPosition(ticket, ticketIndexes)}「${ticket.name}」`).join(" / ");
    errors.push(`旧会員 ${tag} のチケットが重複しています（${participationLabel}）: ${ticketLabels}`);
  }
}

function groupTicketsByNormalizedNotice(tickets: TicketInfo[]): { notice: string; tickets: TicketInfo[] }[] {
  const groups = new Map<string, TicketInfo[]>();
  for (const ticket of tickets) {
    const notice = normalizeNoticeText(ticket.organizerNotice);
    groups.set(notice, [...(groups.get(notice) ?? []), ticket]);
  }
  return [...groups.entries()].map(([notice, groupTickets]) => ({ notice, tickets: groupTickets }));
}
