import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import fs from "node:fs";
import { EVENT_LIST_URL, STORAGE_STATE_PATH, validateOperationalConfig, type AppEnv } from "../config.js";
import type { EventInfo, EventListItem } from "../types.js";
import { saveFailureArtifacts } from "../checker.js";
import { AcquisitionError, assertAdminEventListPageState } from "../acquisition/quality.js";
import { collectEventListsWithPagination, fetchEventInfoFromPage } from "../osiro.js";
import { sortEventsByStartAtDesc } from "../utils/sort.js";
import { assertEventCountHasNotDroppedUnexpectedly, loadPreviousEventCount, saveSuccessfulEventCount } from "../check-state.js";
import { saveStorageStateAtomically, type StorageStateWriter } from "./persistence.js";
import { closeResources, type Closable } from "./cleanup.js";
import { buildFatalErrorMessage, buildSlackMessages, createSlackDryRunOutcome, printSummary, sendBuiltMessagesToSlack } from "../slack.js";
import { createRunOutcome, type NotificationOutcome, type RunOutcome, type RunFailure, type StageResult } from "./model.js";
import { runReference } from "../domain/references.js";
import { validateEvent } from "../validation/engine.js";
import type { EventDisplayContext, EventValidationOutcome, ObservedReference, ValidationResult } from "../domain/model.js";
import type { RunSummary } from "../results/model.js";
import { pruneExpiredArtifacts } from "../artifacts/manager.js";

export type RuntimePage = Closable;
export type RuntimeContext = StorageStateWriter & { newPage(): Promise<RuntimePage> };
export type RuntimeHandles = { browser: Closable; context: RuntimeContext; listPage: RuntimePage };

export type RunDependencies = {
  storageStateExists(filePath: string): boolean;
  cleanupArtifacts(retentionDays: number): Promise<void>;
  launchRuntime(headless: boolean, storageStatePath: string): Promise<RuntimeHandles>;
  collectList(page: RuntimePage, listUrl: string): Promise<EventListItem[]>;
  fetchDetail(page: RuntimePage, item: EventListItem): Promise<EventInfo>;
  checkEvent(event: EventInfo): EventValidationOutcome;
  saveArtifact(page: RuntimePage, eventName: string): Promise<void>;
  loadEventCount(): Promise<number | null>;
  saveEventCount(count: number): Promise<void>;
  saveSession(context: RuntimeContext, listPage: RuntimePage): Promise<void>;
  close(resources: Array<{ label: string; resource: Closable }>): Promise<string[]>;
  present(summary: RunSummary): void;
  buildMessages(summary: RunSummary, executionError?: Error): string[];
  notify(env: AppEnv, messages: string[]): Promise<NotificationOutcome>;
  now(): Date;
};

export const defaultRunDependencies: RunDependencies = {
  storageStateExists: (filePath) => fs.existsSync(filePath),
  cleanupArtifacts: async (retentionDays) => { await pruneExpiredArtifacts({ retentionDays }); },
  launchRuntime: async (headless, storageStatePath) => {
    const browser = await chromium.launch({ headless });
    try {
      const context = await browser.newContext({ storageState: storageStatePath });
      const listPage = await context.newPage();
      return { browser, context, listPage };
    } catch (error) {
      await browser.close().catch(() => undefined);
      throw error;
    }
  },
  collectList: (page, listUrl) => collectEventListsWithPagination(page as Page, listUrl),
  fetchDetail: (page, item) => fetchEventInfoFromPage(page as Page, item),
  checkEvent: (event) => validateEvent(event),
  saveArtifact: (page, eventName) => saveFailureArtifacts(page as Page, eventName),
  loadEventCount: () => loadPreviousEventCount(),
  saveEventCount: (count) => saveSuccessfulEventCount(count),
  saveSession: async (context, listPage) => {
    const page = listPage as Page;
    assertAdminEventListPageState(page.url(), (await page.locator("#eventIndex").count()) > 0);
    await saveStorageStateAtomically(context, STORAGE_STATE_PATH);
  },
  close: (resources) => closeResources(resources),
  present: (summary) => printSummary(summary),
  buildMessages: (summary, executionError) => executionError
    ? [buildFatalErrorMessage(executionError, summary.executedAt), ...(summary.events.length > 0 ? buildSlackMessages(summary) : [])]
    : buildSlackMessages(summary),
  notify: async (env, messages) => env.slackDryRun
    ? createSlackDryRunOutcome(messages)
    : sendBuiltMessagesToSlack(env.slackBotToken, env.slackChannelId, messages),
  now: () => new Date()
};

export async function runApplication(env: AppEnv, dependencies: RunDependencies = defaultRunDependencies): Promise<RunOutcome> {
  const stages: StageResult[] = [];
  const displayEvents: EventDisplayContext[] = [];
  const allEvents: EventDisplayContext[] = [];
  let skippedCount = 0;
  let runtime: RuntimeHandles | undefined;
  let listItems: EventListItem[] = [];
  let previousCount: number | null = null;
  let fatalError: Error | undefined;
  let authenticationValid = true;

  try {
    validateOperationalConfig(env);
    if (env.artifactCleanupEnabled === false) {
      stages.push({ stage: "artifact-maintenance", status: "skipped", reason: "ARTIFACT_CLEANUP_ENABLED=false" });
    } else {
      try {
        await dependencies.cleanupArtifacts(env.artifactRetentionDays ?? 30);
        stages.push({ stage: "artifact-maintenance", status: "completed" });
      } catch (error) {
        stages.push(failedStage("artifact-maintenance", "unexpected-failure", error));
        fatalError = asError(error);
      }
    }
    if (!fatalError && !dependencies.storageStateExists(STORAGE_STATE_PATH)) {
      authenticationValid = false;
      throw new AcquisitionError("QUAL-LIST-002", `${STORAGE_STATE_PATH} がありません。先に npm run auth を実行してください。`);
    }
    if (!fatalError) stages.push({ stage: "initialization", status: "completed" });
    if (!fatalError) try {
      previousCount = await dependencies.loadEventCount();
      stages.push({
        stage: "state-persistence",
        status: "completed",
        reason: previousCount === null ? "前回件数状態は不存在（初回実行）です" : "前回件数状態を読み取りました",
        references: [runReference("STATE_FILE", "STATE", "previousEventCount", previousCount === null ? "empty" : "present")]
      });
    } catch (error) {
      stages.push(failedStage("state-persistence", "state-failure", error, undefined, [runReference("STATE_FILE", "STATE", "previousEventCount", "unavailable", safeReason(error))]));
      fatalError = asError(error);
    }

    if (!fatalError) {
      try {
        runtime = await dependencies.launchRuntime(env.headless, STORAGE_STATE_PATH);
        stages.push({ stage: "authentication", status: "completed" });
      } catch (error) {
        stages.push(failedStage("authentication", "authentication-failure", error));
        fatalError = asError(error);
        authenticationValid = false;
      }
    }

    if (!fatalError && runtime) {
      try {
        listItems = await dependencies.collectList(runtime.listPage, EVENT_LIST_URL);
        assertEventCountHasNotDroppedUnexpectedly(previousCount, listItems.length);
        stages.push({ stage: "list-acquisition", status: "completed", references: [runReference("LIST_PAGE", "EVENT", "eventList", "present")] });
      } catch (error) {
        const authenticationFailure = isAuthenticationFailure(error);
        stages.push(failedStage(authenticationFailure ? "authentication" : "list-acquisition", authenticationFailure ? "authentication-failure" : "acquisition-failure", error, undefined, [runReference("LIST_PAGE", "EVENT", "eventList", "unavailable", safeReason(error))]));
        fatalError = asError(error);
        authenticationValid = !authenticationFailure;
      }
    }

    if (!fatalError && runtime) {
      for (const item of listItems) {
        const detailPage = await runtime.context.newPage();
        let stopAfterThisEvent = false;
        try {
          let event: EventInfo | undefined;
          try {
            event = await dependencies.fetchDetail(detailPage, item);
            stages.push({ stage: "detail-acquisition", status: "completed", eventId: item.detailUrl, references: [runReference("DETAIL_PAGE", "EVENT", "eventDetail", "present", undefined, item.detailUrl)] });
          } catch (error) {
            if (isAuthenticationFailure(error)) {
              authenticationValid = false;
              fatalError = asError(error);
              stopAfterThisEvent = true;
              stages.push(failedStage("authentication", "authentication-failure", error, item.detailUrl));
            } else {
              stages.push(failedStage("detail-acquisition", "partial-success", error, item.detailUrl));
              try {
                await dependencies.saveArtifact(detailPage, item.name);
              } catch (artifactError) {
                stages.push(failedStage("artifact-maintenance", "unexpected-failure", artifactError, item.detailUrl));
                fatalError ??= asError(artifactError);
              }
              const unknownContext = detailUnknown(item, error);
              displayEvents.push(unknownContext);
              allEvents.push(unknownContext);
            }
          }

          if (event) try {
            const checked = dependencies.checkEvent(event);
            allEvents.push(checked.event);
            if (checked.event.eligibilityStatus === "excluded") skippedCount += 1;
            else displayEvents.push(checked.event);
            stages.push({ stage: "validation", status: "completed", eventId: item.detailUrl });
          } catch (error) {
            fatalError = asError(error);
            stopAfterThisEvent = true;
            stages.push(failedStage("validation", "unexpected-failure", error, item.detailUrl));
          }
        } finally {
          try {
            await detailPage.close();
          } catch (error) {
            stages.push(failedStage("cleanup", "cleanup-failure", new Error(`イベント詳細ページ終了に失敗しました: ${safeReason(error)}`), item.detailUrl));
          }
        }
        if (stopAfterThisEvent) break;
      }
    }

    if (listItems.length >= 0 && stages.some((stage) => stage.stage === "list-acquisition" && stage.status === "completed")) {
      try {
        await dependencies.saveEventCount(listItems.length);
        stages.push({ stage: "state-persistence", status: "completed" });
      } catch (error) {
        stages.push(failedStage("state-persistence", "state-failure", error));
        fatalError ??= asError(error);
      }
    }

    if (runtime && authenticationValid && stages.some((stage) => stage.stage === "list-acquisition" && stage.status === "completed")) {
      try {
        await dependencies.saveSession(runtime.context, runtime.listPage);
        stages.push({ stage: "state-persistence", status: "completed" });
      } catch (error) {
        stages.push(failedStage("state-persistence", "state-failure", error));
        fatalError ??= asError(error);
      }
    } else if (runtime) {
      stages.push({ stage: "state-persistence", status: "skipped", reason: "認証状態を確認できないためログイン状態を保存しません" });
    }
  } catch (error) {
    const authenticationFailure = isAuthenticationFailure(error);
    stages.push(failedStage(authenticationFailure ? "authentication" : "unexpected", authenticationFailure ? "authentication-failure" : "unexpected-failure", error));
    fatalError = asError(error);
  } finally {
    if (runtime) {
      const cleanupErrors = await dependencies.close([
        { label: "一覧ページ", resource: runtime.listPage },
        { label: "ブラウザ", resource: runtime.browser }
      ]);
      if (cleanupErrors.length === 0) stages.push({ stage: "cleanup", status: "completed" });
      for (const reason of cleanupErrors) {
        stages.push({ stage: "cleanup", status: "failed", failureType: "cleanup-failure", reason });
        fatalError ??= new Error(reason);
      }
    } else {
      stages.push({ stage: "cleanup", status: "skipped", reason: "起動済みリソースがないため" });
    }
  }

  const summary = aggregateSummary(displayEvents, skippedCount, dependencies.now(), {
    executionComplete: !stages.some((stage) => stage.status === "failed"),
    acquisitionComplete: !stages.some((stage) => (stage.stage === "list-acquisition" || stage.stage === "detail-acquisition") && stage.status === "failed")
  });
  stages.push({ stage: "aggregation", status: "completed" });
  try {
    dependencies.present(summary);
    stages.push({ stage: "presentation", status: "completed" });
  } catch (error) {
    stages.push(failedStage("presentation", "unexpected-failure", error));
    fatalError ??= asError(error);
    summary.executionComplete = false;
  }

  const technicalReasons = stages.filter((stage) => stage.status === "failed").map((stage) => stage.reason).filter((reason): reason is string => Boolean(reason));
  const notificationError = fatalError ?? (technicalReasons.length > 0 ? new Error(technicalReasons.join(" / ")) : undefined);
  let notification: NotificationOutcome;
  try {
    const messages = dependencies.buildMessages(summary, notificationError);
    notification = await dependencies.notify(env, messages);
    stages.push(notification.status === "failed"
      ? { stage: "notification", status: "failed", failureType: "notification-failure", reason: notification.reason ?? "Slack通知に失敗しました" }
      : { stage: "notification", status: "completed" });
  } catch (error) {
    notification = { status: "failed", plannedMessageIds: [], sentMessageIds: [], unsentMessageIds: [], attempts: 0, reason: safeReason(error) };
    stages.push(failedStage("notification", "notification-failure", error));
  }

  return createRunOutcome(stages, allEvents, notification, summary);
}

export function aggregateSummary(
  events: EventDisplayContext[],
  excludedCount: number,
  executedAt: Date,
  completeness: Pick<RunSummary, "executionComplete" | "acquisitionComplete">
): RunSummary {
  const sortedEvents = sortEventsByStartAtDesc(events);
  const targetEvents = sortedEvents.filter((event) => event.eligibilityStatus === "target");
  return {
    targetLabel: "募集中イベント",
    ...completeness,
    checkedCount: targetEvents.length,
    excludedCount,
    undeterminedCount: sortedEvents.filter((event) => event.eligibilityStatus === "undetermined").length,
    okCount: targetEvents.filter((event) => event.eventStatus === "ok").length,
    ngCount: targetEvents.filter((event) => event.eventStatus === "failed").length,
    unknownCount: targetEvents.filter((event) => event.eventStatus === "unknown").length,
    failedAndUnknownCount: targetEvents.filter((event) => event.eventStatus === "failed-and-unknown").length,
    events: sortedEvents,
    executedAt
  };
}

function detailUnknown(item: EventListItem, error: unknown): EventDisplayContext {
  const eventId = eventIdFromUrl(item.detailUrl);
  const reason = `詳細取得失敗: ${safeReason(error)}`;
  const reference: ObservedReference = runReference("DETAIL_PAGE", "EVENT", "eventDetail", "unavailable", reason, eventId);
  const validation: ValidationResult = {
    ruleId: "QUAL-DETAIL-ACQUISITION",
    businessGroup: "取得品質",
    confirmationArea: "SYSTEM",
    judgmentUnit: "ACQUISITION",
    status: "unknown",
    eventId,
    applicabilityReferences: [reference],
    inspectedFields: [reference],
    message: reason,
    reason
  };
  return {
    eventId,
    detailUrl: item.detailUrl,
    name: item.name ? { state: "present", value: item.name } : { state: "unavailable", reason: "一覧からイベント名を取得できません" },
    startAt: { state: "unavailable", reason: "詳細を取得できないため開始日時を確認できません" },
    eligibilityStatus: "undetermined",
    eligibilityReasons: [],
    eventStatus: "unknown",
    validationResults: [validation],
    classificationDiagnostics: [],
    tickets: []
  };
}

function eventIdFromUrl(url: string): string {
  return url.match(/\/admin_events\/([^/]+)\/edit/)?.[1] ?? url;
}

function failedStage(
  stage: StageResult["stage"],
  failureType: RunFailure["type"],
  error: unknown,
  eventId?: string,
  references?: StageResult["references"]
): StageResult {
  return { stage, status: "failed", failureType, reason: safeReason(error), eventId, references };
}

function isAuthenticationFailure(error: unknown): boolean {
  return error instanceof AcquisitionError && ["QUAL-LIST-002", "QUAL-DETAIL-002"].includes(error.ruleId)
    || error instanceof Error && error.message.includes("ログイン状態が期限切れ");
}

function safeReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export type { Browser, BrowserContext, Page };
