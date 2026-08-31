import type { EventDisplayContext } from "../domain/model.js";

/** 実行1回分の集計正本。表示層はeventsのEventDisplayContextだけを参照する。 */
export type RunSummary = {
  targetLabel: string;
  executionComplete: boolean;
  acquisitionComplete: boolean;
  checkedCount: number;
  excludedCount: number;
  undeterminedCount: number;
  okCount: number;
  ngCount: number;
  unknownCount: number;
  failedAndUnknownCount: number;
  events: EventDisplayContext[];
  executedAt: Date;
};
