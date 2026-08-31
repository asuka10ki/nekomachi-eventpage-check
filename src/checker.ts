import { safeFileName } from "./utils/url.js";
import { prepareArtifactFile, secureArtifactFile, writePrivateArtifact } from "./artifacts/manager.js";

export async function saveFailureArtifacts(
  page: { screenshot(options: { path: string; fullPage: boolean }): Promise<unknown>; content(): Promise<string> },
  eventName: string
): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeName = safeFileName(eventName);
  const screenshotPath = await prepareArtifactFile("screenshots", `${timestamp}-${safeName}.png`);
  const htmlPath = await prepareArtifactFile("html", `${timestamp}-${safeName}.html`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await secureArtifactFile(screenshotPath);
  await writePrivateArtifact(htmlPath, sanitizeDiagnosticHtml(await page.content()));
}

export function sanitizeDiagnosticHtml(html: string): string {
  return html
    .replace(/(<input\b[^>]*\btype=["']?(?:hidden|password)["']?[^>]*\bvalue=["'])[^"']*(["'][^>]*>)/gi, "$1[REDACTED]$2")
    .replace(/(<input\b[^>]*\bname=["']?(?:authenticity_token|csrf[^"'\s>]*)["']?[^>]*\bvalue=["'])[^"']*(["'][^>]*>)/gi, "$1[REDACTED]$2")
    .replace(/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/gi, "[REDACTED_SLACK_WEBHOOK]")
    .replace(/\bxox[a-z]-[A-Za-z0-9-]+\b/g, "[REDACTED_SLACK_TOKEN]");
}
