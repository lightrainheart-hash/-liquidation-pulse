# LiqPulse v0.4.0

iPhone Safari/PWA向けの分析専用リアルタイム先物モニターです。注文機能はありません。

## v0.3
- Hyperliquid WebSocket: 価格 / Tradesをリアルタイム表示
- Hyperliquid Info API: Mark / OI / Funding
- BTC / ETH / SOL: HyperPerpsの実ポジション由来清算クラスター対応
- iOS SafariのCORS制約対策としてCloudflare Worker Relayを正式対応
- Relay URLはアプリ内で保存・接続テスト可能（localStorage）
- Service Workerキャッシュ v0.3.0

## Relay
`relay-worker.js` をCloudflare Workersにデプロイし、発行された `https://xxxxx.workers.dev` をアプリの「清算データ Relay」に貼り付けます。

RelayはBTC/ETH/SOLの公開清算APIのみを中継し、APIキー・Cookie・ユーザーデータは扱いません。


## v0.4.0 GitHub → Cloudflare Workers 自動デプロイ

`worker/` をCloudflare Worker専用ルートとして追加しました。

- Worker root directory: `worker`
- Wrangler config: `worker/wrangler.jsonc`
- Worker name: `liqpulse-relay`
- Deploy command: `npx wrangler deploy`（Cloudflare既定）
- GitHub `main` 更新時に自動デプロイ可能
- LiqPulse本体には標準Relay URLをプリセット

Cloudflareで既存Worker `liqpulse-relay` → Settings → Builds → Connect からGitHubリポジトリを接続し、Root directoryを `worker` に設定してください。


## v0.4.0
- Liquidation Radar（最寄り上下トリガー、±5%清算総額）
- 15分の清算クラスター増減をiPhone内ローカル履歴から計算
- 現在価格を中心に、上側ショート清算→現在値→下側ロング清算で表示
- 一次トリガー / 上値の壁 / 主要クラスターの自動ラベル
- 表示段数 5 / 8 / 12 切替
