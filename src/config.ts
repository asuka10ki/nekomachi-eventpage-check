import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { RulesConfig } from "./types.js";

export const EVENT_LIST_URL = "https://nekomachi-club.com/admin/events?state=yet_end";
export const EVENT_LIST_URLS = [
  EVENT_LIST_URL,
  "https://nekomachi-club.com/admin/events?limit=30&page=2&state=yet_end"
];
export const STORAGE_STATE_PATH = "storageState.json";

export type AppEnv = {
  slackBotToken?: string;
  slackChannelId: string;
  headless: boolean;
};

export function loadEnv(): AppEnv {
  loadDotEnvFile();
  return {
    slackBotToken: process.env.SLACK_BOT_TOKEN,
    slackChannelId: process.env.SLACK_CHANNEL_ID || "C0BCXMXG745",
    headless: (process.env.HEADLESS || "true").toLowerCase() !== "false"
  };
}

export function loadRules(filePath = path.join("config", "rules.yaml")): RulesConfig {
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = YAML.parse(raw) as RulesConfig;
  validateRules(parsed);
  return parsed;
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

function validateRules(config: RulesConfig): void {
  for (const kind of ["online", "offline"] as const) {
    if (!config[kind]?.tickets?.length) throw new Error(`config/rules.yaml の ${kind}.tickets が空です`);
    for (const ticket of config[kind].tickets) {
      if (ticket.visibilityTags.length !== 1) {
        throw new Error(`チケットルール ${ticket.id} の visibilityTags は1要素にしてください`);
      }
    }
  }
}
