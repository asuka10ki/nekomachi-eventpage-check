import { expectedNormalPrice, OPTIONAL_FIRST_TIME_RATE_KEY, RATE_LABELS, REQUIRED_RATE_KEYS } from "../domain/catalog.js";
import type { DeliveryMode, DerivedEvent, RateKey, RulePlan, ValidationResult } from "../domain/model.js";
import { nonApplicableResult, result } from "./common.js";

export function validateBody(derived: DerivedEvent, plans: RulePlan[]): ValidationResult[] {
  return plans.filter((plan) => plan.ruleId.startsWith("BODY-")).map((plan) => {
    const group = plan.ruleId === "BODY-001" || plan.ruleId === "BODY-002" ? "回数表記" : "本文参加費";
    const nonApplicable = nonApplicableResult(plan, group, "BODY", "BODY");
    if (nonApplicable) return nonApplicable;
    const body = derived.event.bodyText;
    if (body.state !== "present") {
      return result(plan, group, "BODY", "BODY", body.state === "empty" && plan.ruleId >= "BODY-003" ? "failed" : "unknown", "ページ本文を確認できません", { reason: body.state === "empty" ? "本文が空欄です" : "本文を取得できません" });
    }
    const fee = feeSection(body.value);
    if (plan.ruleId === "BODY-001") {
      const invalid = [...fee.matchAll(/(?<!今月)(?<![0-9])1回目/g)].length > 0;
      return result(plan, group, "BODY", "BODY", invalid ? "failed" : "passed", invalid ? "ページ本文の参加費の1回目表記を「今月1回目」にしてください" : "1回目表記は正常です");
    }
    if (plan.ruleId === "BODY-002") {
      const tokens = [...fee.matchAll(/(?<!今月)(?<![0-9])2回目(?:以降)?/g)];
      const invalid = tokens.length > 0 || (fee.includes("今月2回目") && !fee.includes("今月2回目以降"));
      return result(plan, group, "BODY", "BODY", invalid ? "failed" : "passed", invalid ? "ページ本文の参加費の2回目以降表記を「今月2回目以降」にしてください" : "2回目以降表記は正常です");
    }
    const mode: DeliveryMode = plan.ruleId === "BODY-003" ? "online" : "offline";
    const amounts = parseBodyFeeMap(fee, mode);
    const required = REQUIRED_RATE_KEYS[mode];
    const optional = OPTIONAL_FIRST_TIME_RATE_KEY[mode];
    const problems: string[] = [];
    for (const key of required) checkAmount(key, amounts, problems);
    if (amounts.has(optional)) checkAmount(optional, amounts, problems);
    return result(plan, group, "BODY", "BODY", problems.length === 0 ? "passed" : "failed", problems.length === 0 ? "本文の参加費は正常です" : `ページ本文の参加費を修正してください: ${problems.join(" / ")}`, { actual: Object.fromEntries(amounts) });
  });
}

export function parseBodyFeeMap(text: string, mode: DeliveryMode): Map<RateKey, number[]> {
  const map = new Map<RateKey, number[]>();
  let previousSemanticKeys: RateKey[] = [];
  for (const row of text.split(/\n|。/).map((value) => value.trim()).filter(Boolean)) {
    // 通常料金表と並記されるスクール・セット参加申込み済みの個別料金は別券群で検査する。
    if (/猫町スクール|お申し込み(?:済|いただ)/.test(row)) continue;
    const amountMatch = row.match(/無料|([0-9０-９,，]+)\s*円/);
    if (!amountMatch) continue;
    const amount = amountMatch[0].includes("無料") ? 0 : Number((amountMatch[1] ?? "").replace(/[，,]/g, "").replace(/[０-９]/g, (char) => String("０１２３４５６７８９".indexOf(char))));
    const first = row.includes("今月1回目");
    const second = row.includes("今月2回目以降");
    const firstTime = row.includes("初参加");
    let keys: RateKey[] = [];
    if (mode === "online") {
      if (row.includes("ハイブリッド会員")) keys.push("ON-HYBRID");
      if (row.includes("地域会員")) keys.push("ON-LOCAL");
      if (row.includes("オンライン会員") && first) keys.push("ON-ONLINE-1");
      if (row.includes("オンライン会員") && second) keys.push("ON-ONLINE-2");
      if (row.includes("非会員")) keys.push(firstTime ? "ON-NONMEMBER-FIRST" : "ON-NONMEMBER");
    } else {
      if (row.includes("地域会員") && first) keys.push("OFF-LOCAL-1");
      if (row.includes("地域会員") && second) keys.push("OFF-LOCAL-2");
      if (row.includes("ハイブリッド会員") && first) keys.push("OFF-HYBRID-1");
      if (row.includes("ハイブリッド会員") && second) keys.push("OFF-HYBRID-2");
      if (row.includes("オンライン会員")) keys.push("OFF-ONLINE");
      if (row.includes("非会員")) keys.push(firstTime ? "OFF-NONMEMBER-FIRST" : "OFF-NONMEMBER");
    }
    if (keys.length === 0 && (first || second)) {
      keys = inheritRecurrenceKeys(previousSemanticKeys, mode, first ? 1 : 2);
    }
    for (const key of keys) map.set(key, [...(map.get(key) ?? []), amount]);
    // 対象者が明示された料金行だけを次行の継承元にする。見出し、注記、
    // 継承行を重ねて推測することはしない。
    previousSemanticKeys = hasExplicitFeeAudience(row) ? keys : [];
  }
  return map;
}

function inheritRecurrenceKeys(previous: RateKey[], mode: DeliveryMode, recurrence: 1 | 2): RateKey[] {
  if (previous.length === 0) return [];
  if (mode === "online") {
    const hasOnlineRecurrence = previous.every((key) => key === "ON-ONLINE-1" || key === "ON-ONLINE-2");
    return hasOnlineRecurrence ? [recurrence === 1 ? "ON-ONLINE-1" : "ON-ONLINE-2"] : [];
  }
  const transformed = previous.flatMap((key): RateKey[] => {
    if (key === "OFF-LOCAL-1" || key === "OFF-LOCAL-2") return [recurrence === 1 ? "OFF-LOCAL-1" : "OFF-LOCAL-2"];
    if (key === "OFF-HYBRID-1" || key === "OFF-HYBRID-2") return [recurrence === 1 ? "OFF-HYBRID-1" : "OFF-HYBRID-2"];
    return [];
  });
  return transformed.length === previous.length ? [...new Set(transformed)] : [];
}

function hasExplicitFeeAudience(row: string): boolean {
  return ["ハイブリッド会員", "地域会員", "オンライン会員", "非会員"].some((label) => row.includes(label));
}

function checkAmount(key: RateKey, amounts: Map<RateKey, number[]>, problems: string[]): void {
  const actual = amounts.get(key);
  const expected = expectedNormalPrice(key);
  if (!actual || actual.length === 0) problems.push(`${RATE_LABELS[key]}がありません`);
  else if (actual.some((amount) => amount !== expected)) problems.push(`${RATE_LABELS[key]}は${expected}円にしてください（実際: ${actual.join(",")}円）`);
}

function feeSection(body: string): string {
  const marker = body.search(/(?:^|\n)[^\S\r\n]*(?:(?:■|●|◆|🔴|◾️?)\s*)?(?:読書会)?参加費(?=$|[\s:：（(])/m);
  if (marker < 0) return "";
  const remaining = body.slice(marker);
  const match = remaining.slice(1).match(/\n\s*(?:(?:■|●|◆|🔴|◾️?)|#{1,6}\s+)/);
  return match?.index === undefined ? remaining : remaining.slice(0, match.index + 1);
}
