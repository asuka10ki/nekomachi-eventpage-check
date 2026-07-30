import { chromium } from "playwright";
import fs from "node:fs";
import type { CheckResult, CheckSummary } from "./types.js";
import { checkEventInfo, saveFailureArtifacts } from "./checker.js";
import { EVENT_LIST_URLS, loadEnv, loadRules, STORAGE_STATE_PATH } from "./config.js";
import { collectEventListsWithPagination, fetchEventInfo } from "./osiro.js";
import { postFatalErrorToSlack, postSummaryToSlack, printSummary } from "./slack.js";
import { classifyEventByName } from "./utils/classify.js";
import { sortResultsByStartAtDesc } from "./utils/sort.js";
import {
  assertEventCountHasNotDroppedUnexpectedly,
  loadPreviousEventCount,
  saveSuccessfulEventCount
} from "./check-state.js";

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
  let authenticatedSessionConfirmed = false;

  try {
    const items = await collectEventListsWithPagination(page, EVENT_LIST_URLS);
    assertEventCountHasNotDroppedUnexpectedly(loadPreviousEventCount(), items.length);
    authenticatedSessionConfirmed = true;
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
          status: "unknown",
          errors: [`詳細取得失敗: ${error instanceof Error ? error.message : String(error)}`]
        });
      } finally {
        await detailPage.close();
      }
    }
    saveSuccessfulEventCount(items.length);
  } finally {
    if (authenticatedSessionConfirmed) {
      await context.storageState({ path: STORAGE_STATE_PATH }).catch((error) => {
        console.warn(`ログイン状態の自動更新に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    await page.close();
    await browser.close();
  }

  const sortedResults = sortResultsByStartAtDesc(results);
  const unknownCount = sortedResults.filter((result) => result.status === "unknown").length;

  const summary: CheckSummary = {
    targetLabel: "募集中イベント",
    checkedCount: sortedResults.length,
    skippedCount,
    okCount: sortedResults.filter((result) => result.ok && result.status !== "unknown").length,
    ngCount: sortedResults.filter((result) => !result.ok && result.status !== "unknown").length,
    unknownCount,
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

main().catch(async (error) => {
  try {
    const env = loadEnv();
    await postFatalErrorToSlack(env.slackBotToken, env.slackChannelId, error);
  } catch (slackError) {
    console.error(`実行失敗のSlack通知にも失敗しました: ${slackError instanceof Error ? slackError.message : String(slackError)}`);
  }
  console.error(error);
  process.exitCode = 1;
});
