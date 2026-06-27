export type EventKind = "online" | "offline" | "skip";

export type EventListItem = {
  name: string;
  detailUrl: string;
};

export type EventInfo = {
  name: string;
  kind: EventKind;
  detailUrl: string;
  startAt: Date | null;
  endAt: Date | null;
  venue: string | null;
  tickets: TicketInfo[];
};

export type TicketInfo = {
  name: string;
  price: number | null;
  visibility: string | null;
  visibilityTags: string[];
  onlineEnabled: boolean | null;
  onlineUrl: string | null;
  organizerNotice: string | null;
};

export type TicketRule = {
  id: string;
  name: string;
  note?: string;
  price: number;
  visibilityTags: string[];
};

export type RuleSet = {
  matchMode: "contains";
  tickets: TicketRule[];
};

export type RulesConfig = {
  online: RuleSet;
  offline: RuleSet;
};

export type CheckResult = {
  eventName: string;
  kind: EventKind;
  detailUrl: string;
  startAt: Date | null;
  ok: boolean;
  errors: string[];
};

export type CheckSummary = {
  targetLabel: string;
  checkedCount: number;
  skippedCount: number;
  okCount: number;
  ngCount: number;
  results: CheckResult[];
  executedAt: Date;
};
