# LiqPulse v0.1.0

iPhone Safari/PWA向けの分析専用リアルタイム先物モニターです。注文機能はありません。

## V0.1 対応
- BTC / ETH / SOL / XRP / ZEC
- Hyperliquid WebSocket: リアルタイム価格・約定
- Hyperliquid Info API: Mark price / Open Interest / Funding
- 直近5分の成行BUY/SELL USD比率（Long/Short「取引フロー」指標）
- BTC / ETH / SOL: HyperPerps公開APIの実ポジション由来清算クラスター（1分ごと更新）
- 暫定 Up Squeeze / Down Cascade score
- PWA / iPhoneホーム画面追加
- APIキー不要 / 注文権限なし

## 重要
「Long / Short フロー」は成行約定の買い/売り比率であり、取引所全体の建玉Long/Short比率ではありません。グローバル建玉比率は別データソースが必要です。

HyperPerpsの清算APIは公開・認証不要ですが、Safari側CORSポリシーやAPI仕様変更により直接アクセスできない場合があります。その場合V0.2でCloudflare Workerプロキシを追加してください。

## iPhoneだけで導入する方法（HTTPS公開が必要）
PWAはHTTPS上で動かす必要があります。ZIPをiPhoneに保存し、Cloudflare Pages / GitHub Pages等へiPhone Safariからアップロード・公開します。公開URLをSafariで開き、共有 →「ホーム画面に追加」でインストールできます。

## セキュリティ
- APIキー・秘密鍵・MEXCログイン情報を保存しません。
- すべて読み取り専用の公開市場データです。
- 実注文・署名処理は一切ありません。
