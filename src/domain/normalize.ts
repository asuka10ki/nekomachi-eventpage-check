import type { EventInfo, TicketInfo } from "../types.js";
import { normalizeCommonText, normalizeNoticeText, normalizeTicketText } from "../utils/normalize.js";
import { normalizeOnlineUrl } from "../utils/url.js";
import type { NormalizedEvent, NormalizedTicket, ObservedField } from "./model.js";

export function normalizeEvent(event: EventInfo): NormalizedEvent {
  return {
    eventId: eventIdFromUrl(event.detailUrl),
    detailUrl: event.detailUrl,
    name: textField(event.name, normalizeCommonText),
    startAt: event.fieldAvailability?.startAt === false
      ? { state: "unavailable", reason: "開始日時を取得できません" }
      : event.startAt instanceof Date && !Number.isNaN(event.startAt.getTime())
      ? { state: "present", value: event.startAt, rawValue: event.startAt.toISOString() }
      : event.startAt === null
        ? { state: "empty" }
        : { state: "unavailable", reason: "開始日時を取得できません" },
    endAt: event.fieldAvailability?.endAt === false
      ? { state: "unavailable", reason: "終了日時を取得できません" }
      : event.endAt instanceof Date && !Number.isNaN(event.endAt.getTime())
      ? { state: "present", value: event.endAt, rawValue: event.endAt.toISOString() }
      : event.endAt === null
        ? { state: "empty" }
        : { state: "unavailable", reason: "終了日時を取得できません" },
    venue: event.fieldAvailability?.venue === false ? { state: "unavailable", reason: "会場を取得できません" } : optionalTextField(event.venue, normalizeCommonText, "会場を取得できません"),
    bodyText: event.fieldAvailability?.bodyText === false ? { state: "unavailable", reason: "本文を取得できません" } : optionalTextField(event.bodyText, (value) => value.replace(/\r\n?/g, "\n"), "本文を取得できません"),
    applicationDeadlineEnabled: event.fieldAvailability?.applicationDeadlineEnabled === false ? { state: "unavailable", reason: "申込締切設定を取得できません" } : booleanField(event.applicationDeadlineEnabled, "申込締切設定を取得できません"),
    applicationDeadline: event.fieldAvailability?.applicationDeadline === false ? { state: "unavailable", reason: "申込締切を取得できません" } : optionalTextField(event.applicationDeadline, normalizeCommonText, "申込締切を取得できません"),
    tickets: event.fieldAvailability?.tickets === false ? { state: "unavailable", reason: "チケット集合を取得できません" } : { state: "present", value: event.tickets.map(normalizeTicket) },
    source: event
  };
}

function normalizeTicket(ticket: TicketInfo, index: number): NormalizedTicket {
  const ticketId = `ticket-${index + 1}`;
  return {
    ticketId,
    position: index + 1,
    name: ticket.fieldAvailability?.name === false ? { state: "unavailable", reason: "券名を取得できません" } : textField(ticket.name, normalizeTicketText),
    price: ticket.fieldAvailability?.price === false
      ? { state: "unavailable", reason: "金額を取得できません" }
      : ticket.price === null
      ? { state: "empty" }
      : Number.isInteger(ticket.price) && ticket.price >= 0
        ? { state: "present", value: ticket.price, rawValue: String(ticket.price) }
        : { state: "invalid", rawValue: String(ticket.price), reason: "金額を0以上の整数へ解析できません" },
    visibility: ticket.fieldAvailability?.visibility === false
      ? { state: "unavailable", reason: "販売対象を取得できません" }
      : ticket.visibility === null && ticket.visibilityTags.length === 0
      ? { state: "empty" }
      : { state: "present", value: [...new Set(ticket.visibilityTags)].sort(), rawValue: ticket.visibility ?? undefined },
    onlineEnabled: ticket.fieldAvailability?.onlineEnabled === false ? { state: "unavailable", reason: "オンライン開催設定を取得できません" } : booleanField(ticket.onlineEnabled, "オンライン開催設定を取得できません"),
    onlineUrl: ticket.fieldAvailability?.onlineUrl === false ? { state: "unavailable", reason: "オンラインURLを取得できません" } : optionalTextField(ticket.onlineUrl, normalizeOnlineUrl, "オンラインURLを取得できません"),
    organizerNotice: ticket.fieldAvailability?.organizerNotice === false ? { state: "unavailable", reason: "主催者からのお知らせを取得できません" } : optionalTextField(ticket.organizerNotice, normalizeNoticeText, "主催者からのお知らせを取得できません")
  };
}

function textField(value: string, normalize: (value: string) => string): ObservedField<string> {
  const normalized = normalize(value);
  return normalized ? { state: "present", value: normalized, rawValue: value } : { state: "empty", rawValue: value };
}

function optionalTextField(
  value: string | null | undefined,
  normalize: (value: string) => string,
  unavailableReason: string
): ObservedField<string> {
  if (value === undefined) return { state: "unavailable", reason: unavailableReason };
  if (value === null) return { state: "empty" };
  return textField(value, normalize);
}

function booleanField(value: boolean | null | undefined, reason: string): ObservedField<boolean> {
  if (value === undefined) return { state: "unavailable", reason };
  if (value === null) return { state: "empty" };
  return { state: "present", value };
}

function eventIdFromUrl(url: string): string {
  const match = url.match(/\/admin_events\/([^/]+)\/edit/);
  return match?.[1] ?? url;
}
