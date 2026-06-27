import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { chromium } from "playwright";
import { EVENT_LIST_URL, STORAGE_STATE_PATH } from "./config.js";

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(EVENT_LIST_URL, { waitUntil: "domcontentloaded" });

  console.log("ブラウザでOSIROに手動ログインしてください。ログイン後、このターミナルでEnterを押すと状態を保存します。");
  const rl = createInterface({ input, output });
  await rl.question("ログインが完了したらEnter: ");
  rl.close();

  await context.storageState({ path: STORAGE_STATE_PATH });
  await browser.close();
  console.log(`${STORAGE_STATE_PATH} にログイン状態を保存しました。`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
