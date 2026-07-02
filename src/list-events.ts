import fs from "node:fs";
import { chromium } from "playwright";
import { EVENT_LIST_URLS, loadEnv, STORAGE_STATE_PATH } from "./config.js";
import { collectEventListsWithPagination } from "./osiro.js";
import { classifyEventByName } from "./utils/classify.js";

async function main(): Promise<void> {
  const env = loadEnv();
  if (!fs.existsSync(STORAGE_STATE_PATH)) {
    throw new Error(`${STORAGE_STATE_PATH} がありません。先に npm run auth を実行してください。`);
  }

  const browser = await chromium.launch({ headless: env.headless });
  const context = await browser.newContext({ storageState: STORAGE_STATE_PATH });
  const page = await context.newPage();

  try {
    const events = await collectEventListsWithPagination(page, EVENT_LIST_URLS);
    console.log(`取得件数: ${events.length}`);
    events.forEach((event, index) => {
      console.log(`${index + 1}. [${classifyEventByName(event.name)}] ${event.name}`);
      console.log(`   ${event.detailUrl}`);
    });
  } finally {
    await page.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
