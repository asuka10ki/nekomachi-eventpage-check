import { OPTIONAL_FIRST_TIME_RATE_KEY, RATE_LABELS, REQUIRED_RATE_KEYS } from "../domain/catalog.js";
import { hasRole, type DerivedEvent, type DerivedTicket, type ParticipationForm, type RulePlan, type ValidationResult } from "../domain/model.js";
import { notificationTargets } from "../policy/rule-plan.js";
import { nonApplicableResult, result } from "./common.js";

export function validateTicketSets(derived: DerivedEvent, plans: RulePlan[]): ValidationResult[] {
  return plans.filter((plan) => plan.ruleId.startsWith("SET-")).map((plan) => validateSetPlan(derived, plan));
}

function validateSetPlan(derived: DerivedEvent, plan: RulePlan): ValidationResult {
  const metadata = setMetadata(plan.ruleId);
  const nonApplicable = nonApplicableResult(plan, metadata.group, metadata.area, "TICKET_SET");
  if (nonApplicable) return nonApplicable;
  const sets = derived.sets;
  const attributes = derived.attributes;
  if (!sets || !attributes) return result(plan, metadata.group, metadata.area, "TICKET_SET", "unknown", "券集合または属性を確定できません");

  switch (plan.ruleId) {
    case "SET-001": {
      if (attributes.deliveryMode.state !== "determined" || sets.regularEntrySet.some((ticket) => ticket.rateKeys.state !== "determined")) return unknownSet(plan, metadata, "開催方法またはrateKeyを確定できません");
      const required = REQUIRED_RATE_KEYS[attributes.deliveryMode.value];
      const present = new Set(sets.regularEntrySet.flatMap((ticket) => ticket.rateKeys.state === "determined" ? ticket.rateKeys.value : []));
      const missing = required.filter((key) => !present.has(key));
      return setBoolean(plan, metadata, missing.length === 0, missing.length === 0 ? "必須料金区分はそろっています" : `不足している料金区分: ${missing.map((key) => RATE_LABELS[key]).join("、")}`, { expected: required, actual: [...present] });
    }
    case "SET-002": {
      if (attributes.deliveryMode.state !== "determined") return unknownSet(plan, metadata, "開催方法を確定できません");
      const hasUnknownKey = sets.regularEntrySet.some((ticket) => ticket.rateKeys.state !== "determined" || ticket.participationForm.state !== "determined" || ticket.firstTime.state !== "determined");
      const groups = new Map<string, string[]>();
      for (const ticket of sets.regularEntrySet) {
        if (ticket.rateKeys.state !== "determined" || ticket.participationForm.state !== "determined" || ticket.firstTime.state !== "determined") continue;
        const form = attributes.deliveryMode.value === "online" ? "none" : ticket.participationForm.value;
        for (const key of ticket.rateKeys.value) {
          const groupKey = `${key}|${form}|${ticket.firstTime.value}`;
          groups.set(groupKey, [...(groups.get(groupKey) ?? []), ticket.ticketId]);
        }
      }
      const duplicates = [...groups.entries()].filter(([, ticketIds]) => ticketIds.length > 1);
      if (duplicates.length > 0) return setBoolean(plan, metadata, false, `同一rateKey・参加形態・初参加区分の券が重複しています: ${duplicates.map(([key]) => key).join(", ")}`);
      return hasUnknownKey ? unknownSet(plan, metadata, "重複キーを確定できない券があります") : setBoolean(plan, metadata, true, "同一構成の重複はありません");
    }
    case "SET-003":
      return validateForms(plan, metadata, sets.regularEntrySet, "イベント全体");
    case "SET-004": {
      if (attributes.deliveryMode.state !== "determined") return unknownSet(plan, metadata, "開催方法を確定できません");
      if (sets.regularEntrySet.some((ticket) => ticket.rateKeys.state !== "determined" || ticket.participationForm.state !== "determined")) {
        return unknownSet(plan, metadata, "rateKeyまたは参加形態を確定できない券があります");
      }
      const required = REQUIRED_RATE_KEYS[attributes.deliveryMode.value];
      const problems: string[] = [];
      for (const key of required) {
        const tickets = sets.regularEntrySet.filter((ticket) => ticket.rateKeys.state === "determined" && ticket.rateKeys.value.includes(key));
        const forms = formsOf(tickets);
        if (!forms) return unknownSet(plan, metadata, `${key}の参加形態を確定できません`);
        const missingForms = missingParticipationForms(forms);
        if (missingForms.length > 0) problems.push(`${RATE_LABELS[key]}: ${missingForms.join("・")}`);
      }
      return setBoolean(plan, metadata, problems.length === 0, problems.length === 0 ? "各料金区分の参加形態はそろっています" : `不足している参加形態: ${problems.join(" / ")}`);
    }
    case "SET-005": {
      if (attributes.deliveryMode.state !== "determined") return unknownSet(plan, metadata, "開催方法を確定できません");
      const key = OPTIONAL_FIRST_TIME_RATE_KEY[attributes.deliveryMode.value];
      const tickets = sets.regularEntrySet.filter((ticket) => ticket.rateKeys.state === "determined" && ticket.rateKeys.value.includes(key));
      if (attributes.deliveryMode.value === "online") {
        return setBoolean(plan, metadata, tickets.length > 0, tickets.length > 0 ? "非会員初参加券があります" : "非会員初参加券を追加してください");
      }
      return validateForms(plan, metadata, tickets, "非会員初参加");
    }
    case "SET-006":
      return validateSeriesCoverage(plan, metadata, sets.allSessionSet, true);
    case "SET-007":
      return validateSeriesCoverage(plan, metadata, sets.partialEntrySet, false);
    case "SET-010": {
      const candidates = derived.tickets.filter((ticket) => plan.ticketIds?.includes(ticket.ticketId));
      const ok = candidates.some((ticket) => ticket.onlineEnabled.state === "present" && ticket.onlineEnabled.value);
      if (ok) return setBoolean(plan, metadata, true, "オンライン開催ONの券があります");
      if (candidates.some((ticket) => ticket.onlineEnabled.state !== "present")) return unknownSet(plan, metadata, "候補券のオンライン開催設定を取得できません");
      return setBoolean(plan, metadata, ok, ok ? "オンライン開催ONの券があります" : "オンライン対象イベントですが、「オンライン開催する」がONのチケットがありません");
    }
    case "SET-011": {
      const count = derived.tickets.filter((ticket) => hasRole(ticket, "plan-change")).length;
      return setBoolean(plan, metadata, count === 1, count === 0 ? "プラン変更チケットを1件追加してください" : count === 1 ? "プラン変更チケットは1件です" : "プラン変更チケットが複数存在します", { expected: 1, actual: count });
    }
    case "SET-012": {
      const count = derived.tickets.filter((ticket) => hasRole(ticket, "operation-member")).length;
      return setBoolean(plan, metadata, count >= 1, count >= 1 ? "運営メンバー券があります" : "初心者読書会・初心者限定・ビギナー限定イベントには無料の「運営メンバー」チケットが必要です");
    }
    case "SET-013": {
      const onsite = sets.pricingComparisonSet.filter((ticket) => hasRole(ticket, "fixed-onsite-entry"));
      const online = sets.pricingComparisonSet.filter((ticket) => hasRole(ticket, "fixed-online-entry"));
      const ok = onsite.length > 0 && online.length > 0 && onsite.some((left) => online.every((right) => left.ticketId !== right.ticketId));
      const missing = [onsite.length === 0 ? "現地参加券" : undefined, online.length === 0 ? "オンライン参加券" : undefined].filter((value): value is string => value !== undefined);
      const failure = missing.length > 0
        ? `固定料金ハイブリッドに不足: ${missing.join("、")}`
        : "現地参加券とオンライン参加券を別々の券にしてください";
      return setBoolean(plan, metadata, ok, ok ? "現地参加券とオンライン参加券があります" : failure);
    }
    case "SET-014": {
      const knownParticipants = derived.tickets.filter((ticket) => ticket.roles.state === "determined" && !hasRole(ticket, "plan-change") && !hasRole(ticket, "operation-member"));
      if (knownParticipants.length > 0) return setBoolean(plan, metadata, true, "参加券があります");
      if (derived.tickets.some((ticket) => ticket.roles.state !== "determined")) return unknownSet(plan, metadata, "券役割を確定できず参加券の有無を判定できません");
      return setBoolean(plan, metadata, false, "参加用チケットを1件以上追加してください");
    }
    case "SET-015": {
      const targets = notificationTargets(derived);
      const empty = targets.filter((ticket) => ticket.organizerNotice.state !== "present");
      const knownEmpty = empty.filter((ticket) => ticket.organizerNotice.state === "empty");
      if (knownEmpty.length > 0) {
        return { ...setBoolean(plan, metadata, false, "主催者からのお知らせが空欄です"), ticketIds: knownEmpty.map((ticket) => ticket.ticketId) };
      }
      if (empty.length > 0) {
        return { ...unknownSet(plan, metadata, "お知らせ欄を取得できません"), ticketIds: empty.map((ticket) => ticket.ticketId) };
      }
      return setBoolean(plan, metadata, true, "全通知対象券にお知らせがあります");
    }
    default:
      return unknownSet(plan, metadata, "未実装の券集合ルールです");
  }
}

function validateForms(plan: RulePlan, metadata: Metadata, tickets: DerivedTicket[], label: string): ValidationResult {
  const forms = formsOf(tickets);
  if (!forms) return unknownSet(plan, metadata, `${label}の参加形態を確定できません`);
  const missing = missingParticipationForms(forms);
  return setBoolean(plan, metadata, missing.length === 0, missing.length === 0 ? `${label}の参加形態はそろっています` : `${label}に不足: ${missing.join("、")}`);
}

function missingParticipationForms(forms: Set<ParticipationForm>): string[] {
  return [forms.has("reading") ? undefined : "読書会のみ参加", forms.has("after-party") ? undefined : "懇親会まで参加"]
    .filter((value): value is string => value !== undefined);
}

function formsOf(tickets: DerivedTicket[]): Set<ParticipationForm> | undefined {
  if (tickets.some((ticket) => ticket.participationForm.state !== "determined")) return undefined;
  return new Set(tickets.flatMap((ticket) => ticket.participationForm.state === "determined" ? [ticket.participationForm.value] : []));
}

function validateSeriesCoverage(plan: RulePlan, metadata: Metadata, tickets: DerivedTicket[], enforceDuplicates: boolean): ValidationResult {
  const counts = new Map<string, number>();
  for (const ticket of tickets) {
    if (ticket.visibility.state !== "present") continue;
    for (const tag of ticket.visibility.value.filter((value) => ["オン", "オフ", "ハイ", "外"].includes(value))) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  const missing = ["オン", "オフ", "ハイ", "外"].filter((tag) => !counts.has(tag));
  const duplicates = enforceDuplicates ? [...counts.entries()].filter(([tag, count]) => {
    if (tag !== "外") return count > 1;
    if (count > 2) return true;
    if (count < 2) return false;
    const nonmembers = tickets.filter((ticket) => ticket.visibility.state === "present" && ticket.visibility.value.includes("外"));
    const firstTimeValues = nonmembers.flatMap((ticket) => ticket.firstTime.state === "determined" ? [ticket.firstTime.value] : []);
    return firstTimeValues.length !== 2 || new Set(firstTimeValues).size !== 2;
  }).map(([tag]) => tag) : [];
  const hasUnavailableVisibility = tickets.some((ticket) => ticket.visibility.state !== "present");
  if (duplicates.length > 0 && hasUnavailableVisibility) return setBoolean(plan, metadata, false, `セット参加券の販売対象を修正してください（重複: ${duplicates.join(",")}）`);
  if (hasUnavailableVisibility) return unknownSet(plan, metadata, "セット参加券の販売対象を取得できません");
  const ok = missing.length === 0 && duplicates.length === 0;
  return setBoolean(plan, metadata, ok, ok ? "セット参加券の販売対象はそろっています" : `セット参加券の販売対象を修正してください${missing.length ? `（不足: ${missing.join(",")}）` : ""}${duplicates.length ? `（重複: ${duplicates.join(",")}）` : ""}`);
}

function setBoolean(plan: RulePlan, metadata: Metadata, ok: boolean, message: string, details: { expected?: unknown; actual?: unknown } = {}): ValidationResult {
  return result(plan, metadata.group, metadata.area, "TICKET_SET", ok ? "passed" : "failed", message, details);
}

function unknownSet(plan: RulePlan, metadata: Metadata, reason: string): ValidationResult {
  return result(plan, metadata.group, metadata.area, "TICKET_SET", "unknown", "チケット構成を確認できません", { reason });
}

type Metadata = { group: string; area: "TICKET" | "MULTI_AREA" };

function setMetadata(ruleId: string): Metadata {
  if (["SET-003", "SET-004", "SET-005"].includes(ruleId)) return { group: "参加形態", area: "TICKET" };
  if (["SET-006", "SET-007"].includes(ruleId)) return { group: "セット参加券の構成", area: "TICKET" };
  if (["SET-010", "SET-015"].includes(ruleId)) return { group: "オンライン案内", area: "TICKET" };
  if (ruleId === "SET-011") return { group: "プラン変更", area: "TICKET" };
  if (ruleId === "SET-012") return { group: "運営構成", area: "MULTI_AREA" };
  if (ruleId === "SET-013") return { group: "固定料金参加経路", area: "TICKET" };
  if (ruleId === "SET-014") return { group: "参加券存在", area: "TICKET" };
  return { group: "チケット構成", area: "TICKET" };
}
