# 猫町OSIROイベント設定チェックCLI

OSIRO管理画面の募集中イベントを読み取り、イベント設定・本文・各チケット・チケット構成・設定間整合性を検査し、ConsoleとSlackへ結果を通知する読み取り専用CLIです。OSIROのイベントやチケットは変更しません。

## 動作環境

- Node.js 20以上（`package.json`の`engines`が正本）
- npm
- Playwright Chromium
- OSIRO管理画面へログインできるアカウント
- Slack通知を使う場合は`chat:write`を持つBot

## セットアップ

```powershell
npm ci
npx playwright install chromium
```

初回またはログイン期限切れ時は、対話可能な端末で次を実行します。

```powershell
npm run auth
```

表示されたブラウザでログインし、完了後にターミナルでEnterを押します。認証状態はプロジェクト直下の`storageState.json`へ保存されます。このファイルにはCookieが含まれるためGit管理・共有・artifact削除の対象にしません。通常のチェック成功時にも、OSIRO側で延長された認証状態を原子的に書き戻します。

## 環境変数

`.env`へ設定します。`.env`自体はGit管理しません。

| 変数 | 必須 | 初期値 | 内容 |
| --- | --- | --- | --- |
| `SLACK_BOT_TOKEN` | 本番通知時 | なし | Slack Bot token。ログやartifactへ出力しない |
| `SLACK_CHANNEL_ID` | 本番通知時 | なし | 通知先チャンネルID |
| `SLACK_DRY_RUN` | いいえ | `false` | `true`なら本文生成だけを行いSlackへ送信しない |
| `HEADLESS` | いいえ | `true` | `false`ならチェック用ブラウザを表示する |
| `ARTIFACT_RETENTION_DAYS` | いいえ | `30` | 障害調査artifactの保存日数。0以上の整数 |
| `ARTIFACT_CLEANUP_ENABLED` | いいえ | `true` | `false`なら起動時の期限切れartifact削除を停止する |

dry-runではSlack設定がなくても実行できます。

```powershell
$env:SLACK_DRY_RUN='true'
$env:HEADLESS='true'
npm run check
```

## コマンド

| コマンド | 用途 |
| --- | --- |
| `npm ci` | lockfileどおりのclean install |
| `npx playwright install chromium` | Chromium導入 |
| `npm run auth` | 手動ログインと認証状態保存 |
| `npm run list` | 募集中イベント一覧の読み取り確認 |
| `npm run check` | 取得・検証・Console表示・Slack通知 |
| `npm test` | 全単体・統合テスト |
| `npm run typecheck` | TypeScript型チェック |
| `npm run lint` | Lint |
| `npm run build` | `dist/`へビルド |
| `npm run clean` | TypeScript build成果物のクリーン |

## 判定結果

| 結果 | 意味 |
| --- | --- |
| `OK` | 適用された業務ルールがすべて正常 |
| `NG` | OSIROの業務設定に修正が必要 |
| `UNKNOWN` | 取得・解析・分類不能で、正常か不備かを断定できない |
| `NG＋UNKNOWN` | 同じイベントに業務不備と判定不能が併存 |
| `対象外` | 予告・一覧・事務局決済など、イベント全体を検査対象外とした |
| execution failure | 認証、一覧・詳細取得、状態保存、cleanupなど実行処理が失敗 |
| notification failure | Slack本文生成後の送信または送信状態保存が失敗 |

NGやUNKNOWNがあっても検査自体が最後まで完了すれば終了コードは`0`です。取得・保存・cleanup・Slack通知などの実行失敗は終了コード`1`です。詳細な実行状態は`RunOutcome`へ集約されます。

## Slack通知と再送

Slack本文はイベント境界で3,840文字以下に分割し、全NG・UNKNOWNを順序どおり1回ずつ含めます。各分割の計画、送信済み、未送信、Slack応答`ts`は`logs/slack-notification-progress.json`へ原子的に保存します。

分割送信の途中で失敗した場合、次回は前回計画の未送信本文だけを先に再送し、送信済み本文を重複投稿しません。送信結果の保存自体に失敗して送達状況を確定できない場合は、自動再送せずnotification failureとして停止します。`SLACK_DRY_RUN=true`では送信状態を変更しません。

## 状態ファイルとartifact

| 分類 | 保存先 | 自動削除 |
| --- | --- | --- |
| Playwright認証状態 | `storageState.json` | しない |
| 前回取得件数 | `logs/last-successful-event-count.json` | しない |
| Slack送信状態 | `logs/slack-notification-progress.json` | しない |
| 実行ログ | `logs/` | artifact削除処理では削除しない |
| screenshot | `artifacts/screenshots/*.png` | 保存期間超過時だけ |
| 障害調査HTML | `artifacts/html/*.html` | 保存期間超過時だけ |
| 障害調査JSON | `artifacts/json/*.json` | 保存期間超過時だけ |

削除対象は上表の既知拡張子だけです。不明なファイル、ディレクトリ、シンボリックリンク、artifactディレクトリ外は削除しません。境界日時と保存期間内のファイルは残します。削除・権限設定の失敗は握りつぶさずexecution failureにします。

artifactディレクトリはPOSIX mode `0700`、ファイルは`0600`を設定します。Unix系では所有者以外から読めないことを確認してください。WindowsではPOSIX modeだけでNTFS ACLを完全には表現できないため、運用アカウント専用ディレクトリに配置し、必要に応じてフォルダのプロパティまたは`icacls`で閲覧者を制限してください。

障害調査HTMLではhidden/password値、CSRF token、Slack token、Webhook URLを保存前に除去します。artifactやログをGitへ追加しないでください。

## 料金・販売対象の変更

料金・必須販売対象・rateKeyの唯一の正本は`src/domain/catalog.ts`です。YAMLへ料金を重複定義しません。

変更手順：

1. 業務担当者の確定回答を`docs/外部設計書.md`の業務仕様・回答済み業務確認へ反映する。
2. `src/domain/catalog.ts`の該当rateKey、金額、販売対象を変更する。
3. catalogの全金額を固定する料金回帰テストを同じ変更で更新する。
4. `docs/外部設計書.md`、必要なら`docs/内部設計書.md`を更新する。
5. `npm run lint`、`npm run typecheck`、`npm test`、`npm run build`、Slack dry-runを実行する。

catalogだけを意図せず変更すると料金回帰テストが失敗します。

## 障害時の確認順

1. Consoleの実行失敗理由と終了コードを確認する。
2. `storageState.json`が存在するか確認し、ログイン切れなら`npm run auth`を実行する。
3. 一覧取得件数、HTTPエラー、管理画面DOM識別エラーを確認する。
4. `artifacts/screenshots/`と秘密情報除去済み`artifacts/html/`を確認する。
5. `logs/last-successful-event-count.json`と`logs/slack-notification-progress.json`の破損・権限を確認する。
6. Slackの`not_in_channel`、`missing_scope`、429、5xx、恒久エラーを確認する。
7. 修正後はdry-runで本文と集計を確認してから本番通知する。

## Windowsタスクスケジューラ

事前に`npm ci`、Chromium導入、`npm run auth`を完了し、プロジェクト直下に`.env`と`storageState.json`を用意します。

```powershell
.\install-task.ps1 -Time "09:00"
```

手動実行は`.\run-check.bat`、登録スクリプトは`scripts/run-check.ps1`を使用します。

## 業務仕様・設計の正本

- `docs/外部設計書.md`：利用者向け仕様、全チェックルール、適用表、回答済み業務判断
- `docs/内部設計書.md`：実装構成、処理方式、実装判断、レビュー・完了履歴

設計資料の正本はこの2冊だけです。業務仕様変更時は外部設計書、内部設計書、catalog、テストを同じ変更で同期します。
