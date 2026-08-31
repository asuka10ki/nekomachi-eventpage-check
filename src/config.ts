import fs from "node:fs";

export const EVENT_LIST_URL = "https://nekomachi-club.com/admin/events?state=yet_end";
export const STORAGE_STATE_PATH = "storageState.json";

export type AppEnv = {
  slackBotToken?: string;
  slackChannelId: string;
  slackDryRun?: boolean;
  headless: boolean;
  artifactRetentionDays?: number;
  artifactCleanupEnabled?: boolean;
};

export function loadEnv(): AppEnv {
  loadDotEnvFile();
  return {
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    slackChannelId: process.env.SLACK_CHANNEL_ID || "",
    slackDryRun: (process.env.SLACK_DRY_RUN || "false").toLowerCase() === "true",
    headless: (process.env.HEADLESS || "true").toLowerCase() !== "false",
    artifactRetentionDays: parseNonNegativeInteger(process.env.ARTIFACT_RETENTION_DAYS, 30, "ARTIFACT_RETENTION_DAYS"),
    artifactCleanupEnabled: (process.env.ARTIFACT_CLEANUP_ENABLED || "true").toLowerCase() !== "false"
  };
}

function parseNonNegativeInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} は0以上の整数で指定してください`);
  return parsed;
}

export function validateOperationalConfig(env: AppEnv): void {
  if (env.slackDryRun) return;
  if (!env.slackBotToken?.trim()) throw new Error("SLACK_BOT_TOKEN が未設定です");
  if (!env.slackChannelId.trim()) throw new Error("SLACK_CHANNEL_ID が未設定です");
}

function loadDotEnvFile(filePath = ".env"): void {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}
