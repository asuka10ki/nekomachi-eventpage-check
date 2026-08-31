import type { DerivedEvent, RulePlan, ValidationResult } from "../domain/model.js";
import { evidenceReferences, eventReference, ticketReference, uniqueReferences } from "../domain/references.js";

export function attachInspectedFields(
  derived: DerivedEvent,
  plans: RulePlan[],
  results: ValidationResult[]
): ValidationResult[] {
  return results.map((result) => {
    const plan = plans.find((candidate) => candidate.ruleId === result.ruleId
      && sameIds(candidate.ticketIds, result.ticketIds));
    return {
      ...result,
      applicabilityReferences: plan?.applicabilityReferences ?? result.applicabilityReferences,
      inspectedFields: result.status === "skipped" && plan?.applicability !== "applicable"
        ? []
        : inspectedFieldsForRule(derived, result)
    };
  });
}

function inspectedFieldsForRule(derived: DerivedEvent, result: ValidationResult): ValidationResult["inspectedFields"] {
  const refs: ValidationResult["inspectedFields"] = [];
  const tickets = derived.tickets.filter((ticket) => !result.ticketIds || result.ticketIds.includes(ticket.ticketId));
  const addTicket = (field: "name" | "price" | "visibility" | "onlineEnabled" | "onlineUrl" | "organizerNotice") => {
    refs.push(...tickets.map((ticket) => ticketReference(derived.event.eventId, ticket, field)));
  };

  if (result.ruleId.startsWith("SET-")) refs.push(eventReference(derived.event, "tickets"));

  if (result.ruleId === "EVT-001") refs.push(eventReference(derived.event, "startAt"), eventReference(derived.event, "applicationDeadline"));
  else if (result.ruleId.startsWith("BODY-")) refs.push(eventReference(derived.event, "bodyText"));
  else if (["TKT-003", "TKT-004", "TKT-005", "TKT-010", "TKT-018"].includes(result.ruleId)) addTicket("name");
  else if (["TKT-006", "TKT-012", "TKT-019"].includes(result.ruleId)) addTicket("price");
  else if (["TKT-007", "TKT-011", "TKT-013", "TKT-016"].includes(result.ruleId)) addTicket("visibility");
  else if (result.ruleId === "TKT-008") addTicket("onlineUrl");
  else if (result.ruleId === "TKT-009") {
    addTicket("organizerNotice");
    refs.push(eventReference(derived.event, "startAt"));
  } else if (["TKT-014", "TKT-017"].includes(result.ruleId)) addTicket("onlineEnabled");
  else if (["SET-001", "SET-002", "SET-003", "SET-004", "SET-005"].includes(result.ruleId)) {
    addTicket("name");
    addTicket("visibility");
    refs.push(...tickets.flatMap((ticket) => evidenceReferences([
      ...ticket.rateKeys.evidence,
      ...ticket.participationForm.evidence,
      ...ticket.firstTime.evidence
    ])));
  } else if (["SET-006", "SET-007"].includes(result.ruleId)) {
    addTicket("name");
    addTicket("visibility");
  } else if (result.ruleId === "SET-010") addTicket("onlineEnabled");
  else if (["SET-011", "SET-012", "SET-013", "SET-014"].includes(result.ruleId)) addTicket("name");
  else if (result.ruleId === "SET-015") {
    addTicket("organizerNotice");
    addTicket("onlineEnabled");
  } else if (result.ruleId === "CROSS-001") addTicket("onlineUrl");
  else if (result.ruleId === "CROSS-002") addTicket("organizerNotice");
  else if (result.ruleId === "AREA-001") {
    refs.push(eventReference(derived.event, "bodyText"), eventReference(derived.event, "startAt"));
    for (const ticket of derived.tickets) refs.push(ticketReference(derived.event.eventId, ticket, "organizerNotice"));
  } else if (result.ruleId === "AREA-002") {
    refs.push(eventReference(derived.event, "name"));
    for (const ticket of derived.tickets) refs.push(ticketReference(derived.event.eventId, ticket, "name"));
  }
  return uniqueReferences(refs);
}

function sameIds(left?: string[], right?: string[]): boolean {
  return JSON.stringify([...(left ?? [])].sort()) === JSON.stringify([...(right ?? [])].sort());
}
