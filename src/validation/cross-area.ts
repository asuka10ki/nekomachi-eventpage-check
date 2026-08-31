import { hasRole, type DerivedEvent, type RulePlan, type ValidationResult } from "../domain/model.js";
import { extractReceptionStartTimeFromBody, extractReceptionStartTimeFromNotice } from "../utils/date.js";
import { resolveEventBookTitle, validateTicketNameBookTitle } from "../utils/ticket.js";
import { notificationTargets } from "../policy/rule-plan.js";
import { nonApplicableResult, result } from "./common.js";

export function validateCrossArea(derived: DerivedEvent, plans: RulePlan[]): ValidationResult[] {
  return plans.filter((plan) => plan.ruleId === "AREA-001" || plan.ruleId === "AREA-002").map((plan) => {
    const group = plan.ruleId === "AREA-001" ? "オンライン案内" : "書名";
    const nonApplicable = nonApplicableResult(plan, group, "MULTI_AREA", "CROSS_AREA");
    if (nonApplicable) return nonApplicable;
    return plan.ruleId === "AREA-001" ? validateReception(derived, plan) : validateBookTitles(derived, plan);
  });
}

function validateReception(derived: DerivedEvent, plan: RulePlan): ValidationResult {
  const body = derived.event.bodyText;
  if (body.state === "unavailable" || body.state === "invalid") return result(plan, "オンライン案内", "MULTI_AREA", "CROSS_AREA", "unknown", "本文の受付開始時刻を確認できません", { reason: "本文を取得できません" });
  const bodyTime = body.state === "present" ? extractReceptionStartTimeFromBody(body.value) : null;
  if (!bodyTime) return result(plan, "オンライン案内", "MULTI_AREA", "CROSS_AREA", "skipped", "本文に受付開始時刻がないため比較しません");
  if (derived.event.startAt.state !== "present") return result(plan, "オンライン案内", "MULTI_AREA", "CROSS_AREA", "unknown", "受付開始時刻を比較できません", { reason: "開催日時を取得できません" });
  const allTargets = notificationTargets(derived);
  const errors: string[] = [];
  for (const ticket of allTargets) {
    if (ticket.organizerNotice.state === "empty") {
      errors.push(`[${ticket.position}番目] 見つかりません`);
      continue;
    }
    if (ticket.organizerNotice.state !== "present") continue;
    const actual = extractReceptionStartTimeFromNotice(ticket.organizerNotice.value, derived.event.startAt.value);
    if (actual !== bodyTime) errors.push(`[${ticket.position}番目] ${actual ?? "見つかりません"}`);
  }
  if (errors.length > 0) return result(plan, "オンライン案内", "MULTI_AREA", "CROSS_AREA", "failed", `主催者からのお知らせの受付開始時刻がページ本文と一致していません。期待: ${bodyTime} / 実際: ${errors.join(" / ")}`);
  const uncertainOperationTarget = derived.tickets.some((ticket) => hasRole(ticket, "operation-member") && ticket.onlineEnabled.state !== "present");
  if (uncertainOperationTarget || allTargets.some((ticket) => ticket.organizerNotice.state === "unavailable" || ticket.organizerNotice.state === "invalid")) {
    return result(plan, "オンライン案内", "MULTI_AREA", "CROSS_AREA", "unknown", "受付開始時刻を比較できません", {
      reason: uncertainOperationTarget ? "運営メンバー券のオンライン開催設定を取得できません" : "お知らせ欄を取得できない券があります"
    });
  }
  return result(plan, "オンライン案内", "MULTI_AREA", "CROSS_AREA", "passed", "本文と各券のお知らせの受付開始時刻は一致しています");
}

function validateBookTitles(derived: DerivedEvent, plan: RulePlan): ValidationResult {
  if (derived.event.name.state !== "present") return result(plan, "書名", "MULTI_AREA", "CROSS_AREA", "unknown", "イベント書名を確認できません", { reason: "イベント名を取得できません" });
  const eventName = derived.event.name.value;
  const eventBook = resolveEventBookTitle(eventName);
  if (eventBook.status === "none") return result(plan, "書名", "MULTI_AREA", "CROSS_AREA", "skipped", "イベント名に括弧付き書名がないため比較しません");
  if (eventBook.status === "ambiguous") return result(plan, "書名", "MULTI_AREA", "CROSS_AREA", "unknown", "イベント書名を確認できません", {
    reason: `最長の書名候補が複数あります: ${eventBook.candidates.join("、")}`
  });
  const tickets = derived.tickets.filter((ticket) => !hasRole(ticket, "plan-change") && !hasRole(ticket, "operation-member"));
  if (tickets.some((ticket) => ticket.name.state === "unavailable" || ticket.name.state === "invalid")) return result(plan, "書名", "MULTI_AREA", "CROSS_AREA", "unknown", "チケット書名を確認できません", { reason: "券名を取得できない券があります" });
  const errors = tickets.flatMap((ticket) => {
    if (ticket.name.state !== "present") return [];
    const error = validateTicketNameBookTitle(eventName, ticket.name.value);
    return error ? [`[${ticket.position}番目] ${error}`] : [];
  });
  return result(plan, "書名", "MULTI_AREA", "CROSS_AREA", errors.length === 0 ? "passed" : "failed", errors.length === 0 ? "書名は一致しています" : errors.join(" / "));
}
