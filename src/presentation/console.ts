import type { EventDisplayContext } from "../domain/model.js";
import type { RunSummary } from "../results/model.js";
import { diagnosticIssueLine, validationIssueLine } from "./issues.js";

export function buildConsoleLines(summary: RunSummary): string[] {
  const combined = summary.failedAndUnknownCount;
  const lines = [
    `猫町イベントチェック: ${summary.targetLabel}`,
    `対象 ${summary.checkedCount} / 対象外 ${summary.excludedCount} / 対象判定不能 ${summary.undeterminedCount} / OK ${summary.okCount} / NG ${summary.ngCount} / 判定不能 ${summary.unknownCount}${combined > 0 ? ` / NG＋判定不能 ${combined}` : ""}`
  ];
  for (const context of summary.events.filter((event) => event.eventStatus !== "ok")) {
    const label = context.eventStatus === "failed-and-unknown" ? "NG＋UNKNOWN" : context.eventStatus === "unknown" || context.eligibilityStatus === "undetermined" ? "UNKNOWN" : "NG";
    lines.push(`${label}: ${context.name.state === "present" ? context.name.value : "取得不能"}`);
    lines.push(`  ${context.detailUrl}`);
    for (const error of consoleIssueLines(context)) lines.push(`  - ${error}`);
  }
  return lines;
}

export function printConsoleSummary(summary: RunSummary, logger: Pick<Console, "log"> = console): void {
  for (const line of buildConsoleLines(summary)) logger.log(line);
}

function consoleIssueLines(context: EventDisplayContext): string[] {
  const failures = context.validationResults.filter((item) => item.status === "failed").map((item) => validationIssueLine(context, item));
  const unknowns = context.validationResults
    .filter((item) => item.status === "unknown")
    .map((item) => validationIssueLine(context, item));
  const diagnostics = context.classificationDiagnostics.map((item) => diagnosticIssueLine(context, item));
  return [...failures, ...unknowns, ...diagnostics, ...context.eligibilityReasons.filter(() => context.eligibilityStatus === "undetermined")];
}
