import type { CheckSummary, EventKind } from "./types.js";

export async function postSummaryToSlack(token: string | undefined, channel: string, summary: CheckSummary): Promise<void> {
  if (!token) {
    console.warn("SLACK_BOT_TOKEN が未設定のため、Slack投稿をスキップします。");
    return;
  }

  for (const text of buildSlackMessages(summary)) {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8"
      },
      body: JSON.stringify({ channel, text })
    });
    const body = (await response.json()) as { ok?: boolean; error?: string };
    if (!response.ok || !body.ok) {
      throw new Error(`Slack投稿に失敗しました: ${body.error || response.statusText}`);
    }
  }
}

export function buildSlackMessages(summary: CheckSummary): string[] {
  const ngResults = summary.results.filter((result) => !result.ok);
  const header =
    summary.ngCount === 0
      ? "✅ 猫町イベントチェック完了"
      : "🚨 猫町イベントチェックで不備を検出";

  const lines = [
    header,
    "",
    `対象: ${summary.targetLabel}`,
    `チェック対象: ${summary.checkedCount}件`,
    `対象外: ${summary.skippedCount}件`,
    `OK: ${summary.okCount}件`,
    `NG: ${summary.ngCount}件`,
    ...(summary.ngCount === 0 ? ["結果: すべてOK"] : []),
    `実行日時: ${formatDateTime(summary.executedAt)}`
  ];

  if (ngResults.length > 0) {
    lines.push("");
    ngResults.slice(0, 20).forEach((result, index) => {
      lines.push(`【NG ${index + 1}】`);
      lines.push(`イベント名: ${formatEventNameWithStartAt(result.eventName, result.startAt)}`);
      lines.push(`イベント種別: ${kindLabel(result.kind)}`);
      lines.push(`詳細URL: ${result.detailUrl}`);
      lines.push("不備:");
      result.errors.forEach((error) => lines.push(`- ${error}`));
      lines.push("");
    });
    if (ngResults.length > 20) {
      lines.push(`ほか${ngResults.length - 20}件のNGがあります。`);
    }
  }

  return splitMessage(lines.join("\n"));
}

export function printSummary(summary: CheckSummary): void {
  for (const message of buildSlackMessages(summary)) {
    console.log(message);
  }
}

function splitMessage(text: string): string[] {
  const max = 3900;
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const cut = rest.lastIndexOf("\n", max);
    const index = cut > 1000 ? cut : max;
    chunks.push(rest.slice(0, index));
    rest = rest.slice(index).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function formatDateTime(date: Date): string {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}`;
}

function formatEventNameWithStartAt(eventName: string, startAt: Date | null): string {
  if (!startAt) return eventName;
  return `${eventName}（開催日時: ${formatDateTime(startAt)}）`;
}

function kindLabel(kind: EventKind): string {
  return kind === "online" ? "オンライン" : kind === "offline" ? "オフライン" : "対象外";
}
