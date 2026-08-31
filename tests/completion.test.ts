import { afterEach, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ArtifactOperationError,
  prepareArtifactFile,
  pruneExpiredArtifacts,
  writePrivateArtifact,
  type ArtifactFileSystem
} from "../src/artifacts/manager.js";
import { fetchEventInfoFromPage } from "../src/osiro.js";
import { sanitizeDiagnosticHtml } from "../src/checker.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "event-check-completion-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("TSK-018 artifact lifecycle", () => {
  it("redacts secrets before diagnostic HTML is written", () => {
    const sanitized = sanitizeDiagnosticHtml('<input type="hidden" name="authenticity_token" value="secret"><input type="password" value="password"><p>xoxb-123-secret https://hooks.slack.com/services/A/B/C</p>');
    expect(sanitized).not.toMatch(/value="secret"|value="password"|hooks\.slack\.com\/services/);
    expect(sanitized).toContain("[REDACTED]");
  });
  it("deletes only expired known artifacts and retains boundary, recent and unknown files", async () => {
    const parent = await temporaryDirectory();
    const root = path.join(parent, "artifacts");
    const now = new Date("2026-08-23T12:00:00.000Z");
    const expired = await createArtifact(root, "screenshots", "expired.png", new Date("2026-07-23T11:59:59.999Z"));
    const boundary = await createArtifact(root, "screenshots", "boundary.png", new Date("2026-07-24T12:00:00.000Z"));
    const recent = await createArtifact(root, "html", "recent.html", new Date("2026-08-23T11:00:00.000Z"));
    const unknown = await createArtifact(root, "html", "keep.txt", new Date("2020-01-01T00:00:00.000Z"));

    const report = await pruneExpiredArtifacts({ root, retentionDays: 30, now });

    expect(report.deleted).toEqual([expired]);
    await expect(fs.stat(expired)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(boundary)).resolves.toBeDefined();
    await expect(fs.stat(recent)).resolves.toBeDefined();
    await expect(fs.stat(unknown)).resolves.toBeDefined();
  });

  it("never touches state, authentication, files outside the root or symbolic-link targets", async () => {
    const parent = await temporaryDirectory();
    const root = path.join(parent, "artifacts");
    const outside = path.join(parent, "outside");
    await fs.mkdir(outside, { recursive: true });
    const outsideFile = path.join(outside, "secret.png");
    const stateFile = path.join(parent, "last-successful-event-count.json");
    const authFile = path.join(parent, "storageState.json");
    await fs.writeFile(outsideFile, "outside", "utf8");
    await fs.writeFile(stateFile, "state", "utf8");
    await fs.writeFile(authFile, "auth", "utf8");
    await fs.mkdir(root, { recursive: true });
    await fs.symlink(outside, path.join(root, "screenshots"), "junction");

    const report = await pruneExpiredArtifacts({ root, retentionDays: 0, now: new Date("2026-08-23T12:00:00.000Z") });

    expect(report.deleted).toEqual([]);
    await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("outside");
    await expect(fs.readFile(stateFile, "utf8")).resolves.toBe("state");
    await expect(fs.readFile(authFile, "utf8")).resolves.toBe("auth");
    const safe = await prepareArtifactFile("html", "../../escape.html", root);
    expect(path.dirname(safe)).toBe(path.join(root, "html"));
  });

  it("handles a missing directory and retention zero with an explicit fake clock", async () => {
    const parent = await temporaryDirectory();
    const root = path.join(parent, "missing-artifacts");
    await expect(pruneExpiredArtifacts({ root, now: new Date("2026-08-23T12:00:00.000Z") })).resolves.toEqual({ examined: 0, deleted: [], retained: [] });
    const old = await createArtifact(root, "json", "old.json", new Date("2026-08-23T11:59:59.999Z"));
    const boundary = await createArtifact(root, "json", "boundary.json", new Date("2026-08-23T12:00:00.000Z"));
    const report = await pruneExpiredArtifacts({ root, retentionDays: 0, now: new Date("2026-08-23T12:00:00.000Z") });
    expect(report.deleted).toEqual([old]);
    await expect(fs.stat(boundary)).resolves.toBeDefined();
  });

  it("reports deletion and permission failures instead of swallowing them", async () => {
    const parent = await temporaryDirectory();
    const root = path.join(parent, "artifacts");
    await createArtifact(root, "html", "old.html", new Date("2020-01-01T00:00:00.000Z"));
    const deleteFailure: ArtifactFileSystem = { ...fs, rm: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } };
    await expect(pruneExpiredArtifacts({ root, retentionDays: 0, now: new Date("2026-08-23T12:00:00.000Z"), fileSystem: deleteFailure }))
      .rejects.toMatchObject({ operation: "delete" });

    const permissionFailure: ArtifactFileSystem = { ...fs, chmod: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } };
    await expect(prepareArtifactFile("html", "failure.html", root, permissionFailure)).rejects.toMatchObject({ operation: "permission" });
    await expect(writePrivateArtifact(path.join(root, "html", "failure.html"), "body", permissionFailure)).rejects.toMatchObject({ operation: "permission" });
  });

  it("rejects invalid retention settings", async () => {
    await expect(pruneExpiredArtifacts({ retentionDays: -1 })).rejects.toBeInstanceOf(ArtifactOperationError);
    await expect(pruneExpiredArtifacts({ retentionDays: 1.5 })).rejects.toBeInstanceOf(ArtifactOperationError);
  });
});

describe("TSK-019 detail DOM readiness", () => {
  let browser: Browser | undefined;
  let page: Page | undefined;

  afterEach(async () => {
    await page?.close();
    await browser?.close();
    page = undefined;
    browser = undefined;
  });

  async function openPage(): Promise<Page> {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    return page;
  }

  it("loads a normal detail page from required DOM without waiting for network quiescence", async () => {
    const current = await openPage();
    await current.route("http://osiro.test/**", async (route) => {
      if (route.request().url().endsWith("/stream")) return;
      await route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: detailHtml("通常表示", "<script>fetch('/stream')</script>") });
    });
    const result = await fetchEventInfoFromPage(current, item("normal"), { domTimeoutMs: 500 });
    expect(result.name).toBe("通常表示");
    expect(result.fieldAvailability?.tickets).toBe(true);
  });

  it("waits for delayed form and delayed ticket DOM instead of using a fixed sleep", async () => {
    const current = await openPage();
    const delayed = `<div id="mount"></div><script>
      setTimeout(() => { document.querySelector('#mount').innerHTML = ${JSON.stringify(detailHtml("遅延表示"))}; }, 30);
    </script>`;
    await current.route("http://osiro.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: delayed }));
    const result = await fetchEventInfoFromPage(current, item("delayed"), { domTimeoutMs: 500 });
    expect(result.name).toBe("遅延表示");
    expect(result.tickets).toHaveLength(1);
  });

  it("waits until fields inside an already visible ticket become available", async () => {
    const current = await openPage();
    const incomplete = detailHtml("項目遅延").replace('<select><option selected>オン</option></select>', '<span id="visibility-slot"></span>');
    const delayedField = `${incomplete}<script>setTimeout(() => { document.querySelector('#visibility-slot').innerHTML = '<select><option selected>オン</option></select>'; }, 30);</script>`;
    await current.route("http://osiro.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: delayedField }));
    const result = await fetchEventInfoFromPage(current, item("delayed-field"), { domTimeoutMs: 500 });
    expect(result.tickets[0]?.fieldAvailability?.visibility).toBe(true);
  });

  it("distinguishes a missing form, missing ticket region and missing title by timeout reason", async () => {
    const current = await openPage();
    await current.route("http://osiro.test/admin_events/title-only/edit", (route) => route.fulfill({ status: 200, contentType: "text/html", body: '<input id="title" value="タイトルのみ">' }));
    await expect(fetchEventInfoFromPage(current, item("title-only"), { domTimeoutMs: 100 })).rejects.toMatchObject({ ruleId: "QUAL-DETAIL-004" });

    await current.route("http://osiro.test/admin_events/no-tickets/edit", (route) => route.fulfill({ status: 200, contentType: "text/html", body: detailHtml("券領域なし", "", false) }));
    await expect(fetchEventInfoFromPage(current, item("no-tickets"), { domTimeoutMs: 100 })).rejects.toMatchObject({ ruleId: "QUAL-DETAIL-005" });

    await current.route("http://osiro.test/admin_events/incomplete-ticket/edit", (route) => route.fulfill({
      status: 200,
      contentType: "text/html",
      body: detailHtml("券項目不足").replace('<select><option selected>オン</option></select>', "")
    }));
    await expect(fetchEventInfoFromPage(current, item("incomplete-ticket"), { domTimeoutMs: 100 })).rejects.toMatchObject({ ruleId: "QUAL-DETAIL-006" });

    await current.route("http://osiro.test/admin_events/no-title/edit", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<main>changed</main>" }));
    await expect(fetchEventInfoFromPage(current, item("no-title"), { domTimeoutMs: 100 })).rejects.toMatchObject({ ruleId: "QUAL-DETAIL-003" });
  });

  it("rejects login redirects, navigation failures and HTTP errors", async () => {
    const current = await openPage();
    await current.route("http://osiro.test/admin_events/login/edit", (route) => route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: "<script>history.replaceState(null, '', '/login')</script><main>login</main>"
    }));
    await expect(fetchEventInfoFromPage(current, item("login"), { domTimeoutMs: 20 })).rejects.toMatchObject({ ruleId: "QUAL-DETAIL-002" });

    await current.route("http://osiro.test/admin_events/http/edit", (route) => route.fulfill({ status: 503, body: "unavailable" }));
    await expect(fetchEventInfoFromPage(current, item("http"), { domTimeoutMs: 20 })).rejects.toMatchObject({ ruleId: "QUAL-DETAIL-001" });

    await current.route("http://osiro.test/admin_events/abort/edit", (route) => route.abort("connectionfailed"));
    await expect(fetchEventInfoFromPage(current, item("abort"), { navigationTimeoutMs: 100 })).rejects.toBeDefined();
  });

  it("times out a navigation that never completes", async () => {
    const current = await openPage();
    await current.route("http://osiro.test/admin_events/navigation-timeout/edit", async () => new Promise<void>(() => {
      // navigation timeoutを再現するため、routeを意図的に未完了のまま保持する。
    }));
    await expect(fetchEventInfoFromPage(current, item("navigation-timeout"), { navigationTimeoutMs: 30, domTimeoutMs: 20 })).rejects.toBeDefined();
  });
});

async function createArtifact(root: string, category: "screenshots" | "html" | "json", name: string, modifiedAt: Date): Promise<string> {
  const directory = path.join(root, category);
  await fs.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, name);
  await fs.writeFile(filePath, "artifact", "utf8");
  await fs.utimes(filePath, modifiedAt, modifiedAt);
  return path.resolve(filePath);
}

function item(id: string) {
  return { name: id, detailUrl: `http://osiro.test/admin_events/${id}/edit` };
}

function detailHtml(title: string, extra = "", includeTickets = true): string {
  return `<div id="editEvent"><input id="title" value="${title}"><input type="datetime-local" value="2026-08-23T20:00"><input type="datetime-local" value="2026-08-23T22:00"><input id="editEvent_venue" value="オンライン"><textarea name="body">本文</textarea>${includeTickets ? '<div id="event_tickets"><input name="event_ticket_name" value="参加券"><select><option selected>無料</option></select><input id="is_online_1" type="checkbox" checked><input placeholder="Zoom" value="https://zoom.example/room"><textarea placeholder="参加方法">19:55までに参加してください</textarea><select><option selected>オン</option></select></div>' : ""}</div>${extra}`;
}
