# LiqPulse v0.3.0

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
