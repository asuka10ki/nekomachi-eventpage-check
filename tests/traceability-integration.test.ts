import { describe, expect, it } from "vitest";
import { validateEvent } from "../src/validation/engine.js";
import { buildConsoleLines } from "../src/presentation/console.js";
import { buildSlackMessages } from "../src/slack.js";
import { runApplication, type RunDependencies, type RuntimePage } from "../src/run/orchestrator.js";
import { AcquisitionError } from "../src/acquisition/quality.js";
import { createPlannedSlackMessages, sendSlackMessagesWithPersistentProgress, type SlackProgressFileSystem } from "../src/notification/slack-progress.js";
import type { SlackPostResponse, SlackTransport } from "../src/notification/slack-client.js";
import type { AppEnv } from "../src/config.js";
import type { EventInfo, EventListItem, TicketInfo } from "../src/types.js";
import type { EventDisplayContext } from "../src/domain/model.js";
import type { RunSummary } from "../src/results/model.js";

const env: AppEnv = { slackChannelId: "fake", slackDryRun: true, headless: true };
const notice = "20:00から受付を開始します。20:25までに受付を済ませてください。";
const planName = "プラン変更後にお申し込み下さい。プラン変更前は参加ボタンは押さないでください。";

function ticket(overrides: Partial<TicketInfo> & Pick<TicketInfo, "name">): TicketInfo {
  return {
    name: overrides.name,
    price: overrides.price ?? 0,
    visibility: overrides.visibility ?? null,
    visibilityTags: overrides.visibilityTags ?? [],
    onlineEnabled: overrides.onlineEnabled ?? true,
    onlineUrl: "onlineUrl" in overrides ? overrides.onlineUrl! : "https://zoom.example/room",
    organizerNotice: "organizerNotice" in overrides ? overrides.organizerNotice! : notice,
    fieldAvailability: overrides.fieldAvailability
  };
}

function onlineTickets(): TicketInfo[] {
  return [
    ticket({ name: "『存在と時間』ハイブリッド会員", visibilityTags: ["ハイ"] }),
    ticket({ name: "『存在と時間』地域会員", price: 800, visibilityTags: ["オフ"] }),
    ticket({ name: "『存在と時間』オンライン会員（今月1回目）", visibilityTags: ["オン"] }),
    ticket({ name: "『存在と時間』オンライン会員（今月2回目以降）", price: 800, visibilityTags: ["オン"] }),
    ticket({ name: "『存在と時間』非会員", price: 1100, visibilityTags: ["外"] }),
    ticket({ name: planName, visibilityTags: ["A", "U-22", "B"], onlineEnabled: false, onlineUrl: null, organizerNotice: null })
  ];
}

function event(id: string, overrides: Partial<EventInfo> = {}): EventInfo {
  return {
    name: `『存在と時間』読書会 ${id}`,
    detailUrl: `https://nekomachi-club.com/admin_events/${id}/edit`,
    startAt: new Date(2026, 7, 22, 20, 30),
    endAt: new Date(2026, 7, 22, 22, 0),
    venue: "",
    bodyText: [
      "■参加費", "ハイブリッド会員：無料", "地域会員：800円",
      "オンライン会員（今月1回目）：無料", "オンライン会員（今月2回目以降）：800円",
      "非会員：1,100円", "■タイムテーブル", "20:00 受付開始"
    ].join("\n"),
    applicationDeadlineEnabled: false,
    applicationDeadline: null,
    tickets: onlineTickets(),
    ...overrides
  };
}

describe("TSK-010 traceability", () => {
  it("keeps observed references for eligibility, attributes, roles, rate keys and every ticket set", () => {
    const outcome = validateEvent(event("trace"));
    expect(outcome.derived.eligibility.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ reference: expect.objectContaining({ eventId: "trace", field: "name", source: "DETAIL_PAGE" }) })
    ]));
    expect(outcome.derived.attributes).toBeDefined();
    for (const attribute of Object.values(outcome.derived.attributes!)) expect(attribute.evidence.length).toBeGreaterThan(0);
    for (const derivedTicket of outcome.derived.tickets) {
      expect(derivedTicket.roles.evidence.length).toBeGreaterThan(0);
      expect(derivedTicket.roles.evidence[0].reference).toMatchObject({ eventId: "trace", ticketId: derivedTicket.ticketId, ticketPosition: derivedTicket.position });
      expect(derivedTicket.rateKeys.evidence.length).toBeGreaterThan(0);
    }
    expect(outcome.derived.setEvidence).toBeDefined();
    for (const setEvidence of Object.values(outcome.derived.setEvidence!)) expect(setEvidence.length).toBeGreaterThan(0);
  });

  it("records online, offline, hybrid, fixed-fee and standard derivation reasons", () => {
    const online = validateEvent(event("online-evidence"));
    expect(online.derived.attributes?.deliveryMode).toMatchObject({ state: "determined", value: "online" });
    expect(online.derived.attributes?.pricingMode).toMatchObject({ state: "determined", value: "standard" });
    const offline = validateEvent(event("offline-evidence", { name: "【愛知】読書会" }));
    expect(offline.derived.attributes?.deliveryMode).toMatchObject({ state: "determined", value: "offline" });
    const hybrid = validateEvent(event("hybrid-evidence", { venue: "オフ会場＋オンライン" }));
    expect(hybrid.derived.attributes?.deliveryMode).toMatchObject({ state: "determined", value: "hybrid" });
    const fixed = validateEvent(event("fixed-evidence", {
      tickets: [ticket({ name: "固定料金オンライン参加", price: 2000, visibilityTags: ["オン", "オフ", "ハイ", "外"] })]
    }));
    expect(fixed.derived.attributes?.pricingMode).toMatchObject({ state: "determined", value: "fixed-fee" });
    expect(fixed.derived.attributes?.fixedFeeType).toMatchObject({ state: "determined", value: "standard" });
    for (const outcome of [online, offline, hybrid, fixed]) {
      expect(outcome.derived.attributes?.deliveryMode.evidence.length).toBeGreaterThan(0);
      expect(outcome.derived.attributes?.pricingMode.evidence.length).toBeGreaterThan(0);
      expect(outcome.derived.attributes?.fixedFeeType.evidence.length).toBeGreaterThan(0);
    }
  });

  it("records applicable, skipped and unknown rule references without empty determined evidence", () => {
    const normal = validateEvent(event("plans"));
    const applicability = new Set(normal.plans.map((plan) => plan.applicability));
    expect(applicability.has("applicable")).toBe(true);
    expect(applicability.has("skipped")).toBe(true);
    expect(normal.plans.every((plan) => plan.applicabilityReferences.length > 0)).toBe(true);
    for (const ruleId of ["EVT-001", "BODY-003", "TKT-006", "SET-001", "CROSS-001", "AREA-001"]) {
      expect(normal.plans.find((plan) => plan.ruleId === ruleId)?.applicabilityReferences.length).toBeGreaterThan(0);
    }
    const priority = validateEvent(event("priority", {
      tickets: [ticket({ name: planName, visibilityTags: ["オン", "A", "U-22", "B"], onlineEnabled: false, onlineUrl: null, organizerNotice: null })]
    }));
    expect(priority.derived.tickets[0].roles).toMatchObject({ state: "determined", value: ["plan-change"] });
    const unavailable = validateEvent(event("unknown-plan", { fieldAvailability: { tickets: false }, tickets: [] }));
    expect(unavailable.plans.some((plan) => plan.applicability === "unknown" && plan.applicabilityReferences.some((reference) => reference.state === "unavailable"))).toBe(true);
  });

  it("tracks inspected fields for passed, failed, unknown and cross-ticket results", () => {
    const normal = validateEvent(event("inspected"));
    const passedPrice = normal.validationResults.find((result) => result.ruleId === "TKT-006" && result.status === "passed");
    expect(passedPrice?.inspectedFields).toEqual(expect.arrayContaining([expect.objectContaining({ field: "price", ticketPosition: 1 })]));

    const failed = validateEvent(event("failed", { tickets: [] }));
    expect(failed.validationResults.find((result) => result.ruleId === "SET-014" && result.status === "failed")?.inspectedFields)
      .toEqual([expect.objectContaining({ field: "tickets", state: "present" })]);

    const unknown = validateEvent(event("unknown-field", {
      tickets: [ticket({ name: "取得不能券", visibilityTags: ["オン"], fieldAvailability: { onlineUrl: false } })]
    }));
    expect(unknown.validationResults.some((result) => result.status === "unknown"
      && result.inspectedFields.some((reference) => reference.state === "unavailable"))).toBe(true);

    const cross = normal.validationResults.find((result) => result.ruleId === "CROSS-001");
    expect(cross?.inspectedFields.filter((reference) => reference.field === "onlineUrl").length).toBeGreaterThan(1);

    for (const outcome of [normal, failed, unknown]) {
      for (const validation of outcome.validationResults) {
        const plan = outcome.plans.find((candidate) => candidate.ruleId === validation.ruleId
          && JSON.stringify(candidate.ticketIds ?? []) === JSON.stringify(validation.ticketIds ?? []));
        if (plan?.applicability === "applicable") expect(validation.inspectedFields.length, validation.ruleId).toBeGreaterThan(0);
      }
    }
  });

  it("uses one EventDisplayContext for derived delivery mode, status and ticket positions", () => {
    const context = validateEvent(event("display", { tickets: [] })).event;
    expect(context).toMatchObject({ eventId: "display", deliveryMode: "online", eligibilityStatus: "target", eventStatus: "failed" });
    expect(validateEvent(event("display-tickets")).event.tickets[0]).toMatchObject({ ticketId: "ticket-1", position: 1 });
    const summary = summaryOf([context]);
    expect(buildConsoleLines(summary).join("\n")).toContain(context.name.state === "present" ? context.name.value : "取得不能");
    expect(buildSlackMessages(summary).join("\n")).toContain("イベント種別: オンライン");
  });

  it("keeps excluded and failed-and-unknown display states without reclassification", () => {
    const excluded = validateEvent(event("excluded", { name: "【予告】読書会" }));
    expect(excluded.event).toMatchObject({ eventId: "excluded", eligibilityStatus: "excluded" });
    const combined = validateEvent(event("combined", { bodyText: undefined, tickets: [] })).event;
    expect(combined.eventStatus).toBe("failed-and-unknown");
    expect(buildSlackMessages(summaryOf([combined])).join("\n")).toContain("【NG＋UNKNOWN 1】");
  });
});

describe("TSK-016 whole-system integration", () => {
  it("runs acquisition through validation, shared presentation, notification, persistence, cleanup and RunOutcome", async () => {
    const fixture = makeRun([event("ok"), event("ng", { tickets: [] }), event("unknown", { fieldAvailability: { tickets: false }, tickets: [] }), event("skip", { name: "【予告】読書会" })]);
    const outcome = await runApplication(env, fixture.dependencies);
    expect(outcome).toMatchObject({ runStatus: "business-failure", executionStatus: "completed", exitCode: 0, summary: { checkedCount: 3, excludedCount: 1, okCount: 1, ngCount: 1, unknownCount: 1 } });
    expect(outcome.stages.find((stage) => stage.stage === "list-acquisition")?.references).toEqual([
      expect.objectContaining({ source: "LIST_PAGE", field: "eventList" })
    ]);
    expect(outcome.stages.find((stage) => stage.stage === "state-persistence")?.references).toEqual([
      expect.objectContaining({ source: "STATE_FILE", field: "previousEventCount" })
    ]);
    expect(fixture.state).toMatchObject({ savedCount: 4, savedSession: 1, presented: 1, notified: 1 });
    expect(fixture.state.closed).toEqual(["detail", "detail", "detail", "detail", "list", "browser"]);
    expect(fixture.state.messages.join("\n")).toContain("【NG 1】");
    expect(fixture.state.messages.join("\n")).toContain("【UNKNOWN 1】");
  });

  it("preserves more than 21 NG and UNKNOWN events without omission, duplication or double counting", async () => {
    const ngEvents = Array.from({ length: 22 }, (_, index) => event(`ng-${index + 1}`, { tickets: [] }));
    const unknownEvents = Array.from({ length: 22 }, (_, index) => event(`unknown-${index + 1}`, { fieldAvailability: { tickets: false }, tickets: [] }));
    const fixture = makeRun([...ngEvents, ...unknownEvents]);
    const outcome = await runApplication(env, fixture.dependencies);
    expect(outcome.summary).toMatchObject({ checkedCount: 44, okCount: 0, ngCount: 22, unknownCount: 22, failedAndUnknownCount: 0 });
    const text = fixture.state.messages.join("\n");
    const eventLines = text.split("\n").filter((line) => line.startsWith("イベント名: "));
    for (const item of [...ngEvents, ...unknownEvents]) expect(eventLines.filter((line) => line.startsWith(`イベント名: ${item.name}（`))).toHaveLength(1);
    expect(text).toContain("【NG 22】");
    expect(text).toContain("【UNKNOWN 22】");
  });

  it("preserves failed-and-unknown and multiple issues in one event", async () => {
    const fixture = makeRun([event("combined-system", { bodyText: undefined, tickets: [] })]);
    const outcome = await runApplication(env, fixture.dependencies);
    expect(outcome.summary).toMatchObject({ checkedCount: 1, ngCount: 0, unknownCount: 0, failedAndUnknownCount: 1 });
    const result = outcome.summary!.events[0];
    expect(result.eventStatus).toBe("failed-and-unknown");
    expect(result.validationResults.filter((entry) => entry.status === "unknown").length).toBeGreaterThan(0);
    expect(result.validationResults.filter((entry) => entry.status === "failed").length).toBeGreaterThan(0);
  });

  it("covers empty list, list DOM failure and authentication stop with consistent exit codes", async () => {
    const empty = makeRun([]);
    expect(await runApplication(env, empty.dependencies)).toMatchObject({ runStatus: "success", exitCode: 0, summary: { checkedCount: 0 } });

    const dom = makeRun([], { collectList: async () => { throw new AcquisitionError("QUAL-LIST-003", "一覧DOMを取得できません"); } });
    expect(await runApplication(env, dom.dependencies)).toMatchObject({ runStatus: "acquisition-failure", exitCode: 1 });

    let calls = 0;
    const auth = makeRun([event("first"), event("second")], { fetchDetail: async () => {
      calls += 1;
      throw new AcquisitionError("QUAL-DETAIL-002", "ログイン状態が期限切れです");
    } });
    expect(await runApplication(env, auth.dependencies)).toMatchObject({ runStatus: "authentication-failure", exitCode: 1 });
    expect(calls).toBe(1);
    expect(auth.state.closed).toEqual(["detail", "list", "browser"]);
  });

  it("resumes only unsent Slack chunks across orchestrator process restarts", async () => {
    const events = Array.from({ length: 24 }, (_, index) => event(`restart-ng-${index + 1}`, { tickets: [] }));
    const fileSystem = new SlackMemoryFileSystem();
    const firstTransport = new SequenceTransport([
      { status: 200, ok: true, messageId: "1.000" },
      { status: 400, ok: false, error: "invalid_blocks" }
    ]);
    const first = makeRun(events, {
      notify: async (_appEnv, messages) => sendSlackMessagesWithPersistentProgress(
        firstTransport,
        "fake-channel",
        createPlannedSlackMessages(messages),
        { statePath: "virtual/integration-slack.json", fileSystem }
      )
    });
    const firstOutcome = await runApplication(env, first.dependencies);
    expect(firstOutcome).toMatchObject({ runStatus: "notification-failure", exitCode: 1, notification: { status: "failed" } });
    expect(firstTransport.calls.length).toBe(2);

    const resumedTransport = new SequenceTransport([]);
    const resumed = makeRun(events, {
      notify: async (_appEnv, messages) => sendSlackMessagesWithPersistentProgress(
        resumedTransport,
        "fake-channel",
        createPlannedSlackMessages(messages),
        { statePath: "virtual/integration-slack.json", fileSystem }
      )
    });
    const resumedOutcome = await runApplication(env, resumed.dependencies);
    expect(resumedOutcome).toMatchObject({ runStatus: "business-failure", exitCode: 0, notification: { status: "sent", unsentMessageIds: [] } });
    expect(resumedTransport.calls).not.toContain(firstTransport.calls[0]);
    expect(resumedTransport.calls.length).toBeGreaterThan(0);
  });
});

function makeRun(events: EventInfo[], overrides: Partial<RunDependencies> = {}) {
  const state = { closed: [] as string[], savedCount: -1, savedSession: 0, presented: 0, notified: 0, messages: [] as string[] };
  const listPage: RuntimePage = { close: async () => { state.closed.push("list"); } };
  const browser: RuntimePage = { close: async () => { state.closed.push("browser"); } };
  const items: EventListItem[] = events.map((item) => ({ name: item.name, detailUrl: item.detailUrl }));
  const byUrl = new Map(events.map((item) => [item.detailUrl, item]));
  const dependencies: RunDependencies = {
    storageStateExists: () => true,
    cleanupArtifacts: async () => undefined,
    launchRuntime: async () => ({
      browser,
      listPage,
      context: {
        newPage: async () => ({ close: async () => { state.closed.push("detail"); } }),
        storageState: async () => ({ cookies: [], origins: [] })
      }
    }),
    collectList: async () => items,
    fetchDetail: async (_page, item) => byUrl.get(item.detailUrl)!,
    checkEvent: (item) => validateEvent(item),
    saveArtifact: async () => undefined,
    loadEventCount: async () => null,
    saveEventCount: async (count) => { state.savedCount = count; },
    saveSession: async () => { state.savedSession += 1; },
    close: async (resources) => {
      for (const resource of resources) await resource.resource.close();
      return [];
    },
    present: (summary) => {
      state.presented += 1;
      buildConsoleLines(summary);
    },
    buildMessages: (summary) => buildSlackMessages(summary),
    notify: async (_appEnv, messages) => {
      state.notified += 1;
      state.messages = messages;
      return { status: "dry-run", plannedMessageIds: messages.map((_message, index) => String(index + 1)), sentMessageIds: [], attempts: 0 };
    },
    now: () => new Date("2026-08-23T11:00:00.000Z"),
    ...overrides
  };
  return { dependencies, state };
}

function summaryOf(events: EventDisplayContext[]): RunSummary {
  return {
    targetLabel: "テスト",
    executionComplete: true,
    acquisitionComplete: true,
    checkedCount: events.length,
    excludedCount: 0,
    undeterminedCount: 0,
    okCount: events.filter((event) => event.eventStatus === "ok").length,
    ngCount: events.filter((event) => event.eventStatus === "failed").length,
    unknownCount: events.filter((event) => event.eventStatus === "unknown").length,
    failedAndUnknownCount: events.filter((event) => event.eventStatus === "failed-and-unknown").length,
    events,
    executedAt: new Date("2026-08-23T11:00:00.000Z")
  };
}

class SequenceTransport implements SlackTransport {
  readonly calls: string[] = [];
  constructor(private readonly responses: SlackPostResponse[]) {}
  async post(_channel: string, text: string): Promise<SlackPostResponse> {
    this.calls.push(text);
    return this.responses.shift() ?? { status: 200, ok: true, messageId: `${this.calls.length}.000` };
  }
}

class SlackMemoryFileSystem implements SlackProgressFileSystem {
  readonly files = new Map<string, string>();
  async readFile(filePath: string): Promise<string> {
    const value = this.files.get(filePath);
    if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return value;
  }
  async mkdir(): Promise<void> {}
  async writeFile(filePath: string, data: string): Promise<void> { this.files.set(filePath, data); }
  async rename(oldPath: string, newPath: string): Promise<void> {
    const value = this.files.get(oldPath);
    if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    this.files.set(newPath, value);
    this.files.delete(oldPath);
  }
  async rm(filePath: string): Promise<void> { this.files.delete(filePath); }
}
