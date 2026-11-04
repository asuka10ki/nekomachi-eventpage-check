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

export const NEKOMACHI_PLUS_PRICE = 0;
export const NEKOMACHI_PLUS_REQUIRED_VISIBILITY = ["オン", "オフ", "ハイ"] as const;
export const MEMBER_NONMEMBER_FIXED_MEMBER_PRICE = 6000;
export const MEMBER_NONMEMBER_FIXED_EXTERNAL_PRICE = 8500;
export const MEMBER_VISIBILITY_TAGS = ["オン", "オフ", "ハイ"] as const;
export type OfflineRateKey = Extract<RateKey, `OFF-${string}`>;
export type OfflinePricePattern = Readonly<Record<OfflineRateKey, number>>;
function offlinePricePattern(memberPrice: number, nonmemberPrice: number): OfflinePricePattern {
  return {
    "OFF-LOCAL-1": 0, "OFF-HYBRID-1": 0,
    "OFF-LOCAL-2": memberPrice, "OFF-HYBRID-2": memberPrice, "OFF-ONLINE": memberPrice,
    "OFF-NONMEMBER": nonmemberPrice, "OFF-NONMEMBER-FIRST": nonmemberPrice
  };
}
export const NORMAL_OFFLINE_PRICE_PATTERNS: readonly OfflinePricePattern[] = [
  offlinePricePattern(1800, 2300),
  offlinePricePattern(1800, 2000),
  offlinePricePattern(1500, 1800)
];

export function isOfflineRateKey(key: RateKey): key is OfflineRateKey {
  return key.startsWith("OFF-");
}

export function matchingNormalOfflinePatterns(
  entries: ReadonlyArray<{ rateKey: RateKey; price: number }>,
  patterns: readonly OfflinePricePattern[] = NORMAL_OFFLINE_PRICE_PATTERNS
): OfflinePricePattern[] {
  // 許可金額外は各値の不備として報告し、料金パターンの推測には使わない。
  const valid = entries.filter(({ rateKey, price }) => isOfflineRateKey(rateKey)
    && NORMAL_OFFLINE_PRICE_PATTERNS.some((pattern) => pattern[rateKey] === price));
  return patterns.filter((pattern) => valid.every(({ rateKey, price }) => isOfflineRateKey(rateKey) && pattern[rateKey] === price));
}

function offlineAllowedPrices(key: OfflineRateKey): number[] {
  return [...new Set(NORMAL_OFFLINE_PRICE_PATTERNS.map((pattern) => pattern[key]))];
}

export type MemberNonmemberAudience = "member" | "external" | "conflict" | "none";

export function memberNonmemberAudience(visibilityTags: string[]): MemberNonmemberAudience {
  const hasMember = MEMBER_VISIBILITY_TAGS.some((tag) => visibilityTags.includes(tag));
  const hasExternal = visibilityTags.includes("外");
  if (hasMember && hasExternal) return "conflict";
  if (hasMember) return "member";
  if (hasExternal) return "external";
  return "none";
}

export function memberNonmemberFixedPrice(audience: MemberNonmemberAudience): number | null {
  if (audience === "member") return MEMBER_NONMEMBER_FIXED_MEMBER_PRICE;
  if (audience === "external") return MEMBER_NONMEMBER_FIXED_EXTERNAL_PRICE;
  return null;
}

const NORMAL_PRICES: Record<RateKey, number[]> = {
  "ON-HYBRID": [0],
  "ON-LOCAL": [800],
  "ON-ONLINE-1": [0],
  "ON-ONLINE-2": [800],
  "ON-NONMEMBER": [1100],
  "ON-NONMEMBER-FIRST": [1100],
  "OFF-LOCAL-1": offlineAllowedPrices("OFF-LOCAL-1"),
  "OFF-HYBRID-1": offlineAllowedPrices("OFF-HYBRID-1"),
  "OFF-LOCAL-2": offlineAllowedPrices("OFF-LOCAL-2"),
  "OFF-HYBRID-2": offlineAllowedPrices("OFF-HYBRID-2"),
  "OFF-ONLINE": offlineAllowedPrices("OFF-ONLINE"),
  "OFF-NONMEMBER": offlineAllowedPrices("OFF-NONMEMBER"),
  "OFF-NONMEMBER-FIRST": offlineAllowedPrices("OFF-NONMEMBER-FIRST")
};

const GUEST_PRICES: Record<RateKey, number[]> = {
  "ON-HYBRID": [550, 500],
  "ON-LOCAL": [1200],
  "ON-ONLINE-1": [550, 500],
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

const GUEST_ONLINE_PRICE_PATTERNS: ReadonlyArray<Readonly<Partial<Record<RateKey, number>>>> = [
  {
    "ON-HYBRID": 550,
    "ON-LOCAL": 1200,
    "ON-ONLINE-1": 550,
    "ON-ONLINE-2": 1200,
    "ON-NONMEMBER": 1500,
    "ON-NONMEMBER-FIRST": 1500
  },
  {
    "ON-HYBRID": 500,
    "ON-LOCAL": 1200,
    "ON-ONLINE-1": 500,
    "ON-ONLINE-2": 1200,
    "ON-NONMEMBER": 1500,
    "ON-NONMEMBER-FIRST": 1500
  }
];

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

export function matchesGuestPriceConfiguration(
  deliveryMode: DeliveryMode,
  entries: ReadonlyArray<{ rateKeys: RateKey[]; price: number }>
): boolean {
  if (deliveryMode !== "online") {
    return entries.every((entry) => entry.rateKeys.every((key) => isGuestPrice(key, entry.price)));
  }
  return GUEST_ONLINE_PRICE_PATTERNS.some((pattern) =>
    entries.every((entry) => entry.rateKeys.every((key) => pattern[key] === entry.price))
  );
}

export function expectedNormalPrice(rateKey: RateKey): number {
  return NORMAL_PRICES[rateKey][0];
}
