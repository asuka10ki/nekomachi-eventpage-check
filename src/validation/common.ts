import type { ConfirmationArea, JudgmentUnit, RulePlan, ValidationResult, ValidationStatus } from "../domain/model.js";

export function result(
  plan: RulePlan,
  businessGroup: string,
  confirmationArea: ConfirmationArea,
  judgmentUnit: JudgmentUnit,
  status: ValidationStatus,
  message: string,
  details: Pick<ValidationResult, "expected" | "actual" | "reason"> = {}
): ValidationResult {
  return {
    ruleId: plan.ruleId,
    businessGroup,
    confirmationArea,
    judgmentUnit,
    status,
    eventId: plan.eventId,
    ticketIds: plan.ticketIds,
    applicabilityReferences: plan.applicabilityReferences,
    inspectedFields: [],
    message,
    ...details
  };
}

export function nonApplicableResult(
  plan: RulePlan,
  businessGroup: string,
  confirmationArea: ConfirmationArea,
  judgmentUnit: JudgmentUnit
): ValidationResult | undefined {
  if (plan.applicability === "applicable") return undefined;
  return result(
    plan,
    businessGroup,
    confirmationArea,
    judgmentUnit,
    plan.applicability,
    plan.applicability === "unknown" ? "適用条件を判定できません" : "適用対象外です",
    { reason: plan.reason }
  );
}
