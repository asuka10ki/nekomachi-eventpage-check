import { isApplicationDeadlineWithinEventRange } from "../utils/date.js";
import type { DerivedEvent, RulePlan, ValidationResult } from "../domain/model.js";
import { nonApplicableResult, result } from "./common.js";

export function validateEventSettings(derived: DerivedEvent, plans: RulePlan[]): ValidationResult[] {
  return plans.filter((plan) => plan.ruleId === "EVT-001").map((plan) => {
    const nonApplicable = nonApplicableResult(plan, "申込締切", "EVENT_SETTING", "EVENT_SETTING");
    if (nonApplicable) return nonApplicable;
    const start = derived.event.startAt;
    const deadline = derived.event.applicationDeadline;
    if (start.state !== "present" || deadline.state === "unavailable") {
      return result(plan, "申込締切", "EVENT_SETTING", "EVENT_SETTING", "unknown", "申込締切日を確認できません", { reason: "開催日時または申込締切欄を取得できません" });
    }
    if (deadline.state !== "present") {
      return result(plan, "申込締切", "EVENT_SETTING", "EVENT_SETTING", "failed", "申込締切日を入力してください");
    }
    const ok = isApplicationDeadlineWithinEventRange(start.value, deadline.value);
    const expectedEnd = `${start.value.getFullYear()}/${String(start.value.getMonth() + 1).padStart(2, "0")}/${String(start.value.getDate()).padStart(2, "0")}`;
    const earliest = new Date(start.value.getFullYear(), start.value.getMonth(), start.value.getDate() - 3);
    const expectedStart = `${earliest.getFullYear()}/${String(earliest.getMonth() + 1).padStart(2, "0")}/${String(earliest.getDate()).padStart(2, "0")}`;
    const failureMessage = `申込締切日は開催日の3日前から開催日までにしてください。期待: ${expectedStart}〜${expectedEnd} / 実際: ${deadline.value}`;
    return result(plan, "申込締切", "EVENT_SETTING", "EVENT_SETTING", ok ? "passed" : "failed", ok ? "申込締切日は正常です" : failureMessage, {
      expected: `${expectedStart}〜${expectedEnd}`,
      actual: deadline.value
    });
  });
}
