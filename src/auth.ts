import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { chromium } from "playwright";
import { EVENT_LIST_URL, STORAGE_STATE_PATH, loadEnv } from "./config.js";
import { createAuthenticationHandler } from "./authentication/osiro.js";
import { assertAdminEventListPageState, assertSuccessfulHttpResponse } from "./acquisition/quality.js";
import { saveStorageStateAtomically } from "./run/persistence.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(EVENT_LIST_URL, { waitUntil: "domcontentloaded" });

    console.log("ブラウザでOSIROに手動ログインしてください。ログイン後、このターミナルでEnterを押すと管理画面へのアクセスを確認して状態を保存します。");
    const rl = createInterface({ input, output });
    try { await rl.question("ログインが完了したらEnter: "); }
    finally { rl.close(); }

    const response = await page.goto(EVENT_LIST_URL, { waitUntil: "domcontentloaded" });
    assertSuccessfulHttpResponse(page.url(), response?.status() ?? null, response?.ok() ?? false);
    await createAuthenticationHandler(env.verificationMailbox)(page, EVENT_LIST_URL);
    assertAdminEventListPageState(page.url(), await page.locator("#eventIndex").count() > 0);
    await saveStorageStateAtomically(context, STORAGE_STATE_PATH);
    console.log(`${STORAGE_STATE_PATH} にログイン状態を保存しました。`);
  } finally { await browser.close(); }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
