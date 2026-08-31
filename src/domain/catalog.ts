import type { DeliveryMode, PricingScheme, RateKey } from "./model.js";

export const ALL_RATE_KEYS: RateKey[] = [
  "ON-HYBRID", "ON-LOCAL", "ON-ONLINE-1", "ON-ONLINE-2", "ON-NONMEMBER", "ON-NONMEMBER-FIRST",
  "OFF-LOCAL-1", "OFF-HYBRID-1", "OFF-LOCAL-2", "OFF-HYBRID-2", "OFF-ONLINE", "OFF-NONMEMBER", "OFF-NONMEMBER-FIRST"
];

export const REQUIRED_RATE_KEYS: Record<DeliveryMode, RateKey[]> = {
  online: ["ON-HYBRID", "ON-LOCAL", "ON-ONLINE-1", "ON-ONLINE-2", "ON-NONMEMBER"],
  offline: ["OFF-LOCAL-1", "OFF-HYBRID-1", "OFF-LOCAL-2", "OFF-HYBRID-2", "OFF-ONLINE", "OFF-NONMEMBER"],
  hybrid: ["OFF-LOCAL-1", "OFF-HYBRID-1", "OFF-LOCAL-2", "OFF-HYBRID-2", "OFF-ONLINE", "OFF-NONMEMBER"]
};

export const OPTIONAL_FIRST_TIME_RATE_KEY: Record<DeliveryMode, RateKey> = {
  online: "ON-NONMEMBER-FIRST",
  offline: "OFF-NONMEMBER-FIRST",
  hybrid: "OFF-NONMEMBER-FIRST"
};

const NORMAL_PRICES: Record<RateKey, number[]> = {
  "ON-HYBRID": [0],
  "ON-LOCAL": [800],
  "ON-ONLINE-1": [0],
  "ON-ONLINE-2": [800],
  "ON-NONMEMBER": [1100],
  "ON-NONMEMBER-FIRST": [1100],
  "OFF-LOCAL-1": [0],
  "OFF-HYBRID-1": [0],
  "OFF-LOCAL-2": [1800],
  "OFF-HYBRID-2": [1800],
  "OFF-ONLINE": [1800],
  "OFF-NONMEMBER": [2300],
  "OFF-NONMEMBER-FIRST": [2300]
};

const GUEST_PRICES: Record<RateKey, number[]> = {
  "ON-HYBRID": [550],
  "ON-LOCAL": [1200],
  "ON-ONLINE-1": [550],
  "ON-ONLINE-2": [1200],
  "ON-NONMEMBER": [1500],
  "ON-NONMEMBER-FIRST": [1500],
  "OFF-LOCAL-1": [800, 500],
  "OFF-HYBRID-1": [800, 500],
  "OFF-LOCAL-2": [3000, 2300],
  "OFF-HYBRID-2": [3000, 2300],
  "OFF-ONLINE": [3000, 2300],
  "OFF-NONMEMBER": [3500, 2800],
  "OFF-NONMEMBER-FIRST": [3500, 2800]
};

export const RATE_VISIBILITY: Record<RateKey, string> = {
  "ON-HYBRID": "ハイ",
  "ON-LOCAL": "オフ",
  "ON-ONLINE-1": "オン",
  "ON-ONLINE-2": "オン",
  "ON-NONMEMBER": "外",
  "ON-NONMEMBER-FIRST": "外",
  "OFF-LOCAL-1": "オフ",
  "OFF-HYBRID-1": "ハイ",
  "OFF-LOCAL-2": "オフ",
  "OFF-HYBRID-2": "ハイ",
  "OFF-ONLINE": "オン",
  "OFF-NONMEMBER": "外",
  "OFF-NONMEMBER-FIRST": "外"
};

export const RATE_LABELS: Record<RateKey, string> = {
  "ON-HYBRID": "ハイブリッド会員",
  "ON-LOCAL": "地域会員",
  "ON-ONLINE-1": "オンライン会員（今月1回目）",
  "ON-ONLINE-2": "オンライン会員（今月2回目以降）",
  "ON-NONMEMBER": "非会員",
  "ON-NONMEMBER-FIRST": "非会員（初参加）",
  "OFF-LOCAL-1": "地域会員（今月1回目）",
  "OFF-HYBRID-1": "ハイブリッド会員（今月1回目）",
  "OFF-LOCAL-2": "地域会員（今月2回目以降）",
  "OFF-HYBRID-2": "ハイブリッド会員（今月2回目以降）",
  "OFF-ONLINE": "オンライン会員",
  "OFF-NONMEMBER": "非会員",
  "OFF-NONMEMBER-FIRST": "非会員（初参加）"
};

export function allowedPrices(rateKey: RateKey, scheme: PricingScheme): number[] {
  if (scheme === "not-applicable") return [];
  return scheme === "guest" ? GUEST_PRICES[rateKey] : NORMAL_PRICES[rateKey];
}

export function isGuestPrice(rateKey: RateKey, price: number): boolean {
  return GUEST_PRICES[rateKey].includes(price);
}

export function expectedNormalPrice(rateKey: RateKey): number {
  return NORMAL_PRICES[rateKey][0];
}
