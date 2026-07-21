import fs from "node:fs/promises";
import path from "node:path";
import type { CheckResult, EventInfo, RulesConfig, TicketInfo, TicketRule } from "./types.js";
import { formatHourMinute } from "./utils/date.js";
import { extractDeadlineTimeFromNotice, isApplicationDeadlineWithinEventRange, isDeadlineFiveMinutesBeforeStart, parseApplicationDeadlineDate } from "./utils/date.js";
import { normalizeCommonText, normalizeNoticeText, normalizeTicketText } from "./utils/normalize.js";
import { classifyTicketRulesByInfo, containsAllTags, sameTagSet, validateTicketNameBookTitle, validateTicketNameMemberLabel } from "./utils/ticket.js";
import { normalizeOnlineUrl, safeFileName } from "./utils/url.js";

const PLAN_CHANGE_TICKET_TEXT = "プラン変更後にお申し込み下さい。プラン変更前は参加ボタンは押さないでください。";

export function checkEventInfo(event: EventInfo, rulesConfig: RulesConfig): CheckResult {
  if (event.kind === "skip") {
    return { eventName: event.name, kind: event.kind, detailUrl: event.detailUrl, startAt: event.startAt, ok: true, errors: [] };
  }

  const errors: string[] = [];
  const ticketIndexes = new Map<TicketInfo, number>();
  event.tickets.forEach((ticket, index) => ticketIndexes.set(ticket, index + 1));
  validateOperationMemberTicket(event, errors, ticketIndexes);
  validateAppliedPersonTicketNames(event.tickets, errors, ticketIndexes);
  validateApplicationDeadline(event, errors);

  if (areAllAppliedPersonTickets(event.tickets)) {
    return {
      eventName: event.name,
      kind: event.kind,
      detailUrl: event.detailUrl,
      startAt: event.startAt,
      ok: errors.length === 0,
      errors
    };
  }

  if (runsOnlineChecks(event) && isAllSessionOnlineEvent(event.tickets)) {
    const allSessionTickets = event.tickets.filter((ticket) => !isPlanChangeTicket(ticket));
    const planChangeTickets = event.tickets.filter((ticket) => isPlanChangeTicket(ticket));
    validateAllSessionOnlineTickets(allSessionTickets, errors, ticketIndexes);
    if (planChangeTickets.length > 0) {
      validatePlanChangeTicket(planChangeTickets, errors, ticketIndexes);
    }
    validateLegacyMemberDuplicates(event, errors, ticketIndexes);
    validateOnlineFields(event, errors, ticketIndexes);
    return {
      eventName: event.name,
      kind: event.kind,
      detailUrl: event.detailUrl,
      startAt: event.startAt,
      ok: errors.length === 0,
      errors
    };
  }

  if (event.tickets.length === 1) {
    const onlyTicket = event.tickets[0];
    if (!isAppliedPersonTicket(onlyTicket) && onlyTicket.price !== 0) {
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

  if (event.tickets.length === 2 && !event.tickets.some((ticket) => isPlanChangeTicket(ticket))) {
    errors.push("固定費イベントでは、片方がプラン変更チケットである必要があります");
  }

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
    if (isOperationMemberTicket(ticket)) {
      continue;
    }
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
    if (runsOfflineChecks(event) && tickets.length > 0) {
      validateOfflineParticipationForRule(rule, label, tickets, errors);
    }
    if (tickets.length > 1 && !isAllowedDuplicateTicket(rule, tickets, event.kind)) {
      errors.push(`チケット「${label}」が複数存在します`);
    }
  }

  for (const ticket of unmatched) {
    errors.push(`${ticketPosition(ticket, ticketIndexes)}期待ルールに一致しないチケット名があります: 「${ticket.name || "(空)"}」`);
  }

  validateLegacyMemberDuplicates(event, errors, ticketIndexes);

  validatePlanChangeTicket(planChangeTickets, errors, ticketIndexes);

  if (runsOnlineChecks(event)) {
    validateOnlineFields(event, errors, ticketIndexes);
  }
  if (runsOfflineChecks(event)) {
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
  const recurrenceError = validateTicketNameRecurrence(rule, ticket);
  if (recurrenceError) errors.push(`${ticketPosition(ticket, ticketIndexes)}チケット「${label}」: ${recurrenceError}`);
  if (!allowAdditionalVisibilityTags) {
    const memberLabelError = validateTicketNameMemberLabel(rule, ticket.name);
    if (memberLabelError) errors.push(`${ticketPosition(ticket, ticketIndexes)}チケット「${label}」: ${memberLabelError}`);
  }
  const expectedPrices = [rule.price, ...(rule.priceAlternatives ?? [])];
  if (!isExcludedFromPriceCheck(ticket) && !expectedPrices.includes(ticket.price ?? Number.NaN)) {
    errors.push(`${ticketPosition(ticket, ticketIndexes)}チケット「${label}」: 金額が期待値と異なります。期待: ${expectedPrices.join("円 または ")}円 / 実際: ${ticket.price ?? "取得できません"}`);
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
  const noticeCheckableTickets = checkableTickets;
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

  const noticeGroups = groupTicketsByNormalizedNotice(noticeCheckableTickets);
  if (noticeGroups.length > 1) {
    const outlier = noticeGroups.length === 2 ? noticeGroups.find((group) => group.tickets.length === 1) : undefined;
    if (outlier) {
      const ticket = outlier.tickets[0];
      errors.push(`主催者からのお知らせがチケット間で一致していません。異なるチケット: ${ticketPosition(ticket, ticketIndexes)}「${ticket.name}」`);
    } else {
      errors.push("主催者からのお知らせがチケット間で一致していません");
    }
  }

  for (const ticket of noticeCheckableTickets) {
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

function validateApplicationDeadline(event: EventInfo, errors: string[]): void {
  if (!("applicationDeadline" in event)) return;
  if (event.applicationDeadlineEnabled === false) return;
  const deadline = event.applicationDeadline ?? "";
  if (!event.startAt) {
    errors.push("開催日時を取得できないため申込締切日を確認できません");
    return;
  }
  const parsed = parseApplicationDeadlineDate(deadline, event.startAt);
  if (!parsed || !isApplicationDeadlineWithinEventRange(event.startAt, deadline)) {
    const eventDate = new Date(event.startAt.getFullYear(), event.startAt.getMonth(), event.startAt.getDate());
    const earliest = new Date(eventDate);
    earliest.setDate(earliest.getDate() - 3);
    errors.push(`申込締切日は開催日の3日前から開催日までにしてください。期待: ${formatDate(earliest)}〜${formatDate(eventDate)} / 実際: ${deadline || "取得できません"}`);
  }
}

function ticketRuleLabel(rule: TicketRule): string {
  return [rule.name, rule.note].filter(Boolean).join(" ");
}

function rulesForEvent(event: EventInfo, rulesConfig: RulesConfig): TicketRule[] {
  if (event.kind === "online" && isGuestOnlineEvent(event)) {
    return [
      { id: "online_member_first", name: "オンライン会員", note: "1回目", price: 550, visibilityTags: ["オン"] },
      { id: "local_member", name: "地域会員", price: 1200, visibilityTags: ["オフ"] },
      { id: "online_member_second", name: "オンライン会員", note: "2回目以降", price: 1200, visibilityTags: ["オン"] },
      { id: "hybrid_member", name: "ハイブリッド会員", price: 550, visibilityTags: ["ハイ"] },
      { id: "non_member", name: "非会員", price: 1500, visibilityTags: ["外"] }
    ];
  }

  if (runsOfflineChecks(event) && isGuestOfflineEvent(event)) {
    return [
      { id: "local_member_first", name: "地域会員", note: "1回目", price: 800, priceAlternatives: [500], visibilityTags: ["オフ"] },
      { id: "hybrid_member_first", name: "ハイブリッド会員", note: "1回目", price: 800, priceAlternatives: [500], visibilityTags: ["ハイ"] },
      { id: "local_member_second", name: "地域会員", note: "2回目以降", price: 3000, priceAlternatives: [2300], visibilityTags: ["オフ"] },
      { id: "hybrid_member_second", name: "ハイブリッド会員", note: "2回目以降", price: 3000, priceAlternatives: [2300], visibilityTags: ["ハイ"] },
      { id: "online_member", name: "オンライン会員", price: 3000, priceAlternatives: [2300], visibilityTags: ["オン"] },
      { id: "non_member", name: "非会員", price: 3500, priceAlternatives: [2800], visibilityTags: ["外"] }
    ];
  }

  if (event.kind === "skip") return [];
  return (runsOfflineChecks(event) ? rulesConfig.offline : rulesConfig.online).tickets;
}

function runsOnlineChecks(event: EventInfo): boolean {
  return event.kind === "online" || event.kind === "hybrid";
}

function runsOfflineChecks(event: EventInfo): boolean {
  return event.kind === "offline" || event.kind === "hybrid";
}

function isGuestOfflineEvent(event: EventInfo): boolean {
  if (isGuestEventName(event)) return true;

  const checkableTickets = event.tickets.filter((ticket) => !isPlanChangeTicket(ticket));
  const hasGuestNonMemberPrice = checkableTickets.some((ticket) => ticket.visibilityTags.includes("外") && (ticket.price === 3500 || ticket.price === 2800));
  const hasGuestMemberPrice = checkableTickets.some((ticket) => {
    const hasMemberTag = ticket.visibilityTags.some((tag) => ["オン", "オフ", "ハイ"].includes(tag));
    return hasMemberTag && (ticket.price === 3000 || ticket.price === 2300);
  });

  return hasGuestNonMemberPrice || hasGuestMemberPrice;
}

function isGuestOnlineEvent(event: EventInfo): boolean {
  if (isGuestEventName(event)) return true;

  const checkableTickets = event.tickets.filter((ticket) => !isPlanChangeTicket(ticket));
  const hasGuestNonMemberPrice = checkableTickets.some((ticket) => ticket.visibilityTags.includes("外") && ticket.price === 1500);
  const hasGuestMemberPrice = checkableTickets.some((ticket) => {
    const hasMemberTag = ticket.visibilityTags.some((tag) => ["オン", "オフ", "ハイ"].includes(tag));
    return hasMemberTag && (ticket.price === 550 || ticket.price === 1200);
  });

  return hasGuestNonMemberPrice || hasGuestMemberPrice;
}

function isGuestEventName(event: EventInfo): boolean {
  return /ゲスト|さんと読む/.test(event.name);
}

function isPlanChangeTicket(ticket: TicketInfo): boolean {
  return /(プラン変更後|新プラン切り替え後|プラン切り替え後)にお申(?:し)?込み(?:下さい|ください)。?/.test(ticket.name);
}

function validateTicketNameRecurrence(rule: TicketRule, ticket: TicketInfo): string | null {
  const text = normalizeTicketText(ticket.name);
  if (rule.note === "1回目" && !text.includes("今月1回目")) {
    return "1回目チケット名には「今月1回目」を入れてください";
  }
  if (rule.note === "2回目以降" && !text.includes("今月2回目以降")) {
    return "2回目以降チケット名には「今月2回目以降」を入れてください";
  }
  return null;
}

function validateOperationMemberTicket(event: EventInfo, errors: string[], ticketIndexes: Map<TicketInfo, number>): void {
  if (!requiresOperationMemberTicket(event)) return;

  const tickets = event.tickets.filter((ticket) => isOperationMemberTicket(ticket));
  if (tickets.length === 0) {
    errors.push("初心者読書会・ビギナー限定イベントには無料の「運営メンバー」チケットが必要です");
    return;
  }

  for (const ticket of tickets) {
    if (ticket.price !== 0) {
      errors.push(`${ticketPosition(ticket, ticketIndexes)}「運営メンバー」チケットは無料である必要があります。実際: ${ticket.price ?? "取得できません"}円`);
    }
  }
}

function requiresOperationMemberTicket(event: EventInfo): boolean {
  return [event.name, ...event.tickets.map((ticket) => ticket.name)].some((text) => /初心者読書会|ビギナー限定/.test(text));
}

function isOperationMemberTicket(ticket: TicketInfo): boolean {
  return ticket.name.includes("運営メンバー");
}

function isExcludedFromDuplicateCheck(ticket: TicketInfo): boolean {
  return isAppliedPersonTicket(ticket);
}

function isExcludedFromPriceCheck(ticket: TicketInfo): boolean {
  return isAppliedPersonTicket(ticket) || isAllSessionsTicket(ticket);
}

function isAppliedPersonTicket(ticket: TicketInfo): boolean {
  return /お申し込み済みの方/.test(ticket.name);
}

function isAllSessionsTicket(ticket: TicketInfo): boolean {
  return /全\s*\d+\s*回/.test(normalizeTicketText(ticket.name));
}

function areAllSessionTickets(tickets: TicketInfo[]): boolean {
  return tickets.length > 0 && tickets.every((ticket) => isAllSessionsTicket(ticket));
}

function isAllSessionOnlineEvent(tickets: TicketInfo[]): boolean {
  const nonPlanChangeTickets = tickets.filter((ticket) => !isPlanChangeTicket(ticket));
  return areAllSessionTickets(nonPlanChangeTickets);
}

function validateAllSessionOnlineTickets(tickets: TicketInfo[], errors: string[], ticketIndexes: Map<TicketInfo, number>): void {
  const expectedPlans = [
    { tag: "オン", label: "オンライン会員" },
    { tag: "オフ", label: "地域会員" },
    { tag: "ハイ", label: "ハイブリッド会員" },
    { tag: "外", label: "非会員" }
  ];

  for (const plan of expectedPlans) {
    const matchedTickets = tickets.filter((ticket) => ticket.visibilityTags.includes(plan.tag));
    if (matchedTickets.length === 0) {
      errors.push(`全N回チケットには「${plan.label}」のチケットが1つ必要です`);
    }
    if (matchedTickets.length > 1 && !isAllowedAllSessionDuplicate(plan.tag, matchedTickets)) {
      errors.push(`全N回チケット「${plan.label}」が複数存在します: ${matchedTickets.map((ticket) => `${ticketPosition(ticket, ticketIndexes)}「${ticket.name}」`).join(" / ")}`);
    }
  }

  for (const ticket of tickets) {
    const knownTags = ticket.visibilityTags.filter((tag) => expectedPlans.some((plan) => plan.tag === tag));
    if (knownTags.length === 0 || knownTags.length !== ticket.visibilityTags.length) {
      errors.push(`${ticketPosition(ticket, ticketIndexes)}全N回チケットの販売対象者が期待値と異なります。期待: オン または オフ または ハイ または 外 / 実際: ${ticket.visibilityTags.join(",") || "取得できません"}`);
    }
  }
}

function isAllowedAllSessionDuplicate(tag: string, tickets: TicketInfo[]): boolean {
  if (tag !== "外" || tickets.length !== 2) return false;
  const hasFirstTime = tickets.some((ticket) => isFirstTimeTicket(ticket));
  const hasRegular = tickets.some((ticket) => !isFirstTimeTicket(ticket));
  return hasFirstTime && hasRegular;
}

function validateAppliedPersonTicketNames(tickets: TicketInfo[], errors: string[], ticketIndexes: Map<TicketInfo, number>): void {
  for (const ticket of tickets) {
    if (/お申(?:し)?込みいただいた方/.test(ticket.name)) {
      errors.push(`${ticketPosition(ticket, ticketIndexes)}特殊申込済みチケット名は「お申し込み済みの方」に統一してください: 「${ticket.name}」`);
    }
  }
}

function areAllAppliedPersonTickets(tickets: TicketInfo[]): boolean {
  return tickets.length > 0 && tickets.every((ticket) => isAppliedPersonTicket(ticket));
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
    if (normalizeCommonText(ticket.name) !== PLAN_CHANGE_TICKET_TEXT) {
      errors.push(`${ticketPosition(ticket, ticketIndexes)}プラン変更チケット名は「${PLAN_CHANGE_TICKET_TEXT}」にしてください: 「${ticket.name}」`);
    }
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
  if (kind === "offline" || kind === "hybrid") {
    if (rule.id === "non_member") {
      const firstTimeTickets = tickets.filter((ticket) => isFirstTimeTicket(ticket));
      return hasOneOfflineParticipationPair(tickets.filter((ticket) => !isFirstTimeTicket(ticket)))
        && (firstTimeTickets.length === 0 || hasOneOfflineParticipationPair(firstTimeTickets));
    }
    const participationTypes = tickets.map((ticket) => getOfflineParticipationType(ticket)).filter(Boolean);
    return tickets.length === 2 && participationTypes.includes("reading") && participationTypes.includes("afterParty");
  }

  if (rule.id !== "non_member" || tickets.length !== 2) return false;
  const hasFirstTime = tickets.some((ticket) => /初参加/.test(ticket.name));
  const hasRegular = tickets.some((ticket) => !/初参加/.test(ticket.name));
  return hasFirstTime && hasRegular;
}

function validateOfflineParticipationForRule(rule: TicketRule, label: string, tickets: TicketInfo[], errors: string[]): void {
  if (rule.id === "non_member") {
    validateOfflineNonMemberParticipation(label, tickets, errors);
    return;
  }
  validateOfflineParticipationPair(label, tickets, errors);
}

function validateOfflineNonMemberParticipation(label: string, tickets: TicketInfo[], errors: string[]): void {
  const firstTimeTickets = tickets.filter((ticket) => isFirstTimeTicket(ticket));
  validateOfflineParticipationPair(`${label} 通常`, tickets.filter((ticket) => !isFirstTimeTicket(ticket)), errors);
  if (firstTimeTickets.length > 0) {
    validateOfflineParticipationPair(`${label} 初参加`, firstTimeTickets, errors);
  }
}

function validateOfflineParticipationPair(label: string, tickets: TicketInfo[], errors: string[]): void {
  const participationTypes = tickets.map((ticket) => getOfflineParticipationType(ticket));
  const readingCount = participationTypes.filter((type) => type === "reading").length;
  const afterPartyCount = participationTypes.filter((type) => type === "afterParty").length;
  const otherCount = participationTypes.filter((type) => type === null).length;

  if (readingCount === 1 && afterPartyCount === 1 && otherCount === 0) return;

  errors.push(`オフラインチケット「${label}」は「読書会のみ参加」と「懇親会まで参加」が1つずつ必要です。実際: 読書会のみ参加 ${readingCount}件 / 懇親会まで参加 ${afterPartyCount}件 / 参加種別不明 ${otherCount}件`);
}

function hasOneOfflineParticipationPair(tickets: TicketInfo[]): boolean {
  const participationTypes = tickets.map((ticket) => getOfflineParticipationType(ticket));
  return tickets.length === 2
    && participationTypes.filter((type) => type === "reading").length === 1
    && participationTypes.filter((type) => type === "afterParty").length === 1;
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

function isFirstTimeTicket(ticket: TicketInfo): boolean {
  return /初参加/.test(ticket.name);
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
    const participationType = runsOfflineChecks(event) ? getOfflineParticipationType(ticket) ?? "other" : "default";
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

function formatDate(date: Date): string {
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
}
