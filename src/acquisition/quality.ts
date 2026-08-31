import type { EventListItem } from "../types.js";

export class AcquisitionError extends Error {
  constructor(
    readonly ruleId: string,
    message: string,
    readonly scope: "run" | "event" = "run"
  ) {
    super(message);
    this.name = "AcquisitionError";
  }
}

export function assertAdminSessionIsValid(currentUrl: string, scope: "run" | "event" = "run"): void {
  const pathname = new URL(currentUrl).pathname;
  if (pathname === "/login" || pathname.startsWith("/login/")) {
    throw new AcquisitionError(scope === "run" ? "QUAL-LIST-002" : "QUAL-DETAIL-002", "OSIROのログイン状態が期限切れです。npm run auth を実行してログイン状態を更新してください。", scope);
  }
}

export function assertCollectedEventsExist(events: EventListItem[]): void {
  if (events.length === 0) {
    throw new AcquisitionError("QUAL-LIST-006", "OSIROの募集中イベントを1件も取得できませんでした。一覧画面の読み込みまたは画面構造を確認してください。");
  }
}

export function assertSuccessfulHttpResponse(url: string, status: number | null, ok: boolean, scope: "run" | "event" = "run"): void {
  if (status === null || !ok) {
    throw new AcquisitionError(scope === "run" ? "QUAL-LIST-001" : "QUAL-DETAIL-001", `OSIROへのアクセスに失敗しました。HTTPステータス: ${status ?? "取得不能"} / URL: ${redactUrl(url)}`, scope);
  }
}

export function assertAdminEventListPageState(currentUrl: string, hasEventIndex: boolean): void {
  assertAdminSessionIsValid(currentUrl);
  const pathname = new URL(currentUrl).pathname;
  if (pathname !== "/admin/events" || !hasEventIndex) {
    throw new AcquisitionError("QUAL-LIST-003", "OSIROのイベント一覧画面を確認できませんでした。画面構造またはアクセス権限を確認してください。");
  }
}

export function assertAdminEventDetailPageState(currentUrl: string, hasTitle: boolean): void {
  assertAdminSessionIsValid(currentUrl);
  const pathname = new URL(currentUrl).pathname;
  if (!/^\/admin_events\/[^/]+\/edit$/.test(pathname) || !hasTitle) {
    throw new AcquisitionError("QUAL-DETAIL-003", "OSIROのイベント詳細画面からタイトル欄を取得できませんでした。", "event");
  }
}

export function assertPaginationAdvanced(previousUrl: string, currentUrl: string): void {
  if (previousUrl === currentUrl) throw new AcquisitionError("QUAL-LIST-004", "OSIROのイベント一覧で次ページへ移動できませんでした。");
}

export function assertPageLimitNotExceeded(pageIndex: number, maxPages = 20): void {
  if (pageIndex >= maxPages) throw new AcquisitionError("QUAL-LIST-005", `OSIROのイベント一覧が${maxPages}ページを超えたため、全ページを取得できませんでした。`);
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "取得URL（解析不能）";
  }
}
