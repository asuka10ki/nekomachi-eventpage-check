import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

export type MailboxConfig = { host: string; port: number; username: string; password: string };
export interface VerificationMailbox {
  refresh(): Promise<void>;
  latestUid(): Promise<number>;
  newUids(afterUid: number): Promise<number[]>;
  read(uid: number): Promise<Buffer | undefined>;
  close(): Promise<void>;
}

export class VerificationMailboxError extends Error {}
const CODE_SENDER = "info@nekomachi-club.com";
const CODE_SUBJECT = "【猫町.】管理ツールの確認コード";

// 名簿自動生成（オシロ→Slack）の差出人・件名・時刻・UID条件を移植。
export async function extractVerificationCode(raw: Buffer, requestedAt: Date, now = new Date()): Promise<string | undefined> {
  const mail = await simpleParser(raw, { skipTextToHtml: true, skipImageLinks: true });
  if (mail.from?.value.length !== 1 || mail.from.value[0].address?.toLowerCase() !== CODE_SENDER || mail.subject !== CODE_SUBJECT) return undefined;
  const sent = mail.date?.getTime();
  if (sent === undefined || !Number.isFinite(sent) || sent < requestedAt.getTime() - 60000
    || now.getTime() - sent < -60000 || now.getTime() - sent >= 600000) return undefined;
  const texts = [mail.text ?? ""];
  if (mail.html) {
    const htmlMail = await simpleParser(Buffer.from(`Content-Type: text/html; charset=utf-8\r\n\r\n${mail.html}`), { skipTextToHtml: true, skipImageLinks: true });
    texts.push(htmlMail.text ?? "");
  }
  const codes = new Set(texts.flatMap((text) => [...text.matchAll(/確認コードを画面に入力してください[。．.]?\s*([0-9]{6})(?![0-9])/g)].map((match) => match[1])));
  return codes.size === 1 ? [...codes][0] : undefined;
}

export async function openVerificationMailbox(config: MailboxConfig): Promise<VerificationMailbox> {
  const client = new ImapFlow({
    host: config.host, port: config.port, secure: true,
    auth: { user: config.username, pass: config.password },
    logger: false, logRaw: false, emitLogs: false, disableAutoIdle: true,
    connectionTimeout: 30000, greetingTimeout: 30000, socketTimeout: 30000
  });
  // 接続の非同期errorを保持する。IMAPの生応答・資格情報は外へ出さない。
  let connectionFailed = false;
  client.on("error", () => { connectionFailed = true; });
  try {
    await client.connect();
    await client.mailboxOpen("INBOX", { readOnly: true });
  } catch {
    client.close();
    throw new VerificationMailboxError("OSIRO確認コード用メールボックスに接続できませんでした。IMAP設定・認証情報を確認してください。");
  }
  async function search(afterUid?: number): Promise<number[]> {
    if (connectionFailed) throw new VerificationMailboxError("OSIRO確認コード用メールボックスとの接続が切れました。");
    const uids = await client.search({ from: CODE_SENDER, ...(afterUid === undefined ? {} : { uid: `${afterUid + 1}:*` }) }, { uid: true });
    if (!uids) throw new VerificationMailboxError("OSIRO確認コードのメール検索に失敗しました。");
    return uids.filter((uid) => afterUid === undefined || uid > afterUid);
  }
  return {
    refresh: async () => { await client.mailboxOpen("INBOX", { readOnly: true }); },
    latestUid: async () => (await search()).reduce((max, uid) => Math.max(max, uid), 0),
    newUids: (afterUid) => search(afterUid),
    read: async (uid) => {
      // source:trueはBODY.PEEK[]。既読フラグを変更しない。
      const mail = await client.fetchOne(String(uid), { source: true }, { uid: true });
      return mail ? mail.source : undefined;
    },
    close: async () => {
      try { await client.logout(); }
      catch { client.close(); throw new VerificationMailboxError("OSIRO確認コード用メールボックスの終了に失敗しました。"); }
    }
  };
}

export async function waitForVerificationCode(
  mailbox: VerificationMailbox,
  afterUid: number,
  requestedAt: Date,
  options: { timeoutMs?: number; now?: () => Date; wait?: (ms: number) => Promise<void> } = {}
): Promise<string> {
  const now = options.now ?? (() => new Date());
  const wait = options.wait ?? ((ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const deadline = now().getTime() + (options.timeoutMs ?? 120000);
  try {
    while (now().getTime() < deadline) {
      await mailbox.refresh();
      const uids = (await mailbox.newUids(afterUid)).filter((uid) => uid > afterUid).sort((a, b) => b - a).slice(0, 20);
      for (const uid of uids) {
        const raw = await mailbox.read(uid);
        if (!raw) continue;
        const code = await extractVerificationCode(raw, requestedAt, now());
        if (code) return code;
      }
      await wait(Math.min(5000, Math.max(0, deadline - now().getTime())));
    }
  } catch {
    throw new VerificationMailboxError("OSIRO確認コードのメール取得に失敗しました。IMAP接続を確認してください。");
  }
  throw new VerificationMailboxError("OSIROの新しい確認コードを取得できませんでした（待機期限切れ）。メールの受信状況を確認してください。");
}
