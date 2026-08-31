import { BUSINESS_RULE_IDS } from "../domain/derive.js";
import { OPTIONAL_FIRST_TIME_RATE_KEY } from "../domain/catalog.js";
import { hasRole, type DerivedEvent, type DerivedTicket, type RulePlan } from "../domain/model.js";
import { configReference, evidenceReferences, eventReference, ticketReference, uniqueReferences } from "../domain/references.js";

export function buildRulePlans(derived: DerivedEvent): RulePlan[] {
  if (derived.eligibility.status !== "target" || !derived.attributes || !derived.sets) return [];
  const plans: RulePlan[] = [];
  const eventId = derived.event.eventId;
  const { attributes, sets } = derived;
  const delivery = attributes.deliveryMode.state === "determined" ? attributes.deliveryMode.value : undefined;
  const pricingMode = attributes.pricingMode.state === "determined" ? attributes.pricingMode.value : undefined;
  const pricingScheme = attributes.pricingScheme.state === "determined" ? attributes.pricingScheme.value : undefined;
  const applied = attributes.appliedComposition.state === "determined" ? attributes.appliedComposition.value : undefined;
  const allApplied = applied === "already-applied-only";
  const normalConfiguration = pricingMode === "standard" && sets.regularEntrySet.length >= 1;
  const normalSetUncertain = pricingMode === "standard"
    && sets.pricingComparisonSet.some((ticket) => !hasRole(ticket, "member-entry"));
  const noticeCandidates = notificationTargets(derived);

  add(plans, eventId, "EVT-001", deadlineApplicability(derived));
  add(plans, eventId, "BODY-001", bodyRecurrenceApplicability(derived, /(?<![0-9])1回目/));
  add(plans, eventId, "BODY-002", bodyRecurrenceApplicability(derived, /(?<![0-9])2回目/));
  add(plans, eventId, "BODY-003", bodyFeeApplicability(derived, delivery === "online" && normalConfiguration && pricingScheme === "normal", [attributes.deliveryMode, attributes.pricingMode, attributes.pricingScheme], "通常オンライン本文料金ではないため"));
  add(plans, eventId, "BODY-004", bodyFeeApplicability(derived, (delivery === "offline" || delivery === "hybrid") && normalConfiguration && pricingScheme === "normal", [attributes.deliveryMode, attributes.pricingMode, attributes.pricingScheme], "通常オフライン料金ではないため"));
  add(plans, eventId, "AREA-001", attributePlan((delivery === "online" || delivery === "hybrid") && !allApplied && noticeCandidates.length > 0, [attributes.deliveryMode, attributes.appliedComposition], "比較可能なオンライン案内券がないため"));
  add(plans, eventId, "AREA-002", attributePlan(!allApplied, [attributes.appliedComposition], "全券申込み済みのため"));

  for (const ticket of derived.tickets) {
    const id = [ticket.ticketId];
    const regular = sets.regularEntrySet.some((entry) => entry.ticketId === ticket.ticketId);
    const comparison = sets.pricingComparisonSet.some((entry) => entry.ticketId === ticket.ticketId);
    const plan = hasRole(ticket, "plan-change");
    const operation = hasRole(ticket, "operation-member");
    const recurrence = ticket.rateKeys.state === "determined" ? ticket.rateKeys.value : [];
    const roleUnknown = ticket.roles.state !== "determined";
    add(plans, eventId, "TKT-003", roleUnknown || (normalConfiguration && regular && ticket.rateKeys.state !== "determined")
      ? { applicability: "unknown", reason: "券役割またはrateKeyを確定できません" }
      : simple(normalConfiguration && regular && recurrence.some((key) => key.endsWith("-1")), "1回目条件の通常参加券ではないため"), id);
    add(plans, eventId, "TKT-004", roleUnknown || (normalConfiguration && regular && ticket.rateKeys.state !== "determined")
      ? { applicability: "unknown", reason: "券役割またはrateKeyを確定できません" }
      : simple(normalConfiguration && regular && recurrence.some((key) => key.endsWith("-2")), "2回目条件の通常参加券ではないため"), id);
    add(plans, eventId, "TKT-005", simple(false, "BQ-01により券名の会員種別確認を廃止したため"), id);
    const priceApplicable = normalConfiguration && regular;
    add(plans, eventId, "TKT-006", attributes.pricingMode.state !== "determined" || roleUnknown
      ? { applicability: "unknown", reason: "料金方式または券役割を確定できません" }
      : priceApplicable
      ? attributePlan(true, [attributes.pricingScheme, ticket.rateKeys], "")
      : simple(false, "standardの通常参加券ではないため"), id);
    const visibilityApplicable = !allApplied && !plan && !operation && pricingMode === "standard";
    add(plans, eventId, "TKT-007", roleUnknown || attributes.appliedComposition.state !== "determined"
      ? { applicability: "unknown", reason: "申込み済み構成または券役割を確定できません" }
      : simple(visibilityApplicable, "販売対象確認の対象券ではないため"), id);
    const onlineBase = (delivery === "online" || delivery === "hybrid") && !allApplied && !plan;
    add(plans, eventId, "TKT-008", roleUnknown ? { applicability: "unknown", reason: "券役割を確定できません" } : onlineFieldApplicability(onlineBase, ticket, true), id);
    const noticeTarget = noticeCandidates.some((entry) => entry.ticketId === ticket.ticketId);
    add(plans, eventId, "TKT-009", roleUnknown ? { applicability: "unknown", reason: "券役割を確定できません" } : noticeApplicability(onlineBase && noticeTarget, ticket), id);
    add(plans, eventId, "TKT-010", roleUnknown ? { applicability: "unknown", reason: "券名を取得できずプラン変更券か判定できません" } : simple(plan, "プラン変更券ではないため"), id);
    add(plans, eventId, "TKT-011", roleUnknown ? { applicability: "unknown", reason: "券名を取得できずプラン変更券か判定できません" } : simple(plan, "プラン変更券ではないため"), id);
    add(plans, eventId, "TKT-012", roleUnknown ? { applicability: "unknown", reason: "券名を取得できず運営メンバー券か判定できません" } : simple(operation, "運営メンバー券ではないため"), id);
    add(plans, eventId, "TKT-013", attributePlan(pricingMode === "fixed-fee" && comparison, [attributes.pricingMode], "固定料金比較券ではないため"), id);
    add(plans, eventId, "TKT-014", simple(false, "途中参加券のオンライン開催ON必須チェックを廃止したため"), id);
    add(plans, eventId, "TKT-016", roleUnknown
      ? { applicability: "unknown", reason: "券名を取得できずプラン変更券か判定できません" }
      : simple(!plan, "プラン変更券のため"), id);
    add(plans, eventId, "TKT-017", attributePlan(delivery === "hybrid" && pricingMode === "fixed-fee" && comparison && ticket.name.state === "present" && ticket.name.value.includes("オンライン参加"), [attributes.deliveryMode, attributes.pricingMode], "固定料金ハイブリッドのオンライン参加券ではないため"), id);
    add(plans, eventId, "TKT-018", roleUnknown ? { applicability: "unknown", reason: "券名を取得できず役割候補を確定できません" } : simple(ticket.rawRoleCandidates.length >= 2, "複数の生役割候補を持たないため"), id);
    add(plans, eventId, "TKT-019", roleUnknown ? { applicability: "unknown", reason: "除外役割を確定できず料金比較集合を確定できません" } : simple(comparison, "料金比較集合に含まれないため"), id);
  }

  add(plans, eventId, "SET-001", normalSetPlan(normalSetUncertain, normalConfiguration && !allApplied, [attributes.pricingMode, attributes.appliedComposition], "standardの通常参加券群がないため"), ids(sets.regularEntrySet));
  add(plans, eventId, "SET-002", normalSetPlan(normalSetUncertain, normalConfiguration && !allApplied, [attributes.pricingMode, attributes.appliedComposition], "standardの通常参加券群がないため"), ids(sets.regularEntrySet));
  const offlineStandard = (delivery === "offline" || delivery === "hybrid") && normalConfiguration && !allApplied;
  add(plans, eventId, "SET-003", normalSetPlan(normalSetUncertain, offlineStandard, [attributes.deliveryMode, attributes.pricingMode, attributes.appliedComposition], "オフライン通常参加券群ではないため"), ids(sets.regularEntrySet));
  add(plans, eventId, "SET-004", normalSetPlan(normalSetUncertain, offlineStandard, [attributes.deliveryMode, attributes.pricingMode, attributes.appliedComposition], "オフライン通常参加券群ではないため"), ids(sets.regularEntrySet));
  const firstTimeTickets = sets.regularEntrySet.filter((ticket) => ticket.firstTime.state === "determined" && ticket.firstTime.value);
  const optionalFirstKey = delivery ? OPTIONAL_FIRST_TIME_RATE_KEY[delivery] : undefined;
  const optionalFirstUnknown = firstTimeTickets.some((ticket) => ticket.rateKeys.state !== "determined");
  const optionalFirstPresent = optionalFirstKey !== undefined && firstTimeTickets.some((ticket) => ticket.rateKeys.state === "determined" && ticket.rateKeys.value.includes(optionalFirstKey));
  const firstTimeStandard = normalConfiguration && !allApplied;
  add(plans, eventId, "SET-005", normalSetUncertain && firstTimeStandard
    ? { applicability: "unknown", reason: "用途を分類できない料金比較券があり通常参加券群を確定できません" }
    : firstTimeStandard && optionalFirstUnknown
    ? { applicability: "unknown", reason: "初参加券のrateKeyを確定できません" }
    : attributePlan(firstTimeStandard && optionalFirstPresent, [attributes.deliveryMode, attributes.pricingMode], "非会員初参加券がないため"), ids(sets.regularEntrySet));
  add(plans, eventId, "SET-006", attributePlan(!allApplied && sets.allSessionSet.length > 0, [attributes.appliedComposition, attributes.hasAllSessionEntry], "全回券群がないか全券申込み済みのため"), ids(sets.allSessionSet));
  add(plans, eventId, "SET-007", attributePlan(!allApplied && sets.partialEntrySet.length > 0, [attributes.appliedComposition, attributes.hasPartialEntry], "途中参加券群がないか全券申込み済みのため"), ids(sets.partialEntrySet));
  const onlineDelivery = delivery === "online" || delivery === "hybrid";
  const set010Candidates = derived.tickets.filter((ticket) => ticket.roles.state === "determined" && !hasRole(ticket, "plan-change"));
  const set010HasKnownOn = set010Candidates.some((ticket) => ticket.onlineEnabled.state === "present" && ticket.onlineEnabled.value);
  const set010HasUnknownRole = derived.tickets.some((ticket) => ticket.roles.state !== "determined");
  const onlineTicketExistencePlan = attributes.deliveryMode.state !== "determined"
    ? { applicability: "unknown" as const, reason: "開催方法を確定できません" }
    : !onlineDelivery
    ? simple(false, "オンラインまたはハイブリッドではないため")
    : derived.event.tickets.state !== "present"
    ? { applicability: "unknown" as const, reason: "チケット集合を取得できません" }
    : set010HasUnknownRole && !set010HasKnownOn
    ? { applicability: "unknown" as const, reason: "券役割を確定できずオンライン開催ON券の集計対象を確定できません" }
    : simple(true, "");
  add(plans, eventId, "SET-010", onlineTicketExistencePlan, ids(set010Candidates));
  add(plans, eventId, "SET-011", planChangeApplicability(derived), ids(derived.tickets.filter((ticket) => hasRole(ticket, "plan-change"))));
  add(plans, eventId, "SET-012", attributePlan(attributes.beginner.state === "determined" && attributes.beginner.value, [attributes.beginner], "初心者・ビギナー限定イベントではないため"), ids(derived.tickets.filter((ticket) => hasRole(ticket, "operation-member"))));
  add(plans, eventId, "SET-013", attributePlan(delivery === "hybrid" && pricingMode === "fixed-fee", [attributes.deliveryMode, attributes.pricingMode], "固定料金ハイブリッドではないため"), ids(sets.pricingComparisonSet));
  add(plans, eventId, "SET-014", derived.event.tickets.state === "present"
    ? simple(true, "")
    : { applicability: "unknown", reason: "チケット集合を取得できません" }, ids(derived.tickets));
  const uncertainRoleTarget = derived.tickets.some((ticket) => ticket.roles.state !== "determined");
  const uncertainOperationTarget = derived.tickets.some((ticket) => hasRole(ticket, "operation-member") && ticket.onlineEnabled.state !== "present");
  const knownEmptyNotice = noticeCandidates.some((ticket) => ticket.organizerNotice.state === "empty");
  add(plans, eventId, "SET-015", uncertainOperationTarget && !knownEmptyNotice && (delivery === "online" || delivery === "hybrid") && !allApplied
    ? { applicability: "unknown", reason: "運営メンバー券のオンライン開催設定を取得できず通知対象を確定できません" }
    : attributePlan((delivery === "online" || delivery === "hybrid") && !allApplied && noticeCandidates.length > 0, [attributes.deliveryMode, attributes.appliedComposition], "通知比較券がないため"), ids(noticeCandidates));
  const allUrlTargets = onlineUrlTargets(derived);
  const urlTargets = allUrlTargets.filter((ticket) => guidanceComparisonException(ticket) !== "exclude");
  const uncertainUrlException = allUrlTargets.some((ticket) => guidanceComparisonException(ticket) === "unknown");
  const uncertainOnlineTarget = uncertainRoleTarget || derived.tickets.some((ticket) => ticket.roles.state === "determined" && !hasRole(ticket, "plan-change") && ticket.onlineEnabled.state !== "present");
  add(plans, eventId, "CROSS-001", (uncertainOnlineTarget || uncertainUrlException) && urlTargets.length < 2 && (delivery === "online" || delivery === "hybrid") && !allApplied
    ? { applicability: "unknown", reason: uncertainUrlException ? "申込み済み券がURL比較の除外条件を満たすか判定できません" : "オンライン開催設定を取得できずURL比較集合を確定できません" }
    : attributePlan((delivery === "online" || delivery === "hybrid") && !allApplied && urlTargets.length >= 2, [attributes.deliveryMode, attributes.appliedComposition], "URL比較券が2件未満のため"), ids(urlTargets));
  const noticeTargets = noticeCandidates.filter((ticket) => guidanceComparisonException(ticket) !== "exclude");
  const uncertainNoticeException = noticeCandidates.some((ticket) => guidanceComparisonException(ticket) === "unknown");
  const uncertainNoticeTarget = uncertainRoleTarget || uncertainOperationTarget || uncertainNoticeException || noticeCandidates.some((ticket) => ticket.organizerNotice.state === "unavailable" || ticket.organizerNotice.state === "invalid");
  add(plans, eventId, "CROSS-002", uncertainNoticeTarget && noticeTargets.length < 2 && (delivery === "online" || delivery === "hybrid") && !allApplied
    ? { applicability: "unknown", reason: uncertainNoticeException ? "申込み済み券がお知らせ比較の除外条件を満たすか判定できません" : "通知対象またはお知らせ欄を取得できず比較集合を確定できません" }
    : attributePlan((delivery === "online" || delivery === "hybrid") && !allApplied && noticeTargets.length >= 2, [attributes.deliveryMode, attributes.appliedComposition], "非空のお知らせ比較券が2件未満のため"), ids(noticeTargets));

  return plans.map((plan) => ({ ...plan, applicabilityReferences: applicabilityReferences(derived, plan) }));
}

export function onlineUrlTargets(derived: DerivedEvent): DerivedTicket[] {
  return onlineGuidanceCandidates(derived).filter((ticket) => ticket.onlineEnabled.state === "present" && ticket.onlineEnabled.value);
}

export function notificationTargets(derived: DerivedEvent): DerivedTicket[] {
  return onlineGuidanceCandidates(derived).filter((ticket) =>
    !hasRole(ticket, "operation-member") || (ticket.onlineEnabled.state === "present" && ticket.onlineEnabled.value)
  );
}

export function onlineGuidanceCandidates(derived: DerivedEvent): DerivedTicket[] {
  return derived.tickets.filter((ticket) => ticket.roles.state === "determined" && !hasRole(ticket, "plan-change"));
}

function guidanceComparisonException(ticket: DerivedTicket): "exclude" | "include" | "unknown" {
  if (!hasRole(ticket, "already-applied")) return "include";
  if (ticket.onlineUrl.state === "empty") return "include";
  if (ticket.onlineUrl.state === "unavailable" || ticket.onlineUrl.state === "invalid") return "unknown";
  if (!isNekomachiEventUrl(ticket.onlineUrl.value)) return "include";
  return "exclude";
}

function isNekomachiEventUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "nekomachi-club.com" && url.pathname.startsWith("/events/");
  } catch {
    return false;
  }
}

function planChangeApplicability(derived: DerivedEvent): Pick<RulePlan, "applicability" | "reason"> {
  if (derived.event.tickets.state !== "present") return { applicability: "unknown", reason: "チケット集合を取得できません" };
  if (derived.tickets.some((ticket) => ticket.roles.state !== "determined")) {
    return { applicability: "unknown", reason: "券名を取得できずプラン変更券か判定できません" };
  }
  return { applicability: "applicable" };
}

function deadlineApplicability(derived: DerivedEvent): Pick<RulePlan, "applicability" | "reason"> {
  const field = derived.event.applicationDeadlineEnabled;
  if (field.state !== "present") return { applicability: "unknown", reason: "申込締切設定を取得できません" };
  return simple(field.value, "申込締切設定がOFFのため");
}

function bodyRecurrenceApplicability(derived: DerivedEvent, pattern: RegExp): Pick<RulePlan, "applicability" | "reason"> {
  const body = derived.event.bodyText;
  if (body.state === "unavailable" || body.state === "invalid") return { applicability: "unknown", reason: "本文を取得・解析できません" };
  if (body.state === "empty") return { applicability: "skipped", reason: "本文に回数表記がないため" };
  const fee = feeSection(body.value);
  return simple(pattern.test(fee), "参加費節に該当する回数表記がないため");
}

function bodyFeeApplicability(
  derived: DerivedEvent,
  condition: boolean,
  dependencies: Array<{ state: string }>,
  skippedReason: string
): Pick<RulePlan, "applicability" | "reason"> {
  const base = attributePlan(condition, dependencies, skippedReason);
  if (base.applicability !== "applicable") return base;
  const body = derived.event.bodyText;
  if (body.state === "unavailable" || body.state === "invalid") return { applicability: "unknown", reason: "本文を取得・解析できません" };
  if (body.state === "empty" || feeSection(body.value).length === 0) return { applicability: "skipped", reason: "本文に参加費欄がないため" };
  return { applicability: "applicable" };
}

function attributePlan(condition: boolean, dependencies: Array<{ state: string }>, skippedReason: string): Pick<RulePlan, "applicability" | "reason"> {
  if (dependencies.some((value) => value.state !== "determined")) return { applicability: "unknown", reason: "適用条件の属性を確定できません" };
  return simple(condition, skippedReason);
}

function normalSetPlan(
  uncertain: boolean,
  condition: boolean,
  dependencies: Array<{ state: string }>,
  skippedReason: string
): Pick<RulePlan, "applicability" | "reason"> {
  if (condition && uncertain) return { applicability: "unknown", reason: "用途を分類できない料金比較券があり通常参加券群を確定できません" };
  return attributePlan(condition, dependencies, skippedReason);
}

function simple(condition: boolean, reason: string): Pick<RulePlan, "applicability" | "reason"> {
  return condition ? { applicability: "applicable" } : { applicability: "skipped", reason };
}

function onlineFieldApplicability(base: boolean, ticket: DerivedTicket, requireOn: boolean): Pick<RulePlan, "applicability" | "reason"> {
  if (!base) return { applicability: "skipped", reason: "オンライン案内の対象券ではないため" };
  if (ticket.onlineEnabled.state !== "present") return { applicability: "unknown", reason: "オンライン開催設定を取得できません" };
  return simple(!requireOn || ticket.onlineEnabled.value, "オンライン開催がOFFのため");
}

function noticeApplicability(base: boolean, ticket: DerivedTicket): Pick<RulePlan, "applicability" | "reason"> {
  if (!base) return { applicability: "skipped", reason: "オンライン案内の対象券ではないため" };
  if (ticket.organizerNotice.state === "unavailable" || ticket.organizerNotice.state === "invalid") return { applicability: "unknown", reason: "お知らせ欄を取得できません" };
  if (ticket.organizerNotice.state === "empty") return { applicability: "skipped", reason: "お知らせが空欄のため、入力有無はSET-015で確認します" };
  return { applicability: "applicable" };
}

function add(
  plans: RulePlan[],
  eventId: string,
  ruleId: string,
  decision: Pick<RulePlan, "applicability" | "reason">,
  ticketIds?: string[]
): void {
  plans.push({ ruleId, eventId, ticketIds, applicabilityReferences: [], ...decision });
}

function ids(tickets: DerivedTicket[]): string[] {
  return tickets.map((ticket) => ticket.ticketId);
}

function feeSection(body: string): string {
  const marker = body.search(/(?:^|\n)[^\S\r\n]*(?:(?:■|●|◆|🔴|◾️?)\s*)?(?:読書会)?参加費(?=$|[\s:：（(])/m);
  if (marker < 0) return "";
  const remaining = body.slice(marker);
  const next = remaining.slice(1).search(/\n\s*(?:(?:■|●|◆|🔴|◾️?)|#{1,6}\s+)/);
  return next < 0 ? remaining : remaining.slice(0, next + 1);
}

function applicabilityReferences(derived: DerivedEvent, plan: RulePlan): RulePlan["applicabilityReferences"] {
  if (plan.ruleId === "TKT-005") return [configReference(derived.event.eventId, "BQ-01.ticketMemberLabelCheckDisabled")];
  const references = [] as RulePlan["applicabilityReferences"];
  const attributes = derived.attributes;
  const tickets = derived.tickets.filter((ticket) => !plan.ticketIds || plan.ticketIds.includes(ticket.ticketId));
  const addEvidence = (...items: Array<{ evidence: import("../domain/model.js").DerivationEvidence[] } | undefined>) => {
    references.push(...items.flatMap((item) => item ? evidenceReferences(item.evidence) : []));
  };

  if (plan.ruleId === "EVT-001") {
    references.push(eventReference(derived.event, "applicationDeadlineEnabled"));
  } else if (plan.ruleId.startsWith("BODY-")) {
    references.push(eventReference(derived.event, "bodyText"));
    if (plan.ruleId === "BODY-003" || plan.ruleId === "BODY-004") addEvidence(attributes?.deliveryMode, attributes?.pricingMode, attributes?.pricingScheme);
  } else if (plan.ruleId.startsWith("TKT-")) {
    for (const ticket of tickets) {
      references.push(ticketReference(derived.event.eventId, ticket, "name"));
      addEvidence(ticket.roles, ticket.rateKeys);
      if (["TKT-006", "TKT-012", "TKT-019"].includes(plan.ruleId)) references.push(ticketReference(derived.event.eventId, ticket, "price"));
      if (["TKT-007", "TKT-011", "TKT-013", "TKT-016"].includes(plan.ruleId)) references.push(ticketReference(derived.event.eventId, ticket, "visibility"));
      if (["TKT-008"].includes(plan.ruleId)) references.push(ticketReference(derived.event.eventId, ticket, "onlineUrl"));
      if (["TKT-009"].includes(plan.ruleId)) references.push(ticketReference(derived.event.eventId, ticket, "organizerNotice"));
      if (["TKT-014", "TKT-017"].includes(plan.ruleId)) references.push(ticketReference(derived.event.eventId, ticket, "onlineEnabled"));
    }
    addEvidence(attributes?.deliveryMode, attributes?.pricingMode, attributes?.pricingScheme);
    if (plan.ruleId !== "TKT-016") addEvidence(attributes?.appliedComposition);
  } else if (plan.ruleId.startsWith("SET-")) {
    references.push(eventReference(derived.event, "tickets"));
    addEvidence(
      attributes?.deliveryMode, attributes?.pricingMode, attributes?.pricingScheme, attributes?.beginner,
      attributes?.seriesEvent, attributes?.hasAllSessionEntry, attributes?.hasPartialEntry, attributes?.appliedComposition
    );
    if (derived.setEvidence) references.push(...evidenceReferences(Object.values(derived.setEvidence).flat()));
  } else if (plan.ruleId === "CROSS-001") {
    for (const ticket of tickets) references.push(
      ticketReference(derived.event.eventId, ticket, "onlineEnabled"),
      ticketReference(derived.event.eventId, ticket, "onlineUrl")
    );
    addEvidence(attributes?.deliveryMode, attributes?.appliedComposition);
  } else if (plan.ruleId === "CROSS-002") {
    for (const ticket of tickets) references.push(ticketReference(derived.event.eventId, ticket, "organizerNotice"));
    addEvidence(attributes?.deliveryMode, attributes?.appliedComposition);
  } else if (plan.ruleId === "AREA-001") {
    references.push(eventReference(derived.event, "bodyText"), eventReference(derived.event, "startAt"));
    for (const ticket of derived.tickets) references.push(ticketReference(derived.event.eventId, ticket, "organizerNotice"));
    addEvidence(attributes?.deliveryMode, attributes?.appliedComposition);
  } else if (plan.ruleId === "AREA-002") {
    references.push(eventReference(derived.event, "name"));
    for (const ticket of derived.tickets) references.push(ticketReference(derived.event.eventId, ticket, "name"));
    addEvidence(attributes?.appliedComposition);
  }

  if (references.length === 0) references.push(configReference(derived.event.eventId, `rule.${plan.ruleId}.applicability`));
  return uniqueReferences(references);
}

export function assertAllBusinessRulesPlanned(plans: RulePlan[]): void {
  const planned = new Set(plans.map((plan) => plan.ruleId));
  const missing = BUSINESS_RULE_IDS.filter((ruleId) => !planned.has(ruleId));
  if (missing.length > 0) throw new Error(`RulePlanが作成されていないルールがあります: ${missing.join(", ")}`);
}
