# YT Proxy (YouTube / Niconico Proxy)

YouTubeおよびニコニコ動画の動画情報を取得・中継し、Google Apps Script (GAS) などの外部システムと連携して再生するためのプロキシサーバーです。

## 必要条件

1. **Node.js** (v18以降推奨)
2. **yt-dlp** (システム環境変数 PATH に登録し、コマンドラインから呼び出せる状態にしてください)
3. **cloudflared.exe** (Cloudflare Tunnel のバイナリを本リポジトリのルート直下に配置してください)

## 設定と準備

### 1. GAS連携設定
`start.bat` をテキストエディタで開き、以下の変数を環境に合わせて書き換えてください。
* `GAS_URL`: 連携先 Google Apps Script のデプロイURL
* `KEY`: 認証キー (GAS側と一致させてください)

### 2. 制限動画の視聴（ニコニコ動画）
センシティブ（ログイン制限）動画を視聴するには、ニコニコ動画にログインした状態の Netscape 形式クッキーファイルをエクスポートし、ルート直下に **`cookies.txt`** という名前で配置してください。

## 使い方

* **起動**: `start.bat` を実行します。
  * サーバー（ポート3000）および `cloudflared` トンネルが起動し、自動的にトンネルURLがGASへ通知されます。
* **停止**: `stop.bat` を実行します。
* **再起動**: `restart.bat` を実行します。
