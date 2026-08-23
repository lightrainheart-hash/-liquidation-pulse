# LiqPulse v0.7.0

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


## v0.5.0
- Binance USDⓈ-M公開統計をCloudflare Relay経由で取得
- 全口座 Account Long/Short Ratio
- Top Trader Account Long/Short Ratio
- Top Trader Position Long/Short Ratio
- BTC / ETH / SOL / XRP / ZECで取得を試行し、未上場・API制限時は安全に「取得失敗」表示
- PressureにはPosition Ratioを小さな補助要素として追加（方向予測ではない）
- ETH / SOLはBTCと同じLiquidation Radar / 清算クラスター表示を継続

Long/Short統計はBinance USDⓈ-Mの公開市場統計であり、Hyperliquid全体の建玉比率ではありません。


## v0.7.0

- Long/Short Positioning: BinanceをPrimary、Bybit Linearを全口座比率のFallbackとして追加。
- BinanceがCloudflare経由で拒否された場合でもBybit `GET /v5/market/account-ratio` の5分統計を利用。
- データソースを画面下に明示し、Top Traderが取得できない場合は欠損を明示。

## v0.7.0 deployment hardening

- `relay-worker.js` is the canonical Cloudflare Worker entry point.
- `index.js` contains the same Worker source as a non-empty backup.
- `wrangler.jsonc` points directly to `relay-worker.js`.
- The duplicate `worker/` folder was removed to avoid iPhone/GitHub upload name collisions.


## v0.7.0
- Market Bias Engine: liquidation / taker / public L-S / funding / OI momentum composite
- 15-minute OI and price momentum stored locally on the iPhone
- Data-confidence indicator and concise reason list
- Clearer handling when Binance Top Trader data is unavailable
- No order execution; analysis-only


## v0.7.0
- 画面上部に AI Quick View を追加
- LONG/SHORTどちらが優勢かを一目で表示
- AI判断は LONG候補 / SHORT候補 / 見送り の3段階（低信頼度は見送り）
- 最寄りショート清算ライン / ロング清算ラインを上部に表示
- 詳細 Market Bias Engine は下段へ移動
- 極端なTakerフローや15分急変を簡易警戒表示
