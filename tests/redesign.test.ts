import { describe, expect, it } from "vitest";
import { chromium } from "playwright";
import { validateEvent } from "../src/validation/engine.js";
import { BUSINESS_RULE_IDS, deriveEvent } from "../src/domain/derive.js";
import { matchedExcludedEventNameMarkers } from "../src/domain/eligibility.js";
import { normalizeEvent } from "../src/domain/normalize.js";
import { sendSlackMessages, type SlackPostResponse, type SlackTransport } from "../src/notification/slack-client.js";
import { saveStorageStateAtomically } from "../src/run/persistence.js";
import { closeResources } from "../src/run/cleanup.js";
import { createRunOutcome } from "../src/run/model.js";
import { validateOperationalConfig } from "../src/config.js";
import { buildSlackMessages, createSlackDryRunOutcome } from "../src/slack.js";
import type { EventInfo, TicketInfo } from "../src/types.js";
import { ADMIN_EVENT_FORM_EVALUATION_SCRIPT, assertAdminSessionIsValid, collectEventListWithPagination, extractEventFormDataWithTicketFallback } from "../src/osiro.js";
import { parseBodyFeeMap } from "../src/validation/body.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EventDisplayContext, EventStatus, ValidationResult } from "../src/domain/model.js";
import type { RunSummary } from "../src/results/model.js";
import { aggregateSummary } from "../src/run/orchestrator.js";

const notice = "20:00から受付を開始します。20:25までに受付を済ませてください。";
const planName = "プラン変更後にお申し込み下さい。プラン変更前は参加ボタンは押さないでください。";

function ticket(overrides: Partial<TicketInfo> & Pick<TicketInfo, "name">): TicketInfo {
  return {
    name: overrides.name,
    price: "price" in overrides ? overrides.price! : 0,
    visibility: "visibility" in overrides ? overrides.visibility! : null,
    visibilityTags: "visibilityTags" in overrides ? overrides.visibilityTags! : [],
    onlineEnabled: "onlineEnabled" in overrides ? overrides.onlineEnabled! : true,
    onlineUrl: "onlineUrl" in overrides ? overrides.onlineUrl! : "https://zoom.example/room",
    organizerNotice: "organizerNotice" in overrides ? overrides.organizerNotice! : notice,
    fieldAvailability: overrides.fieldAvailability
  };
}

function event(overrides: Partial<EventInfo> = {}): EventInfo {
  return {
    name: "『存在と時間』読書会",
    detailUrl: "https://nekomachi-club.com/admin_events/test/edit",
    startAt: new Date(2026, 7, 22, 20, 30),
    endAt: new Date(2026, 7, 22, 22, 0),
    venue: "",
    bodyText: [
      "■参加費",
      "ハイブリッド会員：無料",
      "地域会員：800円",
      "オンライン会員（今月1回目）：無料",
      "オンライン会員（今月2回目以降）：800円",
      "非会員：1,100円",
      "■タイムテーブル",
      "20:00 受付開始"
    ].join("\n"),
    applicationDeadlineEnabled: false,
    applicationDeadline: null,
    tickets: [],
    ...overrides
  };
}

function onlineTickets(): TicketInfo[] {
  return [
    ticket({ name: "『存在と時間』ハイブリッド会員", price: 0, visibilityTags: ["ハイ"] }),
    ticket({ name: "『存在と時間』地域会員", price: 800, visibilityTags: ["オフ"] }),
    ticket({ name: "『存在と時間』オンライン会員（今月1回目）", price: 0, visibilityTags: ["オン"] }),
    ticket({ name: "『存在と時間』オンライン会員（今月2回目以降）", price: 800, visibilityTags: ["オン"] }),
    ticket({ name: "『存在と時間』非会員", price: 1100, visibilityTags: ["外"] }),
    ticket({ name: planName, price: 0, visibilityTags: ["A", "U-22", "B"], onlineEnabled: false, onlineUrl: null, organizerNotice: null })
  ];
}

function statuses(info: EventInfo): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const item of validateEvent(info).validationResults) map.set(item.ruleId, [...(map.get(item.ruleId) ?? []), item.status]);
  return map;
}

function firstStatus(info: EventInfo, ruleId: string): string | undefined {
  return validateEvent(info).validationResults.find((item) => item.ruleId === ruleId)?.status;
}

function displayContext(name: string, status: EventStatus, message: string, index = 1): EventDisplayContext {
  const eventId = `display-${index}`;
  const validation: ValidationResult = {
    ruleId: status === "unknown" ? "QUAL-TEST" : "TEST-NG",
    businessGroup: "テスト",
    confirmationArea: "SYSTEM",
    judgmentUnit: "EVENT",
    status: status === "unknown" ? "unknown" : "failed",
    eventId,
    applicabilityReferences: [],
    inspectedFields: [],
    message,
    reason: status === "unknown" ? message : undefined
  };
  return {
    eventId,
    detailUrl: `https://example.com/${index}`,
    name: { state: "present", value: name },
    startAt: { state: "empty" },
    deliveryMode: "online",
    eligibilityStatus: "target",
    eligibilityReasons: [],
    eventStatus: status,
    validationResults: [validation],
    classificationDiagnostics: [],
    tickets: []
  };
}

function runSummary(events: EventDisplayContext[], counts?: Partial<Pick<RunSummary, "okCount" | "ngCount" | "unknownCount" | "failedAndUnknownCount">>): RunSummary {
  return {
    targetLabel: "テスト",
    executionComplete: true,
    acquisitionComplete: true,
    checkedCount: events.length,
    excludedCount: 0,
    undeterminedCount: 0,
    okCount: counts?.okCount ?? events.filter((item) => item.eventStatus === "ok").length,
    ngCount: counts?.ngCount ?? events.filter((item) => item.eventStatus === "failed").length,
    unknownCount: counts?.unknownCount ?? events.filter((item) => item.eventStatus === "unknown").length,
    failedAndUnknownCount: counts?.failedAndUnknownCount ?? events.filter((item) => item.eventStatus === "failed-and-unknown").length,
    events,
    executedAt: new Date(2026, 7, 22)
  };
}

describe("new result and classification model", () => {
  it("keeps all 39 canonical business rule IDs unique", () => {
    expect(BUSINESS_RULE_IDS).toHaveLength(39);
    expect(new Set(BUSINESS_RULE_IDS).size).toBe(39);
  });
  it("distinguishes empty from unavailable", () => {
    const normalized = normalizeEvent(event({ bodyText: undefined }));
    expect(normalized.bodyText.state).toBe("unavailable");
    expect(normalizeEvent(event({ bodyText: null })).bodyText.state).toBe("empty");
    expect(normalizeEvent(event({ tickets: [ticket({ name: "無料", price: null })] })).tickets.state).toBe("present");
  });

  it("separates excluded and undetermined eligibility", () => {
    expect(validateEvent(event({ name: "【予告】読書会" })).derived.eligibility.status).toBe("excluded");
    const normalized = normalizeEvent(event());
    normalized.name = { state: "unavailable", reason: "DOM変更" };
    expect(deriveEvent(normalized).eligibility.status).toBe("undetermined");
  });

  it.each(["予告", "一覧", "事務局決済"])("uses the shared exclusion marker for acquisition and eligibility: %s", (marker) => {
    expect(matchedExcludedEventNameMarkers(`【${marker}】読書会`)).toEqual([marker]);
    expect(validateEvent(event({ name: `【${marker}】読書会` })).derived.eligibility.status).toBe("excluded");
  });

  it("aggregates target and undetermined events into separate counts", () => {
    const target = displayContext("target", "ok", "", 1);
    const undetermined = { ...displayContext("undetermined", "unknown", "取得不能", 2), eligibilityStatus: "undetermined" as const };
    const summary = aggregateSummary([target, undetermined], 3, new Date(2026, 7, 22), {
      executionComplete: false,
      acquisitionComplete: false
    });
    expect(summary).toMatchObject({ checkedCount: 1, excludedCount: 3, undeterminedCount: 1, okCount: 1, unknownCount: 0 });
    expect(summary.checkedCount + summary.excludedCount + summary.undeterminedCount).toBe(5);
  });

  it("reports the exact accepted application-deadline range", () => {
    const info = event({
      name: "猫町.で、旅をしよう。",
      startAt: new Date(2026, 8, 21, 11, 0),
      applicationDeadlineEnabled: true,
      applicationDeadline: "2026-08-31T23:59",
      tickets: [ticket({ name: "参加", price: 0, visibilityTags: ["オン", "オフ", "ハイ", "外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null })]
    });
    expect(validateEvent(info).validationResults.find((item) => item.ruleId === "EVT-001")?.message)
      .toBe("申込締切日は開催日の3日前から開催日までにしてください。期待: 2026/09/18〜2026/09/21 / 実際: 2026-08-31T23:59");
  });

  it("skips AREA-002 without a bracketed event title and reports equal-length event candidates as unknown", () => {
    expect(firstStatus(event({ name: "書名の括弧がない読書会", tickets: onlineTickets() }), "AREA-002")).toBe("skipped");
    expect(firstStatus(event({ name: "『存在』と『時間』を読む", tickets: onlineTickets() }), "AREA-002")).toBe("unknown");
  });

  it.each([
    ["文学フリマ大阪", "", "offline"],
    ["【愛知】読書会", "", "offline"],
    ["猫町.で、旅をしよう", "", "offline"],
    ["【福岡 第一回】読書会", "", "online"],
    ["通常読書会", "オフ会場＋オンライン", "hybrid"],
    ["通常読書会", "", "online"]
  ])("derives delivery mode from name and venue: %s", (name, venue, expected) => {
    expect(deriveEvent(normalizeEvent(event({ name, venue }))).attributes?.deliveryMode).toMatchObject({ state: "determined", value: expected });
  });
});

describe("normal ticket composition", () => {
  it("derives normal rate keys from sales targets and prices when names omit member labels", () => {
    const tickets = onlineTickets().map((entry, index) => ({
      ...entry,
      name: index === 2 ? "参加 ※今月1回目" : index === 3 ? "参加 ※今月2回目以降" : "参加"
    }));
    const derived = deriveEvent(normalizeEvent(event({ tickets })));
    expect(derived.tickets.slice(0, 5).map((entry) => entry.rateKeys)).toEqual([
      expect.objectContaining({ state: "determined", value: ["ON-HYBRID"] }),
      expect.objectContaining({ state: "determined", value: ["ON-LOCAL"] }),
      expect.objectContaining({ state: "determined", value: ["ON-ONLINE-1"] }),
      expect.objectContaining({ state: "determined", value: ["ON-ONLINE-2"] }),
      expect.objectContaining({ state: "determined", value: ["ON-NONMEMBER"] })
    ]);
  });

  it("uses sales targets exclusively for member type and never uses member wording or price", () => {
    const info = event({ tickets: [
      ticket({ name: "地域会員（今月1回目）", price: 9999, visibilityTags: ["オン"] }),
      ticket({ name: "オンライン会員", price: 0, visibilityTags: ["ハイ"] })
    ] });
    const derived = deriveEvent(normalizeEvent(info));
    expect(derived.tickets[0].rateKeys).toMatchObject({ state: "determined", value: ["ON-ONLINE-1"] });
    expect(derived.tickets[1].rateKeys).toMatchObject({ state: "determined", value: ["ON-HYBRID"] });
  });

  it("does not infer an online-member recurrence from its price", () => {
    const derived = deriveEvent(normalizeEvent(event({ tickets: [ticket({ name: "参加", price: 0, visibilityTags: ["オン"] })] })));
    expect(derived.tickets[0].rateKeys).toMatchObject({ state: "unknown" });
  });

  it("accepts a complete normal online configuration", () => {
    const outcome = validateEvent(event({ tickets: onlineTickets() }));
    expect(outcome.eventStatus).toBe("ok");
    expect(firstStatus(event({ tickets: onlineTickets() }), "BODY-003")).toBe("passed");
    expect(firstStatus(event({ tickets: onlineTickets() }), "SET-001")).toBe("passed");
  });

  it("checks body fee amounts independently from ticket amounts", () => {
    const bad = event({ tickets: onlineTickets(), bodyText: event().bodyText!.replace("非会員：1,100円", "非会員：1,200円") });
    expect(firstStatus(bad, "BODY-003")).toBe("failed");
    expect(validateEvent(bad).validationResults.filter((item) => item.ruleId === "TKT-006" && item.status !== "skipped").every((item) => item.status === "passed")).toBe(true);
  });

  it("skips BODY-003 when the body has no fee section but still checks an existing incomplete section", () => {
    const noFeeSection = event({ tickets: onlineTickets(), bodyText: "■開催案内\n20:00 受付開始" });
    expect(firstStatus(noFeeSection, "BODY-003")).toBe("skipped");

    const incompleteFeeSection = event({ tickets: onlineTickets(), bodyText: "■参加費\n非会員：1,100円" });
    expect(firstStatus(incompleteFeeSection, "BODY-003")).toBe("failed");
  });

  it("checks body and ticket recurrence separately and skips absent body tokens", () => {
    const badTicket = onlineTickets();
    badTicket[2] = ticket({ name: "『存在と時間』オンライン会員（1回目）", price: 0, visibilityTags: ["オン"] });
    expect(validateEvent(event({ tickets: badTicket })).validationResults.find((item) => item.ruleId === "TKT-003" && item.ticketIds?.includes("ticket-3"))?.status).toBe("failed");
    const noTokens = event({ tickets: onlineTickets(), bodyText: "■参加費\n非会員：1,100円" });
    expect(firstStatus(noTokens, "BODY-001")).toBe("skipped");
    expect(firstStatus(noTokens, "BODY-002")).toBe("skipped");
  });

  it("reports a missing online rateKey in SET-001", () => {
    const tickets = onlineTickets().filter((entry) => !entry.name.includes("地域会員"));
    const outcome = validateEvent(event({ tickets }));
    expect(outcome.validationResults.find((item) => item.ruleId === "SET-001")?.status).toBe("failed");
    expect(outcome.validationResults.find((item) => item.ruleId === "SET-004")?.status).toBe("skipped");
  });

  it("does not require a one-ticket event to be free", () => {
    const one = event({ tickets: [ticket({ name: "非会員", price: 1100, visibilityTags: ["外"] })] });
    expect(validateEvent(one).validationResults.some((item) => item.message.includes("1つだけ") && item.status === "failed")).toBe(false);
  });

  it("does not apply the full normal-price matrix to a single generic ticket and reports each online guidance failure", () => {
    const info = event({ tickets: [ticket({ name: "単一参加券", price: 0, visibilityTags: ["オン", "オフ", "ハイ", "外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null })] });
    const outcome = validateEvent(info);
    expect(outcome.validationResults.find((item) => item.ruleId === "SET-010")?.status).toBe("failed");
    expect(outcome.validationResults.filter((item) => item.status === "failed").map((item) => item.ruleId)).toEqual(["SET-010", "SET-011", "SET-015", "AREA-001"]);
    expect(outcome.validationResults.find((item) => item.ruleId === "TKT-009")?.status).toBe("skipped");
    expect(outcome.validationResults.some((item) => item.status === "unknown")).toBe(false);
  });

  it("accepts the documented combined member lines in the online body fee", () => {
    const body = [
      "■参加費",
      "非会員：1,100円",
      "ハイブリッド会員・オンライン会員（今月1回目）：無料",
      "地域会員・オンライン会員（今月2回目以降）：800円"
    ].join("\n");
    expect(firstStatus(event({ tickets: onlineTickets(), bodyText: body }), "BODY-003")).toBe("passed");
  });
});

describe("offline SET-001 through SET-005 responsibility", () => {
  const offlineBody = [
    "■参加費",
    "地域会員/ハイブリッド会員（今月1回目）：無料",
    "地域会員/ハイブリッド会員（今月2回目以降）：1,800円",
    "オンライン会員：1,800円",
    "非会員：2,300円"
  ].join("\n");
  const specs: Array<[string, number, string]> = [
    ["地域会員（今月1回目）", 0, "オフ"], ["ハイブリッド会員（今月1回目）", 0, "ハイ"],
    ["地域会員（今月2回目以降）", 1800, "オフ"], ["ハイブリッド会員（今月2回目以降）", 1800, "ハイ"],
    ["オンライン会員", 1800, "オン"], ["非会員", 2300, "外"]
  ];
  function offlineTickets(): TicketInfo[] {
    return specs.flatMap(([name, price, tag]) => [
      ticket({ name: `${name} 読書会のみ参加`, price, visibilityTags: [tag], onlineEnabled: false, onlineUrl: null, organizerNotice: null }),
      ticket({ name: `${name} 懇親会まで参加`, price, visibilityTags: [tag], onlineEnabled: false, onlineUrl: null, organizerNotice: null })
    ]).concat(ticket({ name: planName, price: 0, visibilityTags: ["A", "U-22", "B"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }));
  }

  it("parses the red-circle fee heading used by current offline pages", () => {
    const body = `本文\n🔴参加費\n 地域会員/ハイブリッド会員（今月1回目） 無料\n 地域会員/ハイブリッド会員（今月2回目以降） 1,800円\n オンライン会員 1,800円\n 非会員 2,300円\n🔴タイムテーブル`;
    expect([...parseBodyFeeMap(body, "offline")]).toEqual([
      ["OFF-LOCAL-1", [0]], ["OFF-HYBRID-1", [0]], ["OFF-LOCAL-2", [1800]],
      ["OFF-HYBRID-2", [1800]], ["OFF-ONLINE", [1800]], ["OFF-NONMEMBER", [2300]]
    ]);
    expect(firstStatus(event({ name: "【愛知】読書会", bodyText: body, tickets: offlineTickets() }), "BODY-004")).toBe("passed");
  });

  it("accepts the reading-club fee heading and a second-visit continuation row", () => {
    const body = `🔴読書会参加費\n 地域会員/ハイブリッド会員（今月1回目） 無料\n ※今月2回目以降は1,800円\n オンライン会員 1,800円\n 非会員 2,300円`;
    expect(firstStatus(event({ name: "【愛知】読書会", bodyText: body, tickets: offlineTickets() }), "BODY-004")).toBe("passed");
  });

  it("skips BODY-004 when the body has no fee section", () => {
    const info = event({ name: "【愛知】読書会", bodyText: "■開催案内\n19:30 受付開始", tickets: offlineTickets() });
    expect(firstStatus(info, "BODY-004")).toBe("skipped");
  });

  it("does not assign a continuation row without an unambiguous immediately prior audience", () => {
    const withoutSource = "🔴読書会参加費\n※今月2回目以降は1,800円";
    expect(parseBodyFeeMap(withoutSource, "offline").has("OFF-LOCAL-2")).toBe(false);
    const wrongSource = "🔴参加費\n非会員 2,300円\n※今月2回目以降は1,800円";
    expect(parseBodyFeeMap(wrongSource, "offline").has("OFF-LOCAL-2")).toBe(false);
  });

  it("accepts two different forms for every rateKey without treating them as duplicates", () => {
    const outcome = validateEvent(event({ name: "【愛知】読書会", bodyText: offlineBody, tickets: offlineTickets() }));
    for (const id of ["SET-001", "SET-002", "SET-003", "SET-004"]) expect(outcome.validationResults.find((item) => item.ruleId === id)?.status).toBe("passed");
  });

  it("detects the same rateKey and form duplicate only in SET-002", () => {
    const tickets = offlineTickets();
    tickets.splice(-1, 0, { ...tickets[0] });
    const outcome = validateEvent(event({ name: "【愛知】読書会", bodyText: offlineBody, tickets }));
    expect(outcome.validationResults.find((item) => item.ruleId === "SET-002")?.status).toBe("failed");
    expect(outcome.validationResults.find((item) => item.ruleId === "SET-004")?.status).toBe("passed");
  });

  it("requires both forms only when the optional first-time nonmember slot exists", () => {
    const tickets = offlineTickets();
    tickets.splice(-1, 0, ticket({ name: "非会員 初参加 読書会のみ参加", price: 2300, visibilityTags: ["外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }));
    expect(firstStatus(event({ name: "【愛知】読書会", bodyText: offlineBody, tickets }), "SET-005")).toBe("failed");
    expect(firstStatus(event({ name: "【愛知】読書会", bodyText: offlineBody, tickets: offlineTickets() }), "SET-005")).toBe("skipped");
  });

  it("reports a wholly missing offline rateKey in both SET-001 and SET-004", () => {
    const tickets = offlineTickets().filter((entry) => !entry.name.includes("地域会員（今月1回目）"));
    const outcome = validateEvent(event({ name: "【愛知】読書会", bodyText: offlineBody, tickets }));
    expect(outcome.validationResults.find((item) => item.ruleId === "SET-001")?.status).toBe("failed");
    expect(outcome.validationResults.find((item) => item.ruleId === "SET-004")?.status).toBe("failed");
  });
});

describe("online SET-005 responsibility", () => {
  it("checks an optional first-time nonmember ticket when it exists", () => {
    const tickets = onlineTickets();
    tickets.splice(-1, 0, ticket({ name: "非会員 初参加", price: 1100, visibilityTags: ["外"] }));

    expect(firstStatus(event({ tickets }), "SET-005")).toBe("passed");
    expect(firstStatus(event({ tickets: onlineTickets() }), "SET-005")).toBe("skipped");
  });
});

describe("fixed fee and its documented detection limits", () => {
  function fixedTickets(names = ["現地参加", "オンライン参加"]): TicketInfo[] {
    return names.map((name) => ticket({ name, price: 2000, visibilityTags: ["オン", "オフ", "ハイ", "外"], onlineEnabled: name.includes("オンライン"), onlineUrl: name.includes("オンライン") ? "https://zoom.example/room" : null })).concat(
      ticket({ name: planName, price: 0, visibilityTags: ["A", "U-22", "B"], onlineEnabled: false, onlineUrl: null, organizerNotice: null })
    );
  }

  it("classifies two equal comparison tickets as fixed fee without using plan or visibility", () => {
    const info = event({ tickets: [ticket({ name: "参加A", price: 2000 }), ticket({ name: "参加B", price: 2000 })] });
    expect(deriveEvent(normalizeEvent(info)).attributes?.pricingMode).toMatchObject({ state: "determined", value: "fixed-fee" });
    expect(firstStatus(info, "SET-011")).toBe("failed");
  });

  it.each([
    ["online", "読書会", ""],
    ["offline", "【愛知】読書会", ""],
    ["hybrid", "読書会", "オフ会場＋オンライン"]
  ] as const)("classifies one %s comparison ticket as fixed-fee", (_kind, name, venue) => {
    const info = event({ name, venue, tickets: [ticket({ name: "参加券", price: 2000, visibilityTags: ["オン", "オフ", "ハイ", "外"] })] });
    const outcome = validateEvent(info);
    expect(outcome.derived.attributes?.pricingMode).toMatchObject({ state: "determined", value: "fixed-fee" });
    expect(firstStatus(info, "SET-011")).toBe("failed");
    expect(outcome.validationResults.filter((item) => ["SET-001", "SET-002", "SET-003", "SET-004", "SET-005", "TKT-006"].includes(item.ruleId)).every((item) => item.status === "skipped")).toBe(true);
  });

  it("keeps zero comparison tickets standard and unavailable comparison prices unknown", () => {
    const planOnly = event({ tickets: [ticket({ name: planName, visibilityTags: ["A", "U-22", "B"] })] });
    expect(deriveEvent(normalizeEvent(planOnly)).attributes?.pricingMode).toMatchObject({ state: "determined", value: "standard" });
    const unavailable = event({ tickets: [ticket({ name: "参加", price: null, fieldAvailability: { price: false }, visibilityTags: ["外"] })] });
    expect(deriveEvent(normalizeEvent(unavailable)).attributes?.pricingMode).toMatchObject({ state: "unknown" });
  });

  it("does not apply normal price or offline participation checks to fixed fee", () => {
    const info = event({ name: "【愛知】固定料金", bodyText: "", tickets: fixedTickets(["参加A", "参加B"]) });
    const map = statuses(info);
    expect(map.get("SET-003")).toEqual(["skipped"]);
    expect(map.get("TKT-006")?.every((value) => value === "skipped")).toBe(true);
    expect(map.get("TKT-013")?.slice(0, 2)).toEqual(["passed", "passed"]);
  });

  it("requires separate onsite and online routes for fixed hybrid and validates online ON", () => {
    const info = event({ venue: "オフ会場＋オンライン", bodyText: "", tickets: fixedTickets() });
    expect(firstStatus(info, "SET-013")).toBe("passed");
    expect(validateEvent(info).validationResults.some((item) => item.ruleId === "TKT-017" && item.status === "passed")).toBe(true);
    const missing = event({ venue: "オフ会場＋オンライン", bodyText: "", tickets: fixedTickets(["現地参加", "会場参加"]) });
    expect(validateEvent(missing).validationResults.find((item) => item.ruleId === "SET-013")).toMatchObject({
      status: "failed",
      message: "固定料金ハイブリッドに不足: オンライン参加券"
    });
  });

  it("detects missing all-member sales targets on a fixed fee ticket", () => {
    const tickets = fixedTickets();
    tickets[0] = { ...tickets[0], visibilityTags: ["オン"] };
    expect(validateEvent(event({ tickets })).validationResults.find((item) => item.ruleId === "TKT-013" && item.status === "failed")?.message)
      .toContain("固定料金チケットの販売対象に「オフ」、「ハイ」、「外」を追加してください");
  });

  describe("nekomachi-plus fixed fee", () => {
    function plusTickets(overrides: Partial<TicketInfo> = {}): TicketInfo[] {
      return [
        ticket({
          name: "猫町プラス内参加",
          price: 0,
          visibilityTags: ["オン", "オフ", "ハイ"],
          organizerNotice: null,
          ...overrides
        }),
        ticket({
          name: planName,
          price: 0,
          visibilityTags: ["A", "U-22", "B"],
          onlineEnabled: false,
          onlineUrl: null,
          organizerNotice: null
        })
      ];
    }

    it("classifies exactly two tickets with one plan-change ticket and no external visibility", () => {
      const outcome = validateEvent(event({ tickets: plusTickets() }));

      expect(outcome.derived.attributes?.pricingMode).toMatchObject({ state: "determined", value: "fixed-fee" });
      expect(outcome.derived.attributes?.fixedFeeType).toMatchObject({ state: "determined", value: "nekomachi-plus" });
      expect(outcome.validationResults.find((item) => item.ruleId === "SET-011")?.status).toBe("passed");
      expect(outcome.validationResults.find((item) => item.ruleId === "TKT-013" && item.ticketIds?.includes("ticket-1"))?.status).toBe("passed");
      expect(outcome.validationResults.find((item) => item.ruleId === "TKT-020" && item.ticketIds?.includes("ticket-1"))?.status).toBe("passed");
      expect(outcome.validationResults.find((item) => item.ruleId === "SET-015")?.status).toBe("skipped");
      expect(outcome.validationResults.find((item) => item.ruleId === "AREA-001")?.status).toBe("skipped");
      expect(outcome.validationResults.find((item) => item.ruleId === "TKT-008" && item.ticketIds?.includes("ticket-1"))?.status).toBe("passed");
    });

    it("requires every nekomachi-plus participation ticket to be free", () => {
      const outcome = validateEvent(event({ tickets: plusTickets({ price: 500 }) }));

      expect(outcome.derived.attributes?.fixedFeeType).toMatchObject({ state: "determined", value: "nekomachi-plus" });
      expect(outcome.validationResults.find((item) => item.ruleId === "TKT-020" && item.status === "failed")?.message)
        .toContain("猫町プラス内イベントの参加券は無料にしてください");
    });

    it("distinguishes an empty nekomachi-plus price from an unavailable price", () => {
      const empty = validateEvent(event({ tickets: plusTickets({ price: null }) }));
      expect(empty.validationResults.find((item) => item.ruleId === "TKT-020")?.status).toBe("failed");

      const unavailable = validateEvent(event({ tickets: plusTickets({ price: null, fieldAvailability: { price: false } }) }));
      expect(unavailable.validationResults.find((item) => item.ruleId === "TKT-020")?.status).toBe("unknown");
    });

    it("requires online, local and hybrid visibility without requiring external visibility", () => {
      const outcome = validateEvent(event({ tickets: plusTickets({ visibilityTags: ["オン", "オフ"] }) }));

      expect(outcome.validationResults.find((item) => item.ruleId === "TKT-013" && item.status === "failed")?.message)
        .toContain("猫町プラス内チケットの販売対象に「ハイ」を追加してください");
    });

    it.each([
      ["one ticket", [ticket({ name: "参加", price: 0, visibilityTags: ["オン", "オフ", "ハイ"] })]],
      ["two tickets without a plan-change ticket", [
        ticket({ name: "参加A", price: 0, visibilityTags: ["オン", "オフ", "ハイ"] }),
        ticket({ name: "参加B", price: 0, visibilityTags: ["オン", "オフ", "ハイ"] })
      ]],
      ["an external target", [
        ticket({ name: "参加", price: 0, visibilityTags: ["オン", "オフ", "ハイ", "外"] }),
        ticket({ name: planName, price: 0, visibilityTags: ["A", "U-22", "B"], onlineEnabled: false, onlineUrl: null, organizerNotice: null })
      ]]
    ])("keeps %s as a standard fixed-fee event", (_label, tickets) => {
      const attributes = deriveEvent(normalizeEvent(event({ tickets }))).attributes;
      expect(attributes?.pricingMode).toMatchObject({ state: "determined", value: "fixed-fee" });
      expect(attributes?.fixedFeeType).toMatchObject({ state: "determined", value: "standard" });
    });

    it("does not guess the fixed-fee type when visibility cannot be acquired", () => {
      const tickets = plusTickets({ fieldAvailability: { visibility: false } });
      const outcome = validateEvent(event({ tickets }));
      expect(outcome.derived.attributes?.fixedFeeType).toMatchObject({ state: "unknown" });
      for (const ruleId of ["TKT-013", "TKT-020"]) {
        expect(outcome.validationResults.find((item) => item.ruleId === ruleId && item.ticketIds?.includes("ticket-1"))?.status).toBe("unknown");
        expect(outcome.validationResults.find((item) => item.ruleId === ruleId && item.ticketIds?.includes("ticket-2"))?.status).toBe("skipped");
      }
    });

    it("does not classify a plan-change plus all-session composition as fixed fee", () => {
      const tickets = plusTickets({ name: "全3回参加" });
      const attributes = deriveEvent(normalizeEvent(event({ tickets }))).attributes;
      expect(attributes?.pricingMode).toMatchObject({ state: "determined", value: "standard" });
      expect(attributes?.fixedFeeType).toMatchObject({ state: "determined", value: "not-applicable" });
    });

    it("still validates an entered notice while allowing an empty notice", () => {
      const blank = validateEvent(event({ tickets: plusTickets() }));
      expect(blank.validationResults.find((item) => item.ruleId === "TKT-009" && item.ticketIds?.includes("ticket-1"))?.status).toBe("skipped");

      const entered = validateEvent(event({ tickets: plusTickets({ organizerNotice: "20:00から受付を開始します。20:20までに受付を済ませてください。" }) }));
      expect(entered.validationResults.find((item) => item.ruleId === "TKT-009" && item.ticketIds?.includes("ticket-1"))?.status).toBe("failed");
      expect(entered.validationResults.find((item) => item.ruleId === "AREA-001")?.status).toBe("passed");
    });
  });

  it.each([
    ["one comparison ticket", [ticket({ name: "参加", price: 2000 })], "fixed-fee"],
    ["different prices", [ticket({ name: "参加A", price: 2000 }), ticket({ name: "参加B", price: 2500 })], "standard"],
    ["normal tickets accidentally all equal", [ticket({ name: "地域会員", price: 800, visibilityTags: ["オフ"] }), ticket({ name: "非会員", price: 800, visibilityTags: ["外"] })], "fixed-fee"]
  ])("keeps the answered detection limit: %s", (_label, tickets, expected) => {
    expect(deriveEvent(normalizeEvent(event({ tickets }))).attributes?.pricingMode).toMatchObject({ state: "determined", value: expected });
  });
});

describe("series, applied, beginner and unknown roles", () => {
  const seriesTickets = (label: string) => ["オン", "オフ", "ハイ", "外"].map((tag) => ticket({ name: `${label} ${tag}`, price: 999, visibilityTags: [tag] }));

  it.each([
    ["all session only", seriesTickets("全3回"), "SET-006"],
    ["partial only", seriesTickets("第2回から参加"), "SET-007"],
    ["all and partial", [...seriesTickets("全3回"), ...seriesTickets("第2回から参加")], "SET-007"]
  ])("keeps normal configuration out of %s", (_label, tickets, appliedRule) => {
    const info = event({ name: "全3回『存在と時間』読書会", tickets: [...tickets, ticket({ name: planName, visibilityTags: ["A", "U-22", "B"], onlineEnabled: false, onlineUrl: null, organizerNotice: null })] });
    expect(firstStatus(info, "SET-001")).toBe("skipped");
    expect(firstStatus(info, appliedRule)).toBe("passed");
    expect(firstStatus(info, "SET-011")).toBe("passed");
  });

  it("counts an already-applied partial ticket only when ON and still checks its notice", () => {
    const appliedPartial = ticket({ name: "第2回から参加 お申し込み済みの方 オン", price: 999, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null });
    const info = event({ name: "全3回読書会", tickets: [
      ticket({ name: "第2回から参加 オフ", price: 999, visibilityTags: ["オフ"] }),
      ticket({ name: "第2回から参加 ハイ", price: 999, visibilityTags: ["ハイ"] }),
      ticket({ name: "第2回から参加 外", price: 999, visibilityTags: ["外"] }),
      appliedPartial,
      ticket({ name: planName, visibilityTags: ["A", "U-22", "B"], onlineEnabled: false, onlineUrl: null, organizerNotice: null })
    ] });
    const outcome = validateEvent(info);
    expect(outcome.validationResults.find((item) => item.ruleId === "TKT-014" && item.ticketIds?.includes("ticket-4"))?.status).toBe("skipped");
    expect(outcome.validationResults.find((item) => item.ruleId === "SET-015")?.status).toBe("failed");
  });

  it("keeps plan-change required for already-applied-only events", () => {
    const info = event({ tickets: [ticket({ name: "オンライン会員 お申し込み済みの方", visibilityTags: ["オン"] })] });
    expect(firstStatus(info, "SET-001")).toBe("skipped");
    expect(firstStatus(info, "SET-010")).toBe("passed");
    expect(firstStatus(info, "SET-011")).toBe("failed");

    const withPlan = event({ tickets: [
      ticket({ name: "オンライン会員 お申し込み済みの方", visibilityTags: ["オン"] }),
      ticket({ name: planName, visibilityTags: ["A", "U-22", "B"], onlineEnabled: false, onlineUrl: null, organizerNotice: null })
    ] });
    expect(firstStatus(withPlan, "SET-011")).toBe("passed");
  });

  it("requires plan change even when no normal participation ticket exists", () => {
    expect(firstStatus(event({ tickets: [] }), "SET-011")).toBe("failed");
  });

  it("counts ON tickets for SET-010 even when every ticket is already applied", () => {
    const on = event({ tickets: [ticket({ name: "オンライン会員 お申し込み済みの方", visibilityTags: ["オン"], onlineEnabled: true })] });
    const off = event({ tickets: [ticket({ name: "オンライン会員 お申し込み済みの方", visibilityTags: ["オン"], onlineEnabled: false })] });

    expect(firstStatus(on, "SET-010")).toBe("passed");
    expect(firstStatus(off, "SET-010")).toBe("failed");
    for (const ruleId of ["TKT-008", "TKT-009", "SET-015", "CROSS-001", "CROSS-002", "AREA-001"]) {
      expect(firstStatus(on, ruleId)).toBe("skipped");
    }
  });

  it("keeps SET-010 unknown when the ticket collection cannot be acquired", () => {
    const info = event({ fieldAvailability: { tickets: false }, tickets: [] });
    expect(firstStatus(info, "SET-010")).toBe("unknown");
  });

  it("does not let an ON ticket with an unknown role make SET-010 pass", () => {
    const info = event({ tickets: [ticket({ name: "", onlineEnabled: true, fieldAvailability: { name: false } })] });
    expect(firstStatus(info, "SET-010")).toBe("unknown");
  });

  it("checks legacy member tags on all-applied tickets and excludes only the plan-change ticket from TKT-016", () => {
    const info = event({ tickets: [
      ticket({ name: "オンライン会員 お申し込み済みの方", visibilityTags: ["オン", "A"] }),
      ticket({ name: planName, visibilityTags: ["A", "U-22", "B"], onlineEnabled: false, onlineUrl: null, organizerNotice: null })
    ] });
    const outcome = validateEvent(info);
    const results = outcome.validationResults.filter((item) => item.ruleId === "TKT-016");
    expect(results.find((item) => item.ticketIds?.includes("ticket-1"))?.status).toBe("failed");
    expect(results.find((item) => item.ticketIds?.includes("ticket-2"))?.status).toBe("skipped");
    const slack = buildSlackMessages(runSummary([outcome.event])).join("\n");
    expect(slack).toContain("[TKT-016 / 1番目「オンライン会員 お申し込み済みの方」] 販売対象から旧会員タグ（A）を外してください");
    expect(slack).not.toContain("ticket-1");
    expect(slack).not.toContain("[1番目] チケット");
  });

  it("requires plan change for an already-applied-only all-session event", () => {
    const info = event({ name: "全3回読書会", tickets: [ticket({ name: "全3回 お申し込み済みの方", visibilityTags: ["オン"] })] });
    expect(firstStatus(info, "SET-011")).toBe("failed");
    expect(firstStatus(info, "SET-006")).toBe("skipped");
  });

  it("keeps an already-applied all-session ticket in SET-006 when other participation tickets remain", () => {
    const info = event({ name: "全3回読書会", tickets: [
      ticket({ name: "全3回 オン お申し込み済みの方", visibilityTags: ["オン"] }),
      ...["オフ", "ハイ", "外"].map((tag) => ticket({ name: `全3回 ${tag}`, visibilityTags: [tag] })),
      ticket({ name: planName, visibilityTags: ["A", "U-22", "B"], onlineEnabled: false, onlineUrl: null, organizerNotice: null })
    ] });
    expect(firstStatus(info, "SET-006")).toBe("passed");
  });

  it("reports both TKT-007 and TKT-016 when a ticket has only legacy visibility tags", () => {
    const info = event({ tickets: [
      ...onlineTickets(),
      ticket({ name: "お申し込み済みの方", visibilityTags: ["A", "U-22", "B"], onlineEnabled: false, onlineUrl: null, organizerNotice: notice })
    ] });
    const outcome = validateEvent(info);
    const targetId = "ticket-7";
    expect(outcome.validationResults.find((item) => item.ruleId === "TKT-007" && item.ticketIds?.includes(targetId))?.status).toBe("failed");
    expect(outcome.validationResults.find((item) => item.ruleId === "TKT-016" && item.ticketIds?.includes(targetId))?.status).toBe("failed");
    expect(outcome.validationResults.filter((item) => item.ticketIds?.includes(targetId) && item.status === "failed" && item.businessGroup === "販売対象")).toHaveLength(2);
  });

  it.each([
    ["normal plus all-session", seriesTickets("全3回"), "SET-006"],
    ["normal plus partial", seriesTickets("第2回から参加"), "SET-007"],
    ["normal plus both series groups", [...seriesTickets("全3回"), ...seriesTickets("第2回から参加")], "SET-007"]
  ])("keeps regular and series sets independent: %s", (_label, special, seriesRule) => {
    const info = event({ name: "全3回『存在と時間』読書会", tickets: [...onlineTickets().slice(0, 5), ...special, onlineTickets()[5]] });
    expect(firstStatus(info, "SET-001")).toBe("passed");
    expect(firstStatus(info, seriesRule)).toBe("passed");
  });

  it("requires an operation member ticket only for beginner events and checks zero price", () => {
    const missing = event({ name: "初心者読書会", tickets: onlineTickets() });
    expect(firstStatus(missing, "SET-012")).toBe("failed");
    const withPaid = event({ name: "初心者読書会", tickets: [...onlineTickets(), ticket({ name: "運営メンバー", price: 500, onlineEnabled: false, onlineUrl: null, organizerNotice: null })] });
    expect(validateEvent(withPaid).validationResults.some((item) => item.ruleId === "TKT-012" && item.status === "failed")).toBe(true);
  });

  it("recognizes 初心者限定 as a beginner event", () => {
    const info = event({
      name: "【オンライン・初心者限定】著者参加！『読書会入門』",
      bodyText: "■開催案内\n20:00 受付開始",
      tickets: onlineTickets()
    });
    const outcome = validateEvent(info);
    expect(outcome.derived.attributes?.beginner).toMatchObject({ state: "determined", value: true });
    expect(outcome.validationResults.find((item) => item.ruleId === "SET-012")?.status).toBe("failed");
    expect(outcome.validationResults.find((item) => item.ruleId === "BODY-003")?.status).toBe("skipped");
  });

  it("treats an unclassified ticket as unknown diagnostic, not business failure", () => {
    const outcome = validateEvent(event({ tickets: [ticket({ name: "用途未定", visibilityTags: [] })] }));
    expect(outcome.classificationDiagnostics).toHaveLength(1);
    expect(outcome.classificationDiagnostics[0].status).toBe("unknown");
    expect(outcome.validationResults.some((item) => item.ruleId === "SET-009")).toBe(false);
  });

  it("derives member-entry only from current sales targets, not a member label in the ticket name", () => {
    const outcome = validateEvent(event({ tickets: [ticket({ name: "オンライン会員（今月1回目）", visibilityTags: [] })] }));
    expect(outcome.derived.tickets[0].roles).toMatchObject({ state: "determined", value: ["unclassified"] });
    expect(outcome.classificationDiagnostics).toHaveLength(1);
  });

  it("keeps normal ticket-set rules unknown when an unclassified comparison ticket can change the set", () => {
    const outcome = validateEvent(event({ tickets: [
      ticket({ name: "参加（今月1回目）", price: 0, visibilityTags: ["オン"] }),
      ticket({ name: "用途未定", price: 800, visibilityTags: [] })
    ] }));
    expect(outcome.derived.attributes?.pricingMode).toMatchObject({ state: "determined", value: "standard" });
    expect(outcome.validationResults.find((item) => item.ruleId === "SET-001")?.status).toBe("unknown");
    expect(outcome.validationResults.find((item) => item.ruleId === "TKT-006" && item.ticketIds?.includes("ticket-1"))?.status).toBe("unknown");
  });

  it("distinguishes an explicit zero-ticket business failure from unavailable ticket acquisition", () => {
    expect(firstStatus(event({ tickets: [] }), "SET-014")).toBe("failed");
    expect(firstStatus(event({ tickets: [], fieldAvailability: { tickets: false } }), "SET-014")).toBe("unknown");
  });

  it("does not count a ticket with an unavailable name as a known participation ticket", () => {
    const outcome = validateEvent(event({ tickets: [ticket({ name: "", fieldAvailability: { name: false } })] }));
    expect(outcome.validationResults.find((item) => item.ruleId === "SET-014")?.status).toBe("unknown");
    for (const ruleId of ["TKT-003", "TKT-004", "TKT-008", "TKT-009", "TKT-010", "TKT-011", "TKT-012", "TKT-018", "TKT-019"]) {
      expect(outcome.validationResults.find((item) => item.ruleId === ruleId)?.status).toBe("unknown");
    }
  });

  it("requires plan change for a one-ticket fixed-fee event even when the role is unclassified", () => {
    expect(firstStatus(event({ tickets: [ticket({ name: "用途未定" })] }), "SET-011")).toBe("failed");
  });

  it("separates an empty price failure from an unavailable price unknown", () => {
    const emptyPrice = event({ tickets: [ticket({ name: "参加A", price: null }), ticket({ name: "参加B", price: 2000 })] });
    expect(validateEvent(emptyPrice).validationResults.some((item) => item.ruleId === "TKT-019" && item.ticketIds?.includes("ticket-1") && item.status === "failed")).toBe(true);
    const unavailablePrice = event({ tickets: [ticket({ name: "参加A", price: null, fieldAvailability: { price: false } }), ticket({ name: "参加B", price: 2000 })] });
    expect(validateEvent(unavailablePrice).validationResults.some((item) => item.ruleId === "TKT-019" && item.ticketIds?.includes("ticket-1") && item.status === "unknown")).toBe(true);
  });

  it("keeps archive wording in normal participation checks", () => {
    const tickets = onlineTickets();
    tickets[2] = ticket({ name: "『存在と時間』オンライン会員（今月1回目・アーカイブ付き）", price: 0, visibilityTags: ["オン"] });
    expect(validateEvent(event({ tickets })).derived.tickets[2].roles).toMatchObject({ state: "determined", value: expect.arrayContaining(["member-entry"]) });
  });
});

describe("online guidance", () => {
  it("checks notices independently when every candidate is OFF", () => {
    const info = event({ tickets: [
      ticket({ name: "参加A", price: 2000, visibilityTags: ["オン", "オフ", "ハイ", "外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null })
    ] });
    expect(firstStatus(info, "SET-010")).toBe("failed");
    expect(firstStatus(info, "SET-015")).toBe("failed");
  });

  it("includes an operation ticket only when its online setting is ON", () => {
    const off = [...onlineTickets(), ticket({ name: "運営メンバー", price: 0, onlineEnabled: false, onlineUrl: null, organizerNotice: null })];
    expect(firstStatus(event({ name: "初心者読書会", tickets: off }), "SET-015")).toBe("passed");
    const on = [...onlineTickets(), ticket({ name: "運営メンバー", price: 0, onlineEnabled: true, onlineUrl: "https://zoom.example/room", organizerNotice: null })];
    expect(firstStatus(event({ name: "初心者読書会", tickets: on }), "SET-015")).toBe("failed");
  });
  it("separates URL absence, URL mismatch, notice absence, deadline and body-time mismatch", () => {
    const tickets = onlineTickets();
    tickets[0] = { ...tickets[0], onlineUrl: null };
    tickets[1] = { ...tickets[1], onlineUrl: "https://zoom.example/other" };
    tickets[2] = { ...tickets[2], organizerNotice: null };
    tickets[3] = { ...tickets[3], organizerNotice: "19:55から受付を開始します。20:20までに" };
    const outcome = validateEvent(event({ tickets }));
    expect(outcome.validationResults.some((item) => item.ruleId === "TKT-008" && item.status === "failed")).toBe(true);
    expect(outcome.validationResults.find((item) => item.ruleId === "CROSS-001")?.status).toBe("failed");
    expect(outcome.validationResults.find((item) => item.ruleId === "SET-015")?.status).toBe("failed");
    expect(outcome.validationResults.some((item) => item.ruleId === "TKT-009" && item.status === "failed")).toBe(true);
    expect(outcome.validationResults.find((item) => item.ruleId === "AREA-001")?.status).toBe("failed");
  });

  it("assigns empty notice input only to SET-015 while keeping independent consistency checks", () => {
    const tickets = onlineTickets();
    tickets[0] = { ...tickets[0], onlineUrl: null, organizerNotice: null };
    const outcome = validateEvent(event({ tickets }));
    const failed = outcome.validationResults.filter((item) => item.status === "failed");
    expect(failed.some((item) => item.ruleId === "TKT-008" && item.ticketIds?.includes("ticket-1"))).toBe(true);
    expect(outcome.validationResults.find((item) => item.ruleId === "TKT-009" && item.ticketIds?.includes("ticket-1"))?.status).toBe("skipped");
    for (const ruleId of ["SET-015", "CROSS-001", "CROSS-002", "AREA-001"]) {
      expect(failed.some((item) => item.ruleId === ruleId)).toBe(true);
    }
  });

  it("separates notice presence from the deadline check", () => {
    const blankTickets = onlineTickets();
    blankTickets[0] = { ...blankTickets[0], organizerNotice: null };
    const blank = validateEvent(event({ tickets: blankTickets }));
    expect(blank.validationResults.find((item) => item.ruleId === "SET-015")?.status).toBe("failed");
    expect(blank.validationResults.find((item) => item.ruleId === "TKT-009" && item.ticketIds?.includes("ticket-1"))?.status).toBe("skipped");

    const wrongDeadlineTickets = onlineTickets();
    wrongDeadlineTickets[0] = { ...wrongDeadlineTickets[0], organizerNotice: "20:00から受付を開始します。20:20までに受付を済ませてください。" };
    const wrongDeadline = validateEvent(event({ tickets: wrongDeadlineTickets }));
    expect(wrongDeadline.validationResults.find((item) => item.ruleId === "SET-015")?.status).toBe("passed");
    expect(wrongDeadline.validationResults.find((item) => item.ruleId === "TKT-009" && item.ticketIds?.includes("ticket-1"))?.status).toBe("failed");
  });

  it("shows each ticket position and name only once in Slack issue lines", () => {
    const tickets = onlineTickets();
    tickets[0] = { ...tickets[0], organizerNotice: null };
    const outcome = validateEvent(event({ tickets }));
    const slack = buildSlackMessages(runSummary([outcome.event])).join("\n");
    const setLine = slack.split("\n").find((line) => line.includes("[SET-015"));
    expect(setLine).toBe(`- [SET-015 / 1番目「${tickets[0].name}」] 主催者からのお知らせが空欄です`);
    expect(slack).toContain("[CROSS-002] 主催者からのお知らせが異なります: 1番目");
    expect(slack).not.toContain("[CROSS-002 /");

    for (const line of slack.split("\n").filter((entry) => /^- \[/.test(entry))) {
      const referenceEnd = line.indexOf("] ");
      if (referenceEnd < 0) continue;
      const reference = line.slice(0, referenceEnd);
      const message = line.slice(referenceEnd + 2);
      for (const match of reference.matchAll(/(\d+)番目「([^」]+)」/g)) {
        expect(message, line).not.toContain(`${match[1]}番目`);
        expect(message, line).not.toContain(match[2]);
      }
    }
  });

  it("does not repeat a ticket position in an unclassified-ticket diagnostic", () => {
    const info = event({ tickets: [
      ticket({ name: "用途未定", price: 2000 }),
      ticket({ name: planName, visibilityTags: ["A", "U-22", "B"], onlineEnabled: false, onlineUrl: null, organizerNotice: null })
    ] });
    const slack = buildSlackMessages(runSummary([validateEvent(info).event])).join("\n");
    const line = slack.split("\n").find((entry) => entry.includes("[DIAG-ROLE-001"));
    expect(line).toBe("- [DIAG-ROLE-001 / 1番目「用途未定」] 用途を分類できないチケットがあります: 設定不備とは断定できず、分類ルール未対応の可能性があります");
  });

  it("identifies the ticket positions belonging to each mismatched URL and notice group", () => {
    const tickets = onlineTickets();
    tickets[0] = { ...tickets[0], onlineUrl: "https://zoom.example/other", organizerNotice: "別のお知らせ" };
    tickets[1] = { ...tickets[1], organizerNotice: "別のお知らせ" };
    const outcome = validateEvent(event({ tickets }));
    expect(outcome.validationResults.find((item) => item.ruleId === "CROSS-001")?.message)
      .toBe("オンライン参加URLが異なります: 1番目 ↔ 2番目・3番目・4番目・5番目");
    expect(outcome.validationResults.find((item) => item.ruleId === "CROSS-002")?.message)
      .toBe("主催者からのお知らせが異なります: 1番目・2番目 ↔ 3番目・4番目・5番目");
  });

  it("allows an already-applied ticket with a nekomachi event URL to use different URL and notice regardless of price", () => {
    const tickets = onlineTickets();
    tickets[0] = ticket({
      name: "全3回参加にお申し込み済みの方",
      price: 100,
      visibilityTags: ["オン", "オフ", "ハイ", "外"],
      onlineUrl: "https://nekomachi-club.com/events/previous-session",
      organizerNotice: "申込み済みの方は19:55から受付を開始します。20:25までに受付を済ませてください。"
    });
    const outcome = validateEvent(event({ name: "全3回講座 第二回", tickets }));
    expect(outcome.validationResults.find((item) => item.ruleId === "CROSS-001")).toMatchObject({ status: "passed", ticketIds: ["ticket-2", "ticket-3", "ticket-4", "ticket-5"] });
    expect(outcome.validationResults.find((item) => item.ruleId === "CROSS-002")).toMatchObject({ status: "passed", ticketIds: ["ticket-2", "ticket-3", "ticket-4", "ticket-5"] });
    expect(outcome.validationResults.find((item) => item.ruleId === "TKT-008" && item.ticketIds?.includes("ticket-1"))?.status).toBe("passed");
    expect(outcome.validationResults.find((item) => item.ruleId === "TKT-009" && item.ticketIds?.includes("ticket-1"))?.status).toBe("passed");
  });

  it.each([
    ["未申込み", 0, "通常参加", "https://nekomachi-club.com/events/previous-session"],
    ["別URL", 0, "全3回参加にお申し込み済みの方", "https://example.com/events/previous-session"]
  ])("does not apply the comparison exception when %s", (_label, price, name, onlineUrl) => {
    const tickets = onlineTickets();
    tickets[0] = ticket({ name, price, visibilityTags: ["オン", "オフ", "ハイ", "外"], onlineUrl, organizerNotice: "別案内" });
    const outcome = validateEvent(event({ name: "全3回講座 第二回", tickets }));
    expect(outcome.validationResults.find((item) => item.ruleId === "CROSS-001")?.status).toBe("failed");
    expect(outcome.validationResults.find((item) => item.ruleId === "CROSS-002")?.status).toBe("failed");
  });

  it("excludes plan change from URL and notice comparisons", () => {
    const info = event({ tickets: onlineTickets() });
    const outcome = validateEvent(info);
    for (const id of ["TKT-008", "TKT-009"]) {
      expect(outcome.validationResults.find((item) => item.ruleId === id && item.ticketIds?.includes("ticket-6"))?.status).toBe("skipped");
    }
  });

  it("returns unknown rather than skipped when online settings or URL fields are unavailable", () => {
    const tickets = onlineTickets();
    tickets[0] = { ...tickets[0], fieldAvailability: { onlineEnabled: false } };
    let outcome = validateEvent(event({ tickets }));
    expect(outcome.validationResults.find((item) => item.ruleId === "TKT-008" && item.ticketIds?.includes("ticket-1"))?.status).toBe("unknown");
    tickets[0] = { ...onlineTickets()[0], fieldAvailability: { onlineUrl: false } };
    outcome = validateEvent(event({ tickets }));
    expect(outcome.validationResults.find((item) => item.ruleId === "TKT-008" && item.ticketIds?.includes("ticket-1"))?.status).toBe("unknown");
  });

  it("does not pass the body/notice comparison when an operation ticket target cannot be determined", () => {
    const tickets = onlineTickets();
    tickets.push(ticket({
      name: "運営メンバー",
      price: 0,
      onlineEnabled: false,
      onlineUrl: null,
      organizerNotice: "19:50から受付を開始します。20:20までに",
      fieldAvailability: { onlineEnabled: false }
    }));
    const outcome = validateEvent(event({ name: "初心者読書会", tickets }));
    expect(outcome.validationResults.find((item) => item.ruleId === "AREA-001")?.status).toBe("unknown");
  });

  it("reports a known body/notice mismatch even when another operation target is uncertain", () => {
    const tickets = onlineTickets();
    tickets[0] = { ...tickets[0], organizerNotice: "19:55から受付を開始します。20:20までに" };
    tickets.push(ticket({
      name: "運営メンバー",
      price: 0,
      onlineEnabled: false,
      onlineUrl: null,
      organizerNotice: "19:50から受付を開始します。20:20までに",
      fieldAvailability: { onlineEnabled: false }
    }));
    const outcome = validateEvent(event({ name: "初心者読書会", tickets }));
    expect(outcome.validationResults.find((item) => item.ruleId === "AREA-001")?.status).toBe("failed");
  });

  it("reports a known empty notice even when another notice cannot be acquired", () => {
    const tickets = onlineTickets();
    tickets[0] = { ...tickets[0], organizerNotice: null };
    tickets[1] = { ...tickets[1], fieldAvailability: { organizerNotice: false } };
    const outcome = validateEvent(event({ tickets }));
    expect(outcome.validationResults.find((item) => item.ruleId === "SET-015")?.status).toBe("failed");
  });
});

describe("guest classification", () => {
  function guestOnline(): TicketInfo[] {
    return [
      ticket({ name: "ハイブリッド会員", price: 550, visibilityTags: ["ハイ"] }),
      ticket({ name: "地域会員", price: 1200, visibilityTags: ["オフ"] }),
      ticket({ name: "オンライン会員（今月1回目）", price: 550, visibilityTags: ["オン"] }),
      ticket({ name: "オンライン会員（今月2回目以降）", price: 1200, visibilityTags: ["オン"] }),
      ticket({ name: "非会員", price: 1500, visibilityTags: ["外"] })
    ];
  }

  it("uses guest only when every comparison ticket matches its guest rate", () => {
    expect(deriveEvent(normalizeEvent(event({ tickets: guestOnline() }))).attributes?.pricingScheme).toMatchObject({ state: "determined", value: "guest" });
    const oneWrong = guestOnline();
    oneWrong[0] = { ...oneWrong[0], price: 600 };
    expect(deriveEvent(normalizeEvent(event({ tickets: oneWrong }))).attributes?.pricingScheme).toMatchObject({ state: "determined", value: "normal" });
  });
});

describe("Slack transport", () => {
  class FakeTransport implements SlackTransport {
    readonly calls: string[] = [];
    constructor(private readonly responses: SlackPostResponse[]) {}
    async post(_channel: string, text: string): Promise<SlackPostResponse> {
      this.calls.push(text);
      return this.responses.shift() ?? { status: 200, ok: true };
    }
  }

  it.each([
    [429, "ratelimited"],
    [503, "service_unavailable"]
  ])("retries temporary Slack response %s", async (status, error) => {
    const fake = new FakeTransport([{ status, ok: false, error }, { status: 200, ok: true }]);
    const outcome = await sendSlackMessages(fake, "test-channel", [{ id: "1", text: "dry-run" }], { wait: async () => undefined });
    expect(outcome.status).toBe("sent");
    expect(fake.calls).toHaveLength(2);
  });

  it("does not retry a permanent Slack error and never calls a real service", async () => {
    const fake = new FakeTransport([{ status: 200, ok: false, error: "invalid_auth" }]);
    const outcome = await sendSlackMessages(fake, "test-channel", [{ id: "1", text: "dry-run" }], { wait: async () => undefined });
    expect(outcome.status).toBe("failed");
    expect(fake.calls).toHaveLength(1);
  });

  it("retries a network exception up to the configured attempt limit", async () => {
    let calls = 0;
    const transport: SlackTransport = {
      post: async () => {
        calls += 1;
        throw new Error("network unavailable");
      }
    };
    const outcome = await sendSlackMessages(transport, "test-channel", [{ id: "1", text: "dry-run" }], { maxAttempts: 3, wait: async () => undefined });
    expect(outcome).toMatchObject({ status: "failed", attempts: 3, reason: expect.stringContaining("network unavailable") });
    expect(calls).toBe(3);
  });

  it("splits long Slack bodies below the API safety limit", () => {
    const messages = buildSlackMessages(runSummary([displayContext("長文", "failed", "X".repeat(9000))]));
    expect(messages.length).toBeGreaterThan(1);
    expect(messages.every((message) => message.length <= 3900)).toBe(true);
    expect(messages.every((message, index) => message.startsWith(`【Slack ${index + 1}/${messages.length}】`))).toBe(true);
  });

  it("does not truncate more than twenty abnormal events", () => {
    const events = Array.from({ length: 25 }, (_, index) => displayContext(`不備イベント${index + 1}`, "failed", `不備${index + 1}`, index + 1));
    const text = buildSlackMessages(runSummary(events)).join("\n");
    expect(text).toContain("【NG 25】");
    expect(text).toContain("不備イベント25");
    expect(text).not.toContain("ほか5件");
  });

  it("does not truncate more than twenty UNKNOWN events", () => {
    const events = Array.from({ length: 22 }, (_, index) => displayContext(`判定不能イベント${index + 1}`, "unknown", `取得不能${index + 1}`, index + 1));
    const text = buildSlackMessages(runSummary(events)).join("\n");
    expect(text).toContain("【UNKNOWN 22】");
    expect(text).toContain("判定不能イベント22");
  });

  it("renders UNKNOWN and failed-and-unknown exactly once with traceable rule IDs", () => {
    const failedOutcome = validateEvent(event({ tickets: [], bodyText: undefined }));
    expect(failedOutcome.eventStatus).toBe("failed-and-unknown");
    const unknownContext = displayContext("判定不能", "unknown", "取得不能");
    const combinedContext = { ...failedOutcome.event, name: { state: "present" as const, value: "複合" } };
    const messages = buildSlackMessages(runSummary([unknownContext, combinedContext])).join("\n");
    expect(messages.match(/【UNKNOWN 1】/g)).toHaveLength(1);
    expect(messages.match(/【NG＋UNKNOWN 1】/g)).toHaveLength(1);
    expect(messages).toContain("[SET-014]");
    expect(messages).not.toContain("【NG 1】");
  });

  it("resumes a partial batch by sending only unsent message IDs", async () => {
    const fake = new FakeTransport([{ status: 200, ok: true, messageId: "3.000" }]);
    const messages = [{ id: "1", text: "first" }, { id: "2", text: "second" }, { id: "3", text: "third" }];
    const outcome = await sendSlackMessages(fake, "test-channel", messages, {
      previouslySentMessageIds: ["1", "2"],
      wait: async () => undefined
    });
    expect(fake.calls).toEqual(["third"]);
    expect(outcome).toMatchObject({ status: "sent", sentMessageIds: ["1", "2", "3"], unsentMessageIds: [], slackMessageIds: { "3": "3.000" } });
  });
});

describe("execution and persistence boundaries", () => {
  it("keeps the browser-side admin form extraction script syntactically valid", () => {
    expect(() => new Function(`return ${ADMIN_EVENT_FORM_EVALUATION_SCRIPT}`)).not.toThrow();
    expect(ADMIN_EVENT_FORM_EVALUATION_SCRIPT).toContain("/\\n\\s*\\n+/g");
  });

  it("extracts a representative OSIRO ticket DOM and distinguishes explicit zero from unavailable", async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <input id="title" value="テスト読書会">
        <input type="datetime-local" value="2026-08-22T20:30">
        <input type="datetime-local" value="2026-08-22T22:00">
        <textarea name="body">■参加費<br>非会員：1,100円</textarea>
        <div id="event_tickets">
          <input name="event_ticket_name" value="参加 ※今月1回目">
          <select><option selected>事前決済</option></select>
          <input placeholder="半角、コンマなし" value="800">
          <select><option selected>オン</option></select>
          <input id="is_online_1" type="checkbox" checked>
          <input placeholder="Zoom URL" value="https://zoom.example/room">
          <textarea placeholder="参加方法">20:25までに受付してください</textarea>
          <input name="event_ticket_name" value="参加2">
          <select><option selected>無料</option></select>
          <select><option selected>外</option></select>
          <input id="is_online_2" type="checkbox">
          <input placeholder="Zoom URL" value="">
          <textarea placeholder="参加方法"></textarea>
        </div>
      `);
      const populated = await extractEventFormDataWithTicketFallback(page);
      expect(populated.availability.tickets).toBe(true);
      expect(populated.tickets).toHaveLength(2);
      expect(populated.tickets[0]).toMatchObject({ name: "参加 ※今月1回目", price: 800, visibilityTags: ["オン"], onlineEnabled: true });
      expect(populated.tickets[1]).toMatchObject({ name: "参加2", price: 0, visibilityTags: ["外"], onlineEnabled: false });

      await page.setContent("<input id='title' value='0券'><div id='event_tickets'></div>");
      const zero = await extractEventFormDataWithTicketFallback(page);
      expect(zero).toMatchObject({ tickets: [], availability: expect.objectContaining({ tickets: true }) });

      await page.setContent("<input id='title' value='DOM欠落'>");
      const unavailable = await extractEventFormDataWithTicketFallback(page);
      expect(unavailable).toMatchObject({ tickets: [], availability: expect.objectContaining({ tickets: false }) });

      await page.setContent(`
        <input id="title" value="fallback">
        <section><label>チケット名<input value="fallback券"></label><label>金額<input value="1200"></label><label>販売対象者<select><option selected>外</option></select></label></section>
      `);
      const fallback = await extractEventFormDataWithTicketFallback(page);
      expect(fallback.availability.tickets).toBe(true);
      expect(fallback.tickets[0]).toMatchObject({ name: "fallback券", fieldAvailability: expect.objectContaining({ onlineUrl: false, organizerNotice: false }) });
    } finally {
      await page.close();
      await browser.close();
    }
  });

  it("collects multiple list pages, stops at the last page and deduplicates detail URLs", async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.route("http://osiro.test/**", async (route) => {
      const url = new URL(route.request().url());
      const second = url.searchParams.get("page") === "2";
      const html = second
        ? `<div id="eventIndex"><a href="/admin_events/b/edit">イベントB</a><a href="/admin_events/c/edit">イベントC</a></div>`
        : `<div id="eventIndex"><a href="/admin_events/a/edit">イベントA</a><a href="/admin_events/b/edit">イベントB</a><a href="/admin/events?page=2" rel="next">Next</a></div>`;
      await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html });
    });
    try {
      const items = await collectEventListWithPagination(page, "http://osiro.test/admin/events");
      expect(items.map((item) => item.detailUrl)).toEqual([
        "http://osiro.test/admin_events/a/edit",
        "http://osiro.test/admin_events/b/edit",
        "http://osiro.test/admin_events/c/edit"
      ]);
      expect(page.url()).toBe("http://osiro.test/admin/events?page=2");
    } finally {
      await page.close();
      await browser.close();
    }
  });

  it("rejects the final URL after a list request is redirected to the login page", () => {
    expect(() => assertAdminSessionIsValid("https://nekomachi-club.com/login")).toThrow("ログイン状態が期限切れ");
  });

  it("keeps execution, partial acquisition and notification failure as separate outcomes", () => {
    const partial = createRunOutcome(
      [{ stage: "list-acquisition", status: "completed" }, { stage: "detail-acquisition", status: "failed", eventId: "event-1", reason: "DOM unavailable" }],
      [],
      { status: "sent", plannedMessageIds: ["1"], sentMessageIds: ["1"], attempts: 1 }
    );
    expect(partial).toMatchObject({ executionStatus: "failed", acquisitionStatus: "partial", exitCode: 1, notification: { status: "sent" } });
    const notificationFailure = createRunOutcome(
      [{ stage: "list-acquisition", status: "completed" }],
      [],
      { status: "failed", plannedMessageIds: ["1"], sentMessageIds: [], attempts: 3, reason: "Slack failed" }
    );
    expect(notificationFailure).toMatchObject({ executionStatus: "failed", acquisitionStatus: "complete", exitCode: 1, notification: { status: "failed" } });
  });

  it("rejects missing Slack settings before acquisition", () => {
    expect(() => validateOperationalConfig({ slackBotToken: undefined, slackChannelId: "channel", headless: true })).toThrow("SLACK_BOT_TOKEN");
    expect(() => validateOperationalConfig({ slackBotToken: "token", slackChannelId: "", headless: true })).toThrow("SLACK_CHANNEL_ID");
    expect(() => validateOperationalConfig({ slackBotToken: undefined, slackChannelId: "", slackDryRun: true, headless: true })).not.toThrow();
  });

  it("builds Slack messages without sending in dry-run mode", () => {
    expect(createSlackDryRunOutcome(["message-1", "message-2"])).toEqual({
      status: "dry-run",
      plannedMessageIds: ["message-1", "message-2"],
      sentMessageIds: [],
      attempts: 0
    });
  });

  it("writes storage state through a validated temporary file", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "event-check-state-"));
    const target = path.join(directory, "state.json");
    try {
      await saveStorageStateAtomically({ storageState: async ({ path: output }) => { await fs.writeFile(output, JSON.stringify({ cookies: [] }), "utf8"); } }, target);
      expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ cookies: [] });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("does not replace a prior storage state when the new state is invalid", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "event-check-state-"));
    const target = path.join(directory, "state.json");
    await fs.writeFile(target, JSON.stringify({ cookies: ["old"] }), "utf8");
    try {
      await expect(saveStorageStateAtomically({ storageState: async ({ path: output }) => { await fs.writeFile(output, "not-json", "utf8"); } }, target)).rejects.toThrow("ログイン状態の保存に失敗");
      expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ cookies: ["old"] });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("replaces an existing valid storage state after validation", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "event-check-state-"));
    const target = path.join(directory, "state.json");
    await fs.writeFile(target, JSON.stringify({ cookies: ["old"] }), "utf8");
    try {
      await saveStorageStateAtomically({ storageState: async ({ path: output }) => { await fs.writeFile(output, JSON.stringify({ cookies: ["new"] }), "utf8"); } }, target);
      expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ cookies: ["new"] });
      expect((await fs.readdir(directory)).filter((name) => name.includes(".bak-") || name.includes(".tmp-"))).toEqual([]);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps a browser close failure as an execution error while continuing cleanup", async () => {
    let secondClosed = false;
    const errors = await closeResources([
      { label: "ページ", resource: { close: async () => { throw new Error("close failed"); } } },
      { label: "ブラウザ", resource: { close: async () => { secondClosed = true; } } }
    ]);
    expect(errors).toEqual(["ページ終了に失敗しました: close failed"]);
    expect(secondClosed).toBe(true);
  });
});
