import { describe, expect, it } from "vitest";
import {
  extractDeadlineTimeFromNotice,
  extractReceptionStartTimeFromBody,
  extractReceptionStartTimeFromNotice,
  isApplicationDeadlineWithinEventRange,
  isDeadlineFiveMinutesBeforeStart
} from "../src/utils/date.js";
import { normalizePriceText, normalizeTicketText, normalizeVisibilityTags } from "../src/utils/normalize.js";
import { normalizeOnlineUrl } from "../src/utils/url.js";
import { extractBookTitle, resolveEventBookTitle, validateTicketNameBookTitle } from "../src/utils/ticket.js";
import { validateEvent } from "../src/validation/engine.js";
import { buildFatalErrorMessage, buildSlackMessages, isRetryableSlackFailure } from "../src/slack.js";
import { sortEventsByStartAtDesc } from "../src/utils/sort.js";
import {
  assertAdminEventDetailPageState,
  assertAdminEventListPageState,
  assertAdminSessionIsValid,
  assertCollectedEventsExist,
  assertPageLimitNotExceeded,
  assertPaginationAdvanced,
  assertSuccessfulHttpResponse
} from "../src/osiro.js";
import { assertEventCountHasNotDroppedUnexpectedly } from "../src/check-state.js";
import type { EventInfo } from "../src/types.js";
import type { EventDisplayContext, EventStatus, ValidationResult } from "../src/domain/model.js";
import type { RunSummary } from "../src/results/model.js";
import { ALL_RATE_KEYS, allowedPrices, RATE_VISIBILITY, REQUIRED_RATE_KEYS } from "../src/domain/catalog.js";

function validationMessages(event: EventInfo): string[] {
  const outcome = validateEvent(event);
  return [
    ...outcome.validationResults.filter((item) => item.status === "failed").map((item) => item.message),
    ...outcome.validationResults.filter((item) => item.status === "unknown").map((item) => `[${item.ruleId}] 判定不能: ${item.reason ?? item.message}`),
    ...outcome.classificationDiagnostics.map((item) => `[${item.diagnosticId}] ${item.message}: ${item.reason}`)
  ];
}

function displayContext(name: string, status: EventStatus, message: string, startAt?: Date): EventDisplayContext {
  const eventId = name;
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
    detailUrl: "https://example.com",
    name: { state: "present", value: name },
    startAt: startAt ? { state: "present", value: startAt } : { state: "empty" },
    deliveryMode: "online",
    eligibilityStatus: "target",
    eligibilityReasons: [],
    eventStatus: status,
    validationResults: [validation],
    classificationDiagnostics: [],
    tickets: []
  };
}

function summary(events: EventDisplayContext[], executedAt: Date): RunSummary {
  return {
    targetLabel: "テスト",
    executionComplete: true,
    acquisitionComplete: true,
    checkedCount: events.length,
    excludedCount: 0,
    undeterminedCount: 0,
    okCount: events.filter((item) => item.eventStatus === "ok").length,
    ngCount: events.filter((item) => item.eventStatus === "failed").length,
    unknownCount: events.filter((item) => item.eventStatus === "unknown").length,
    failedAndUnknownCount: events.filter((item) => item.eventStatus === "failed-and-unknown").length,
    events,
    executedAt
  };
}

describe("admin session", () => {
  it("rejects a redirect to the login page", () => {
    expect(() => assertAdminSessionIsValid("https://nekomachi-club.com/login")).toThrow(
      "OSIROのログイン状態が期限切れです。npm run auth を実行してログイン状態を更新してください。"
    );
  });

  it("accepts an authenticated admin event list URL", () => {
    expect(() => assertAdminSessionIsValid("https://nekomachi-club.com/admin/events?state=yet_end")).not.toThrow();
  });

  it("rejects an event list page without the admin event index", () => {
    expect(() => assertAdminEventListPageState("https://nekomachi-club.com/admin/events?state=yet_end", false)).toThrow(
      "OSIROのイベント一覧画面を確認できませんでした。画面構造またはアクセス権限を確認してください。"
    );
  });

  it("rejects an empty collected event list", () => {
    expect(() => assertCollectedEventsExist([])).toThrow(
      "OSIROの募集中イベントを1件も取得できませんでした。一覧画面の読み込みまたは画面構造を確認してください。"
    );
  });

  it("accepts an explicit zero-ticket detail page but rejects a missing title field", () => {
    expect(() => assertAdminEventDetailPageState("https://nekomachi-club.com/admin_events/abc/edit", true)).not.toThrow();
    expect(() => assertAdminEventDetailPageState("https://nekomachi-club.com/admin_events/abc/edit", false)).toThrow(
      "OSIROのイベント詳細画面からタイトル欄を取得できませんでした。"
    );
  });

  it("rejects an unsuccessful or missing HTTP response", () => {
    expect(() => assertSuccessfulHttpResponse("https://nekomachi-club.com/admin/events", 500, false)).toThrow(
      "OSIROへのアクセスに失敗しました。HTTPステータス: 500"
    );
    expect(() => assertSuccessfulHttpResponse("https://nekomachi-club.com/admin/events", null, false)).toThrow(
      "OSIROへのアクセスに失敗しました。HTTPステータス: 取得不能"
    );
    expect(() => assertSuccessfulHttpResponse("https://user:secret@example.com/admin/events?token=secret#private", 500, false)).toThrow("https://example.com/admin/events");
    expect(() => assertSuccessfulHttpResponse("https://user:secret@example.com/admin/events?token=secret#private", 500, false)).not.toThrow(/secret|token|private/);
  });

  it("rejects pagination that does not advance or exceeds the page limit", () => {
    expect(() => assertPaginationAdvanced("https://example.com?page=1", "https://example.com?page=1")).toThrow("次ページへ移動できません");
    expect(() => assertPageLimitNotExceeded(20)).toThrow("20ページを超えた");
    expect(() => assertPaginationAdvanced("https://example.com?page=1", "https://example.com?page=2")).not.toThrow();
  });
});

describe("collection health", () => {
  it("rejects an event count below half of the previous successful run", () => {
    expect(() => assertEventCountHasNotDroppedUnexpectedly(36, 17)).toThrow(
      "OSIROのイベント取得件数が前回から急減しました。前回: 36件 / 今回: 17件"
    );
    expect(() => assertEventCountHasNotDroppedUnexpectedly(36, 18)).not.toThrow();
    expect(() => assertEventCountHasNotDroppedUnexpectedly(null, 1)).not.toThrow();
    expect(() => assertEventCountHasNotDroppedUnexpectedly(9, 1)).not.toThrow();
  });
});

describe("normalizers", () => {
  it("normalizes ticket text variants", () => {
    expect(normalizeTicketText("オンライン会員（二回目以降）")).toContain("2回目以降");
    expect(normalizeTicketText("地域会員　初回")).toContain("1回目");
  });

  it("parses prices", () => {
    expect(normalizePriceText("￥1,100円")).toBe(1100);
    expect(normalizePriceText("0")).toBe(0);
  });

  it("normalizes visibility tags", () => {
    expect(normalizeVisibilityTags(["オンライン会員", "オン"])).toEqual(["オン"]);
    expect(normalizeVisibilityTags(["地域会員"])).toEqual(["オフ"]);
    expect(normalizeVisibilityTags(["(1)【5月まで】ラウンジ会員（A○/U-22○/B○）"])).toEqual(["A", "B", "U-22"]);
  });

  it("normalizes url text", () => {
    expect(normalizeOnlineUrl(" https://example.com/\n　 ")).toBe("https://example.com/");
  });
});

describe("book title", () => {
  it("extracts bracketed titles", () => {
    expect(extractBookTitle("【オンライン】『存在と時間』読書会")).toBe("存在と時間");
    expect(extractBookTitle("括弧のない存在と時間読書会")).toBeNull();
    expect(resolveEventBookTitle("『存在』と『時間』を読む")).toEqual({ status: "ambiguous", candidates: ["存在", "時間"] });
  });

  it("validates event and ticket title match", () => {
    expect(validateTicketNameBookTitle("『存在と時間』読書会", "『存在と時間』オンライン会員 1回目")).toBeNull();
    expect(validateTicketNameBookTitle("『存在と時間』読書会", "オンライン参加 ※1回目")).toBeNull();
    expect(validateTicketNameBookTitle("『存在と時間』読書会", "猫町スクールに「読書会なし」でお申し込み済みの方")).toBeNull();
    expect(validateTicketNameBookTitle("『存在と時間』読書会", "『純粋理性批判』オンライン会員 1回目")).toContain("別の本");
    expect(validateTicketNameBookTitle("『存在と時間』読書会", "『存在と時間』『純粋理性批判』セット")).toContain("『純粋理性批判』");
  });
});

describe("canonical price and visibility catalog", () => {
  it("locks every normal price and required visibility to the TypeScript catalog", () => {
    expect(REQUIRED_RATE_KEYS.online).toEqual(["ON-HYBRID", "ON-LOCAL", "ON-ONLINE-1", "ON-ONLINE-2", "ON-NONMEMBER"]);
    expect(REQUIRED_RATE_KEYS.offline).toEqual(["OFF-LOCAL-1", "OFF-HYBRID-1", "OFF-LOCAL-2", "OFF-HYBRID-2", "OFF-ONLINE", "OFF-NONMEMBER"]);
    expect(Object.keys(RATE_VISIBILITY)).toEqual(ALL_RATE_KEYS);
    expect(Object.fromEntries(ALL_RATE_KEYS.map((key) => [key, allowedPrices(key, "normal")])))
      .toEqual({
        "ON-HYBRID": [0], "ON-LOCAL": [800], "ON-ONLINE-1": [0], "ON-ONLINE-2": [800], "ON-NONMEMBER": [1100], "ON-NONMEMBER-FIRST": [1100],
        "OFF-LOCAL-1": [0], "OFF-HYBRID-1": [0], "OFF-LOCAL-2": [1800], "OFF-HYBRID-2": [1800], "OFF-ONLINE": [1800], "OFF-NONMEMBER": [2300], "OFF-NONMEMBER-FIRST": [2300]
      });
  });
});

describe("deadline", () => {
  it("extracts deadline time", () => {
    expect(extractDeadlineTimeFromNotice("7/22 20：25までに参加してください")).toBe("20:25");
    expect(extractDeadlineTimeFromNotice("可能な限り18時25分までに受付を済ませてください")).toBe("18:25");
  });

  it("checks five minutes before start", () => {
    const startAt = new Date(2026, 6, 22, 20, 30);
    expect(isDeadlineFiveMinutesBeforeStart(startAt, "20:25までに")).toBe(true);
    expect(isDeadlineFiveMinutesBeforeStart(startAt, "20:30までに")).toBe(false);
  });

  it("checks application deadline date range", () => {
    const startAt = new Date(2026, 6, 22, 20, 30);
    expect(isApplicationDeadlineWithinEventRange(startAt, "申込締切：2026/07/19 23:59")).toBe(true);
    expect(isApplicationDeadlineWithinEventRange(startAt, "申込締切：7/22 12:00")).toBe(true);
    expect(isApplicationDeadlineWithinEventRange(startAt, "申込締切：2026/07/18 23:59")).toBe(false);
    expect(isApplicationDeadlineWithinEventRange(startAt, "申込締切：2026/07/23 00:00")).toBe(false);
  });

  it("extracts reception start time from body and organizer notice", () => {
    const startAt = new Date(2026, 6, 22, 20, 30);
    expect(extractReceptionStartTimeFromBody("■タイムテーブル 20:00 受付開始 20:30 読書会開始")).toBe("20:00");
    expect(extractReceptionStartTimeFromBody("■タイムテーブル 受付開始 20:00 読書会開始 20:30")).toBe("20:00");
    expect(extractReceptionStartTimeFromNotice("読書会スタート30分前から受付をオープンしております。20:25までに受付を済ませてください。", startAt)).toBe("20:00");
    expect(extractReceptionStartTimeFromNotice("20時から受付を開始します。20:25までに受付を済ませてください。", startAt)).toBe("20:00");
    expect(extractReceptionStartTimeFromNotice("受付開始：20時です。20:25までに受付を済ませてください。", startAt)).toBe("20:00");
  });
});

describe("slack output", () => {
  it("includes event start datetime in NG event names", () => {
    const messages = buildSlackMessages(summary([
      displayContext("テストイベント", "failed", "テストエラー", new Date("2026-07-01T20:30:00+09:00"))
    ], new Date("2026-06-25T00:00:00+09:00")));

    expect(messages.join("\n")).toContain("イベント名: テストイベント（開催日時: 2026-07-01 20:30）");
  });

  it("builds a Slack notification when the check terminates unexpectedly", () => {
    const message = buildFatalErrorMessage(
      new Error("OSIROのログイン状態が期限切れです"),
      new Date("2026-07-30T00:45:00+09:00")
    );

    expect(message).toContain("🚨 猫町イベントチェック実行失敗");
    expect(message).toContain("チェック処理が途中で終了しました。");
    expect(message).toContain("エラー: OSIROのログイン状態が期限切れです");
    expect(message).toContain("実行日時: 2026-07-30 00:45");
  });

  it("does not report all OK when an event is unknown", () => {
    const messages = buildSlackMessages(summary([
      displayContext("取得失敗イベント", "unknown", "詳細取得失敗")
    ], new Date("2026-07-30T00:45:00+09:00")));

    expect(messages.join("\n")).toContain("UNKNOWN: 1件");
    expect(messages.join("\n")).toContain("【UNKNOWN 1】");
    expect(messages.join("\n")).not.toContain("結果: すべてOK");
  });

  it("reports all OK only for a complete run with at least one checked event and no undetermined event", () => {
    const executedAt = new Date("2026-07-30T00:45:00+09:00");
    expect(buildSlackMessages(summary([], executedAt)).join("\n")).not.toContain("結果: すべてOK");

    const complete = summary([displayContext("正常イベント", "ok", "")], executedAt);
    expect(buildSlackMessages(complete).join("\n")).toContain("結果: すべてOK");
    expect(buildSlackMessages({ ...complete, executionComplete: false }).join("\n")).not.toContain("結果: すべてOK");
    expect(buildSlackMessages({ ...complete, acquisitionComplete: false }).join("\n")).not.toContain("結果: すべてOK");
    expect(buildSlackMessages({ ...complete, undeterminedCount: 1 }).join("\n")).not.toContain("結果: すべてOK");
  });

  it("retries temporary Slack failures but not permanent configuration errors", () => {
    expect(isRetryableSlackFailure(429, "ratelimited")).toBe(true);
    expect(isRetryableSlackFailure(503, "service_unavailable")).toBe(true);
    expect(isRetryableSlackFailure(200, "internal_error")).toBe(true);
    expect(isRetryableSlackFailure(200, "invalid_auth")).toBe(false);
  });
});

describe("result sorting", () => {
  it("sorts check results by event start datetime descending", () => {
    const sorted = sortEventsByStartAtDesc([
      displayContext("old", "ok", "", new Date("2026-07-01T10:00:00+09:00")),
      displayContext("unknown", "ok", ""),
      displayContext("new", "ok", "", new Date("2026-08-01T10:00:00+09:00"))
    ]);

    expect(sorted.map((result) => result.name.state === "present" ? result.name.value : "")).toEqual(["new", "old", "unknown"]);
  });
});

describe("event checks", () => {
  it("requires a single free online event to have an online-enabled ticket", () => {
    const event: EventInfo = {
      name: "無料イベント",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 6, 14, 20, 0),
      endAt: null,
      venue: null,
      tickets: [
        { name: "無料チケット", price: 0, visibility: "全員", visibilityTags: ["オン", "オフ", "ハイ", "外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    expect(validationMessages(event)).toContain("オンライン対象イベントですが、「オンライン開催する」がONのチケットがありません");
  });

  it("rejects an online event when none of its regular tickets are online-enabled", () => {
    const event: EventInfo = {
      name: "オンライン読書会",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 6, 31, 20, 0),
      endAt: null,
      venue: null,
      tickets: [
        { name: "オンライン会員 今月1回目", price: 0, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "非会員", price: 1100, visibility: null, visibilityTags: ["外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    expect(validationMessages(event)).toContain("オンライン対象イベントですが、「オンライン開催する」がONのチケットがありません");
  });

  it("does not require a single applied-person ticket to be free", () => {
    const event: EventInfo = {
      name: "申込済みイベント",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 6, 14, 20, 0),
      endAt: null,
      venue: null,
      tickets: [
        { name: "全回にお申し込み済みの方", price: 5000, visibility: "全員", visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    expect(validationMessages(event)).not.toContain("チケットが1つだけのイベントは無料である必要があります。実際: 5000円");
  });

  it("accepts offline reading and after-party ticket variants for the same plan", () => {
    const event: EventInfo = {
      name: "【東京】読書会",
      detailUrl: "https://example.com",
      startAt: null,
      endAt: null,
      venue: null,
      tickets: [
        { name: "読書会のみ参加 ※今月1回目", price: 0, visibility: null, visibilityTags: ["オフ"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "懇親会まで参加 ※今月1回目", price: 0, visibility: null, visibilityTags: ["オフ"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    expect(validationMessages(event)).not.toContain("チケット「地域会員 1回目」が複数存在します");
  });

  it("requires one reading and one after-party ticket for each offline member plan", () => {
    const event: EventInfo = {
      name: "【東京】読書会",
      detailUrl: "https://example.com",
      startAt: null,
      endAt: null,
      venue: null,
      tickets: [
        { name: "地域会員 読書会のみ参加 ※今月1回目", price: 0, visibility: null, visibilityTags: ["オフ"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "ハイブリッド会員 懇親会まで参加 ※今月1回目", price: 0, visibility: null, visibilityTags: ["ハイ"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "非会員 読書会のみ参加", price: 2300, visibility: null, visibilityTags: ["外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "非会員 懇親会まで参加", price: 2300, visibility: null, visibilityTags: ["外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    const errors = validationMessages(event);

    expect(errors.some((error) => error.includes("地域会員（今月1回目）") && error.includes("懇親会まで参加"))).toBe(true);
    expect(errors.some((error) => error.includes("ハイブリッド会員（今月1回目）") && error.includes("読書会のみ参加"))).toBe(true);
  });

  it("runs both online and offline checks for hybrid venue events", () => {
    const event: EventInfo = {
      name: "オフライン併用読書会",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 6, 14, 20, 0),
      endAt: null,
      venue: "オフ会場＋オンライン",
      tickets: [
        { name: "地域会員 読書会のみ参加 ※今月1回目", price: 0, visibility: null, visibilityTags: ["オフ"], onlineEnabled: true, onlineUrl: null, organizerNotice: "19:55までに参加してください" },
        { name: "地域会員 追加チケット ※今月1回目", price: 0, visibility: null, visibilityTags: ["オフ"], onlineEnabled: false, onlineUrl: null, organizerNotice: "19:55までに参加してください" },
        { name: "非会員 参加", price: 2300, visibility: null, visibilityTags: ["外"], onlineEnabled: false, onlineUrl: null, organizerNotice: "19:55までに参加してください" }
      ]
    };

    const errors = validationMessages(event);

    expect(errors.some((error) => error.includes("オンライン参加URLが空"))).toBe(true);
    expect(errors.some((error) => error.includes("イベント全体") && error.includes("懇親会まで参加"))).toBe(true);
  });

  it("accepts organizer notice reception start time matching the page body", () => {
    const notice = "読書会スタート30分前から受付をオープンしております。可能な限り20:25までに受付を済ませてください。";
    const event: EventInfo = {
      name: "全6回オンライン読書会",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 6, 22, 20, 30),
      endAt: null,
      venue: null,
      bodyText: "■タイムテーブル 20:00 受付開始 20:30 読書会開始",
      tickets: [
        { name: "全6回 オンライン会員", price: 5000, visibility: null, visibilityTags: ["オン"], onlineEnabled: true, onlineUrl: "https://zoom.example.com/a", organizerNotice: notice },
        { name: "全6回 地域会員", price: 5000, visibility: null, visibilityTags: ["オフ"], onlineEnabled: true, onlineUrl: "https://zoom.example.com/a", organizerNotice: notice },
        { name: "全6回 ハイブリッド会員", price: 5000, visibility: null, visibilityTags: ["ハイ"], onlineEnabled: true, onlineUrl: "https://zoom.example.com/a", organizerNotice: notice },
        { name: "全6回 非会員", price: 5000, visibility: null, visibilityTags: ["外"], onlineEnabled: true, onlineUrl: "https://zoom.example.com/a", organizerNotice: notice }
      ]
    };

    const errors = validationMessages(event);

    expect(errors.some((error) => error.includes("受付開始時刻がページ本文と一致していません"))).toBe(false);
  });

  it("rejects organizer notice reception start time different from the page body", () => {
    const notice = "19:45から受付を開始します。可能な限り20:25までに受付を済ませてください。";
    const event: EventInfo = {
      name: "全6回オンライン読書会",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 6, 22, 20, 30),
      endAt: null,
      venue: null,
      bodyText: "■タイムテーブル 20:00 受付開始 20:30 読書会開始",
      tickets: [
        { name: "全6回 オンライン会員", price: 5000, visibility: null, visibilityTags: ["オン"], onlineEnabled: true, onlineUrl: "https://zoom.example.com/a", organizerNotice: notice },
        { name: "全6回 地域会員", price: 5000, visibility: null, visibilityTags: ["オフ"], onlineEnabled: true, onlineUrl: "https://zoom.example.com/a", organizerNotice: notice },
        { name: "全6回 ハイブリッド会員", price: 5000, visibility: null, visibilityTags: ["ハイ"], onlineEnabled: true, onlineUrl: "https://zoom.example.com/a", organizerNotice: notice },
        { name: "全6回 非会員", price: 5000, visibility: null, visibilityTags: ["外"], onlineEnabled: true, onlineUrl: "https://zoom.example.com/a", organizerNotice: notice }
      ]
    };

    const errors = validationMessages(event);

    expect(errors.some((error) => error.includes("受付開始時刻がページ本文と一致していません") && error.includes("19:45"))).toBe(true);
    expect(errors.filter((error) => error.includes("受付開始時刻がページ本文と一致していません"))).toHaveLength(1);
  });

  it("accepts the required recurrence wording in the body fee section", () => {
    const event: EventInfo = {
      name: "無料イベント",
      detailUrl: "https://example.com",
      startAt: null,
      endAt: null,
      venue: null,
      bodyText: "■参加費 今月1回目 500円 今月2回目以降 1,000円",
      tickets: [
        { name: "無料チケット", price: 0, visibility: null, visibilityTags: [], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    const errors = validationMessages(event);

    expect(errors.some((error) => error.includes("ページ本文の参加費"))).toBe(false);
  });

  it("rejects bare recurrence wording in the body fee section", () => {
    const event: EventInfo = {
      name: "無料イベント",
      detailUrl: "https://example.com",
      startAt: null,
      endAt: null,
      venue: null,
      bodyText: "■参加費 1回目 500円 2回目以降 1,000円",
      tickets: [
        { name: "無料チケット", price: 0, visibility: null, visibilityTags: [], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    const errors = validationMessages(event);

    expect(errors).toContain("ページ本文の参加費の1回目表記を「今月1回目」にしてください");
    expect(errors).toContain("ページ本文の参加費の2回目以降表記を「今月2回目以降」にしてください");
  });

  it("skips body fee recurrence checks when first and second wording is absent", () => {
    const event: EventInfo = {
      name: "無料イベント",
      detailUrl: "https://example.com",
      startAt: null,
      endAt: null,
      venue: null,
      bodyText: "■参加費 会員 500円 非会員 1,000円",
      tickets: [
        { name: "無料チケット", price: 0, visibility: null, visibilityTags: [], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    const errors = validationMessages(event);

    expect(errors.some((error) => error.includes("ページ本文の参加費"))).toBe(false);
  });

  it("rejects duplicate offline participation types for the same member plan", () => {
    const event: EventInfo = {
      name: "【東京】読書会",
      detailUrl: "https://example.com",
      startAt: null,
      endAt: null,
      venue: null,
      tickets: [
        { name: "地域会員 読書会のみ参加 A ※今月1回目", price: 0, visibility: null, visibilityTags: ["オフ"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "地域会員 読書会のみ参加 B ※今月1回目", price: 0, visibility: null, visibilityTags: ["オフ"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "地域会員 懇親会まで参加 ※今月1回目", price: 0, visibility: null, visibilityTags: ["オフ"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "非会員 読書会のみ参加", price: 2300, visibility: null, visibilityTags: ["外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "非会員 懇親会まで参加", price: 2300, visibility: null, visibilityTags: ["外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    const errors = validationMessages(event);

    expect(errors.some((error) => error.includes("同一rateKey・参加形態・初参加区分") && error.includes("OFF-LOCAL-1"))).toBe(true);
    expect(errors.some((error) => error.includes("各rateKeyの参加形態はそろっています"))).toBe(false);
  });

  it("allows optional first-time offline non-member participation pairs", () => {
    const event: EventInfo = {
      name: "【東京】読書会",
      detailUrl: "https://example.com",
      startAt: null,
      endAt: null,
      venue: null,
      tickets: [
        { name: "非会員 読書会のみ参加", price: 2300, visibility: null, visibilityTags: ["外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "非会員 懇親会まで参加", price: 2300, visibility: null, visibilityTags: ["外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "非会員 初参加 読書会のみ参加", price: 2300, visibility: null, visibilityTags: ["外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "非会員 初参加 懇親会まで参加", price: 2300, visibility: null, visibilityTags: ["外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    const errors = validationMessages(event);

    expect(errors).not.toContain("チケット「非会員」が複数存在します");
    expect(errors.some((error) => error.includes("オフラインチケット「非会員"))).toBe(false);
  });

  it("accepts offline non-member tickets without first-time tickets", () => {
    const event: EventInfo = {
      name: "【東京】読書会",
      detailUrl: "https://example.com",
      startAt: null,
      endAt: null,
      venue: null,
      tickets: [
        { name: "非会員 読書会のみ参加", price: 2300, visibility: null, visibilityTags: ["外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "非会員 懇親会まで参加", price: 2300, visibility: null, visibilityTags: ["外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    const errors = validationMessages(event);

    expect(errors).not.toContain("チケット「非会員」が複数存在します");
    expect(errors.some((error) => error.includes("オフラインチケット「非会員"))).toBe(false);
  });

  it("detects missing first-time offline non-member participation tickets", () => {
    const event: EventInfo = {
      name: "【東京】読書会",
      detailUrl: "https://example.com",
      startAt: null,
      endAt: null,
      venue: null,
      tickets: [
        { name: "非会員 読書会のみ参加", price: 2300, visibility: null, visibilityTags: ["外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "非会員 懇親会まで参加", price: 2300, visibility: null, visibilityTags: ["外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "非会員 初参加 読書会のみ参加", price: 2300, visibility: null, visibilityTags: ["外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "地域会員 今月1回目 読書会のみ参加", price: 0, visibility: null, visibilityTags: ["オフ"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    const errors = validationMessages(event);

    expect(errors.some((error) => error.includes("非会員初参加") && error.includes("懇親会まで参加"))).toBe(true);
    expect(errors.some((error) => error.includes("同一rateKey・参加形態・初参加区分"))).toBe(false);
  });

  it("requires monthly wording for first and second tickets", () => {
    const event: EventInfo = {
      name: "オンライン読書会",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 6, 14, 20, 0),
      endAt: null,
      venue: null,
      tickets: [
        { name: "オンライン会員 1回目", price: 0, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "オンライン会員 2回目以降", price: 800, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "プラン変更後にお申し込み下さい。プラン変更前は参加ボタンは押さないでください。", price: 0, visibility: "旧会員", visibilityTags: ["A", "U-22", "B"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    const errors = validationMessages(event);

    expect(errors).toContain("[1番目] チケット「オンライン会員 1回目」: 1回目チケット名には「今月1回目」を入れてください");
    expect(errors).toContain("[2番目] チケット「オンライン会員 2回目以降」: 2回目以降チケット名には「今月2回目以降」を入れてください");
  });

  it("requires application deadline dates to be between three days before and the event date", () => {
    const event: EventInfo = {
      name: "オンライン読書会",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 6, 22, 20, 0),
      endAt: null,
      venue: null,
      applicationDeadlineEnabled: true,
      applicationDeadline: "申込締切：2026/07/18 23:59",
      tickets: [
        { name: "通常チケット 今月1回目", price: 0, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "プラン変更後にお申し込み下さい。プラン変更前は参加ボタンは押さないでください。", price: 0, visibility: "旧会員", visibilityTags: ["A", "U-22", "B"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    const errors = validationMessages(event);
    expect(errors.some((error) => error.includes("申込締切日は開催日の3日前から開催日までにしてください"))).toBe(true);
  });

  it("skips application deadline checks when deadline setting is off", () => {
    const event: EventInfo = {
      name: "オンライン読書会",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 6, 22, 20, 0),
      endAt: null,
      venue: null,
      applicationDeadlineEnabled: false,
      applicationDeadline: null,
      tickets: [
        { name: "通常チケット 今月1回目", price: 0, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "プラン変更後にお申し込み下さい。プラン変更前は参加ボタンは押さないでください。", price: 0, visibility: "旧会員", visibilityTags: ["A", "U-22", "B"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    const errors = validationMessages(event);
    expect(errors.some((error) => error.includes("申込締切日は"))).toBe(false);
  });

  it("does not misclassify unsupported old applied-person wording as already-applied", () => {
    const event: EventInfo = {
      name: "オンライン読書会",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 6, 14, 20, 0),
      endAt: null,
      venue: null,
      tickets: [
        { name: "通常チケット 今月1回目", price: 0, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "猫町スクールにお申し込みいただいた方 今月1回目", price: 0, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    const outcome = validateEvent(event);
    expect(outcome.derived.tickets[1].roles).toMatchObject({ state: "determined", value: expect.not.arrayContaining(["already-applied"]) });
  });

  it("ignores already-applied tickets in duplicate checks", () => {
    const event: EventInfo = {
      name: "オンライン読書会",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 6, 14, 20, 0),
      endAt: null,
      venue: null,
      tickets: [
        { name: "通常チケット 今月1回目", price: 0, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "猫町スクールにお申し込み済みの方 今月1回目", price: 0, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    expect(validationMessages(event)).not.toContain("チケット「オンライン会員 1回目」が複数存在します");
  });

  it("does not guess a price result from unsupported old applied-person wording", () => {
    const event: EventInfo = {
      name: "オンライン読書会",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 6, 14, 20, 0),
      endAt: null,
      venue: null,
      tickets: [
        { name: "猫町スクールにお申し込みいただいた方 今月1回目", price: 500, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "通常チケット 今月1回目", price: 0, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    const outcome = validateEvent(event);
    expect(outcome.validationResults.some((item) => item.ruleId === "TKT-006" && item.ticketIds?.includes("ticket-1") && item.status === "unknown")).toBe(true);
  });

  it("ignores already-applied tickets in price checks", () => {
    const event: EventInfo = {
      name: "オンライン読書会",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 6, 14, 20, 0),
      endAt: null,
      venue: null,
      tickets: [
        { name: "猫町スクールにお申し込み済みの方 今月1回目", price: 500, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "通常チケット 今月1回目", price: 0, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    expect(validationMessages(event).some((error) => error.includes("[1番目]") && error.includes("金額が期待値と異なります"))).toBe(false);
  });

  it("ignores all-session tickets in price checks", () => {
    const event: EventInfo = {
      name: "オンライン読書会",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 6, 14, 20, 0),
      endAt: null,
      venue: null,
      tickets: [
        { name: "全6回チケット 今月1回目", price: 5000, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "プラン変更後にお申し込み下さい。プラン変更前は参加ボタンは押さないでください。", price: 0, visibility: "旧会員", visibilityTags: ["A", "U-22", "B"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    expect(validationMessages(event).some((error) => error.includes("[1番目]") && error.includes("金額が期待値と異なります"))).toBe(false);
  });

  it("uses all-session online ticket requirements when every ticket is an all-session ticket", () => {
    const notice = "19:55までに参加してください";
    const event: EventInfo = {
      name: "オンライン全6回講座",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 6, 14, 20, 0),
      endAt: null,
      venue: null,
      tickets: [
        { name: "全6回 オンライン会員・ハイブリッド会員", price: 5000, visibility: null, visibilityTags: ["オン", "ハイ"], onlineEnabled: true, onlineUrl: "https://zoom.example.com/a", organizerNotice: notice },
        { name: "全6回 地域会員", price: 5000, visibility: null, visibilityTags: ["オフ"], onlineEnabled: true, onlineUrl: "https://zoom.example.com/a", organizerNotice: notice },
        { name: "全6回 非会員", price: 5000, visibility: null, visibilityTags: ["外"], onlineEnabled: true, onlineUrl: "https://zoom.example.com/a", organizerNotice: notice },
        { name: "🔰初参加 全6回 非会員", price: 5000, visibility: null, visibilityTags: ["外"], onlineEnabled: true, onlineUrl: "https://zoom.example.com/a", organizerNotice: notice }
      ]
    };

    const errors = validationMessages(event);
    expect(errors).toContain("プラン変更チケットを1件追加してください");
  });

  it("treats online events as all-session events when only the plan-change ticket is not all-session", () => {
    const notice = "19:55までに参加してください";
    const event: EventInfo = {
      name: "オンライン全6回講座",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 6, 14, 20, 0),
      endAt: null,
      venue: null,
      tickets: [
        { name: "全6回 オンライン会員・ハイブリッド会員", price: 5000, visibility: null, visibilityTags: ["オン", "ハイ"], onlineEnabled: false, onlineUrl: null, organizerNotice: notice },
        { name: "全6回 地域会員", price: 5000, visibility: null, visibilityTags: ["オフ"], onlineEnabled: false, onlineUrl: null, organizerNotice: notice },
        { name: "全6回 非会員", price: 5000, visibility: null, visibilityTags: ["外"], onlineEnabled: false, onlineUrl: null, organizerNotice: notice },
        { name: "🔰初参加 全6回 非会員", price: 5000, visibility: null, visibilityTags: ["外"], onlineEnabled: false, onlineUrl: null, organizerNotice: notice },
        { name: "プラン変更後にお申し込み下さい。プラン変更前は参加ボタンは押さないでください。", price: 0, visibility: "旧会員", visibilityTags: ["A", "U-22", "B"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    const errors = validationMessages(event);
    expect(errors.some((error) => error.includes("期待されるチケット"))).toBe(false);
    expect(errors.some((error) => error.includes("販売対象者が期待値と異なります"))).toBe(false);
  });

  it("requires every member plan once when every ticket is an all-session ticket", () => {
    const event: EventInfo = {
      name: "オンライン全6回講座",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 6, 14, 20, 0),
      endAt: null,
      venue: null,
      tickets: [
        { name: "全6回 オンライン会員", price: 5000, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "全6回 地域会員A", price: 5000, visibility: null, visibilityTags: ["オフ"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "全6回 地域会員B", price: 5000, visibility: null, visibilityTags: ["オフ"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "全6回 非会員", price: 5000, visibility: null, visibilityTags: ["外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    const errors = validationMessages(event);
    expect(errors.some((error) => error.includes("セット参加券の販売対象を修正") && error.includes("ハイ"))).toBe(true);
    expect(errors.some((error) => error.includes("重複") && error.includes("オフ"))).toBe(true);
    expect(errors.some((error) => error.includes("プラン変更チケットを1件追加"))).toBe(true);
  });

  it("treats all-applied-person events like fixed-fee events without regular plan checks", () => {
    const event: EventInfo = {
      name: "オンライン読書会",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 6, 14, 20, 0),
      endAt: null,
      venue: null,
      tickets: [
        { name: "大阪会場で全6回にお申し込み済みの方", price: 0, visibility: null, visibilityTags: ["オン", "オフ", "ハイ", "外", "A", "U-22", "B"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "オンラインで全6回にお申し込み済みの方", price: 0, visibility: null, visibilityTags: ["オン", "オフ", "ハイ", "外", "A", "U-22", "B"], onlineEnabled: true, onlineUrl: null, organizerNotice: null }
      ]
    };

    const errors = validationMessages(event);
    expect(errors.some((error) => error.includes("期待されるチケット"))).toBe(false);
    expect(errors.some((error) => error.includes("オンライン参加URLが空"))).toBe(false);
    expect(errors.some((error) => error.includes("金額が期待値と異なります"))).toBe(false);
  });

  it("requires a free operation member ticket for beginner events", () => {
    const event: EventInfo = {
      name: "【東京】ビギナー限定読書会",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 6, 14, 20, 0),
      endAt: null,
      venue: null,
      tickets: [
        { name: "通常チケット 今月1回目", price: 0, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    expect(validationMessages(event)).toContain("初心者読書会・初心者限定・ビギナー限定イベントには無料の「運営メンバー」チケットが必要です");
  });

  it("requires operation member tickets to be free", () => {
    const event: EventInfo = {
      name: "初心者読書会",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 6, 14, 20, 0),
      endAt: null,
      venue: null,
      tickets: [
        { name: "通常チケット 今月1回目", price: 0, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "運営メンバー", price: 500, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "プラン変更後にお申し込み下さい。プラン変更前は参加ボタンは押さないでください。", price: 0, visibility: "旧会員", visibilityTags: ["A", "U-22", "B"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    expect(validationMessages(event).some((error) => error.includes("運営メンバー") && error.includes("無料にしてください"))).toBe(true);
  });

  it("excludes operation member tickets from plan checks but checks online URL and notices", () => {
    const event: EventInfo = {
      name: "初心者読書会",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 6, 14, 20, 0),
      endAt: null,
      venue: null,
      tickets: [
        { name: "通常チケット 今月1回目", price: 0, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "運営メンバー", price: 0, visibility: null, visibilityTags: ["オン"], onlineEnabled: true, onlineUrl: null, organizerNotice: "別のお知らせ" },
        { name: "プラン変更後にお申し込み下さい。プラン変更前は参加ボタンは押さないでください。", price: 0, visibility: "旧会員", visibilityTags: ["A", "U-22", "B"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    const errors = validationMessages(event);
    expect(errors.some((error) => error.includes("期待ルールに一致しないチケット名") && error.includes("運営メンバー"))).toBe(false);
    expect(errors.some((error) => error.includes("運営メンバー") && error.includes("オンライン参加URLが空"))).toBe(true);
    expect(errors.some((error) => error.includes("主催者からのお知らせが空欄"))).toBe(true);
    expect(errors.some((error) => error.includes("運営メンバー") && error.includes("締切時刻が開始5分前ではありません"))).toBe(true);
  });

  it("requires fixed-fee two-ticket events to include a plan-change ticket", () => {
    const event: EventInfo = {
      name: "【名古屋】講座",
      detailUrl: "https://example.com",
      startAt: null,
      endAt: null,
      venue: null,
      tickets: [
        { name: "固定費チケット", price: 1800, visibility: "全員", visibilityTags: ["オン", "オフ", "ハイ", "外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "追加チケット", price: 0, visibility: "全員", visibilityTags: ["オン", "オフ", "ハイ", "外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    expect(validationMessages(event)).toContain("プラン変更チケットを1件追加してください");
  });

  it("classifies one comparison ticket as fixed-fee by BQ-02", () => {
    const event: EventInfo = {
      name: "【名古屋】講座",
      detailUrl: "https://example.com",
      startAt: null,
      endAt: null,
      venue: null,
      tickets: [
        { name: "固定費チケット", price: 1500, visibility: "全員", visibilityTags: ["オン", "オフ", "ハイ", "外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "プラン変更後にお申し込み下さい。プラン変更前は参加ボタンは押さないでください。", price: 0, visibility: "(1)【5月まで】ラウンジ会員", visibilityTags: ["A", "U-22", "B"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    expect(validateEvent(event).derived.attributes?.pricingMode).toMatchObject({ state: "determined", value: "fixed-fee" });
  });

  it("classifies differently priced comparison tickets as standard by the answered rule", () => {
    const event: EventInfo = {
      name: "【愛知】美術館鑑賞会",
      detailUrl: "https://example.com",
      startAt: null,
      endAt: null,
      venue: "美術館",
      tickets: [
        { name: "懇親感想会まで参加", price: 2800, visibility: "全員", visibilityTags: ["オン", "オフ", "ハイ", "外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "美術館鑑賞会のみ参加", price: 2300, visibility: "全員", visibilityTags: ["オン", "オフ", "ハイ", "外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "プラン変更後にお申し込み下さい。プラン変更前は参加ボタンは押さないでください。", price: 0, visibility: "旧会員", visibilityTags: ["A", "U-22", "B"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    const outcome = validateEvent(event);
    expect(outcome.derived.attributes?.pricingMode).toMatchObject({ state: "determined", value: "standard" });
    expect(outcome.validationResults.filter((item) => item.ruleId === "TKT-013").every((item) => item.status === "skipped")).toBe(true);
  });

  it("requires fixed-fee ticket to cover every member plan", () => {
    const event: EventInfo = {
      name: "【名古屋】講座",
      detailUrl: "https://example.com",
      startAt: null,
      endAt: null,
      venue: null,
      tickets: [
        { name: "固定費チケット", price: 1800, visibility: "一部会員", visibilityTags: ["オン", "オフ"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "固定費チケット2", price: 1800, visibility: "全員", visibilityTags: ["オン", "オフ", "ハイ", "外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "プラン変更後にお申し込み下さい。プラン変更前は参加ボタンは押さないでください。", price: 0, visibility: "(1)【5月まで】ラウンジ会員", visibilityTags: ["(1)【5月まで】ラウンジ会員"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    expect(validationMessages(event).some((error) => error.includes("固定料金チケットの販売対象に「ハイ」、「外」を追加してください"))).toBe(true);
  });

  it("does not compare a fixed-fee ticket price with the regular price set", () => {
    const event: EventInfo = {
      name: "【名古屋】講座",
      detailUrl: "https://example.com",
      startAt: null,
      endAt: null,
      venue: null,
      tickets: [
        { name: "固定費チケット", price: 1500, visibility: "全員", visibilityTags: ["オン", "オフ", "ハイ", "外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "プラン変更後にお申し込み下さい。プラン変更前は参加ボタンは押さないでください。", price: 0, visibility: "旧会員", visibilityTags: ["A", "U-22", "B"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    expect(validationMessages(event).some((error) => error.includes("固定費チケットの金額"))).toBe(false);
  });

  it("treats partial-series events as price-exempt but requires a plan-change ticket", () => {
    const notice = "19:55までに参加してください";
    const event: EventInfo = {
      name: "【全3回・著者レクチャー】オンライン講座 第二回",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 8, 16, 20, 0),
      endAt: null,
      venue: "Zoom",
      tickets: [
        { name: "全3回参加にお申し込み済の方", price: 0, visibility: null, visibilityTags: ["オン", "オフ", "ハイ", "外", "A", "U-22", "B"], onlineEnabled: true, onlineUrl: "https://previous.example.com", organizerNotice: "別のお知らせ" },
        { name: "第2回から参加", price: 5000, visibility: null, visibilityTags: ["外"], onlineEnabled: true, onlineUrl: "https://zoom.example.com/a", organizerNotice: notice },
        { name: "第2回から参加", price: 4000, visibility: null, visibilityTags: ["オフ"], onlineEnabled: true, onlineUrl: "https://zoom.example.com/a", organizerNotice: notice },
        { name: "第2回から参加", price: 3000, visibility: null, visibilityTags: ["オン", "ハイ"], onlineEnabled: true, onlineUrl: "https://zoom.example.com/a", organizerNotice: notice }
      ]
    };

    const errors = validationMessages(event);
    expect(errors.some((error) => error.includes("金額が期待値と異なります"))).toBe(false);
    expect(errors).toContain("プラン変更チケットを1件追加してください");
    expect(errors.some((error) => error.includes("オンライン参加URLが異なります"))).toBe(true);
    expect(errors.some((error) => error.includes("主催者からのお知らせが異なります"))).toBe(true);
  });

  it("reports legacy member tags per ticket", () => {
    const event: EventInfo = {
      name: "【東京】読書会",
      detailUrl: "https://example.com",
      startAt: null,
      endAt: null,
      venue: null,
      tickets: [
        { name: "読書会のみ参加 旧会員1", price: 1800, visibility: null, visibilityTags: ["A", "U-22", "B"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "読書会のみ参加 旧会員2", price: 1800, visibility: null, visibilityTags: ["A"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "懇親会まで参加 旧会員", price: 1800, visibility: null, visibilityTags: ["A"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "プラン変更後にお申し込み下さい。プラン変更前は参加ボタンは押さないでください。", price: 0, visibility: "(1)【5月まで】ラウンジ会員", visibilityTags: ["A"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    const outcome = validateEvent(event);
    expect(outcome.validationResults.filter((item) => item.ruleId === "TKT-016" && item.status === "failed")).toHaveLength(3);
    expect(outcome.validationResults.some((item) => item.ruleId === "CROSS-003")).toBe(false);
  });

  it("requires legacy member tags only on the plan-change ticket", () => {
    const event: EventInfo = {
      name: "【名古屋】講座",
      detailUrl: "https://example.com",
      startAt: null,
      endAt: null,
      venue: null,
      tickets: [
        { name: "固定費チケット", price: 1500, visibility: "旧会員混入", visibilityTags: ["オン", "オフ", "ハイ", "外", "A"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "プラン変更後にお申し込み下さい。プラン変更前は参加ボタンは押さないでください。", price: 0, visibility: "旧会員", visibilityTags: ["A", "U-22"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    const errors = validationMessages(event);
    expect(errors.some((error) => error.includes("販売対象から旧会員タグ（A）を外してください"))).toBe(true);
    expect(errors.some((error) => error.includes("プラン変更券の販売対象に「B」を追加してください"))).toBe(true);
  });

  it("recognizes plan switch wording as a legacy member ticket", () => {
    const event: EventInfo = {
      name: "オンライン読書会",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 6, 14, 20, 0),
      endAt: null,
      venue: null,
      tickets: [
        { name: "通常チケット 今月1回目", price: 0, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "プラン切り替え後にお申し込み下さい。（切り替え前は参加ボタンを押さないでください）", price: 0, visibility: "旧会員", visibilityTags: ["A", "U-22", "B"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    const errors = validationMessages(event);
    expect(errors.some((error) => error.includes("期待ルールに一致しないチケット名"))).toBe(false);
    expect(errors.some((error) => error.includes("プラン変更チケット名は"))).toBe(true);
  });

  it("uses guest offline prices for guest events", () => {
    const event: EventInfo = {
      name: "〖名古屋〗ゲストさんと読む『茶の本』",
      detailUrl: "https://example.com",
      startAt: null,
      endAt: null,
      venue: null,
      tickets: [
        { name: "読書会のみ参加", price: 3500, visibility: null, visibilityTags: ["外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "懇親会まで参加", price: 3500, visibility: null, visibilityTags: ["外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "読書会のみ参加（今月1回目）", price: 800, visibility: null, visibilityTags: ["オフ", "ハイ"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "懇親会まで参加（今月1回目）", price: 800, visibility: null, visibilityTags: ["オフ", "ハイ"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "読書会のみ参加（今月2回目以降）", price: 3000, visibility: null, visibilityTags: ["オフ", "ハイ"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "懇親会まで参加（今月2回目以降）", price: 3000, visibility: null, visibilityTags: ["オフ", "ハイ"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "読書会のみ参加", price: 3000, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "懇親会まで参加", price: 3000, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "プラン変更後にお申し込み下さい。プラン変更前は参加ボタンは押さないでください。", price: 0, visibility: "旧会員", visibilityTags: ["A", "U-22", "B"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    const errors = validationMessages(event);
    expect(errors.filter((error) => error.includes("金額が期待値と異なります"))).toEqual([]);
  });

  it("uses regular offline prices for Komai-san events", () => {
    const event: EventInfo = {
      name: "【東京】駒井稔さんと読む、村上春樹最新長編『夏帆 The Tale of KAHO』",
      detailUrl: "https://example.com",
      startAt: null,
      endAt: null,
      venue: null,
      tickets: [
        { name: "地域会員・ハイブリッド会員（今月1回目）", price: 0, visibility: null, visibilityTags: ["オフ", "ハイ"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "地域会員・ハイブリッド会員（今月2回目以降）", price: 1800, visibility: null, visibilityTags: ["オフ", "ハイ"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "オンライン会員", price: 1800, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "非会員", price: 2300, visibility: null, visibilityTags: ["外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    const errors = validationMessages(event);
    expect(errors.filter((error) => error.includes("金額が期待値と異なります"))).toEqual([]);
  });

  it("uses guest online prices for online guest events", () => {
    const notice = "19:55までに参加してください";
    const event: EventInfo = {
      name: "ゲストと読む『茶の本』オンライン読書会",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 6, 14, 20, 0),
      endAt: null,
      venue: null,
      tickets: [
        { name: "オンライン会員（今月1回目）", price: 550, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: notice },
        { name: "地域会員・オンライン会員（今月2回目以降）", price: 1200, visibility: null, visibilityTags: ["オフ", "オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: notice },
        { name: "ハイブリッド会員", price: 550, visibility: null, visibilityTags: ["ハイ"], onlineEnabled: false, onlineUrl: null, organizerNotice: notice },
        { name: "非会員", price: 1500, visibility: null, visibilityTags: ["外"], onlineEnabled: false, onlineUrl: null, organizerNotice: notice },
        { name: "プラン変更後にお申し込み下さい。プラン変更前は参加ボタンは押さないでください。", price: 0, visibility: "旧会員", visibilityTags: ["A", "U-22", "B"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    const errors = validationMessages(event);
    expect(errors.filter((error) => error.includes("金額が期待値と異なります"))).toEqual([]);
    expect(errors.filter((error) => error.includes("期待されるチケット"))).toEqual([]);
    expect(errors.filter((error) => error.includes("チケット名の会員名が閲覧権限と一致していません"))).toEqual([]);
    expect(errors.filter((error) => error.includes("チケット「地域会員」が複数存在します"))).toEqual([]);
  });

  it("accepts alternate guest offline prices", () => {
    const event: EventInfo = {
      name: "【福岡】ゲストさんと読む『茶の本』",
      detailUrl: "https://example.com",
      startAt: null,
      endAt: null,
      venue: null,
      tickets: [
        { name: "読書会のみ参加", price: 2800, visibility: null, visibilityTags: ["外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "懇親会まで参加", price: 2800, visibility: null, visibilityTags: ["外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "読書会のみ参加（今月1回目）", price: 500, visibility: null, visibilityTags: ["オフ", "ハイ"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "懇親会まで参加（今月1回目）", price: 500, visibility: null, visibilityTags: ["オフ", "ハイ"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "読書会のみ参加（今月2回目以降）", price: 2300, visibility: null, visibilityTags: ["オフ", "ハイ"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "懇親会まで参加（今月2回目以降）", price: 2300, visibility: null, visibilityTags: ["オフ", "ハイ"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "読書会のみ参加", price: 2300, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "懇親会まで参加", price: 2300, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "プラン変更後にお申し込み下さい。プラン変更前は参加ボタンは押さないでください。", price: 0, visibility: "旧会員", visibilityTags: ["A", "U-22", "B"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    const errors = validationMessages(event);
    expect(errors.filter((error) => error.includes("金額が期待値と異なります"))).toEqual([]);
  });
});
