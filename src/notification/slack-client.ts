import type { NotificationOutcome } from "../run/model.js";

export type SlackPostResponse = {
  status: number;
  ok: boolean;
  error?: string;
  retryAfterSeconds?: number;
  messageId?: string;
};

export interface SlackTransport {
  post(channel: string, text: string): Promise<SlackPostResponse>;
}

export type SlackRetryOptions = {
  maxAttempts?: number;
  wait?: (milliseconds: number) => Promise<void>;
  previouslySentMessageIds?: string[];
  previouslySentSlackMessageIds?: Record<string, string>;
  onMessageSending?: (messageId: string) => Promise<void>;
  onMessageSent?: (messageId: string, slackMessageId?: string) => Promise<void>;
  onMessageFailed?: (messageId: string) => Promise<void>;
};

export class SlackApiTransport implements SlackTransport {
  constructor(
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  async post(channel: string, text: string): Promise<SlackPostResponse> {
    const response = await this.fetcher("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ channel, text })
    });
    const body = (await response.json()) as { ok?: boolean; error?: string; ts?: string };
    return {
      status: response.status,
      ok: response.ok && body.ok === true,
      error: body.error,
      retryAfterSeconds: Number(response.headers.get("retry-after") ?? "0"),
      messageId: body.ts
    };
  }
}

export async function sendSlackMessages(
  transport: SlackTransport,
  channel: string,
  messages: Array<{ id: string; text: string }>,
  options: SlackRetryOptions = {}
): Promise<NotificationOutcome> {
  if (!channel.trim()) {
    return { status: "failed", plannedMessageIds: messages.map((message) => message.id), sentMessageIds: [], unsentMessageIds: messages.map((message) => message.id), attempts: 0, reason: "SLACK_CHANNEL_ID が未設定です" };
  }
  const plannedMessageIds = messages.map((message) => message.id);
  const sentMessageIds: string[] = [...new Set(options.previouslySentMessageIds ?? [])].filter((id) => plannedMessageIds.includes(id));
  const slackMessageIds: Record<string, string> = Object.fromEntries(
    Object.entries(options.previouslySentSlackMessageIds ?? {}).filter(([id]) => sentMessageIds.includes(id))
  );
  let attempts = 0;
  const maxAttempts = options.maxAttempts ?? 3;
  const wait = options.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  for (const message of messages) {
    if (sentMessageIds.includes(message.id)) continue;
    try {
      await options.onMessageSending?.(message.id);
    } catch (error) {
      return {
        status: "failed",
        plannedMessageIds,
        sentMessageIds,
        unsentMessageIds: plannedMessageIds.filter((id) => !sentMessageIds.includes(id)),
        slackMessageIds,
        attempts,
        reason: `Slack送信前の進捗保存に失敗しました: ${error instanceof Error ? error.message : String(error)}`
      };
    }
    let lastReason = "不明なエラー";
    let sent = false;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      attempts += 1;
      try {
        const response = await transport.post(channel, message.text);
        if (response.ok) {
          sentMessageIds.push(message.id);
          if (response.messageId) slackMessageIds[message.id] = response.messageId;
          try {
            await options.onMessageSent?.(message.id, response.messageId);
          } catch (error) {
            return {
              status: "failed",
              plannedMessageIds,
              sentMessageIds,
              unsentMessageIds: plannedMessageIds.filter((id) => !sentMessageIds.includes(id)),
              slackMessageIds,
              attempts,
              reason: `Slack送信進捗の保存に失敗しました: ${error instanceof Error ? error.message : String(error)}`
            };
          }
          sent = true;
          break;
        }
        lastReason = response.error ?? `HTTP ${response.status}`;
        if (!isRetryableSlackFailure(response.status, response.error) || attempt === maxAttempts) break;
        await wait(Math.max((response.retryAfterSeconds ?? 0) * 1000, attempt * 1000));
      } catch (error) {
        lastReason = error instanceof Error ? error.message : String(error);
        if (attempt === maxAttempts) break;
        await wait(attempt * 1000);
      }
    }
    if (!sent) {
      try {
        await options.onMessageFailed?.(message.id);
      } catch (error) {
        return {
          status: "failed",
          plannedMessageIds,
          sentMessageIds,
          unsentMessageIds: plannedMessageIds.filter((id) => !sentMessageIds.includes(id)),
          slackMessageIds,
          attempts,
          reason: `Slack送信失敗後の進捗保存に失敗しました: ${error instanceof Error ? error.message : String(error)}`
        };
      }
      return {
        status: "failed",
        plannedMessageIds,
        sentMessageIds,
        unsentMessageIds: plannedMessageIds.filter((id) => !sentMessageIds.includes(id)),
        slackMessageIds,
        attempts,
        reason: `Slack投稿に失敗しました: ${lastReason}`
      };
    }
  }
  return { status: "sent", plannedMessageIds, sentMessageIds, unsentMessageIds: [], slackMessageIds, attempts };
}

export function isRetryableSlackFailure(status: number, error?: string): boolean {
  return status === 429 || status >= 500 || ["ratelimited", "internal_error", "fatal_error", "service_unavailable", "request_timeout"].includes(error ?? "");
}
