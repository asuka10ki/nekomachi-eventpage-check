export type EventListItem = {
  name: string;
  detailUrl: string;
};

export type EventInfo = {
  name: string;
  detailUrl: string;
  startAt: Date | null;
  endAt: Date | null;
  venue: string | null;
  bodyText?: string | null;
  applicationDeadlineEnabled?: boolean | null;
  applicationDeadline?: string | null;
  tickets: TicketInfo[];
  fieldAvailability?: Partial<Record<"startAt" | "endAt" | "venue" | "bodyText" | "applicationDeadlineEnabled" | "applicationDeadline" | "tickets", boolean>>;
};

export type TicketInfo = {
  name: string;
  price: number | null;
  visibility: string | null;
  visibilityTags: string[];
  onlineEnabled: boolean | null;
  onlineUrl: string | null;
  organizerNotice: string | null;
  fieldAvailability?: Partial<Record<"name" | "price" | "visibility" | "onlineEnabled" | "onlineUrl" | "organizerNotice", boolean>>;
};
