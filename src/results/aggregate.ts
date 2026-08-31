import type { EventStatus, ValidationResult } from "../domain/model.js";

export function aggregateEventStatus(results: ValidationResult[], diagnosticCount: number): EventStatus {
  const failed = results.some((item) => item.status === "failed");
  const unknown = diagnosticCount > 0 || results.some((item) => item.status === "unknown");
  if (failed && unknown) return "failed-and-unknown";
  if (failed) return "failed";
  if (unknown) return "unknown";
  return "ok";
}

export function assertUniqueValidationResults(results: ValidationResult[]): void {
  const keys = new Set<string>();
  for (const item of results) {
    const key = `${item.ruleId}|${item.eventId}|${[...(item.ticketIds ?? [])].sort().join(",")}`;
    if (keys.has(key)) throw new Error(`ValidationResultの一意キーが重複しています: ${key}`);
    keys.add(key);
  }
}
