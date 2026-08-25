# LiqPulse v2.5.0

## Precision validation release

v2.5.0 focuses on **signal quality and self-validation**, not on producing more LONG/SHORT calls.

### 1. Market-specific decision profiles

BTC, ETH, SOL, XRP, ZEC, SP500, KIOXIA, GOLD and SILVER now use separate decision profiles.
The profiles change:

- minimum data-quality required before an entry candidate is allowed
- candidate / priority confidence thresholds
- relative signal weights for liquidation, Taker flow, OI/price, L2, Funding, market breadth, Index basis and Order Map walls
- 15 / 30 / 60 minute validation thresholds appropriate to each market's volatility

No profile can bypass the global `見送り` behavior when required data quality is insufficient.

### 2. Signal Validation

Displayed LONG/SHORT candidates are stored locally and checked against later observed prices at:

- 15 minutes
- 30 minutes
- 60 minutes

Moves smaller than the market-specific validation threshold are classified as **flat** rather than forced into a win/loss result.
If LiqPulse was closed and no price history exists around the target time, that evaluation is marked unavailable and is **not** counted as a loss.

After at least 12 completed evaluations, the displayed confidence is modestly calibrated using the device's own observed history. Historical performance can affect at most 25% of the final confidence so a small sample cannot dominate the live model.

The Quick View header shows `検証中` until enough observations exist. Per-horizon results are available under `詳細分析 > Signal Validation`.

> Validation data is stored only in browser localStorage on that device. It is not a backtest of periods when the app was not collecting data and it does not guarantee future performance.

### 3. Whale wall reliability

Order Map walls now receive a confidence score using more than size alone:

- persistence time
- number of observations
- replenishment after partial depletion
- repeated defense after price approaches the wall
- relative wall size
- penalty when a wall disappears close to price (spoof / pull risk)
- optional opposing Taker-flow absorption evidence while the wall remains active

Nearest-wall metadata and the important-wall list show the reliability score. The AI engine discounts low-reliability walls instead of treating every large snapshot equally.

### 4. Wall + real-liquidation confluence

For markets with public real liquidation-cluster data, LiqPulse checks whether a reliable large Order Map wall and a matching liquidation cluster overlap within a tight price band.
That overlap is treated as an **important branch point** rather than an automatic direction prediction.
Directional weight is only added when Taker flow confirms a likely break or defense; otherwise Quick View warns `重要分岐接近` and remains conservative.

### 5. Existing market coverage

- BTC / ETH / SOL: Hyperliquid + real liquidation data where available + Order Map
- XRP / ZEC: Hyperliquid with public-data fallbacks / estimated reaction zones
- SP500: Hyperliquid HIP-3 + S&P 500 internal breadth / Market Map + Order Map
- KIOXIA: MEXC `KIOXIASTOCK_USDT` public Futures data + MEXC L2 Order Map + Index basis
- GOLD / SILVER: HIP-3 market data and existing fallbacks

KIOXIA L2 walls are **not** labeled as real liquidation prices. OI* remains an estimated notional based on MEXC `holdVol × 0.001 KIOXIA × Fair Price`.

## Deployment

Upload **all files** to the GitHub repository and commit to `main`. Cloudflare Workers Builds should deploy automatically.
Verify that:

- `/health` reports `2.5.0`
- the app header displays `v2.5.0`
- Quick View shows the new validation pill
- `詳細分析` contains `Signal Validation`

## Safety / interpretation

LiqPulse is an analysis assistant, not an execution system. Signal confidence is a model score calibrated with limited locally observed outcomes; it is not a probability guarantee. The precision release is deliberately biased toward **fewer, better-qualified signals** and more `見送り` states when evidence is weak or conflicting.
