import type { EventKind } from "../types.js";
import { normalizeEventNameForClassification } from "./normalize.js";

export function classifyEventByName(eventName: string): EventKind {
  const normalizedName = normalizeEventNameForClassification(eventName);

  if (normalizedName.includes("【予告】") || normalizedName.includes("【一覧】") || normalizedName.includes("事務局決済")) {
    return "skip";
  }

  const offlineMarkers = ["【名古屋】", "【東京】", "【大阪】", "【京都】", "【福岡】", "東京開催"];
  if (offlineMarkers.some((marker) => normalizedName.includes(marker))) {
    return "offline";
  }

  return "online";
}
