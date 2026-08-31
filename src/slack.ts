import type { DeliveryMode, EventDisplayContext } from "./domain/model.js";
import type { RunSummary } from "./results/model.js";
import { SlackApiTransport } from "./notification/slack-client.js";
import { createPlannedSlackMessages, sendSlackMessagesWithPersistentProgress } from "./notification/slack-progress.js";
import { printConsoleSummary } from "./presentation/console.js";
import { diagnosticIssueLine, validationIssueLine } from "./presentation/issues.js";
import type { NotificationOutcome } from "./run/model.js";

export { isRetryableSlackFailure } from "./notification/slack-client.js";

export function createSlackDryRunOutcome(messages: string[]): NotificationOutcome {
  const plannedMessageIds = messages.map((_message, index) => `message-${index + 1}`);
  messages.forEach((message, index) => {
    console.log(`--- Slack dry-run ${index + 1}/${messages.length} ---`);
    console.log(message);
  });
  console.log(`Slack dry-run: ${plannedMessageIds.length}件の本文を生成し、送信は行いませんでした`);
  return { status: "dry-run", plannedMessageIds, sentMessageIds: [], attempts: 0 };
}

export async function postSummaryToSlack(token: string | undefined, channel: string, summary: RunSummary): Promise<NotificationOutcome> {
  return postMessagesToSlack(token, channel, buildSlackMessages(summary));
}

export async function postFatalErrorToSlack(
  token: string | undefined,
  channel: string,
  error: unknown,
  executedAt = new Date()
): Promise<NotificationOutcome> {
  return postMessagesToSlack(token, channel, [buildFatalErrorMessage(error, executedAt)]);
}

export async function postFailureSummaryToSlack(
  token: string | undefined,
  channel: string,
  summary: RunSummary,
  error: unknown
): Promise<NotificationOutcome> {
  return postMessagesToSlack(token, channel, [buildFatalErrorMessage(error, summary.executedAt), ...buildSlackMessages(summary)]);
}

export function buildFatalErrorMessage(error: unknown, executedAt: Date): string {
  const errorMessage = error instanceof Error ? error.message : String(error);
  return [
    "🚨 猫町イベントチェック実行失敗",
    "",
    "チェック処理が途中で終了しました。",
    `エラー: ${errorMessage}`,
    `実行日時: ${formatDateTime(executedAt)}`
  ].join("\n");
}

async function postMessagesToSlack(token: string | undefined, channel: string, messages: string[]): Promise<NotificationOutcome> {
  const outcome = await sendBuiltMessagesToSlack(token, channel, messages);
  if (outcome.status === "failed") throw new Error(outcome.reason ?? "Slack投稿に失敗しました");
  console.log(`Slack通知完了: ${outcome.sentMessageIds.length}/${outcome.plannedMessageIds.length}件、試行${outcome.attempts}回`);
  return outcome;
}

export async function sendBuiltMessagesToSlack(token: string | undefined, channel: string, messages: string[]): Promise<NotificationOutcome> {
  const planned = createPlannedSlackMessages(messages);
  if (!token) {
    return { status: "failed", plannedMessageIds: planned.map((message) => message.id), sentMessageIds: [], unsentMessageIds: planned.map((message) => message.id), attempts: 0, reason: "SLACK_BOT_TOKEN が未設定のため、Slackへ通知できません。" };
  }
  return sendSlackMessagesWithPersistentProgress(
    new SlackApiTransport(token),
    channel,
    planned
  );
}

export function buildSlackMessages(summary: RunSummary): string[] {
  const abnormalResults = summary.events.filter((event) => event.eventStatus !== "ok");
  const unknownCount = summary.unknownCount;
  const combinedCount = summary.failedAndUnknownCount;
  const header =
    unknownCount > 0 || combinedCount > 0 || summary.undeterminedCount > 0
      ? "🚨 猫町イベントチェックに判定不能あり"
      : summary.ngCount === 0
      ? "✅ 猫町イベントチェック完了"
      : "🚨 猫町イベントチェックで不備を検出";

  const lines = [
    header,
    "",
    `対象: ${summary.targetLabel}`,
    `チェック対象: ${summary.checkedCount}件`,
    `対象外: ${summary.excludedCount}件`,
    `対象判定不能: ${summary.undeterminedCount}件`,
    `OK: ${summary.okCount}件`,
    `NG: ${summary.ngCount}件`,
    `UNKNOWN: ${unknownCount}件`,
    ...(combinedCount > 0 ? [`NG＋UNKNOWN: ${combinedCount}件`] : []),
    ...(summary.executionComplete && summary.acquisitionComplete && summary.checkedCount > 0 && summary.undeterminedCount === 0
      && summary.ngCount === 0 && unknownCount === 0 && combinedCount === 0 ? ["結果: すべてOK"] : []),
    `実行日時: ${formatDateTime(summary.executedAt)}`
  ];
  const counters = { NG: 0, UNKNOWN: 0, "NG＋UNKNOWN": 0 };
  const blocks = abnormalResults.map((context) => {
    const category = context.eventStatus === "failed-and-unknown"
      ? "NG＋UNKNOWN"
      : context.eventStatus === "unknown" || context.eligibilityStatus === "undetermined"
        ? "UNKNOWN"
        : "NG";
    counters[category] += 1;
    const statuses: Array<"failed" | "unknown"> = category === "NG＋UNKNOWN" ? ["failed", "unknown"] : category === "UNKNOWN" ? ["unknown"] : ["failed"];
    return [
      `【${category} ${counters[category]}】`,
      `イベント名: ${formatEventNameWithStartAt(context.name.state === "present" ? context.name.value : "取得不能", context.startAt.state === "present" ? context.startAt.value : null)}`,
      `イベント種別: ${kindLabel(context.deliveryMode)}`,
      `詳細URL: ${context.detailUrl}`,
      category === "UNKNOWN" ? "判定不能理由:" : category === "NG＋UNKNOWN" ? "不備・判定不能理由:" : "不備:",
      ...outcomeIssueLines(context, statuses).map((error) => `- ${error}`)
    ].join("\n");
  });

  return splitSlackSections(lines.join("\n"), blocks);
}

function outcomeIssueLines(context: EventDisplayContext, statuses: Array<"failed" | "unknown">): string[] {
  const validation = context.validationResults
    .filter((item) => statuses.includes(item.status as "failed" | "unknown"))
    .map((item) => validationIssueLine(context, item));
  const diagnostics = statuses.includes("unknown")
    ? context.classificationDiagnostics.map((item) => diagnosticIssueLine(context, item))
    : [];
  const eligibility = statuses.includes("unknown") && context.eligibilityStatus === "undetermined" ? context.eligibilityReasons : [];
  return [...validation, ...diagnostics, ...eligibility];
}

export function printSummary(summary: RunSummary): void {
  printConsoleSummary(summary);
}

function splitSlackSections(header: string, blocks: string[]): string[] {
  const contentLimit = 3840;
  const sections = [header, ...blocks];
  const chunks: string[] = [];
  let current = "";
  for (const section of sections) {
    const parts = splitLongSection(section, contentLimit);
    for (const part of parts) {
      const candidate = current ? `${current}\n\n${part}` : part;
      if (candidate.length <= contentLimit) current = candidate;
      else {
        if (current) chunks.push(current);
        current = part;
      }
    }
  }
  if (current) chunks.push(current);
  if (chunks.length <= 1) return chunks;
  return chunks.map((chunk, index) => `【Slack ${index + 1}/${chunks.length}】\n${chunk}`);
}

function splitLongSection(section: string, max: number): string[] {
  if (section.length <= max) return [section];
  const parts: string[] = [];
  let rest = section;
  while (rest.length > max) {
    const newline = rest.lastIndexOf("\n", max);
    const cut = newline > 0 ? newline : max;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

function formatDateTime(date: Date): string {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}`;
}

function formatEventNameWithStartAt(eventName: string, startAt: Date | null): string {
  if (!startAt) return eventName;
  return `${eventName}（開催日時: ${formatDateTime(startAt)}）`;
}

function kindLabel(kind: DeliveryMode | undefined): string {
  return kind === "online" ? "オンライン" : kind === "offline" ? "オフライン" : kind === "hybrid" ? "オフ＋オン" : "取得不能";
}
