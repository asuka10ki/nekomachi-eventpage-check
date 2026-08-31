import { describe, expect, it } from "vitest";
import { chromium, type Page } from "playwright";
import path from "node:path";
import {
  CheckStateError,
  loadPreviousEventCount,
  saveSuccessfulEventCount,
  type CheckStateFileSystem
} from "../src/check-state.js";
import { collectEventListWithPagination } from "../src/osiro.js";
import {
  createPlannedSlackMessages,
  loadSlackProgress,
  sendSlackMessagesWithPersistentProgress,
  type SlackProgressFileSystem
} from "../src/notification/slack-progress.js";
import type { SlackPostResponse, SlackTransport } from "../src/notification/slack-client.js";
import { runApplication, type RunDependencies, type RuntimePage } from "../src/run/orchestrator.js";
import { closeResources } from "../src/run/cleanup.js";
import { AcquisitionError } from "../src/acquisition/quality.js";
import type { AppEnv } from "../src/config.js";
import type { EventInfo, EventListItem } from "../src/types.js";
import type { EventValidationOutcome, ValidationResult } from "../src/domain/model.js";
import { validateEvent } from "../src/validation/engine.js";

class MemoryFileSystem implements CheckStateFileSystem, SlackProgressFileSystem {
  readonly files = new Map<string, string>();
  failRead = false;
  failCreate = false;
  failWrite = false;
  failWriteAt: number | undefined;
  writeCount = 0;
  failTemporaryReplace = false;

  async readFile(filePath: string): Promise<string> {
    if (this.failRead) throw nodeError("EACCES");
    const value = this.files.get(filePath);
    if (value === undefined) throw nodeError("ENOENT");
    return value;
  }
  async mkdir(): Promise<void> {}
  async createFile(filePath: string): Promise<void> {
    if (this.failCreate) throw nodeError("EACCES");
    this.files.set(filePath, "");
  }
  async writeFile(filePath: string, data: string): Promise<void> {
    this.writeCount += 1;
    if (this.failWrite || this.writeCount === this.failWriteAt) throw nodeError("EACCES");
    this.files.set(filePath, data);
  }
  async rename(oldPath: string, newPath: string): Promise<void> {
    if (this.failTemporaryReplace && oldPath.includes(".tmp-")) throw nodeError("EACCES");
    const value = this.files.get(oldPath);
    if (value === undefined) throw nodeError("ENOENT");
    this.files.set(newPath, value);
    this.files.delete(oldPath);
  }
  async rm(filePath: string): Promise<void> {
    this.files.delete(filePath);
  }
}

class FakeTransport implements SlackTransport {
  readonly calls: string[] = [];
  constructor(private readonly responses: SlackPostResponse[]) {}
  async post(_channel: string, text: string): Promise<SlackPostResponse> {
    this.calls.push(text);
    return this.responses.shift() ?? { status: 200, ok: true, messageId: `${this.calls.length}.000` };
  }
}

describe("event count state reliability", () => {
  const statePath = path.resolve("virtual", "count.json");
  const valid = (count: unknown = 12, updatedAt: unknown = "2026-08-23T00:00:00.000Z") => JSON.stringify({ eventCount: count, updatedAt });

  it("treats only a missing file as the first execution", async () => {
    const memory = new MemoryFileSystem();
    await expect(loadPreviousEventCount(statePath, memory)).resolves.toBeNull();
    memory.files.set(statePath, valid());
    await expect(loadPreviousEventCount(statePath, memory)).resolves.toBe(12);
  });

  it.each([
    ["invalid JSON", "{"],
    ["negative", valid(-1)],
    ["decimal", valid(1.5)],
    ["string", valid("12")],
    ["missing eventCount", JSON.stringify({ updatedAt: "2026-08-23T00:00:00.000Z" })],
    ["missing updatedAt", JSON.stringify({ eventCount: 12 })]
  ])("rejects %s instead of disabling the drop check", async (_label, raw) => {
    const memory = new MemoryFileSystem();
    memory.files.set(statePath, raw);
    await expect(loadPreviousEventCount(statePath, memory)).rejects.toBeInstanceOf(CheckStateError);
  });

  it("does not hide a read failure", async () => {
    const memory = new MemoryFileSystem();
    memory.failRead = true;
    await expect(loadPreviousEventCount(statePath, memory)).rejects.toMatchObject({ operation: "read" });
  });

  it("saves atomically and preserves the old state when writing or replacement fails", async () => {
    const memory = new MemoryFileSystem();
    memory.files.set(statePath, valid(10));
    memory.failCreate = true;
    await expect(saveSuccessfulEventCount(20, statePath, memory)).rejects.toMatchObject({ operation: "create" });
    expect(memory.files.get(statePath)).toBe(valid(10));

    memory.failCreate = false;
    memory.failWrite = true;
    await expect(saveSuccessfulEventCount(20, statePath, memory)).rejects.toMatchObject({ operation: "write" });
    expect(memory.files.get(statePath)).toBe(valid(10));

    memory.failWrite = false;
    memory.failTemporaryReplace = true;
    await expect(saveSuccessfulEventCount(20, statePath, memory, () => new Date("2026-08-23T01:00:00.000Z"))).rejects.toMatchObject({ operation: "replace" });
    expect(memory.files.get(statePath)).toBe(valid(10));

    memory.failTemporaryReplace = false;
    await expect(saveSuccessfulEventCount(20, statePath, memory, () => new Date("2026-08-23T01:00:00.000Z"))).resolves.toBeUndefined();
    await expect(loadPreviousEventCount(statePath, memory)).resolves.toBe(20);
  });
});

describe("single-origin pagination reliability", () => {
  async function withPage(run: (page: Page) => Promise<void>): Promise<void> {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await run(page);
    } finally {
      await browser.close();
    }
  }

  function listPage(events: Array<{ id: string; query?: string }> = [], next?: string): string {
    return `<div id="eventIndex">${events.map((event) => `<a href="/admin_events/${event.id}/edit${event.query ?? ""}">イベント${event.id}</a>`).join("")}${next ? `<a href="${next}" rel="next">Next</a>` : ""}</div>`;
  }

  it("gets one, two and three pages once and canonicalizes duplicate event URLs", async () => withPage(async (page) => {
    const visits: string[] = [];
    await page.route("http://osiro.test/**", async (route) => {
      const url = new URL(route.request().url());
      visits.push(`${url.pathname}${url.search}`);
      const current = url.searchParams.get("page") ?? "1";
      const body = current === "1"
        ? listPage([{ id: "a", query: "?tracking=1" }], "/admin/events?page=2&state=yet_end")
        : current === "2"
          ? listPage([{ id: "a", query: "?tracking=2" }, { id: "b" }], "/admin/events?state=yet_end&page=3")
          : listPage([{ id: "c" }]);
      await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body });
    });
    const items = await collectEventListWithPagination(page, "http://osiro.test/admin/events?state=yet_end");
    expect(visits).toHaveLength(3);
    expect(new Set(visits).size).toBe(3);
    expect(items.map((item) => item.detailUrl)).toEqual([
      "http://osiro.test/admin_events/a/edit",
      "http://osiro.test/admin_events/b/edit",
      "http://osiro.test/admin_events/c/edit"
    ]);
  }));

  it("allows an explicit empty list but rejects missing list DOM", async () => withPage(async (page) => {
    await page.route("http://osiro.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: listPage() }));
    await expect(collectEventListWithPagination(page, "http://osiro.test/admin/events")).resolves.toEqual([]);
    await page.unrouteAll();
    await page.route("http://osiro.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<main>changed</main>" }));
    await expect(collectEventListWithPagination(page, "http://osiro.test/admin/events")).rejects.toThrow("一覧画面を確認できません");
  }), 25000);

  it("detects repeated next URLs and pagination cycles", async () => withPage(async (page) => {
    await page.route("http://osiro.test/**", async (route) => {
      const url = new URL(route.request().url());
      const body = url.searchParams.get("page") === "2"
        ? listPage([{ id: "b" }], "/admin/events")
        : listPage([{ id: "a" }], "/admin/events?page=2");
      await route.fulfill({ status: 200, contentType: "text/html", body });
    });
    await expect(collectEventListWithPagination(page, "http://osiro.test/admin/events")).rejects.toThrow(/循環|同じ次ページ/);
  }));

  it("rejects an intermediate HTTP failure, login redirect and maximum page overflow", async () => {
    await withPage(async (page) => {
      await page.route("http://osiro.test/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.searchParams.get("page") === "2") await route.fulfill({ status: 503, body: "unavailable" });
        else await route.fulfill({ status: 200, contentType: "text/html", body: listPage([{ id: "a" }], "/admin/events?page=2") });
      });
      await expect(collectEventListWithPagination(page, "http://osiro.test/admin/events")).rejects.toThrow("HTTPステータス: 503");
    });
    await withPage(async (page) => {
      await page.route("http://osiro.test/**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/login") await route.fulfill({ status: 200, contentType: "text/html", body: "login" });
        else await route.fulfill({ status: 200, contentType: "text/html", body: listPage([{ id: "a" }], "/login") });
      });
      await expect(collectEventListWithPagination(page, "http://osiro.test/admin/events")).rejects.toThrow("ログイン状態が期限切れ");
    });
    await withPage(async (page) => {
      await page.route("http://osiro.test/**", async (route) => {
        const url = new URL(route.request().url());
        const current = Number(url.searchParams.get("page") ?? "1");
        await route.fulfill({ status: 200, contentType: "text/html", body: listPage([{ id: String(current) }], `/admin/events?page=${current + 1}`) });
      });
      await expect(collectEventListWithPagination(page, "http://osiro.test/admin/events", 2)).rejects.toThrow("2ページを超えた");
    });
  });
});

describe("persistent Slack delivery progress", () => {
  const statePath = path.resolve("virtual", "slack.json");
  const messages = createPlannedSlackMessages(["first", "second", "third"]);

  it("stores planned, sent and Slack ts for one or three successful messages", async () => {
    const oneMemory = new MemoryFileSystem();
    const one = createPlannedSlackMessages(["only"]);
    await expect(sendSlackMessagesWithPersistentProgress(new FakeTransport([{ status: 200, ok: true, messageId: "1.001" }]), "channel", one, { statePath, fileSystem: oneMemory })).resolves.toMatchObject({ status: "sent" });
    expect((await loadSlackProgress(statePath, oneMemory))?.messages).toEqual([expect.objectContaining({ status: "sent", slackTs: "1.001" })]);

    const memory = new MemoryFileSystem();
    const outcome = await sendSlackMessagesWithPersistentProgress(new FakeTransport([
      { status: 200, ok: true, messageId: "1.000" },
      { status: 200, ok: true, messageId: "2.000" },
      { status: 200, ok: true, messageId: "3.000" }
    ]), "channel", messages, { statePath, fileSystem: memory });
    expect(outcome).toMatchObject({ status: "sent", sentMessageIds: messages.map((message) => message.id), unsentMessageIds: [] });
    expect((await loadSlackProgress(statePath, memory))?.messages.every((message) => message.status === "sent" && Boolean(message.slackTs))).toBe(true);
  });

  it.each([2, 3])("resumes after a process restart when message %s failed", async (failedAt) => {
    const memory = new MemoryFileSystem();
    const initialResponses = messages.map((_message, index): SlackPostResponse => index + 1 === failedAt
      ? { status: 400, ok: false, error: "invalid_blocks" }
      : { status: 200, ok: true, messageId: `${index + 1}.000` });
    const first = new FakeTransport(initialResponses);
    const failed = await sendSlackMessagesWithPersistentProgress(first, "channel", messages, { statePath, fileSystem: memory });
    expect(failed.status).toBe("failed");
    expect(first.calls).toHaveLength(failedAt);

    const resumed = new FakeTransport([]);
    const result = await sendSlackMessagesWithPersistentProgress(resumed, "channel", messages, { statePath, fileSystem: memory });
    expect(resumed.calls).toEqual(messages.slice(failedAt - 1).map((message) => message.text));
    expect(result.status).toBe("sent");

    const complete = new FakeTransport([]);
    await sendSlackMessagesWithPersistentProgress(complete, "channel", messages, { statePath, fileSystem: memory });
    expect(complete.calls).toEqual([]);
  });

  it("creates a different plan when body, aggregate text or destination changes", async () => {
    const memory = new MemoryFileSystem();
    await sendSlackMessagesWithPersistentProgress(new FakeTransport([]), "channel", messages, { statePath, fileSystem: memory });
    const changedBody = createPlannedSlackMessages(["first", "summary changed"]);
    const bodyTransport = new FakeTransport([]);
    await sendSlackMessagesWithPersistentProgress(bodyTransport, "channel", changedBody, { statePath, fileSystem: memory });
    expect(bodyTransport.calls).toEqual(["first", "summary changed"]);
    const destinationTransport = new FakeTransport([]);
    await sendSlackMessagesWithPersistentProgress(destinationTransport, "other-channel", changedBody, { statePath, fileSystem: memory });
    expect(destinationTransport.calls).toEqual(["first", "summary changed"]);
  });

  it("resumes the previous unsent body before a new run whose timestamp changed", async () => {
    const memory = new MemoryFileSystem();
    const first = new FakeTransport([
      { status: 200, ok: true, messageId: "1.000" },
      { status: 400, ok: false, error: "invalid_blocks" }
    ]);
    await sendSlackMessagesWithPersistentProgress(first, "channel", messages, { statePath, fileSystem: memory });

    const nextRunMessages = createPlannedSlackMessages(["new run at a different time"]);
    const resumed = new FakeTransport([]);
    const outcome = await sendSlackMessagesWithPersistentProgress(resumed, "channel", nextRunMessages, { statePath, fileSystem: memory });

    expect(resumed.calls).toEqual(["second", "third"]);
    expect(outcome).toMatchObject({ status: "sent", unsentMessageIds: [] });
    expect((await loadSlackProgress(statePath, memory))?.messages.every((message) => message.status === "sent" && message.text === undefined)).toBe(true);
  });

  it("stops before posting for corrupt state or initial state-save failure", async () => {
    const corruptMemory = new MemoryFileSystem();
    corruptMemory.files.set(statePath, "{");
    const corruptTransport = new FakeTransport([]);
    await expect(sendSlackMessagesWithPersistentProgress(corruptTransport, "channel", messages, { statePath, fileSystem: corruptMemory })).rejects.toThrow("破損");
    expect(corruptTransport.calls).toEqual([]);

    const failedSaveMemory = new MemoryFileSystem();
    failedSaveMemory.failWrite = true;
    const failedSaveTransport = new FakeTransport([]);
    await expect(sendSlackMessagesWithPersistentProgress(failedSaveTransport, "channel", messages, { statePath, fileSystem: failedSaveMemory })).rejects.toThrow("保存できません");
    expect(failedSaveTransport.calls).toEqual([]);
  });

  it("does not duplicate a post whose Slack result could not be persisted", async () => {
    const memory = new MemoryFileSystem();
    // 1=初期計画、2=送信直前、3=Slack成功後のsent保存
    memory.failWriteAt = 3;
    const transport = new FakeTransport([{ status: 200, ok: true, messageId: "1.001" }]);
    const outcome = await sendSlackMessagesWithPersistentProgress(transport, "channel", createPlannedSlackMessages(["only"]), { statePath, fileSystem: memory });
    expect(outcome).toMatchObject({ status: "failed", sentMessageIds: [expect.any(String)] });
    expect(transport.calls).toEqual(["only"]);

    memory.failWriteAt = undefined;
    const retry = new FakeTransport([]);
    await expect(sendSlackMessagesWithPersistentProgress(retry, "channel", createPlannedSlackMessages(["only"]), { statePath, fileSystem: memory })).rejects.toThrow("送信結果が不明");
    expect(retry.calls).toEqual([]);
  });
});

describe("run orchestrator boundaries", () => {
  const env: AppEnv = { slackChannelId: "test", slackDryRun: true, headless: true };

  function makeDependencies(overrides: Partial<RunDependencies> = {}, checkResult?: EventValidationOutcome) {
    const state = { fetched: [] as string[], closed: [] as string[], notified: 0, presented: 0, savedCount: 0 };
    const items: EventListItem[] = [
      { name: "A", detailUrl: "https://example.com/a" },
      { name: "B", detailUrl: "https://example.com/b" }
    ];
    const listPage: RuntimePage = { close: async () => { state.closed.push("list"); } };
    const browser = { close: async () => { state.closed.push("browser"); } };
    const context = {
      storageState: async () => undefined,
      newPage: async (): Promise<RuntimePage> => ({ close: async () => { state.closed.push("detail"); } })
    };
    const dependencies: RunDependencies = {
      storageStateExists: () => true,
      cleanupArtifacts: async () => undefined,
      launchRuntime: async () => ({ browser, context, listPage }),
      collectList: async () => items,
      fetchDetail: async (_page, item) => {
        state.fetched.push(item.detailUrl);
        return eventInfo(item);
      },
      checkEvent: (event) => checkResult ?? resultFor(event.name, true),
      saveArtifact: async () => undefined,
      loadEventCount: async () => null,
      saveEventCount: async (count) => { state.savedCount = count; },
      saveSession: async () => undefined,
      close: async (resources) => closeResources(resources),
      present: () => { state.presented += 1; },
      buildMessages: () => ["summary"],
      notify: async (_config, messagesToSend) => {
        state.notified += 1;
        return { status: "dry-run", plannedMessageIds: messagesToSend.map((_message, index) => String(index)), sentMessageIds: [], attempts: 0 };
      },
      now: () => new Date("2026-08-23T04:00:00.000Z"),
      ...overrides
    };
    return { dependencies, state, items };
  }

  it("completes every stage and keeps business NG at exit code zero", async () => {
    const success = makeDependencies();
    const successOutcome = await runApplication(env, success.dependencies);
    expect(successOutcome).toMatchObject({ runStatus: "success", exitCode: 0, summary: { checkedCount: 2, okCount: 2 } });
    expect(new Set(successOutcome.stages.filter((stage) => stage.status === "completed").map((stage) => stage.stage))).toEqual(new Set([
      "initialization", "authentication", "list-acquisition", "detail-acquisition", "validation",
      "artifact-maintenance", "state-persistence", "cleanup", "aggregation", "presentation", "notification"
    ]));
    expect(success.state.closed).toEqual(["detail", "detail", "list", "browser"]);

    const business = makeDependencies({}, resultFor("NG", false));
    const businessOutcome = await runApplication(env, business.dependencies);
    expect(businessOutcome).toMatchObject({ runStatus: "business-failure", executionStatus: "completed", exitCode: 0, summary: { ngCount: 2 } });
  });

  it("stops subsequent detail acquisition after authentication expires and still cleans up", async () => {
    const setup = makeDependencies({
      fetchDetail: async () => { throw new AcquisitionError("QUAL-DETAIL-002", "ログイン状態が期限切れです", "event"); }
    });
    const outcome = await runApplication(env, setup.dependencies);
    expect(outcome).toMatchObject({ runStatus: "authentication-failure", exitCode: 1, summary: { checkedCount: 0 } });
    expect(outcome.failures.some((failure) => failure.type === "authentication-failure")).toBe(true);
    expect(setup.state.closed).toEqual(["detail", "list", "browser"]);
    expect(setup.state.notified).toBe(1);
  });

  it("keeps one detail failure as partial, but stops for list and state failures", async () => {
    let calls = 0;
    const partial = makeDependencies({ fetchDetail: async (_page, item) => {
      calls += 1;
      if (calls === 1) throw new Error("detail unavailable");
      return eventInfo(item);
    } });
    const partialOutcome = await runApplication(env, partial.dependencies);
    expect(partialOutcome).toMatchObject({
      runStatus: "partial-success",
      acquisitionStatus: "partial",
      exitCode: 1,
      summary: { checkedCount: 1, undeterminedCount: 1, unknownCount: 0, executionComplete: false, acquisitionComplete: false }
    });

    const list = makeDependencies({ collectList: async () => { throw new Error("list failed"); } });
    expect(await runApplication(env, list.dependencies)).toMatchObject({ runStatus: "acquisition-failure", exitCode: 1 });

    const state = makeDependencies({ loadEventCount: async () => { throw new CheckStateError("parse", "broken state"); } });
    const stateOutcome = await runApplication(env, state.dependencies);
    expect(stateOutcome).toMatchObject({ runStatus: "state-failure", exitCode: 1 });
    expect(state.state.fetched).toEqual([]);
  });

  it("records state-save, Slack and cleanup failures without losing the original failure", async () => {
    const save = makeDependencies({ saveEventCount: async () => { throw new Error("save failed"); } });
    expect(await runApplication(env, save.dependencies)).toMatchObject({ runStatus: "state-failure", exitCode: 1 });

    const slack = makeDependencies({ notify: async () => ({ status: "failed", plannedMessageIds: ["1"], sentMessageIds: [], unsentMessageIds: ["1"], attempts: 1, reason: "Slack failed" }) });
    expect(await runApplication(env, slack.dependencies)).toMatchObject({ runStatus: "notification-failure", exitCode: 1 });

    const combined = makeDependencies({
      collectList: async () => { throw new Error("list failed"); },
      close: async () => ["browser close failed"]
    });
    const combinedOutcome = await runApplication(env, combined.dependencies);
    expect(combinedOutcome.failures.map((failure) => failure.type)).toEqual(expect.arrayContaining(["acquisition-failure", "cleanup-failure"]));
    expect(combinedOutcome.exitCode).toBe(1);
  });

  it("stops before authentication when artifact maintenance fails", async () => {
    const setup = makeDependencies({ cleanupArtifacts: async () => { throw new Error("artifact cleanup failed"); } });
    const outcome = await runApplication(env, setup.dependencies);
    expect(outcome).toMatchObject({ runStatus: "unexpected-failure", exitCode: 1 });
    expect(outcome.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "artifact-maintenance", status: "failed", reason: "artifact cleanup failed" })
    ]));
    expect(setup.state.fetched).toEqual([]);
  });

  it("records a failure when diagnostic artifacts cannot be saved", async () => {
    const setup = makeDependencies({
      fetchDetail: async () => { throw new Error("detail unavailable"); },
      saveArtifact: async () => { throw new Error("artifact save failed"); }
    });
    const outcome = await runApplication(env, setup.dependencies);
    expect(outcome).toMatchObject({ runStatus: "unexpected-failure", exitCode: 1 });
    expect(outcome.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "artifact-maintenance", status: "failed", reason: "artifact save failed" })
    ]));
  });

  it("converts Slack message generation errors into notification failure without calling the notifier", async () => {
    const setup = makeDependencies({ buildMessages: () => { throw new Error("message build failed"); } });
    const outcome = await runApplication(env, setup.dependencies);
    expect(outcome).toMatchObject({
      runStatus: "notification-failure",
      exitCode: 1,
      notification: { status: "failed", reason: "message build failed" }
    });
    expect(setup.state.notified).toBe(0);
  });
});

function eventInfo(item: EventListItem): EventInfo {
  return { name: item.name, detailUrl: item.detailUrl, startAt: null, endAt: null, venue: null, tickets: [] };
}

function resultFor(name: string, ok: boolean): EventValidationOutcome {
  const base = validateEvent(eventInfo({ name, detailUrl: `https://example.com/${name}` }));
  const validationResults: ValidationResult[] = ok ? [] : [{
    ruleId: "TEST-NG",
    businessGroup: "テスト",
    confirmationArea: "SYSTEM",
    judgmentUnit: "EVENT",
    status: "failed",
    eventId: base.event.eventId,
    applicabilityReferences: [],
    inspectedFields: [],
    message: "business NG"
  }];
  const eventStatus = ok ? "ok" : "failed";
  return { ...base, eventStatus, validationResults, event: { ...base.event, eventStatus, validationResults } };
}

function nodeError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
