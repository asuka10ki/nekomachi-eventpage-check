import type { EventDisplayContext, ObservedReference } from "../domain/model.js";
import type { RunSummary } from "../results/model.js";

export type StageResult = {
  stage: "initialization" | "configuration" | "artifact-maintenance" | "authentication" | "list-acquisition" | "detail-acquisition" | "classification" | "validation" | "aggregation" | "state-persistence" | "persistence" | "presentation" | "notification" | "cleanup" | "unexpected";
  status: "completed" | "partial" | "failed" | "skipped";
  eventId?: string;
  reason?: string;
  failureType?: Exclude<RunStatus, "success" | "business-failure">;
  references?: ObservedReference[];
};

export type RunStatus =
  | "success"
  | "partial-success"
  | "business-failure"
  | "acquisition-failure"
  | "authentication-failure"
  | "state-failure"
  | "notification-failure"
  | "cleanup-failure"
  | "unexpected-failure";

export type RunFailure = {
  type: Exclude<RunStatus, "success" | "business-failure">;
  stage: StageResult["stage"];
  reason: string;
  eventId?: string;
};

export type NotificationOutcome = {
  status: "sent" | "dry-run" | "failed";
  plannedMessageIds: string[];
  sentMessageIds: string[];
  unsentMessageIds?: string[];
  slackMessageIds?: Record<string, string>;
  attempts: number;
  reason?: string;
};

export type RunOutcome = {
  runStatus: RunStatus;
  executionStatus: "completed" | "failed";
  acquisitionStatus: "complete" | "partial" | "failed";
  stages: StageResult[];
  events: EventDisplayContext[];
  summary?: RunSummary;
  notification: NotificationOutcome;
  failures: RunFailure[];
  exitCode: 0 | 1;
};

export function createRunOutcome(
  stages: StageResult[],
  events: EventDisplayContext[],
  notification: NotificationOutcome,
  summary?: RunSummary
): RunOutcome {
  const acquisitionStages = stages.filter((stage) => stage.stage === "list-acquisition" || stage.stage === "detail-acquisition");
  const listFailed = acquisitionStages.some((stage) => stage.stage === "list-acquisition" && stage.status === "failed");
  const detailFailed = acquisitionStages.some((stage) => stage.stage === "detail-acquisition" && stage.status === "failed");
  const acquisitionStatus: RunOutcome["acquisitionStatus"] = listFailed ? "failed" : detailFailed ? "partial" : "complete";
  const executionStatus: RunOutcome["executionStatus"] = stages.some((stage) => stage.status === "failed") || notification.status === "failed"
    ? "failed"
    : "completed";
  const failures = stages.flatMap((stage): RunFailure[] => stage.status === "failed"
    ? [{ type: stage.failureType ?? defaultFailureType(stage.stage, acquisitionStatus), stage: stage.stage, reason: stage.reason ?? "原因不明", eventId: stage.eventId }]
    : []);
  if (notification.status === "failed" && !failures.some((failure) => failure.type === "notification-failure")) {
    failures.push({ type: "notification-failure", stage: "notification", reason: notification.reason ?? "Slack通知に失敗しました" });
  }
  const hasBusinessIssue = events.some((event) => event.eventStatus && event.eventStatus !== "ok")
    || Boolean(summary && (summary.ngCount > 0 || (summary.unknownCount ?? 0) > 0 || (summary.failedAndUnknownCount ?? 0) > 0));
  const runStatus = determineRunStatus(failures, acquisitionStatus, hasBusinessIssue);
  return {
    runStatus,
    executionStatus,
    acquisitionStatus,
    stages: [...stages],
    events: [...events],
    summary,
    notification,
    failures,
    exitCode: executionStatus === "completed" ? 0 : 1
  };
}

function defaultFailureType(stage: StageResult["stage"], acquisitionStatus: RunOutcome["acquisitionStatus"]): RunFailure["type"] {
  if (stage === "authentication") return "authentication-failure";
  if (stage === "list-acquisition" || stage === "detail-acquisition") return acquisitionStatus === "partial" ? "partial-success" : "acquisition-failure";
  if (stage === "state-persistence" || stage === "persistence") return "state-failure";
  if (stage === "notification") return "notification-failure";
  if (stage === "cleanup") return "cleanup-failure";
  return "unexpected-failure";
}

function determineRunStatus(failures: RunFailure[], acquisitionStatus: RunOutcome["acquisitionStatus"], hasBusinessIssue: boolean): RunStatus {
  const priority: RunFailure["type"][] = [
    "unexpected-failure", "authentication-failure", "state-failure", "acquisition-failure", "cleanup-failure", "notification-failure", "partial-success"
  ];
  const primary = priority.find((type) => failures.some((failure) => failure.type === type));
  if (primary) return primary;
  if (acquisitionStatus === "partial") return "partial-success";
  return hasBusinessIssue ? "business-failure" : "success";
}
