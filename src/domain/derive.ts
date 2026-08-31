import { normalizeEventNameForClassification } from "../utils/normalize.js";
import { isGuestPrice } from "./catalog.js";
import { matchedExcludedEventNameMarkers } from "./eligibility.js";
import { derivedReference, evidence, eventReference, ticketReference } from "./references.js";
import {
  determined,
  hasRole,
  observedValue,
  unknown,
  type AppliedComposition,
  type DeliveryMode,
  type DerivedEvent,
  type DerivedTicket,
  type DerivationResult,
  type EligibilityDecision,
  type EventAttributes,
  type NormalizedEvent,
  type NormalizedTicket,
  type ParticipationForm,
  type PricingMode,
  type PricingScheme,
  type RateKey,
  type TicketRole,
  type TicketSetEvidence,
  type TicketSets,
  type DerivationEvidence
} from "./model.js";

export const BUSINESS_RULE_IDS = [
  "EVT-001", "BODY-001", "BODY-002", "BODY-003", "BODY-004", "AREA-001", "AREA-002",
  "TKT-003", "TKT-004", "TKT-005", "TKT-006", "TKT-007", "TKT-008", "TKT-009",
  "TKT-010", "TKT-011", "TKT-012", "TKT-013", "TKT-014", "TKT-016", "TKT-017", "TKT-018", "TKT-019",
  "SET-001", "SET-002", "SET-003", "SET-004", "SET-005", "SET-006", "SET-007", "SET-010",
  "SET-011", "SET-012", "SET-013", "SET-014", "SET-015", "CROSS-001", "CROSS-002"
] as const;

export function decideEligibility(event: NormalizedEvent): EligibilityDecision {
  const nameEvidence = [evidence(eventReference(event, "name"), "対象外キーワードをイベント名で確認", "partial", "予告・一覧・事務局決済")];
  if (event.name.state !== "present") {
    return { status: "undetermined", reasons: ["イベント名を取得できず対象判定できません"], suppressedRuleIds: [...BUSINESS_RULE_IDS], evidence: nameEvidence };
  }
  const eventName = event.name.value;
  const reasons = matchedExcludedEventNameMarkers(eventName);
  return reasons.length > 0
    ? { status: "excluded", reasons: reasons.map((word) => `イベント名に「${word}」を含む`), suppressedRuleIds: [...BUSINESS_RULE_IDS], evidence: nameEvidence }
    : { status: "target", reasons: [], suppressedRuleIds: [], evidence: nameEvidence };
}

export function deriveEvent(event: NormalizedEvent): DerivedEvent {
  const eligibility = decideEligibility(event);
  if (eligibility.status !== "target") return { event, eligibility, tickets: [] };

  const deliveryMode = deriveDeliveryMode(event);
  const firstPassTickets = event.tickets.state === "present"
    ? event.tickets.value.map((ticket) => deriveFirstPassTicket(event, ticket, deliveryMode))
    : [];
  const pricingComparisonSet = firstPassTickets.filter((ticket) =>
    !ticket.rawRoleCandidates.some((role) => ["plan-change", "operation-member", "already-applied", "all-session-entry", "partial-entry"].includes(role))
  );
  const pricingMode = derivePricingMode(event, firstPassTickets, pricingComparisonSet);
  const tickets = firstPassTickets.map((ticket) => finishTicketRoles(ticket, deliveryMode, pricingMode, pricingComparisonSet));
  const sets = buildTicketSets(tickets, pricingComparisonSet.map((ticket) => ticket.ticketId));
  const pricingScheme = derivePricingScheme(deliveryMode, pricingMode, sets);
  const attributes: EventAttributes = {
    deliveryMode,
    pricingMode,
    pricingScheme,
    beginner: deriveBeginner(event, tickets),
    seriesEvent: event.name.state === "present"
      ? determined(/全\s*[0-9]+\s*回/.test(event.name.value), [evidence(eventReference(event, "name"), "全N回表記をイベント名で確認", "regex", "全N回")])
      : unknown("イベント名を取得できません", [evidence(eventReference(event, "name"), "セット参加イベント判定に必要なイベント名を取得不能")]),
    hasAllSessionEntry: event.tickets.state === "present"
      ? determined(tickets.some((ticket) => hasRole(ticket, "all-session-entry")), roleEvidence(event, tickets, "all-session-entry", "全回券役割の有無を確認"))
      : unknown("チケット集合を取得できません", [evidence(eventReference(event, "tickets"), "全回券判定に必要なチケット集合を取得不能")]),
    hasPartialEntry: event.tickets.state === "present"
      ? determined(tickets.some((ticket) => hasRole(ticket, "partial-entry")), roleEvidence(event, tickets, "partial-entry", "途中参加券役割の有無を確認"))
      : unknown("チケット集合を取得できません", [evidence(eventReference(event, "tickets"), "途中参加券判定に必要なチケット集合を取得不能")]),
    appliedComposition: deriveAppliedComposition(event, sets)
  };

  return { event, eligibility, attributes, tickets, sets, setEvidence: buildTicketSetEvidence(event, tickets, sets) };
}

export function deriveRateKeys(
  name: string,
  deliveryMode: DeliveryMode,
  visibilityTags: string[] = [],
  references?: { name: ReturnType<typeof ticketReference>; visibility: ReturnType<typeof ticketReference> }
): DerivationResult<RateKey[]> {
  const baseEvidence = references
    ? [
      evidence(references.name, "回数・初参加条件を券名から導出", "regex", "初参加・今月1回目・今月2回目以降"),
      evidence(references.visibility, "会員種別を販売対象（閲覧権限）から導出", "normalized-value", "オン・オフ・ハイ・外")
    ]
    : [evidence(derivedReference("standalone", "rateKeyInput"), "関数引数の券名・開催方法・販売対象からrateKeyを導出", "normalized-value")];
  const first = name.includes("初参加");
  const firstRecurrence = /(?:今月)?1回目/.test(name);
  const secondRecurrence = /(?:今月)?2回目(?:以降)?/.test(name);
  if (firstRecurrence && secondRecurrence) return { state: "conflict", candidates: [], evidence: baseEvidence };

  // BQ-01: 会員種別は券名や金額ではなく、OSIROの販売対象（閲覧権限）だけから導出する。
  // 券名は回数・初参加など、販売対象に存在しない修飾条件だけに使用する。
  const keys: RateKey[] = [];
  const tags = visibilityTags.filter((tag) => ["オン", "オフ", "ハイ", "外"].includes(tag));
  if (deliveryMode === "online") {
    if (tags.includes("ハイ")) keys.push("ON-HYBRID");
    if (tags.includes("オフ")) keys.push("ON-LOCAL");
    if (tags.includes("オン") && firstRecurrence) keys.push("ON-ONLINE-1");
    if (tags.includes("オン") && secondRecurrence) keys.push("ON-ONLINE-2");
    if (tags.includes("外")) keys.push(first ? "ON-NONMEMBER-FIRST" : "ON-NONMEMBER");
  } else {
    if (tags.includes("オフ") && firstRecurrence) keys.push("OFF-LOCAL-1");
    if (tags.includes("オフ") && secondRecurrence) keys.push("OFF-LOCAL-2");
    if (tags.includes("ハイ") && firstRecurrence) keys.push("OFF-HYBRID-1");
    if (tags.includes("ハイ") && secondRecurrence) keys.push("OFF-HYBRID-2");
    if (tags.includes("オン")) keys.push("OFF-ONLINE");
    if (tags.includes("外")) keys.push(first ? "OFF-NONMEMBER-FIRST" : "OFF-NONMEMBER");
  }
  return keys.length > 0
    ? determined([...new Set(keys)], baseEvidence)
    : unknown("販売対象と券名の回数・初参加条件からrateKeyを確定できません", baseEvidence);
}

function deriveDeliveryMode(event: NormalizedEvent): DerivationResult<DeliveryMode> {
  const venueEvidence = evidence(eventReference(event, "venue"), "ハイブリッド会場表記を確認", "regex", "オフ会場＋オンライン");
  if (event.venue.state === "unavailable") return unknown("会場を取得できずハイブリッド開催を除外できません", [venueEvidence]);
  const venue = observedValue(event.venue) ?? "";
  if (/オフ会場\s*[+＋]\s*オンライン/.test(venue)) return determined("hybrid", [venueEvidence]);
  const nameEvidence = evidence(eventReference(event, "name"), "オフライン開催マーカーをイベント名で確認", "partial");
  if (event.name.state !== "present") return unknown("イベント名を取得できません", [venueEvidence, nameEvidence]);
  const name = normalizeEventNameForClassification(event.name.value);
  const markers = ["【東京】", "【大阪】", "【京都】", "【福岡】", "【名古屋】", "【愛知】", "東京開催", "文学フリマ", "猫町.で、旅をしよう"];
  const offline = markers.some((marker) => name.includes(marker));
  return determined(offline ? "offline" : "online", [venueEvidence, nameEvidence]);
}

function deriveFirstPassTicket(event: NormalizedEvent, ticket: NormalizedTicket, deliveryMode: DerivationResult<DeliveryMode>): DerivedTicket {
  const nameEvidence = [evidence(ticketReference(event.eventId, ticket, "name"), "券名の用途文言を確認", "regex")];
  if (ticket.name.state !== "present") {
    return {
      ...ticket,
      roles: unknown("券名を取得できません", nameEvidence),
      rawRoleCandidates: [],
      memberLabels: unknown("券名を取得できません", nameEvidence),
      rateKeys: unknown("券名を取得できません", nameEvidence),
      participationForm: unknown("券名を取得できません", nameEvidence),
      firstTime: unknown("券名を取得できません", nameEvidence)
    };
  }
  const name = ticket.name.value;
  const candidates: TicketRole[] = [];
  if (/(?:プラン変更後|新プラン切り替え後|プラン切り替え後)にお申(?:し)?込み(?:下さい|ください)。?/.test(name)) candidates.push("plan-change");
  if (name.includes("運営メンバー")) candidates.push("operation-member");
  if (/お申し込み済み?の方/.test(name)) candidates.push("already-applied");
  if (/全\s*[0-9]+\s*回/.test(name)) candidates.push("all-session-entry");
  if (/第\s*[0-9]+\s*回から参加/.test(name)) candidates.push("partial-entry");
  const labels = memberLabels(name);
  const currentTags = ticket.visibility.state === "present" && ticket.visibility.value.some((tag) => ["オン", "オフ", "ハイ", "外"].includes(tag));
  if (!candidates.includes("plan-change") && !candidates.includes("operation-member") && currentTags) candidates.push("member-entry");
  const visibility = ticket.visibility.state === "present" ? ticket.visibility.value : [];
  const ambiguousAppliedWording = /お申し込み.*方/.test(name) && !candidates.includes("already-applied");
  const rateKeys = ambiguousAppliedWording
    ? unknown<RateKey[]>("申込み済み券に見える未対応文言のためrateKeyを確定できません", nameEvidence)
    : deliveryMode.state === "determined"
      ? deriveRateKeys(name, deliveryMode.value, visibility, {
        name: ticketReference(event.eventId, ticket, "name"),
        visibility: ticketReference(event.eventId, ticket, "visibility")
      })
      : unknown<RateKey[]>("開催方法を確定できません", deliveryMode.evidence);
  return {
    ...ticket,
    roles: determined(candidates, nameEvidence),
    rawRoleCandidates: candidates,
    memberLabels: determined(labels, nameEvidence),
    rateKeys,
    participationForm: participationForm(name, nameEvidence),
    firstTime: determined(name.includes("初参加"), nameEvidence)
  };
}

function finishTicketRoles(
  ticket: DerivedTicket,
  deliveryMode: DerivationResult<DeliveryMode>,
  pricingMode: DerivationResult<PricingMode>,
  comparisonSet: DerivedTicket[]
): DerivedTicket {
  if (ticket.roles.state !== "determined") return ticket;
  const roles = [...ticket.roles.value];
  if (
    deliveryMode.state === "determined" && deliveryMode.value === "hybrid" &&
    pricingMode.state === "determined" && pricingMode.value === "fixed-fee" &&
    comparisonSet.some((entry) => entry.ticketId === ticket.ticketId) && ticket.name.state === "present"
  ) {
    if (ticket.name.value.includes("現地参加")) roles.push("fixed-onsite-entry");
    if (ticket.name.value.includes("オンライン参加")) roles.push("fixed-online-entry");
  }
  if (roles.length === 0) roles.push("unclassified");
  const evidenceItems = [
    ...ticket.roles.evidence,
    ...deliveryMode.evidence,
    ...pricingMode.evidence,
    evidence(derivedReference(ticket.roles.evidence[0]?.reference.eventId ?? "unknown", "finalRoles", ticket), "固定料金ハイブリッドの参加経路役割を統合", "none")
  ];
  return { ...ticket, roles: determined([...new Set(roles)], evidenceItems), rawRoleCandidates: [...new Set(roles.filter((role) => role !== "unclassified"))] };
}

function buildTicketSets(tickets: DerivedTicket[], comparisonIds: string[]): TicketSets {
  const pricingComparisonSet = tickets.filter((ticket) => comparisonIds.includes(ticket.ticketId));
  const applicationTicketSet = tickets.filter((ticket) =>
    !hasRole(ticket, "plan-change") && !hasRole(ticket, "operation-member") &&
    ["member-entry", "already-applied", "all-session-entry", "partial-entry"].some((role) => hasRole(ticket, role as TicketRole))
  );
  return {
    pricingComparisonSet,
    applicationTicketSet,
    regularEntrySet: pricingComparisonSet.filter((ticket) => hasRole(ticket, "member-entry")),
    allSessionSet: tickets.filter((ticket) => hasRole(ticket, "all-session-entry")),
    partialEntrySet: tickets.filter((ticket) => hasRole(ticket, "partial-entry")),
    nonAppliedPartialSet: tickets.filter((ticket) => hasRole(ticket, "partial-entry") && !hasRole(ticket, "already-applied")),
    appliedPartialSet: tickets.filter((ticket) => hasRole(ticket, "partial-entry") && hasRole(ticket, "already-applied")),
    appliedSet: tickets.filter((ticket) => hasRole(ticket, "already-applied"))
  };
}

function derivePricingMode(event: NormalizedEvent, tickets: DerivedTicket[], comparisonSet: DerivedTicket[]): DerivationResult<PricingMode> {
  const collectionEvidence = [evidence(eventReference(event, "tickets"), "料金比較対象から除外する券役割を確認", "normalized-value")];
  if (event.tickets.state !== "present" || tickets.some((ticket) => ticket.roles.state !== "determined")) return unknown("チケット集合または除外役割を確定できません", [
    ...collectionEvidence,
    ...tickets.flatMap((ticket) => ticket.roles.evidence)
  ]);
  const prices: number[] = [];
  for (const ticket of comparisonSet) {
    if (ticket.price.state !== "present") return unknown("比較対象券の金額を確定できません", [evidence(ticketReference(event.eventId, ticket, "price"), "固定料金判定に必要な金額を取得不能")]);
    prices.push(ticket.price.value);
  }
  return determined(prices.length >= 1 && new Set(prices).size === 1 ? "fixed-fee" : "standard", [
    ...collectionEvidence,
    ...comparisonSet.map((ticket) => evidence(ticketReference(event.eventId, ticket, "price"), "比較対象券の金額が全件同額か確認", "normalized-value"))
  ]);
}

function derivePricingScheme(
  deliveryMode: DerivationResult<DeliveryMode>,
  pricingMode: DerivationResult<PricingMode>,
  sets: TicketSets
): DerivationResult<PricingScheme> {
  if (pricingMode.state !== "determined") return unknown("料金方式を確定できません", pricingMode.evidence);
  if (pricingMode.value === "fixed-fee" || sets.pricingComparisonSet.length === 0) return determined("not-applicable", pricingMode.evidence);
  if (deliveryMode.state !== "determined") return unknown("開催方法を確定できません", deliveryMode.evidence);
  if (sets.regularEntrySet.length !== sets.pricingComparisonSet.length) return unknown("通常参加券へ分類できない比較対象券があります", [
    ...pricingMode.evidence,
    ...sets.pricingComparisonSet.flatMap((ticket) => ticket.roles.evidence)
  ]);
  for (const ticket of sets.regularEntrySet) {
    if (ticket.price.state !== "present" || ticket.rateKeys.state !== "determined") return unknown("料金またはrateKeyを確定できません", [
      evidence(derivedReference(ticket.rateKeys.evidence[0]?.reference.eventId ?? "unknown", "pricingScheme", ticket), "料金またはrateKeyが取得不能"),
      ...ticket.rateKeys.evidence
    ]);
  }
  const allGuest = sets.regularEntrySet.every((ticket) => {
    if (ticket.price.state !== "present" || ticket.rateKeys.state !== "determined") return false;
    const price = ticket.price.value;
    return ticket.rateKeys.value.every((key) => isGuestPrice(key, price));
  });
  return determined(allGuest ? "guest" : "normal", [
    ...pricingMode.evidence,
    ...deliveryMode.evidence,
    ...sets.regularEntrySet.flatMap((ticket) => ticket.rateKeys.evidence)
  ]);
}

function deriveBeginner(event: NormalizedEvent, tickets: DerivedTicket[]): DerivationResult<boolean> {
  const values = [event.name, ...tickets.map((ticket) => ticket.name)];
  const evidenceItems = [
    evidence(eventReference(event, "name"), "初心者・ビギナー表記をイベント名で確認", "regex", "初心者読書会・初心者限定・ビギナー限定"),
    ...tickets.map((ticket) => evidence(ticketReference(event.eventId, ticket, "name"), "初心者・ビギナー表記を券名で確認", "regex", "初心者読書会・初心者限定・ビギナー限定"))
  ];
  const names = values.filter((value): value is Extract<typeof value, { state: "present" }> => value.state === "present").map((value) => value.value);
  if (names.some((name) => /初心者読書会|初心者限定|ビギナー限定/.test(name))) return determined(true, evidenceItems);
  return values.every((value) => value.state === "present" || value.state === "empty")
    ? determined(false, evidenceItems)
    : unknown("イベント名または券名を取得できません", evidenceItems);
}

function deriveAppliedComposition(event: NormalizedEvent, sets: TicketSets): DerivationResult<AppliedComposition> {
  const evidenceItems = [
    evidence(eventReference(event, "tickets"), "参加券集合の申込み済み役割を集計", "normalized-value"),
    ...sets.applicationTicketSet.flatMap((ticket) => ticket.roles.evidence)
  ];
  if (
    event.tickets.state !== "present" ||
    sets.applicationTicketSet.some((ticket) => ticket.roles.state !== "determined")
  ) return unknown("参加券集合を確定できません", evidenceItems);
  const appliedCount = sets.applicationTicketSet.filter((ticket) => hasRole(ticket, "already-applied")).length;
  if (appliedCount === 0) return determined("none", evidenceItems);
  return determined(appliedCount === sets.applicationTicketSet.length ? "already-applied-only" : "mixed", evidenceItems);
}

function memberLabels(name: string): string[] {
  return ["ハイブリッド会員", "地域会員", "オンライン会員", "非会員"].filter((label) => name.includes(label));
}

function participationForm(name: string, evidenceItems: DerivationEvidence[]): DerivationResult<ParticipationForm> {
  const reading = name.includes("読書会のみ参加");
  const party = name.includes("懇親会まで参加");
  if (reading && party) return { state: "conflict", candidates: ["reading", "after-party"], evidence: evidenceItems };
  return determined(reading ? "reading" : party ? "after-party" : "none", evidenceItems);
}

function roleEvidence(event: NormalizedEvent, tickets: DerivedTicket[], role: TicketRole, reason: string): DerivationEvidence[] {
  const items = tickets.flatMap((ticket) => ticket.roles.evidence);
  return items.length > 0
    ? items.map((item) => ({ ...item, reason }))
    : [evidence(eventReference(event, "tickets"), `${reason}（チケット0件）`, "normalized-value", role)];
}

function buildTicketSetEvidence(event: NormalizedEvent, tickets: DerivedTicket[], sets: TicketSets): TicketSetEvidence {
  const collection = evidence(eventReference(event, "tickets"), "チケット集合を走査", "normalized-value");
  const forTickets = (members: DerivedTicket[], reason: string): DerivationEvidence[] => members.length > 0
    ? members.flatMap((ticket) => [
      evidence(ticketReference(event.eventId, ticket, "name"), reason, "normalized-value"),
      ...ticket.roles.evidence
    ])
    : [{ ...collection, reason: `${reason}（該当券0件）` }];
  const onlineGuidance = tickets.filter((ticket) => ticket.roles.state === "determined" && !hasRole(ticket, "plan-change"));
  const onlineUrls = onlineGuidance.filter((ticket) => ticket.onlineEnabled.state === "present" && ticket.onlineEnabled.value);
  const notices = onlineGuidance.filter((ticket) => !hasRole(ticket, "operation-member") || (ticket.onlineEnabled.state === "present" && ticket.onlineEnabled.value));
  return {
    pricingComparisonSet: forTickets(sets.pricingComparisonSet, "除外役割を持たない料金比較券として所属"),
    applicationTicketSet: forTickets(sets.applicationTicketSet, "参加申込みに使用する券として所属"),
    regularEntrySet: forTickets(sets.regularEntrySet, "通常参加券として所属"),
    allSessionSet: forTickets(sets.allSessionSet, "全回券役割により所属"),
    partialEntrySet: forTickets(sets.partialEntrySet, "途中参加券役割により所属"),
    nonAppliedPartialSet: forTickets(sets.nonAppliedPartialSet, "未申込みの途中参加券として所属"),
    appliedPartialSet: forTickets(sets.appliedPartialSet, "申込み済み途中参加券として所属"),
    appliedSet: forTickets(sets.appliedSet, "申込み済み券役割により所属"),
    onlineGuidanceCandidates: forTickets(onlineGuidance, "プラン変更券以外のオンライン案内候補として所属"),
    onlineUrlTargets: onlineUrls.length > 0
      ? onlineUrls.map((ticket) => evidence(ticketReference(event.eventId, ticket, "onlineEnabled"), "オンライン開催ONによりURL対象へ所属", "exact", "true"))
      : [{ ...collection, reason: "オンラインURL対象券0件" }],
    notificationTargets: notices.length > 0
      ? notices.flatMap((ticket) => [
        evidence(ticketReference(event.eventId, ticket, "name"), "プラン変更券以外のお知らせ対象候補"),
        evidence(ticketReference(event.eventId, ticket, "onlineEnabled"), "運営メンバー券の場合はオンライン開催ONを確認", "exact", "true")
      ])
      : [{ ...collection, reason: "お知らせ対象券0件" }]
  };
}
