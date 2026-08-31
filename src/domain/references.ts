import type {
  ConfirmationArea,
  DerivationEvidence,
  NormalizedEvent,
  NormalizedTicket,
  ObservedReference
} from "./model.js";

type EventField = Exclude<keyof NormalizedEvent, "eventId" | "detailUrl" | "source">;
type TicketField = Exclude<keyof NormalizedTicket, "ticketId" | "position">;

export function eventReference(event: NormalizedEvent, field: EventField): ObservedReference {
  const value = event[field];
  const area: ConfirmationArea = field === "bodyText" ? "BODY" : "EVENT_SETTING";
  const target = field === "bodyText" ? "BODY" : field === "venue" ? "VENUE" : field === "tickets" ? "TICKET_SET" : "EVENT";
  return {
    eventId: event.eventId,
    area,
    field,
    source: "DETAIL_PAGE",
    target,
    path: `event.${field}`,
    state: value.state,
    reason: "reason" in value ? value.reason : undefined
  };
}

export function ticketReference(eventId: string, ticket: NormalizedTicket, field: TicketField): ObservedReference {
  const value = ticket[field];
  return {
    eventId,
    ticketId: ticket.ticketId,
    ticketPosition: ticket.position,
    area: "TICKET",
    field,
    source: "DETAIL_PAGE",
    target: field === "name" ? "TICKET" : "TICKET_FIELD",
    path: `tickets[${ticket.position - 1}].${field}`,
    state: value.state,
    reason: "reason" in value ? value.reason : undefined
  };
}

export function derivedReference(eventId: string, field: string, ticket?: Pick<NormalizedTicket, "ticketId" | "position">): ObservedReference {
  return {
    eventId,
    ticketId: ticket?.ticketId,
    ticketPosition: ticket?.position,
    area: ticket ? "TICKET" : "SYSTEM",
    field,
    source: "DERIVED",
    target: ticket ? "TICKET_FIELD" : "EVENT",
    path: ticket ? `tickets[${ticket.position - 1}].derived.${field}` : `derived.${field}`,
    state: "present"
  };
}

export function configReference(eventId: string, field: string): ObservedReference {
  return {
    eventId,
    area: "SYSTEM",
    field,
    source: "CONFIG",
    target: "SETTING",
    path: `config.${field}`,
    state: "present"
  };
}

export function runReference(
  source: "LIST_PAGE" | "DETAIL_PAGE" | "STATE_FILE" | "CONFIG",
  target: "EVENT" | "STATE" | "SETTING",
  field: string,
  state: ObservedReference["state"],
  reason?: string,
  eventId = "__run__"
): ObservedReference {
  return { eventId, area: "SYSTEM", field, source, target, path: `run.${field}`, state, reason };
}

export function evidence(
  reference: ObservedReference,
  reason: string,
  comparison: DerivationEvidence["comparison"] = "none",
  patternOrExpected?: string
): DerivationEvidence {
  return { reference, comparison, patternOrExpected, reason };
}

export function uniqueReferences(references: ObservedReference[]): ObservedReference[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = `${reference.source}|${reference.eventId}|${reference.ticketId ?? ""}|${reference.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function evidenceReferences(items: DerivationEvidence[]): ObservedReference[] {
  return uniqueReferences(items.map((item) => item.reference));
}
