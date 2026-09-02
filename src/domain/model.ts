import type { EventInfo } from "../types.js";

export type ObservationState = "present" | "empty" | "unavailable" | "invalid";

export type ObservedField<T> =
  | { state: "present"; value: T; rawValue?: string }
  | { state: "empty"; rawValue?: string }
  | { state: "unavailable"; reason: string }
  | { state: "invalid"; rawValue: string; reason: string };

export type ConfirmationArea = "EVENT_SETTING" | "BODY" | "TICKET" | "MULTI_AREA" | "SYSTEM";
export type JudgmentUnit =
  | "EVENT"
  | "EVENT_SETTING"
  | "BODY"
  | "EACH_TICKET"
  | "TICKET_SET"
  | "CROSS_TICKET"
  | "CROSS_AREA"
  | "ACQUISITION"
  | "EXECUTION"
  | "NOTIFICATION";

export type ValidationStatus = "passed" | "failed" | "unknown" | "skipped";
export type EligibilityStatus = "target" | "excluded" | "undetermined";
export type DeliveryMode = "online" | "offline" | "hybrid";
export type PricingMode = "standard" | "fixed-fee";
export type FixedFeeType = "standard" | "nekomachi-plus" | "not-applicable";
export type PricingScheme = "normal" | "guest" | "not-applicable";
export type AppliedComposition = "none" | "mixed" | "already-applied-only";
export type ParticipationForm = "reading" | "after-party" | "none";

export type RateKey =
  | "ON-HYBRID"
  | "ON-LOCAL"
  | "ON-ONLINE-1"
  | "ON-ONLINE-2"
  | "ON-NONMEMBER"
  | "ON-NONMEMBER-FIRST"
  | "OFF-LOCAL-1"
  | "OFF-HYBRID-1"
  | "OFF-LOCAL-2"
  | "OFF-HYBRID-2"
  | "OFF-ONLINE"
  | "OFF-NONMEMBER"
  | "OFF-NONMEMBER-FIRST";

export type TicketRole =
  | "member-entry"
  | "plan-change"
  | "operation-member"
  | "already-applied"
  | "all-session-entry"
  | "partial-entry"
  | "fixed-onsite-entry"
  | "fixed-online-entry"
  | "unclassified";

export type ObservationSource = "LIST_PAGE" | "DETAIL_PAGE" | "CONFIG" | "STATE_FILE" | "DERIVED";
export type ObservationTarget = "EVENT" | "BODY" | "VENUE" | "TICKET_SET" | "TICKET" | "TICKET_FIELD" | "SETTING" | "STATE";

export type ObservedReference = {
  eventId: string;
  ticketId?: string;
  ticketPosition?: number;
  area: ConfirmationArea;
  field: string;
  source: ObservationSource;
  target: ObservationTarget;
  path: string;
  state: ObservationState;
  reason?: string;
};

export type DerivationEvidence = {
  reference: ObservedReference;
  comparison: "exact" | "partial" | "regex" | "normalized-value" | "none";
  patternOrExpected?: string;
  reason: string;
};

export type DerivationResult<T> =
  | { state: "determined"; value: T; evidence: DerivationEvidence[] }
  | { state: "unknown"; reason: string; evidence: DerivationEvidence[] }
  | { state: "conflict"; candidates: T[]; evidence: DerivationEvidence[] };

export type NormalizedTicket = {
  ticketId: string;
  position: number;
  name: ObservedField<string>;
  price: ObservedField<number>;
  visibility: ObservedField<string[]>;
  onlineEnabled: ObservedField<boolean>;
  onlineUrl: ObservedField<string>;
  organizerNotice: ObservedField<string>;
};

export type NormalizedEvent = {
  eventId: string;
  detailUrl: string;
  name: ObservedField<string>;
  startAt: ObservedField<Date>;
  endAt: ObservedField<Date>;
  venue: ObservedField<string>;
  bodyText: ObservedField<string>;
  applicationDeadlineEnabled: ObservedField<boolean>;
  applicationDeadline: ObservedField<string>;
  tickets: ObservedField<NormalizedTicket[]>;
  source: EventInfo;
};

export type DerivedTicket = NormalizedTicket & {
  roles: DerivationResult<TicketRole[]>;
  rawRoleCandidates: TicketRole[];
  memberLabels: DerivationResult<string[]>;
  rateKeys: DerivationResult<RateKey[]>;
  participationForm: DerivationResult<ParticipationForm>;
  firstTime: DerivationResult<boolean>;
};

export type EventAttributes = {
  deliveryMode: DerivationResult<DeliveryMode>;
  pricingMode: DerivationResult<PricingMode>;
  fixedFeeType: DerivationResult<FixedFeeType>;
  pricingScheme: DerivationResult<PricingScheme>;
  beginner: DerivationResult<boolean>;
  seriesEvent: DerivationResult<boolean>;
  hasAllSessionEntry: DerivationResult<boolean>;
  hasPartialEntry: DerivationResult<boolean>;
  appliedComposition: DerivationResult<AppliedComposition>;
};

export type TicketSets = {
  pricingComparisonSet: DerivedTicket[];
  applicationTicketSet: DerivedTicket[];
  regularEntrySet: DerivedTicket[];
  allSessionSet: DerivedTicket[];
  partialEntrySet: DerivedTicket[];
  nonAppliedPartialSet: DerivedTicket[];
  appliedPartialSet: DerivedTicket[];
  appliedSet: DerivedTicket[];
};

export type TicketSetName = keyof TicketSets
  | "onlineGuidanceCandidates"
  | "onlineUrlTargets"
  | "notificationTargets";

export type TicketSetEvidence = Record<TicketSetName, DerivationEvidence[]>;

export type EligibilityDecision = {
  status: EligibilityStatus;
  reasons: string[];
  suppressedRuleIds: string[];
  evidence: DerivationEvidence[];
};

export type DerivedEvent = {
  event: NormalizedEvent;
  eligibility: EligibilityDecision;
  attributes?: EventAttributes;
  tickets: DerivedTicket[];
  sets?: TicketSets;
  setEvidence?: TicketSetEvidence;
};

export type RulePlan = {
  ruleId: string;
  eventId: string;
  ticketIds?: string[];
  applicability: "applicable" | "skipped" | "unknown";
  applicabilityReferences: ObservedReference[];
  reason?: string;
};

export type ValidationResult = {
  ruleId: string;
  businessGroup: string;
  confirmationArea: ConfirmationArea;
  judgmentUnit: JudgmentUnit;
  status: ValidationStatus;
  eventId: string;
  ticketIds?: string[];
  applicabilityReferences: ObservedReference[];
  inspectedFields: ObservedReference[];
  message: string;
  expected?: unknown;
  actual?: unknown;
  reason?: string;
};

export type ClassificationDiagnostic = {
  diagnosticId: "DIAG-ROLE-001";
  eventId: string;
  ticketId: string;
  status: "unknown";
  evidence: DerivationEvidence[];
  message: string;
  reason: string;
};

export type EventStatus = "ok" | "failed" | "unknown" | "failed-and-unknown";

export type EventDisplayContext = {
  eventId: string;
  detailUrl: string;
  name: ObservedField<string>;
  startAt: ObservedField<Date>;
  deliveryMode?: DeliveryMode;
  eligibilityStatus: EligibilityStatus;
  eligibilityReasons: string[];
  eventStatus?: EventStatus;
  validationResults: ValidationResult[];
  classificationDiagnostics: ClassificationDiagnostic[];
  tickets: Array<{
    ticketId: string;
    position: number;
    name: ObservedField<string>;
  }>;
};

export type EventValidationOutcome = {
  event: EventDisplayContext;
  derived: DerivedEvent;
  plans: RulePlan[];
  validationResults: ValidationResult[];
  classificationDiagnostics: ClassificationDiagnostic[];
  eventStatus?: EventStatus;
};

export function determined<T>(value: T, evidence: DerivationEvidence[]): DerivationResult<T> {
  return { state: "determined", value, evidence };
}

export function unknown<T>(reason: string, evidence: DerivationEvidence[]): DerivationResult<T> {
  return { state: "unknown", reason, evidence };
}

export function hasRole(ticket: DerivedTicket, role: TicketRole): boolean {
  return ticket.roles.state === "determined" && ticket.roles.value.includes(role);
}

export function observedValue<T>(field: ObservedField<T>): T | undefined {
  return field.state === "present" ? field.value : undefined;
}
