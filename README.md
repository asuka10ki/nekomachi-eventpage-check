# 猫町OSIROイベント設定チェックCLI

OSIRO管理画面のイベント一覧からイベント詳細を開き、チケット名、金額、販売対象者、オンライン参加URL、主催者からのお知らせをチェックしてSlackへ投稿するCLIです。

## セットアップ

Node.js 20以上を使ってください。

```bash
cp .env.example .env
cp config/rules.example.yaml config/rules.yaml
npm install
npx playwright install
npm run auth
npm run check
```

## 環境変数

`.env` に以下を設定します。

```env
SLACK_BOT_TOKEN=xoxb-xxxxxxxxxxxxxxxx
SLACK_CHANNEL_ID=C0BCXMXG745
HEADLESS=true
```

`HEADLESS=false` にすると、チェック実行時もブラウザを表示します。

## Slack Bot

Slack Appを作成し、Bot Token Scopesに少なくとも `chat:write` を追加してください。プライベートチャンネルへ投稿する場合は、Botを対象チャンネルに追加する必要があります。投稿先は `.env` の `SLACK_CHANNEL_ID` で指定します。

## 初回ログイン

```bash
npm run auth
```

Chromiumが表示されるので、OSIRO管理画面へ手動ログインしてください。MFAやSSOがある場合も、画面上で完了できます。ログイン後、ターミナルでEnterを押すと `storageState.json` にログイン状態が保存されます。

`storageState.json` はCookieを含むためGit管理しません。

## チェック実行

```bash
npm run check
```

`https://nekomachi-club.com/admin/events?state=yet_end` を開き、一覧に表示されているイベントを取得します。イベント名に `【予告】` `〖予告〗` `【一覧】` `〖一覧〗` を含むものだけ対象外にします。`満席`、`締切`、`募集中` の表示に関係なくチェックします。

## Windows タスク スケジューラ

スケジューラに登録する前に、手動で一度ログイン状態を保存してください。

```powershell
npm run auth
```

このフォルダに `.env` と `storageState.json` がある状態にしてください。

タスク スケジューラで手動登録する場合は、以下のように設定します。

```txt
プログラム/スクリプト:
powershell.exe

引数の追加:
-NoProfile -ExecutionPolicy Bypass -File "C:\asuka-windows\app\イベントページ自動チェック\scripts\run-check.ps1"

開始:
C:\asuka-windows\app\イベントページ自動チェック
```

PowerShellから毎日実行のタスクを登録する場合は、以下を実行します。

```powershell
cd "C:\asuka-windows\app\イベントページ自動チェック"
.\install-task.ps1
```

デフォルトでは毎日 `00:00` に実行されます。時刻を変える場合は以下のように指定します。

```powershell
.\install-task.ps1 -Time "09:00"
```

手動実行する場合は、プロジェクト直下の `run-check.bat` をダブルクリックするか、以下を実行します。

```powershell
.\run-check.bat
```

実行ログは `logs/` に保存されます。成功時は終了コード `0`、失敗時は終了コード `1` で終了します。

## rules.yaml

`config/rules.yaml` でオンライン、オフラインそれぞれの期待チケットを定義します。原則として1チケットにつき販売対象者は1つです。

```yaml
visibilityTags: ["オン"]
visibilityTags: ["オフ"]
visibilityTags: ["ハイ"]
visibilityTags: ["外"]
```

`visibilityTags: ["オフ", "オン"]` のように複数会員種別を1つの期待チケットにまとめないでください。

## チェック内容

イベント種別はイベント名だけで判定します。`〖〗` は `【】` と同じ意味として扱います。`【東京】` `【大阪】` `【京都】` `【福岡】` `【名古屋】` はオフライン、それ以外はオンラインです。

オンラインイベントでは、チケット名、課題本名、金額、販売対象者に加えて、オンライン開催ONのチケットのURL一致、全チケットの主催者お知らせ一致、お知らせ内の `XX:XXまでに` が開始5分前かを確認します。

オフラインイベントでは、チケット名、課題本名、金額、販売対象者を確認します。

## よくあるエラー

`storageState.json がありません`

先に `npm run auth` を実行してください。

`Slack投稿に失敗しました: not_in_channel`

Botを投稿先チャンネルに追加してください。

`Slack投稿に失敗しました: missing_scope`

Slack AppのBot Token Scopesに `chat:write` を追加し、再インストールしてください。

`詳細取得失敗`

画面構造が想定と違う、またはログイン期限切れの可能性があります。`artifacts/screenshots/` と `artifacts/html/` に保存されたファイルを確認してください。

## テスト

```bash
npm test
```

分類、正規化、金額変換、課題本名抽出、URL正規化、締切時刻チェックのユニットテストを実行します。
