export const EXCLUDED_EVENT_NAME_MARKERS = ["予告", "一覧", "事務局決済"] as const;

export function matchedExcludedEventNameMarkers(eventName: string): string[] {
  return EXCLUDED_EVENT_NAME_MARKERS.filter((marker) => eventName.includes(marker));
}
