import { chromium } from "playwright";
import fs from "node:fs";
import type { CheckResult, CheckSummary } from "./types.js";
import { checkEventInfo, saveFailureArtifacts } from "./checker.js";
import { EVENT_LIST_URLS, loadEnv, loadRules, STORAGE_STATE_PATH } from "./config.js";
import { collectEventListsWithPagination, fetchEventInfo } from "./osiro.js";
import { postSummaryToSlack, printSummary } from "./slack.js";
import { classifyEventByName } from "./utils/classify.js";
import { sortResultsByStartAtDesc } from "./utils/sort.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const rules = loadRules();
  if (!fs.existsSync(STORAGE_STATE_PATH)) {
    throw new Error(`${STORAGE_STATE_PATH} がありません。先に npm run auth を実行してください。`);
  }

  const browser = await chromium.launch({ headless: env.headless });
  const context = await browser.newContext({ storageState: STORAGE_STATE_PATH });
  const page = await context.newPage();
  const results: CheckResult[] = [];
  let skippedCount = 0;

  try {
    const items = await collectEventListsWithPagination(page, EVENT_LIST_URLS);
    for (const item of items) {
      const listKind = classifyEventByName(item.name);
      if (listKind === "skip") {
        skippedCount += 1;
        continue;
      }

      const detailPage = await context.newPage();
      try {
        await detailPage.goto(item.detailUrl, { waitUntil: "domcontentloaded" });
        const event = await fetchEventInfo(context, item);
        results.push(checkEventInfo(event, rules));
      } catch (error) {
        await saveFailureArtifacts(detailPage, item.name).catch((artifactError) => {
          console.warn(`artifact保存に失敗しました: ${String(artifactError)}`);
        });
        results.push({
          eventName: item.name,
          kind: listKind,
          detailUrl: item.detailUrl,
          startAt: null,
          ok: false,
          errors: [`詳細取得失敗: ${error instanceof Error ? error.message : String(error)}`]
        });
      } finally {
        await detailPage.close();
      }
    }
  } finally {
    await page.close();
    await browser.close();
  }

  const sortedResults = sortResultsByStartAtDesc(results);

  const summary: CheckSummary = {
    targetLabel: "募集中イベント",
    checkedCount: sortedResults.length,
    skippedCount,
    okCount: sortedResults.filter((result) => result.ok).length,
    ngCount: sortedResults.filter((result) => !result.ok).length,
    results: sortedResults,
    executedAt: new Date()
  };

  printSummary(summary);
  try {
    await postSummaryToSlack(env.slackBotToken, env.slackChannelId, summary);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
