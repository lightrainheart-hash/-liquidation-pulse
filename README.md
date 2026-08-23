# LiqPulse v0.9.2

BTC / ETH / SOL / XRP / ZEC に加え、trade.xyz の HIP-3 市場 `SP500` / `GOLD` / `SILVER` を追加。

## v0.9.2
- ZECを含む全銘柄でHyperliquid L2板を取得
- 実清算データがない場合はL2板から「推定上側/下側反応帯」を表示（実清算ラインとは別物として明記）
- S&P 500 (`xyz:SP500`)、金 (`xyz:GOLD`)、銀 (`xyz:SILVER`) の価格 / OI / Funding / Takerフロー / AI Quick View / Market Biasを追加
- HIP-3はHyperliquid `metaAndAssetCtxs` の `dex: xyz` と prefixed coin を使用
- Workerに `/book/:symbol` を追加
- AIスコアにL2板の買い/売り厚みを補助入力として追加

分析専用。推定反応帯は清算価格・利確価格・損切り価格を直接観測したものではありません。

## v0.9.2
- Finviz iframe を廃止（Finviz側の埋め込み制限による白画面対策）。
- S&P 500構成銘柄を公開市場データから取得し、LiqPulse内で独自Market Mapを描画。
- セクター別、当日騰落率色分け、時価総額順位によるタイルサイズ近似。
- 市場ムード、上昇/下落銘柄数、時価総額加重騰落率を表示。
- 表示数を上位80 / 上位200 / 全構成で切替可能。
- Finviz公式への外部リンクは参考用として維持。
