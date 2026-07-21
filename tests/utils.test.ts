import { describe, expect, it } from "vitest";
import { classifyEventByName } from "../src/utils/classify.js";
import { extractDeadlineTimeFromNotice, isApplicationDeadlineWithinEventRange, isDeadlineFiveMinutesBeforeStart } from "../src/utils/date.js";
import { normalizePriceText, normalizeTicketText, normalizeVisibilityTags } from "../src/utils/normalize.js";
import { normalizeOnlineUrl } from "../src/utils/url.js";
import { classifyTicketRulesByInfo, extractBookTitle, validateTicketNameBookTitle, validateTicketNameMemberLabel } from "../src/utils/ticket.js";
import { checkEventInfo } from "../src/checker.js";
import { buildSlackMessages } from "../src/slack.js";
import { sortResultsByStartAtDesc } from "../src/utils/sort.js";
import type { CheckResult, EventInfo, RulesConfig, TicketInfo, TicketRule } from "../src/types.js";

describe("event classification", () => {
  it("normalizes bracket variants and classifies events", () => {
    expect(classifyEventByName("〖東京〗『存在と時間』読書会")).toBe("offline");
    expect(classifyEventByName("〖予告〗『存在と時間』読書会")).toBe("skip");
    expect(classifyEventByName("U35で読む 村田沙耶香『コンビニ人間』｜U35 BOOK CLUB 東京開催")).toBe("offline");
    expect(classifyEventByName("【福岡 第一回】ゲストと読む『存在と時間』")).toBe("offline");
    expect(classifyEventByName("事務局決済")).toBe("skip");
    expect(classifyEventByName("『存在と時間』読書会")).toBe("online");
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
  });

  it("validates event and ticket title match", () => {
    expect(validateTicketNameBookTitle("『存在と時間』読書会", "『存在と時間』オンライン会員 1回目")).toBeNull();
    expect(validateTicketNameBookTitle("『存在と時間』読書会", "オンライン参加 ※1回目")).toBeNull();
    expect(validateTicketNameBookTitle("『存在と時間』読書会", "猫町スクールに「読書会なし」でお申し込み済みの方")).toBeNull();
    expect(validateTicketNameBookTitle("『存在と時間』読書会", "『純粋理性批判』オンライン会員 1回目")).toContain("別の本");
  });
});

describe("ticket classification", () => {
  const rules: TicketRule[] = [
    { id: "online_member_first", name: "オンライン会員", note: "1回目", price: 0, visibilityTags: ["オン"] },
    { id: "local_member", name: "地域会員", price: 800, visibilityTags: ["オフ"] },
    { id: "online_member_second", name: "オンライン会員", note: "2回目以降", price: 800, visibilityTags: ["オン"] },
    { id: "hybrid_member", name: "ハイブリッド会員", price: 0, visibilityTags: ["ハイ"] },
    { id: "non_member", name: "非会員", price: 1100, visibilityTags: ["外"] }
  ];

  function ticket(name: string, price: number, visibilityTags: string[]): TicketInfo {
    return { name, price, visibility: null, visibilityTags, onlineEnabled: true, onlineUrl: null, organizerNotice: null };
  }

  it("uses visibility and price when ticket names omit member labels", () => {
    expect(classifyTicketRulesByInfo(ticket("神谷 美恵子『生きがいについて』（1回目）", 0, ["オン"]), rules).map((rule) => rule.id)).toEqual(["online_member_first"]);
    expect(classifyTicketRulesByInfo(ticket("神谷 美恵子『生きがいについて』（2回目）", 800, ["オン"]), rules).map((rule) => rule.id)).toEqual(["online_member_second"]);
    expect(classifyTicketRulesByInfo(ticket("神谷 美恵子『生きがいについて』", 800, ["オフ"]), rules).map((rule) => rule.id)).toEqual(["local_member"]);
    expect(classifyTicketRulesByInfo(ticket("神谷 美恵子『生きがいについて』", 0, ["ハイ"]), rules).map((rule) => rule.id)).toEqual(["hybrid_member"]);
    expect(classifyTicketRulesByInfo(ticket("神谷 美恵子『生きがいについて』", 1100, ["外"]), rules).map((rule) => rule.id)).toEqual(["non_member"]);
  });

  it("allows one ticket to belong to multiple member plans", () => {
    expect(classifyTicketRulesByInfo(ticket("二村ヒトシと読む精神分析入門 第二回", 1100, ["オフ", "外"]), rules).map((rule) => rule.id)).toEqual([
      "local_member",
      "non_member"
    ]);
  });

  it("detects member labels that conflict with visibility-derived rule", () => {
    expect(validateTicketNameMemberLabel(rules[1], "オンライン会員向けチケット")).toContain("一致していません");
    expect(validateTicketNameMemberLabel(rules[1], "オンライン参加")).toBeNull();
    expect(validateTicketNameMemberLabel(rules[1], "地域会員向けチケット")).toBeNull();
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
});

describe("slack output", () => {
  it("includes event start datetime in NG event names", () => {
    const messages = buildSlackMessages({
      targetLabel: "テスト",
      checkedCount: 1,
      skippedCount: 0,
      okCount: 0,
      ngCount: 1,
      executedAt: new Date("2026-06-25T00:00:00+09:00"),
      results: [
        {
          eventName: "テストイベント",
          kind: "online",
          detailUrl: "https://example.com",
          startAt: new Date("2026-07-01T20:30:00+09:00"),
          ok: false,
          errors: ["テストエラー"]
        }
      ]
    });

    expect(messages.join("\n")).toContain("イベント名: テストイベント（開催日時: 2026-07-01 20:30）");
  });
});

describe("result sorting", () => {
  it("sorts check results by event start datetime descending", () => {
    const base: Omit<CheckResult, "eventName" | "startAt"> = {
      kind: "online",
      detailUrl: "https://example.com",
      ok: true,
      errors: []
    };
    const sorted = sortResultsByStartAtDesc([
      { ...base, eventName: "old", startAt: new Date("2026-07-01T10:00:00+09:00") },
      { ...base, eventName: "unknown", startAt: null },
      { ...base, eventName: "new", startAt: new Date("2026-08-01T10:00:00+09:00") }
    ]);

    expect(sorted.map((result) => result.eventName)).toEqual(["new", "old", "unknown"]);
  });
});

describe("event checks", () => {
  const rulesConfig: RulesConfig = {
    online: {
      matchMode: "contains",
      tickets: [
        { id: "online_member_first", name: "オンライン会員", note: "1回目", price: 0, visibilityTags: ["オン"] }
      ]
    },
    offline: {
      matchMode: "contains",
      tickets: [
        { id: "local_member_first", name: "地域会員", note: "1回目", price: 0, visibilityTags: ["オフ"] }
      ]
    }
  };

  it("accepts a single free ticket without regular online ticket requirements", () => {
    const event: EventInfo = {
      name: "無料イベント",
      kind: "online",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 6, 14, 20, 0),
      endAt: null,
      venue: null,
      tickets: [
        { name: "無料チケット", price: 0, visibility: "全員", visibilityTags: ["オン", "オフ", "ハイ", "外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    expect(checkEventInfo(event, rulesConfig).ok).toBe(true);
  });

  it("does not require a single applied-person ticket to be free", () => {
    const event: EventInfo = {
      name: "申込済みイベント",
      kind: "online",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 6, 14, 20, 0),
      endAt: null,
      venue: null,
      tickets: [
        { name: "全回にお申し込み済みの方", price: 5000, visibility: "全員", visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    expect(checkEventInfo(event, rulesConfig).errors).not.toContain("チケットが1つだけのイベントは無料である必要があります。実際: 5000円");
  });

  it("accepts offline reading and after-party ticket variants for the same plan", () => {
    const event: EventInfo = {
      name: "【東京】読書会",
      kind: "offline",
      detailUrl: "https://example.com",
      startAt: null,
      endAt: null,
      venue: null,
      tickets: [
        { name: "読書会のみ参加 ※今月1回目", price: 0, visibility: null, visibilityTags: ["オフ"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "懇親会まで参加 ※今月1回目", price: 0, visibility: null, visibilityTags: ["オフ"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    expect(checkEventInfo(event, rulesConfig).errors).not.toContain("チケット「地域会員 1回目」が複数存在します");
  });

  it("requires one reading and one after-party ticket for each offline member plan", () => {
    const event: EventInfo = {
      name: "【東京】読書会",
      kind: "offline",
      detailUrl: "https://example.com",
      startAt: null,
      endAt: null,
      venue: null,
      tickets: [
        { name: "読書会のみ参加 ※今月1回目", price: 0, visibility: null, visibilityTags: ["オフ"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "懇親会まで参加 ※今月1回目", price: 0, visibility: null, visibilityTags: ["ハイ"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    const errors = checkEventInfo(event, {
      online: rulesConfig.online,
      offline: {
        matchMode: "contains",
        tickets: [
          { id: "local_member_first", name: "地域会員", note: "1回目", price: 0, visibilityTags: ["オフ"] },
          { id: "hybrid_member_first", name: "ハイブリッド会員", note: "1回目", price: 0, visibilityTags: ["ハイ"] }
        ]
      }
    }).errors;

    expect(errors).toContain("オフラインチケット「地域会員 1回目」は「読書会のみ参加」と「懇親会まで参加」が1つずつ必要です。実際: 読書会のみ参加 1件 / 懇親会まで参加 0件 / 参加種別不明 0件");
    expect(errors).toContain("オフラインチケット「ハイブリッド会員 1回目」は「読書会のみ参加」と「懇親会まで参加」が1つずつ必要です。実際: 読書会のみ参加 0件 / 懇親会まで参加 1件 / 参加種別不明 0件");
  });

  it("runs both online and offline checks for hybrid venue events", () => {
    const event: EventInfo = {
      name: "オフライン併用読書会",
      kind: "hybrid",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 6, 14, 20, 0),
      endAt: null,
      venue: "オフ会場＋オンライン",
      tickets: [
        { name: "読書会のみ参加 ※今月1回目", price: 0, visibility: null, visibilityTags: ["オフ"], onlineEnabled: true, onlineUrl: null, organizerNotice: "19:55までに参加してください" },
        { name: "追加チケット ※今月1回目", price: 0, visibility: null, visibilityTags: ["オフ"], onlineEnabled: false, onlineUrl: null, organizerNotice: "19:55までに参加してください" }
      ]
    };

    const errors = checkEventInfo(event, rulesConfig).errors;

    expect(errors.some((error) => error.includes("オンライン参加URLが空"))).toBe(true);
    expect(errors).toContain("オフライン読書会には「懇親会まで参加」チケットが必要です");
  });

  it("rejects duplicate offline participation types for the same member plan", () => {
    const event: EventInfo = {
      name: "【東京】読書会",
      kind: "offline",
      detailUrl: "https://example.com",
      startAt: null,
      endAt: null,
      venue: null,
      tickets: [
        { name: "読書会のみ参加 A ※今月1回目", price: 0, visibility: null, visibilityTags: ["オフ"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "読書会のみ参加 B ※今月1回目", price: 0, visibility: null, visibilityTags: ["オフ"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "懇親会まで参加 ※今月1回目", price: 0, visibility: null, visibilityTags: ["オフ"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    const errors = checkEventInfo(event, rulesConfig).errors;

    expect(errors).toContain("オフラインチケット「地域会員 1回目」は「読書会のみ参加」と「懇親会まで参加」が1つずつ必要です。実際: 読書会のみ参加 2件 / 懇親会まで参加 1件 / 参加種別不明 0件");
    expect(errors).toContain("チケット「地域会員 1回目」が複数存在します");
  });

  it("allows optional first-time offline non-member participation pairs", () => {
    const event: EventInfo = {
      name: "【東京】読書会",
      kind: "offline",
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

    const errors = checkEventInfo(event, {
      online: rulesConfig.online,
      offline: {
        matchMode: "contains",
        tickets: [
          { id: "non_member", name: "非会員", price: 2300, visibilityTags: ["外"] }
        ]
      }
    }).errors;

    expect(errors).not.toContain("チケット「非会員」が複数存在します");
    expect(errors.some((error) => error.includes("オフラインチケット「非会員"))).toBe(false);
  });

  it("accepts offline non-member tickets without first-time tickets", () => {
    const event: EventInfo = {
      name: "【東京】読書会",
      kind: "offline",
      detailUrl: "https://example.com",
      startAt: null,
      endAt: null,
      venue: null,
      tickets: [
        { name: "非会員 読書会のみ参加", price: 2300, visibility: null, visibilityTags: ["外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "非会員 懇親会まで参加", price: 2300, visibility: null, visibilityTags: ["外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    const errors = checkEventInfo(event, {
      online: rulesConfig.online,
      offline: {
        matchMode: "contains",
        tickets: [
          { id: "non_member", name: "非会員", price: 2300, visibilityTags: ["外"] }
        ]
      }
    }).errors;

    expect(errors).not.toContain("チケット「非会員」が複数存在します");
    expect(errors.some((error) => error.includes("オフラインチケット「非会員"))).toBe(false);
  });

  it("detects missing first-time offline non-member participation tickets", () => {
    const event: EventInfo = {
      name: "【東京】読書会",
      kind: "offline",
      detailUrl: "https://example.com",
      startAt: null,
      endAt: null,
      venue: null,
      tickets: [
        { name: "非会員 読書会のみ参加", price: 2300, visibility: null, visibilityTags: ["外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "非会員 懇親会まで参加", price: 2300, visibility: null, visibilityTags: ["外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "非会員 初参加 読書会のみ参加", price: 2300, visibility: null, visibilityTags: ["外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    const errors = checkEventInfo(event, {
      online: rulesConfig.online,
      offline: {
        matchMode: "contains",
        tickets: [
          { id: "non_member", name: "非会員", price: 2300, visibilityTags: ["外"] }
        ]
      }
    }).errors;

    expect(errors).toContain("オフラインチケット「非会員 初参加」は「読書会のみ参加」と「懇親会まで参加」が1つずつ必要です。実際: 読書会のみ参加 1件 / 懇親会まで参加 0件 / 参加種別不明 0件");
    expect(errors).toContain("チケット「非会員」が複数存在します");
  });

  it("requires monthly wording for first and second tickets", () => {
    const event: EventInfo = {
      name: "オンライン読書会",
      kind: "online",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 6, 14, 20, 0),
      endAt: null,
      venue: null,
      tickets: [
        { name: "通常チケット 1回目", price: 0, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "通常チケット 2回目", price: 800, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "プラン変更後にお申し込み下さい。プラン変更前は参加ボタンは押さないでください。", price: 0, visibility: "旧会員", visibilityTags: ["A", "U-22", "B"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    const errors = checkEventInfo(event, {
      online: {
        matchMode: "contains",
        tickets: [
          { id: "online_member_first", name: "オンライン会員", note: "1回目", price: 0, visibilityTags: ["オン"] },
          { id: "online_member_second", name: "オンライン会員", note: "2回目以降", price: 800, visibilityTags: ["オン"] }
        ]
      },
      offline: rulesConfig.offline
    }).errors;

    expect(errors).toContain("[1番目] チケット「オンライン会員 1回目」: 1回目チケット名には「今月1回目」を入れてください");
    expect(errors).toContain("[2番目] チケット「オンライン会員 2回目以降」: 2回目以降チケット名には「今月2回目以降」を入れてください");
  });

  it("requires application deadline dates to be between three days before and the event date", () => {
    const event: EventInfo = {
      name: "オンライン読書会",
      kind: "online",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 6, 22, 20, 0),
      endAt: null,
      venue: null,
      applicationDeadline: "申込締切：2026/07/18 23:59",
      tickets: [
        { name: "通常チケット 今月1回目", price: 0, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "プラン変更後にお申し込み下さい。プラン変更前は参加ボタンは押さないでください。", price: 0, visibility: "旧会員", visibilityTags: ["A", "U-22", "B"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    const errors = checkEventInfo(event, rulesConfig).errors;
    expect(errors).toContain("申込締切日は開催日の3日前から開催日までにしてください。期待: 2026/07/19〜2026/07/22 / 実際: 申込締切：2026/07/18 23:59");
  });

  it("skips application deadline checks when deadline setting is off", () => {
    const event: EventInfo = {
      name: "オンライン読書会",
      kind: "online",
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

    const errors = checkEventInfo(event, rulesConfig).errors;
    expect(errors.some((error) => error.includes("申込締切日は"))).toBe(false);
  });

  it("requires applied-person ticket names to use the unified wording", () => {
    const event: EventInfo = {
      name: "オンライン読書会",
      kind: "online",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 6, 14, 20, 0),
      endAt: null,
      venue: null,
      tickets: [
        { name: "通常チケット 今月1回目", price: 0, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "猫町スクールにお申し込みいただいた方 今月1回目", price: 0, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    expect(checkEventInfo(event, rulesConfig).errors.some((error) => error.includes("特殊申込済みチケット名は「お申し込み済みの方」に統一してください"))).toBe(true);
  });

  it("ignores already-applied tickets in duplicate checks", () => {
    const event: EventInfo = {
      name: "オンライン読書会",
      kind: "online",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 6, 14, 20, 0),
      endAt: null,
      venue: null,
      tickets: [
        { name: "通常チケット 今月1回目", price: 0, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "猫町スクールにお申し込み済みの方 今月1回目", price: 0, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    expect(checkEventInfo(event, rulesConfig).errors).not.toContain("チケット「オンライン会員 1回目」が複数存在します");
  });

  it("does not ignore old applied-person wording in price checks", () => {
    const event: EventInfo = {
      name: "オンライン読書会",
      kind: "online",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 6, 14, 20, 0),
      endAt: null,
      venue: null,
      tickets: [
        { name: "猫町スクールにお申し込みいただいた方 今月1回目", price: 500, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "通常チケット 今月1回目", price: 0, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    expect(checkEventInfo(event, rulesConfig).errors.some((error) => error.includes("[1番目]") && error.includes("金額が期待値と異なります"))).toBe(true);
  });

  it("ignores already-applied tickets in price checks", () => {
    const event: EventInfo = {
      name: "オンライン読書会",
      kind: "online",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 6, 14, 20, 0),
      endAt: null,
      venue: null,
      tickets: [
        { name: "猫町スクールにお申し込み済みの方 今月1回目", price: 500, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "通常チケット 今月1回目", price: 0, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    expect(checkEventInfo(event, rulesConfig).errors.some((error) => error.includes("[1番目]") && error.includes("金額が期待値と異なります"))).toBe(false);
  });

  it("ignores all-session tickets in price checks", () => {
    const event: EventInfo = {
      name: "オンライン読書会",
      kind: "online",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 6, 14, 20, 0),
      endAt: null,
      venue: null,
      tickets: [
        { name: "全6回チケット 今月1回目", price: 5000, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "プラン変更後にお申し込み下さい。プラン変更前は参加ボタンは押さないでください。", price: 0, visibility: "旧会員", visibilityTags: ["A", "U-22", "B"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    expect(checkEventInfo(event, rulesConfig).errors.some((error) => error.includes("[1番目]") && error.includes("金額が期待値と異なります"))).toBe(false);
  });

  it("uses all-session online ticket requirements when every ticket is an all-session ticket", () => {
    const notice = "19:55までに参加してください";
    const event: EventInfo = {
      name: "オンライン全6回講座",
      kind: "online",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 6, 14, 20, 0),
      endAt: null,
      venue: null,
      tickets: [
        { name: "全6回 オンライン会員・ハイブリッド会員", price: 5000, visibility: null, visibilityTags: ["オン", "ハイ"], onlineEnabled: false, onlineUrl: null, organizerNotice: notice },
        { name: "全6回 地域会員", price: 5000, visibility: null, visibilityTags: ["オフ"], onlineEnabled: false, onlineUrl: null, organizerNotice: notice },
        { name: "全6回 非会員", price: 5000, visibility: null, visibilityTags: ["外"], onlineEnabled: false, onlineUrl: null, organizerNotice: notice },
        { name: "🔰初参加 全6回 非会員", price: 5000, visibility: null, visibilityTags: ["外"], onlineEnabled: false, onlineUrl: null, organizerNotice: notice }
      ]
    };

    const errors = checkEventInfo(event, rulesConfig).errors;
    expect(errors).toEqual([]);
  });

  it("treats online events as all-session events when only the plan-change ticket is not all-session", () => {
    const notice = "19:55までに参加してください";
    const event: EventInfo = {
      name: "オンライン全6回講座",
      kind: "online",
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

    const errors = checkEventInfo(event, rulesConfig).errors;
    expect(errors.some((error) => error.includes("期待されるチケット"))).toBe(false);
    expect(errors.some((error) => error.includes("販売対象者が期待値と異なります"))).toBe(false);
  });

  it("requires every member plan once when every ticket is an all-session ticket", () => {
    const event: EventInfo = {
      name: "オンライン全6回講座",
      kind: "online",
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

    const errors = checkEventInfo(event, rulesConfig).errors;
    expect(errors).toContain("全N回チケットには「ハイブリッド会員」のチケットが1つ必要です");
    expect(errors.some((error) => error.includes("全N回チケット「地域会員」が複数存在します"))).toBe(true);
    expect(errors.some((error) => error.includes("期待されるチケット"))).toBe(false);
    expect(errors.some((error) => error.includes("プラン変更後にお申し込み下さい"))).toBe(false);
  });

  it("treats all-applied-person events like fixed-fee events without regular plan checks", () => {
    const event: EventInfo = {
      name: "オンライン読書会",
      kind: "online",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 6, 14, 20, 0),
      endAt: null,
      venue: null,
      tickets: [
        { name: "大阪会場で全6回にお申し込み済みの方", price: 0, visibility: null, visibilityTags: ["オン", "オフ", "ハイ", "外", "A", "U-22", "B"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "オンラインで全6回にお申し込み済みの方", price: 0, visibility: null, visibilityTags: ["オン", "オフ", "ハイ", "外", "A", "U-22", "B"], onlineEnabled: true, onlineUrl: null, organizerNotice: null }
      ]
    };

    const errors = checkEventInfo(event, rulesConfig).errors;
    expect(errors.some((error) => error.includes("期待されるチケット"))).toBe(false);
    expect(errors.some((error) => error.includes("オンライン参加URLが空"))).toBe(false);
    expect(errors.some((error) => error.includes("金額が期待値と異なります"))).toBe(false);
  });

  it("requires a free operation member ticket for beginner events", () => {
    const event: EventInfo = {
      name: "【東京】ビギナー限定読書会",
      kind: "online",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 6, 14, 20, 0),
      endAt: null,
      venue: null,
      tickets: [
        { name: "通常チケット 今月1回目", price: 0, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    expect(checkEventInfo(event, rulesConfig).errors).toContain("初心者読書会・ビギナー限定イベントには無料の「運営メンバー」チケットが必要です");
  });

  it("requires operation member tickets to be free", () => {
    const event: EventInfo = {
      name: "初心者読書会",
      kind: "online",
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

    expect(checkEventInfo(event, rulesConfig).errors).toContain("[2番目] 「運営メンバー」チケットは無料である必要があります。実際: 500円");
  });

  it("excludes operation member tickets from plan checks but checks online URL and notices", () => {
    const event: EventInfo = {
      name: "初心者読書会",
      kind: "online",
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

    const errors = checkEventInfo(event, rulesConfig).errors;
    expect(errors.some((error) => error.includes("期待ルールに一致しないチケット名") && error.includes("運営メンバー"))).toBe(false);
    expect(errors.some((error) => error.includes("運営メンバー") && error.includes("オンライン参加URLが空"))).toBe(true);
    expect(errors.some((error) => error.includes("主催者からのお知らせがチケット間で一致していません"))).toBe(true);
    expect(errors.some((error) => error.includes("運営メンバー") && error.includes("締切時刻が開始5分前ではありません"))).toBe(true);
  });

  it("requires fixed-fee two-ticket events to include a plan-change ticket", () => {
    const event: EventInfo = {
      name: "【名古屋】講座",
      kind: "offline",
      detailUrl: "https://example.com",
      startAt: null,
      endAt: null,
      venue: null,
      tickets: [
        { name: "固定費チケット", price: 1500, visibility: "全員", visibilityTags: ["オン", "オフ", "ハイ", "外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "追加チケット", price: 0, visibility: "全員", visibilityTags: ["オン", "オフ", "ハイ", "外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    expect(checkEventInfo(event, rulesConfig).errors).toContain("固定費イベントでは、片方がプラン変更チケットである必要があります");
  });

  it("accepts a fixed-fee ticket plus plan-change ticket without normal plan rules", () => {
    const event: EventInfo = {
      name: "【名古屋】講座",
      kind: "offline",
      detailUrl: "https://example.com",
      startAt: null,
      endAt: null,
      venue: null,
      tickets: [
        { name: "固定費チケット", price: 1500, visibility: "全員", visibilityTags: ["オン", "オフ", "ハイ", "外"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "プラン変更後にお申し込み下さい。プラン変更前は参加ボタンは押さないでください。", price: 0, visibility: "(1)【5月まで】ラウンジ会員", visibilityTags: ["A", "U-22", "B"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    expect(checkEventInfo(event, rulesConfig).ok).toBe(true);
  });

  it("requires fixed-fee ticket to cover every member plan", () => {
    const event: EventInfo = {
      name: "【名古屋】講座",
      kind: "offline",
      detailUrl: "https://example.com",
      startAt: null,
      endAt: null,
      venue: null,
      tickets: [
        { name: "固定費チケット", price: 1500, visibility: "一部会員", visibilityTags: ["オン", "オフ"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "プラン変更後にお申し込み下さい。プラン変更前は参加ボタンは押さないでください。", price: 0, visibility: "(1)【5月まで】ラウンジ会員", visibilityTags: ["(1)【5月まで】ラウンジ会員"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    expect(checkEventInfo(event, rulesConfig).errors).toContain("[1番目] 固定費チケットの閲覧権限が不足しています。期待: オン,オフ,ハイ,外 / 実際: オン,オフ");
  });

  it("detects duplicate legacy member tickets", () => {
    const event: EventInfo = {
      name: "【東京】読書会",
      kind: "offline",
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

    expect(checkEventInfo(event, rulesConfig).errors.some((error) => error.includes("旧会員 A のチケットが重複しています（読書会のみ参加）"))).toBe(true);
  });

  it("requires legacy member tags only on the plan-change ticket", () => {
    const event: EventInfo = {
      name: "【名古屋】講座",
      kind: "offline",
      detailUrl: "https://example.com",
      startAt: null,
      endAt: null,
      venue: null,
      tickets: [
        { name: "固定費チケット", price: 1500, visibility: "旧会員混入", visibilityTags: ["オン", "オフ", "ハイ", "外", "A"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "プラン変更後にお申し込み下さい。プラン変更前は参加ボタンは押さないでください。", price: 0, visibility: "旧会員", visibilityTags: ["A", "U-22"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    const errors = checkEventInfo(event, rulesConfig).errors;
    expect(errors.some((error) => error.includes("旧会員 A はプラン変更チケット以外に入れないでください"))).toBe(true);
    expect(errors.some((error) => error.includes("期待: A,U-22,B"))).toBe(true);
  });

  it("recognizes plan switch wording as a legacy member ticket", () => {
    const event: EventInfo = {
      name: "オンライン読書会",
      kind: "online",
      detailUrl: "https://example.com",
      startAt: new Date(2026, 6, 14, 20, 0),
      endAt: null,
      venue: null,
      tickets: [
        { name: "通常チケット 今月1回目", price: 0, visibility: null, visibilityTags: ["オン"], onlineEnabled: false, onlineUrl: null, organizerNotice: null },
        { name: "プラン切り替え後にお申し込み下さい。（切り替え前は参加ボタンを押さないでください）", price: 0, visibility: "旧会員", visibilityTags: ["A", "U-22", "B"], onlineEnabled: false, onlineUrl: null, organizerNotice: null }
      ]
    };

    const errors = checkEventInfo(event, rulesConfig).errors;
    expect(errors.some((error) => error.includes("期待ルールに一致しないチケット名"))).toBe(false);
    expect(errors.some((error) => error.includes("プラン変更チケット名は"))).toBe(true);
  });

  it("uses guest offline prices for guest events", () => {
    const event: EventInfo = {
      name: "〖名古屋〗ゲストさんと読む『茶の本』",
      kind: "offline",
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

    const errors = checkEventInfo(event, rulesConfig).errors;
    expect(errors.filter((error) => error.includes("金額が期待値と異なります"))).toEqual([]);
  });

  it("uses guest online prices for online guest events", () => {
    const notice = "19:55までに参加してください";
    const event: EventInfo = {
      name: "ゲストと読む『茶の本』オンライン読書会",
      kind: "online",
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

    const errors = checkEventInfo(event, rulesConfig).errors;
    expect(errors.filter((error) => error.includes("金額が期待値と異なります"))).toEqual([]);
    expect(errors.filter((error) => error.includes("期待されるチケット"))).toEqual([]);
    expect(errors.filter((error) => error.includes("チケット名の会員名が閲覧権限と一致していません"))).toEqual([]);
    expect(errors.filter((error) => error.includes("チケット「地域会員」が複数存在します"))).toEqual([]);
  });

  it("accepts alternate guest offline prices", () => {
    const event: EventInfo = {
      name: "【福岡 第一回】ゲストさんと読む『茶の本』",
      kind: "offline",
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

    const errors = checkEventInfo(event, rulesConfig).errors;
    expect(errors.filter((error) => error.includes("金額が期待値と異なります"))).toEqual([]);
  });
});
