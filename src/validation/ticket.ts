import { allowedPrices, NEKOMACHI_PLUS_PRICE, NEKOMACHI_PLUS_REQUIRED_VISIBILITY } from "../domain/catalog.js";
import type { DerivedEvent, DerivedTicket, RulePlan, ValidationResult } from "../domain/model.js";
import { extractDeadlineTimeFromNotice, formatHourMinute, isDeadlineFiveMinutesBeforeStart } from "../utils/date.js";
import { normalizeCommonText } from "../utils/normalize.js";
import { nonApplicableResult, result } from "./common.js";

const PLAN_CHANGE_TEXT = "プラン変更後にお申し込み下さい。プラン変更前は参加ボタンは押さないでください。";

export function validateTickets(derived: DerivedEvent, plans: RulePlan[]): ValidationResult[] {
  return plans.filter((plan) => plan.ruleId.startsWith("TKT-")).map((plan) => validateTicketPlan(derived, plan));
}

function validateTicketPlan(derived: DerivedEvent, plan: RulePlan): ValidationResult {
  const ticket = ticketForPlan(derived, plan);
  const metadata = ticketRuleMetadata(plan.ruleId);
  const nonApplicable = nonApplicableResult(plan, metadata.group, "TICKET", "EACH_TICKET");
  if (nonApplicable) return nonApplicable;
  if (!ticket) return result(plan, metadata.group, "TICKET", "EACH_TICKET", "unknown", "対象チケットを特定できません");
  const label = `[${ticket.position}番目] チケット「${ticket.name.state === "present" ? ticket.name.value : "取得不能"}」`;

  switch (plan.ruleId) {
    case "TKT-003":
      return booleanResult(plan, metadata.group, ticket.name.state === "present" && ticket.name.value.includes("今月1回目"), `${label}: 1回目チケット名には「今月1回目」を入れてください`);
    case "TKT-004":
      return booleanResult(plan, metadata.group, ticket.name.state === "present" && ticket.name.value.includes("今月2回目以降"), `${label}: 2回目以降チケット名には「今月2回目以降」を入れてください`);
    case "TKT-005": {
      // BQ-01により券名の会員種別名は任意となった。ID互換のため結果は
      // RulePlan側で常時skippedとし、この分岐へ到達した場合も業務不備にしない。
      return result(plan, metadata.group, "TICKET", "EACH_TICKET", "skipped", "券名の会員種別名は確認しません");
    }
    case "TKT-006":
      return validatePrice(plan, derived, ticket, label);
    case "TKT-007":
      return validateVisibility(plan, ticket, label);
    case "TKT-008": {
      if (ticket.onlineUrl.state === "unavailable" || ticket.onlineUrl.state === "invalid") return unknownTicket(plan, metadata.group, label, "オンラインURL欄を取得できません");
      return booleanResult(plan, metadata.group, ticket.onlineUrl.state === "present" && ticket.onlineUrl.value.length > 0, `${label}: オンライン開催するがONですが、オンライン参加URLが空です`);
    }
    case "TKT-009": {
      if (ticket.organizerNotice.state === "empty") return result(plan, metadata.group, "TICKET", "EACH_TICKET", "skipped", "お知らせが空欄のため、締切時刻は確認しません");
      if (ticket.organizerNotice.state !== "present" || derived.event.startAt.state !== "present") return unknownTicket(plan, metadata.group, label, "お知らせまたは開始日時を取得できません");
      const actual = extractDeadlineTimeFromNotice(ticket.organizerNotice.value);
      const ok = isDeadlineFiveMinutesBeforeStart(derived.event.startAt.value, ticket.organizerNotice.value);
      const expected = formatHourMinute(new Date(derived.event.startAt.value.getTime() - 5 * 60 * 1000));
      return result(plan, metadata.group, "TICKET", "EACH_TICKET", ok ? "passed" : "failed", ok ? `${label}: お知らせの締切時刻は正常です` : `${label}: 主催者からのお知らせの締切時刻が開始5分前ではありません。期待: ${expected} / 実際: ${actual ?? "見つかりません"}`);
    }
    case "TKT-010": {
      if (ticket.name.state !== "present") return unknownTicket(plan, metadata.group, label, "券名を取得できません");
      const ok = normalizeCommonText(ticket.name.value) === PLAN_CHANGE_TEXT;
      return booleanResult(plan, metadata.group, ok, `${label}: プラン変更チケット名は「${PLAN_CHANGE_TEXT}」にしてください`);
    }
    case "TKT-011":
      return validateRequiredTags(plan, ticket, label, ["A", "U-22", "B"], "プラン変更券の販売対象");
    case "TKT-012": {
      if (ticket.price.state === "unavailable") return unknownTicket(plan, metadata.group, label, "金額欄を取得できません");
      return booleanResult(plan, metadata.group, ticket.price.state === "present" && ticket.price.value === 0, `${label}: 「運営メンバー」チケットは無料にしてください`);
    }
    case "TKT-013":
      return derived.attributes?.fixedFeeType.state === "determined" && derived.attributes.fixedFeeType.value === "nekomachi-plus"
        ? validateRequiredTags(plan, ticket, label, [...NEKOMACHI_PLUS_REQUIRED_VISIBILITY], "猫町プラス内チケットの販売対象")
        : validateRequiredTags(plan, ticket, label, ["オン", "オフ", "ハイ", "外"], "固定料金チケットの販売対象");
    case "TKT-014": {
      if (ticket.onlineEnabled.state !== "present") return unknownTicket(plan, metadata.group, label, "オンライン開催設定を取得できません");
      return booleanResult(plan, metadata.group, ticket.onlineEnabled.value, `${label}: 途中参加チケットの「オンライン開催する」をONにしてください`);
    }
    case "TKT-016": {
      if (ticket.visibility.state !== "present" && ticket.visibility.state !== "empty") return unknownTicket(plan, metadata.group, label, "販売対象を取得できません");
      const tags = ticket.visibility.state === "present" ? ticket.visibility.value : [];
      const legacy = tags.filter((tag) => ["A", "U-22", "B"].includes(tag));
      return booleanResult(plan, metadata.group, legacy.length === 0, `${label}: 販売対象から旧会員タグ（${legacy.join("、")}）を外してください`);
    }
    case "TKT-017": {
      if (ticket.onlineEnabled.state !== "present") return unknownTicket(plan, metadata.group, label, "オンライン開催設定を取得できません");
      return booleanResult(plan, metadata.group, ticket.onlineEnabled.value, `${label}: 固定料金のオンライン参加券は「オンライン開催する」をONにしてください`);
    }
    case "TKT-018": {
      const roles = ticket.rawRoleCandidates;
      const forbidden = (roles.includes("plan-change") && roles.length > 1)
        || (roles.includes("operation-member") && roles.length > 1)
        || (roles.includes("all-session-entry") && roles.includes("partial-entry"))
        || (roles.includes("fixed-onsite-entry") && roles.includes("fixed-online-entry"));
      return booleanResult(plan, metadata.group, !forbidden, `${label}: 同一券へ併記できない用途があります。券を分けるか禁止文言を外してください`);
    }
    case "TKT-019": {
      if (ticket.price.state === "unavailable") return unknownTicket(plan, metadata.group, label, "金額欄を取得できません");
      const ok = ticket.price.state === "present" && Number.isInteger(ticket.price.value) && ticket.price.value >= 0;
      return booleanResult(plan, metadata.group, ok, `${label}: 金額を0以上の整数で入力してください`);
    }
    case "TKT-020": {
      if (ticket.price.state === "unavailable") return unknownTicket(plan, metadata.group, label, "金額欄を取得できません");
      return booleanResult(plan, metadata.group, ticket.price.state === "present" && ticket.price.value === NEKOMACHI_PLUS_PRICE, `${label}: 猫町プラス内イベントの参加券は無料にしてください`);
    }
    default:
      return result(plan, metadata.group, "TICKET", "EACH_TICKET", "unknown", "未実装のチケットルールです");
  }
}

function validatePrice(plan: RulePlan, derived: DerivedEvent, ticket: DerivedTicket, label: string): ValidationResult {
  if (ticket.price.state === "unavailable") return unknownTicket(plan, "料金", label, "金額欄を取得できません");
  if (ticket.price.state === "empty" || ticket.price.state === "invalid") {
    return result(plan, "料金", "TICKET", "EACH_TICKET", "failed", `${label}: 金額が許可金額と異なります。実際: ${ticket.price.state === "empty" ? "空欄" : ticket.price.rawValue}`, { actual: ticket.price.state === "empty" ? null : ticket.price.rawValue });
  }
  if (ticket.rateKeys.state !== "determined" || derived.attributes?.pricingScheme.state !== "determined") {
    return unknownTicket(plan, "料金", label, "金額、rateKey、料金体系のいずれかを確定できません");
  }
  const scheme = derived.attributes.pricingScheme.value;
  const sets = ticket.rateKeys.value.map((key) => new Set(allowedPrices(key, scheme)));
  const common = sets.length === 0 ? [] : [...sets[0]].filter((price) => sets.every((set) => set.has(price)));
  const ok = common.includes(ticket.price.value);
  return result(plan, "料金", "TICKET", "EACH_TICKET", ok ? "passed" : "failed", ok ? `${label}: 金額は正常です` : `${label}: 金額が許可金額と異なります。期待: ${common.join("円 または ")}円 / 実際: ${ticket.price.value}円`, { expected: common, actual: ticket.price.value });
}

function validateVisibility(plan: RulePlan, ticket: DerivedTicket, label: string): ValidationResult {
  if (ticket.visibility.state === "unavailable" || ticket.visibility.state === "invalid") return unknownTicket(plan, "販売対象", label, "販売対象を取得できません");
  const actual = ticket.visibility.state === "present"
    ? ticket.visibility.value.filter((tag) => ["オン", "オフ", "ハイ", "外"].includes(tag))
    : [];
  const ok = actual.length > 0;
  return result(plan, "販売対象", "TICKET", "EACH_TICKET", ok ? "passed" : "failed", ok ? `${label}: 販売対象は入力されています` : `${label}: 販売対象（オン、オフ、ハイ、外のいずれか）を設定してください`, { expected: ["オン", "オフ", "ハイ", "外"], actual });
}

function validateRequiredTags(plan: RulePlan, ticket: DerivedTicket, label: string, required: string[], subject: string): ValidationResult {
  if (ticket.visibility.state === "unavailable" || ticket.visibility.state === "invalid") return unknownTicket(plan, "販売対象", label, "販売対象欄を取得できません");
  const actual = ticket.visibility.state === "present" ? ticket.visibility.value : [];
  const missing = required.filter((tag) => !actual.includes(tag));
  return booleanResult(plan, "販売対象", missing.length === 0, `${label}: ${subject}に${missing.map((tag) => `「${tag}」`).join("、")}を追加してください`);
}

function booleanResult(plan: RulePlan, group: string, ok: boolean, failureMessage: string): ValidationResult {
  return result(plan, group, "TICKET", "EACH_TICKET", ok ? "passed" : "failed", ok ? "正常です" : failureMessage);
}

function unknownTicket(plan: RulePlan, group: string, label: string, reason: string): ValidationResult {
  return result(plan, group, "TICKET", "EACH_TICKET", "unknown", `${label}: 確認できません`, { reason });
}

function ticketForPlan(derived: DerivedEvent, plan: RulePlan): DerivedTicket | undefined {
  return derived.tickets.find((ticket) => ticket.ticketId === plan.ticketIds?.[0]);
}

function ticketRuleMetadata(ruleId: string): { group: string } {
  if (["TKT-003", "TKT-004"].includes(ruleId)) return { group: "回数表記" };
  if (["TKT-006", "TKT-012", "TKT-019", "TKT-020"].includes(ruleId)) return { group: "料金" };
  if (["TKT-007", "TKT-011", "TKT-013", "TKT-016"].includes(ruleId)) return { group: "販売対象" };
  if (["TKT-008", "TKT-009", "TKT-014"].includes(ruleId)) return { group: "オンライン案内" };
  if (["TKT-010"].includes(ruleId)) return { group: "プラン変更" };
  if (["TKT-017"].includes(ruleId)) return { group: "固定料金参加経路" };
  if (["TKT-018"].includes(ruleId)) return { group: "券役割整合性" };
  return { group: "表示内容" };
}
