import type { ClassificationDiagnostic, EventDisplayContext, ValidationResult } from "../domain/model.js";

export function validationIssueLine(context: EventDisplayContext, item: ValidationResult): string {
  const message = item.status === "unknown" ? item.reason ?? item.message : item.message;
  const ticketIds = item.judgmentUnit === "CROSS_TICKET" ? undefined : item.ticketIds;
  return `${issueReference(context, item.ruleId, ticketIds)} ${withoutRepeatedTicketLabel(context, ticketIds, message)}`;
}

export function diagnosticIssueLine(context: EventDisplayContext, item: ClassificationDiagnostic): string {
  return `${issueReference(context, item.diagnosticId, [item.ticketId])} ${item.message}: ${item.reason}`;
}

export function issueReference(context: EventDisplayContext, id: string, ticketIds?: string[]): string {
  if (!ticketIds?.length) return `[${id}]`;
  const labels = ticketIds.map((ticketId) => {
    const ticket = context.tickets.find((entry) => entry.ticketId === ticketId);
    if (!ticket) return "対象券";
    const name = ticket.name.state === "present" ? ticket.name.value : "取得不能";
    return `${ticket.position}番目「${name}」`;
  });
  return `[${id} / ${labels.join("、")}]`;
}

function withoutRepeatedTicketLabel(context: EventDisplayContext, ticketIds: string[] | undefined, message: string): string {
  if (ticketIds?.length !== 1) return message;
  const ticket = context.tickets.find((entry) => entry.ticketId === ticketIds[0]);
  if (!ticket) return message;
  const name = ticket.name.state === "present" ? ticket.name.value : "取得不能";
  const prefix = `[${ticket.position}番目] チケット「${name}」: `;
  return message.startsWith(prefix) ? message.slice(prefix.length) : message;
}
