import { normalizeUrlText } from "./normalize.js";

export function normalizeOnlineUrl(text: string | null): string {
  return normalizeUrlText(text);
}

export function safeFileName(name: string): string {
  return name
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80) || "event";
}
