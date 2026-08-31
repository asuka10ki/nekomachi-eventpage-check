import type { EventInfo } from "../types.js";
import { deriveEvent } from "../domain/derive.js";
import { normalizeEvent } from "../domain/normalize.js";
import { hasRole, type ClassificationDiagnostic, type EventDisplayContext, type EventStatus, type EventValidationOutcome, type ValidationResult } from "../domain/model.js";
import { buildRulePlans } from "../policy/rule-plan.js";
import { aggregateEventStatus, assertUniqueValidationResults } from "../results/aggregate.js";
import { validateBody } from "./body.js";
import { validateCrossArea } from "./cross-area.js";
import { validateCrossTicket } from "./cross-ticket.js";
import { validateEventSettings } from "./event-setting.js";
import { validateTicketSets } from "./ticket-set.js";
import { validateTickets } from "./ticket.js";
import { attachInspectedFields } from "./inspected-fields.js";

export function validateEvent(eventInfo: EventInfo): EventValidationOutcome {
  const normalized = normalizeEvent(eventInfo);
  const derived = deriveEvent(normalized);
  if (derived.eligibility.status !== "target") {
    return { event: displayContext(derived, [], [], undefined), derived, plans: [], validationResults: [], classificationDiagnostics: [] };
  }
  const plans = buildRulePlans(derived);
  const rawValidationResults: ValidationResult[] = [
    ...validateEventSettings(derived, plans),
    ...validateBody(derived, plans),
    ...validateTickets(derived, plans),
    ...validateTicketSets(derived, plans),
    ...validateCrossTicket(derived, plans),
    ...validateCrossArea(derived, plans)
  ];
  const validationResults = attachInspectedFields(derived, plans, rawValidationResults);
  assertUniqueValidationResults(validationResults);
  const classificationDiagnostics = buildClassificationDiagnostics(derived);
  const eventStatus = aggregateEventStatus(validationResults, classificationDiagnostics.length);
  return {
    event: displayContext(derived, validationResults, classificationDiagnostics, eventStatus),
    derived,
    plans,
    validationResults,
    classificationDiagnostics,
    eventStatus
  };
}

function buildClassificationDiagnostics(derived: ReturnType<typeof deriveEvent>): ClassificationDiagnostic[] {
  return derived.tickets.filter((ticket) => hasRole(ticket, "unclassified")).map((ticket) => ({
    diagnosticId: "DIAG-ROLE-001",
    eventId: derived.event.eventId,
    ticketId: ticket.ticketId,
    status: "unknown",
    evidence: ticket.roles.evidence,
    message: "用途を分類できないチケットがあります",
    reason: "設定不備とは断定できず、分類ルール未対応の可能性があります"
  }));
}

function displayContext(
  derived: ReturnType<typeof deriveEvent>,
  validationResults: ValidationResult[],
  classificationDiagnostics: ClassificationDiagnostic[],
  eventStatus: EventStatus | undefined
): EventDisplayContext {
  return {
    eventId: derived.event.eventId,
    detailUrl: derived.event.detailUrl,
    name: derived.event.name,
    startAt: derived.event.startAt,
    deliveryMode: derived.attributes?.deliveryMode.state === "determined" ? derived.attributes.deliveryMode.value : undefined,
    eligibilityStatus: derived.eligibility.status,
    eligibilityReasons: [...derived.eligibility.reasons],
    eventStatus,
    validationResults,
    classificationDiagnostics,
    tickets: derived.tickets.map((ticket) => ({ ticketId: ticket.ticketId, position: ticket.position, name: ticket.name }))
  };
}
