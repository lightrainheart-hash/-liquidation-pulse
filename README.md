# LiqPulse v0.2.0

iPhone Safari / PWA向けの分析専用リアルタイム先物モニターです。注文機能はありません。

## v0.2
- BTC / ETH / SOL: HyperPerps公開データ由来の清算クラスター（Direct + 公開フォールバック2系統）
- XRP / ZEC: 価格 / OI / Funding / Takerフロー
- Hyperliquid WebSocketリアルタイム価格・Trades
- Hyperliquid OI / Funding
- Taker Buy / Sellを5分・15分・1時間で切替
- 清算価格までの距離%表示
- 上下最大クラスター表示
- ±10%以内の距離加重Liquidation Bias
- Pressureスコア
- iPhoneホーム画面PWA
- Service Workerキャッシュ v0.2

## 重要
- Taker Buy/SellはLong/Short建玉比率ではありません。
- Liquidation BiasもAccount Long/Short比率ではなく、清算想定額の上下偏りです。
- Account L/Sは別データソースを検証後に追加予定です。
- 公開CORSプロキシは公開市場データの取得フォールバックにのみ使用し、APIキー・個人情報・注文情報は一切送信しません。
