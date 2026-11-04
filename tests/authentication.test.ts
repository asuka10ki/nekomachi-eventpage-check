import { afterEach, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { extractVerificationCode, waitForVerificationCode, type VerificationMailbox } from "../src/authentication/mailbox.js";
import { createAuthenticationHandler } from "../src/authentication/osiro.js";
import { assertAdminSessionIsValid } from "../src/acquisition/quality.js";
import { collectEventListWithPagination, fetchEventInfoFromPage } from "../src/osiro.js";
import { loadMailboxConfig } from "../src/config.js";

const now = new Date("2026-10-22T03:00:00Z");
const sender = "info@nekomachi-club.com";
const subject = "【猫町.】管理ツールの確認コード";
function message(options: { from?: string; subject?: string; date?: string; body?: string; html?: boolean } = {}): Buffer {
  return Buffer.from([
    `From: ${options.from ?? sender}`,
    `Subject: =?UTF-8?B?${Buffer.from(options.subject ?? subject).toString("base64")}?=`,
    ...(options.date === "" ? [] : [`Date: ${options.date ?? now.toUTCString()}`]),
    `Content-Type: text/${options.html ? "html" : "plain"}; charset=utf-8`,
    "Content-Transfer-Encoding: base64", "",
    Buffer.from(options.body ?? "次の確認コードを画面に入力してください。\n123456").toString("base64")
  ].join("\r\n"));
}

describe("OSIRO verification mail copied from roster app", () => {
  it("loads the same mail environment variables as the roster app without requiring them for an authenticated run", () => {
    expect(loadMailboxConfig({})).toBeUndefined();
    expect(loadMailboxConfig({ MAIL_ADDRESS: "user", MAIL_PASSWORD_OR_APP_PASSWORD: "test" }))
      .toEqual({ host: "imap.mail.yahoo.co.jp", port: 993, username: "user", password: "test" });
    expect(() => loadMailboxConfig({ MAIL_USERNAME: "user" })).toThrow("両方設定");
    expect(() => loadMailboxConfig({ MAIL_USERNAME: "user", MAIL_PASSWORD_OR_APP_PASSWORD: "test", MAIL_IMAP_PORT: "bad" })).toThrow("MAIL_IMAP_PORT");
  });
  it.each([false, true])("extracts encoded plain/HTML mail and ignores unrelated numbers: html=%s", async (html) => {
    const body = html
      ? '<style>.x{color:#654321}</style>次の確認コードを画面に入力してください。<br><strong>123456</strong>'
      : "参照番号654321\n確認コードを画面に入力してください。\n123456";
    expect(await extractVerificationCode(message({ body, html }), now, now)).toBe("123456");
  });

  it.each([
    { from: `${sender}.attacker.invalid` },
    { subject: "イベント参加者CSV" },
    { date: new Date(now.getTime() - 120000).toUTCString() },
    { date: new Date(now.getTime() - 600000).toUTCString() },
    { date: new Date(now.getTime() + 120000).toUTCString() },
    { date: "" },
    { date: "invalid" },
    { body: "参照番号: 123456" },
    { body: "確認コードを画面に入力してください。123456\n確認コードを画面に入力してください。654321" }
  ])("rejects stale, unrelated or ambiguous mail: %j", async (options) => {
    expect(await extractVerificationCode(message(options), now, now)).toBeUndefined();
  });

  it("refreshes the read-only inbox each poll and never reuses an old UID", async () => {
    const fetched: number[] = [];
    let refreshes = 0;
    const box: VerificationMailbox = {
      refresh: async () => { refreshes++; },
      latestUid: async () => 100,
      newUids: async () => refreshes === 1 ? [100] : [100, 101],
      read: async (uid) => { fetched.push(uid); return message(); },
      close: async () => undefined
    };
    let elapsed = 0;
    const code = await waitForVerificationCode(box, 100, now, { now: () => new Date(now.getTime() + elapsed), wait: async (ms) => { elapsed += ms; } });
    expect(code).toBe("123456");
    expect(refreshes).toBe(2);
    expect(fetched).toEqual([101]);
  });

  it("times out without exposing a code or message content", async () => {
    let elapsed = 0;
    const box = fakeMailbox({ newUids: async () => [] });
    await expect(waitForVerificationCode(box, 100, now, { timeoutMs: 10, now: () => new Date(now.getTime() + elapsed), wait: async (ms) => { elapsed += ms; } }))
      .rejects.toThrow("確認コードを取得できませんでした");
  });

  it("rejects conflicting plain-text and HTML codes in one MIME message", async () => {
    const raw = Buffer.from([
      `From: ${sender}`, `Subject: =?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`, `Date: ${now.toUTCString()}`,
      'Content-Type: multipart/alternative; boundary="parts"', "", "--parts",
      "Content-Type: text/plain; charset=utf-8", "", "確認コードを画面に入力してください。123456", "--parts",
      "Content-Type: text/html; charset=utf-8", "", "確認コードを画面に入力してください。<br>654321", "--parts--"
    ].join("\r\n"));
    expect(await extractVerificationCode(raw, now, now)).toBeUndefined();
  });
});

function fakeMailbox(overrides: Partial<VerificationMailbox> = {}): VerificationMailbox {
  return { refresh: async () => undefined, latestUid: async () => 100, newUids: async () => [101], read: async () => message(), close: async () => undefined, ...overrides };
}

describe("OSIRO additional authentication", () => {
  let browser: Browser | undefined;
  afterEach(async () => { await browser?.close(); });
  const origin = "https://nekomachi-club.com";
  const listUrl = `${origin}/admin/events?state=yet_end`;
  const verificationHtml = `<form method="post" action="/admin/reauthentication_code"><button>確認コードを再送する</button></form>
    <form method="post" action="/admin/reauthentication"><input name="code"><button>確認して元の画面に戻る</button></form>`;

  async function openPage(): Promise<Page> {
    browser = await chromium.launch({ headless: true });
    return browser.newPage();
  }

  it.each(["/admin/reauthentication/new", "/admin/reauthentication", "/admin/reauthentication/new/"])("classifies %s as authentication failure", (path) => {
    expect(() => assertAdminSessionIsValid(origin + path)).toThrow("再認証");
  });

  it("completes code resend, mail retrieval and form submission before collecting events", async () => {
    const page = await openPage();
    const operations: string[] = [];
    let authenticated = false;
    await page.route(`${origin}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/admin/reauthentication_code") {
        operations.push("resend");
        await route.fulfill({ contentType: "text/html; charset=utf-8", body: `${verificationHtml}<script>history.replaceState(null,'','/admin/reauthentication/new')</script>` });
      } else if (path === "/admin/reauthentication" && route.request().method() === "POST") {
        expect(route.request().postData()).toBe("code=123456");
        operations.push("submit");
        authenticated = true;
        await route.fulfill({ contentType: "text/html", body: "<script>history.replaceState(null,'','/admin/events?state=yet_end')</script>" });
      } else if (path === "/admin/events" && !authenticated) {
        await route.fulfill({ contentType: "text/html; charset=utf-8", body: `${verificationHtml}<script>history.replaceState(null,'','/admin/reauthentication/new')</script>` });
      } else {
        await route.fulfill({ contentType: "text/html; charset=utf-8", body: path === "/admin/events" ? '<div id="eventIndex"><a href="/admin_events/test/edit">読書会</a></div>' : verificationHtml });
      }
    });
    const handler = createAuthenticationHandler({ host: "imap.test", port: 993, username: "user", password: "test" }, {
      openMailbox: async () => fakeMailbox({ latestUid: async () => { operations.push("snapshot"); return 100; }, close: async () => { operations.push("close"); } }),
      waitForCode: async (_box, uid) => { expect(uid).toBe(100); operations.push("read"); return "123456"; }
    });
    const events = await collectEventListWithPagination(page, listUrl, 20, handler);
    expect(events).toHaveLength(1);
    expect(operations).toEqual(["snapshot", "resend", "read", "close", "submit"]);
    expect(new URL(page.url()).pathname).toBe("/admin/events");
  });

  it("fails explicitly when mailbox settings are absent", async () => {
    const page = await openPage();
    await page.route(`${origin}/**`, (route) => route.fulfill({ contentType: "text/html", body: verificationHtml }));
    await page.goto(`${origin}/admin/reauthentication/new`);
    await expect(createAuthenticationHandler()(page, listUrl)).rejects.toMatchObject({ ruleId: "QUAL-LIST-002" });
  });

  it("invokes authentication for pagination and preserves the requested next page", async () => {
    const page = await openPage();
    const targets: string[] = [];
    await page.route(`${origin}/**`, async (route) => {
      const second = new URL(route.request().url()).searchParams.has("page");
      await route.fulfill({ contentType: "text/html", body: second
        ? "<script>history.replaceState(null,'','/admin/reauthentication/new')</script>"
        : '<div id="eventIndex"><a href="/admin_events/first/edit">first</a><a href="/admin/events?page=2">Next</a></div>' });
    });
    const items = await collectEventListWithPagination(page, listUrl, 20, async (current, target) => {
      targets.push(target);
      if (new URL(current.url()).pathname.includes("reauthentication")) {
        await current.evaluate(() => { history.replaceState(null, "", "/admin/events?page=2"); document.body.innerHTML = '<div id="eventIndex"><a href="/admin_events/second/edit">second</a></div>'; });
      }
    });
    expect(targets).toEqual([listUrl, `${origin}/admin/events?page=2`]);
    expect(items.map((item) => item.name)).toEqual(["first", "second"]);
  });

  it("runs the authentication handler before checking detail DOM", async () => {
    const page = await openPage();
    const detailUrl = `${origin}/admin_events/test/edit`;
    let target = "";
    await page.route(`${origin}/**`, (route) => route.fulfill({ contentType: "text/html", body: "<script>history.replaceState(null,'','/admin/reauthentication/new')</script>" }));
    await expect(fetchEventInfoFromPage(page, { name: "test", detailUrl }, {
      domTimeoutMs: 100,
      authenticate: async (_page, requested) => { target = requested; throw new Error("authentication-handler-reached"); }
    })).rejects.toThrow("authentication-handler-reached");
    expect(target).toBe(detailUrl);
  });

  it("does not connect to mail or submit codes on an unexpected origin", async () => {
    const page = await openPage();
    await page.route("https://unexpected.invalid/**", (route) => route.fulfill({ body: verificationHtml }));
    await page.goto("https://unexpected.invalid/admin/reauthentication/new");
    let opened = false;
    const handler = createAuthenticationHandler({ host: "imap.test", port: 993, username: "user", password: "test" }, {
      openMailbox: async () => { opened = true; return fakeMailbox(); }
    });
    await expect(handler(page, listUrl)).rejects.toThrow("異なるサイト");
    expect(opened).toBe(false);
  });

  it("sanitizes mailbox errors and closes the mailbox", async () => {
    const page = await openPage();
    await page.route(`${origin}/**`, (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: '<form action="/admin/reauthentication_code"><button>確認コードを再送する</button></form>' }));
    await page.goto(`${origin}/admin/reauthentication/new`);
    let closed = false;
    const handler = createAuthenticationHandler({ host: "imap.test", port: 993, username: "user", password: "test" }, {
      openMailbox: async () => fakeMailbox({ close: async () => { closed = true; } }),
      waitForCode: async () => { throw new Error("private-mail-text-123456"); }
    });
    const error = await handler(page, listUrl).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("123456");
    expect(closed).toBe(true);
  });

  it("does not expose fill values when the code input becomes ambiguous", async () => {
    const page = await openPage();
    const body = verificationHtml.replace('<input name="code">', '<input name="code"><input name="code">');
    await page.route(`${origin}/**`, (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: `${body}<script>history.replaceState(null,'','/admin/reauthentication/new')</script>` }));
    await page.goto(`${origin}/admin/reauthentication/new`);
    let closed = false;
    const handler = createAuthenticationHandler({ host: "imap.test", port: 993, username: "user", password: "test" }, {
      openMailbox: async () => fakeMailbox({ close: async () => { closed = true; } }),
      waitForCode: async () => "123456"
    });
    const error = await handler(page, listUrl).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("管理者再認証を完了できません");
    expect(String(error)).not.toContain("123456");
    expect(closed).toBe(true);
  });

  it("recognizes reauthentication during a detail request without misreporting a DOM failure", async () => {
    const page = await openPage();
    await page.route(`${origin}/**`, (route) => route.fulfill({ contentType: "text/html", body: "<script>history.replaceState(null,'','/admin/reauthentication/new')</script>" }));
    await expect(fetchEventInfoFromPage(page, { name: "test", detailUrl: `${origin}/admin_events/test/edit` }, { domTimeoutMs: 100 }))
      .rejects.toMatchObject({ ruleId: "QUAL-DETAIL-002" });
  });
});
