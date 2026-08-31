import type { DerivedEvent, RulePlan, ValidationResult } from "../domain/model.js";
import { nonApplicableResult, result } from "./common.js";

export function validateCrossTicket(derived: DerivedEvent, plans: RulePlan[]): ValidationResult[] {
  return plans.filter((plan) => plan.ruleId === "CROSS-001" || plan.ruleId === "CROSS-002").map((plan) => {
    const nonApplicable = nonApplicableResult(plan, "オンライン案内", "TICKET", "CROSS_TICKET");
    if (nonApplicable) return nonApplicable;
    const tickets = derived.tickets.filter((ticket) => plan.ticketIds?.includes(ticket.ticketId));
    if (plan.ruleId === "CROSS-001") {
      if (tickets.some((ticket) => ticket.onlineUrl.state === "unavailable" || ticket.onlineUrl.state === "invalid")) return result(plan, "オンライン案内", "TICKET", "CROSS_TICKET", "unknown", "URL一致を確認できません", { reason: "URL欄を取得できない券があります" });
      const urls = tickets.map((ticket) => ticket.onlineUrl.state === "present" ? ticket.onlineUrl.value : "");
      const ok = new Set(urls).size <= 1;
      const mismatch = mismatchGroups(tickets, (ticket) => ticket.onlineUrl.state === "present" ? ticket.onlineUrl.value : "");
      return result(plan, "オンライン案内", "TICKET", "CROSS_TICKET", ok ? "passed" : "failed", ok ? "オンライン参加URLは一致しています" : `オンライン参加URLが異なります: ${mismatch}`, { actual: urls });
    }
    if (tickets.some((ticket) => ticket.organizerNotice.state === "unavailable" || ticket.organizerNotice.state === "invalid")) return result(plan, "オンライン案内", "TICKET", "CROSS_TICKET", "unknown", "お知らせ一致を確認できません", { reason: "お知らせ欄を取得できない券があります" });
    const notices = tickets.map((ticket) => ticket.organizerNotice.state === "present" ? ticket.organizerNotice.value : "");
    const ok = new Set(notices).size <= 1;
    const mismatch = mismatchGroups(tickets, (ticket) => ticket.organizerNotice.state === "present" ? ticket.organizerNotice.value : "");
    return result(plan, "オンライン案内", "TICKET", "CROSS_TICKET", ok ? "passed" : "failed", ok ? "主催者からのお知らせは一致しています" : `主催者からのお知らせが異なります: ${mismatch}`, { actual: notices });
  });
}

function mismatchGroups(
  tickets: DerivedEvent["tickets"],
  valueOf: (ticket: DerivedEvent["tickets"][number]) => string | undefined
): string {
  const groups = new Map<string, number[]>();
  for (const ticket of tickets) {
    const value = valueOf(ticket);
    if (value === undefined) continue;
    groups.set(value, [...(groups.get(value) ?? []), ticket.position]);
  }
  return [...groups.values()]
    .map((positions) => positions.map((position) => `${position}番目`).join("・"))
    .join(" ↔ ");
}
