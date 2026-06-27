import type { CheckResult } from "../types.js";

export function sortResultsByStartAtDesc(results: CheckResult[]): CheckResult[] {
  return [...results].sort((a, b) => {
    const aTime = a.startAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    const bTime = b.startAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    return bTime - aTime;
  });
}
