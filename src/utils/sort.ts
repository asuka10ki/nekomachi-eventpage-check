import type { EventDisplayContext } from "../domain/model.js";

export function sortEventsByStartAtDesc(events: EventDisplayContext[]): EventDisplayContext[] {
  return [...events].sort((a, b) => {
    const aTime = a.startAt.state === "present" ? a.startAt.value.getTime() : Number.NEGATIVE_INFINITY;
    const bTime = b.startAt.state === "present" ? b.startAt.value.getTime() : Number.NEGATIVE_INFINITY;
    return bTime - aTime;
  });
}
