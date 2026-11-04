import type { Page } from "playwright";
import { AcquisitionError, assertAdminSessionIsValid, assertSuccessfulHttpResponse, isReauthenticationUrl } from "../acquisition/quality.js";
import { openVerificationMailbox, VerificationMailboxError, waitForVerificationCode, type MailboxConfig, type VerificationMailbox } from "./mailbox.js";

export type AuthenticationHandler = (page: Page, targetUrl: string) => Promise<void>;
type AuthenticationDependencies = {
  openMailbox(config: MailboxConfig): Promise<VerificationMailbox>;
  waitForCode(mailbox: VerificationMailbox, afterUid: number, requestedAt: Date): Promise<string>;
};
const OSIRO_ORIGIN = "https://nekomachi-club.com";

export function createAuthenticationHandler(
  config?: MailboxConfig,
  overrides: Partial<AuthenticationDependencies> = {}
): AuthenticationHandler {
  const dependencies: AuthenticationDependencies = { openMailbox: openVerificationMailbox, waitForCode: waitForVerificationCode, ...overrides };
  return async (page, targetUrl) => {
    const scope = new URL(targetUrl).pathname.startsWith("/admin_events/") ? "event" : "run";
    if (!isReauthenticationUrl(page.url())) {
      assertAdminSessionIsValid(page.url(), scope);
      return;
    }
    const fail = (message: string) => new AcquisitionError(scope === "run" ? "QUAL-LIST-002" : "QUAL-DETAIL-002", message, scope);
    const assertOrigin = () => {
      if (new URL(page.url()).origin !== OSIRO_ORIGIN || new URL(targetUrl).origin !== OSIRO_ORIGIN) {
        throw fail("OSIROの再認証が異なるサイトへ転送されたため停止しました。");
      }
    };
    assertOrigin();
    if (!config?.username || !config.password) throw fail("OSIROの管理者再認証が必要ですが、確認コード取得用のMAIL_USERNAME・MAIL_PASSWORD_OR_APP_PASSWORDが未設定です。npm run authで確認コードを入力してください。");
    try {
      const resend = page.locator('form[action="/admin/reauthentication_code"]');
      if (await resend.count() !== 1) throw fail("OSIROの確認コード再送フォームを確認できませんでした。");
      const mailbox = await dependencies.openMailbox(config);
      let code: string;
      try {
        const afterUid = await mailbox.latestUid();
        const requestedAt = new Date();
        await resend.getByRole("button", { name: "確認コードを再送する", exact: true }).click({ timeout: 15000 });
        await page.waitForLoadState("domcontentloaded", { timeout: 15000 });
        assertOrigin();
        code = await dependencies.waitForCode(mailbox, afterUid, requestedAt);
      } finally {
        await mailbox.close();
      }
      assertOrigin();
      if (!isReauthenticationUrl(page.url()) || !/^[0-9]{6}$/.test(code)) throw fail("OSIROの再認証画面または確認コードの形式を確認できませんでした。");
      const form = page.locator('form[action="/admin/reauthentication"]');
      if (await form.count() !== 1) throw fail("OSIROの確認コード入力フォームを確認できませんでした。");
      await form.locator('input[name="code"]').fill(code, { timeout: 10000 });
      await form.getByRole("button", { name: "確認して元の画面に戻る", exact: true }).click({ timeout: 20000 });
      await page.waitForURL((url) => url.origin === OSIRO_ORIGIN && !isReauthenticationUrl(url.href), { waitUntil: "domcontentloaded", timeout: 15000 });
      assertOrigin();
      assertAdminSessionIsValid(page.url(), scope);
      const response = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      assertOrigin();
      assertSuccessfulHttpResponse(page.url(), response?.status() ?? null, response?.ok() ?? false, scope);
      assertAdminSessionIsValid(page.url(), scope);
    } catch (error) {
      if (error instanceof AcquisitionError) throw error;
      if (error instanceof VerificationMailboxError) throw fail(error.message);
      // Playwrightのfill例外やIMAP応答には秘密が含まれ得る。生の例外は出力しない。
      throw fail("OSIROの管理者再認証を完了できませんでした。確認コードの取得・入力、または画面構造を確認してください。");
    }
  };
}
