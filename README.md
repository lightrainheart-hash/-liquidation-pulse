# LiqPulse v2.4.0

## KIOXIA / MEXC Stock Futures

- Adds **KIOXIA** as a first-class LiqPulse tab using MEXC `KIOXIASTOCK_USDT` public Futures market data.
- Source domain: `https://api.mexc.com` via the existing Cloudflare relay.
- Uses MEXC Last / Fair / Index / Funding / 24h data and `holdVol`.
- OI* is an estimated notional: `holdVol × contractSize (0.001 KIOXIA) × Fair Price`.
- Polls public MEXC recent deals and derives Taker Buy / Sell flow.
- Adds KIOXIA Whale Order Map from MEXC Futures L2 with 1H / 3H / 6H history.
- KIOXIA map ranges are now adaptive: near / standard / wide values are calculated from current price and robust 1-hour volatility. The collection range keeps ±80 as a safety floor and can expand when volatility requires it.
- Adds Index-basis monitoring and uses it as a modest contrarian/overheat input to the AI decision engine.
- No MEXC API key is required. No order placement is implemented.
- MEXC does not provide the same public liquidation-cluster / public account L/S data used elsewhere, so LiqPulse labels KIOXIA reaction zones as **MEXC L2 estimates**, never as real liquidation prices.

## Existing markets

- Cold start remains BTC.
- BTC / ETH / SOL / SP500 Order Maps remain available.
- XRP / ZEC / GOLD / SILVER remain supported with their existing public-data fallbacks.

## Deployment

Upload **all files** to the GitHub repository and commit to `main`. Cloudflare Workers Builds should deploy automatically. Verify `/health` reports `2.4.0`.

## v2.4.0 consistency / range fixes

- `AI Quick View` is now always the first analysis card immediately below the price hero for every asset.
- Order Map price-range buttons use stable slots instead of BTC-specific hard-coded values, fixing ETH / SOL / SP500 / KIOXIA controls.
- Order Map ranges are generated per market from current price + robust 1-hour volatility, then snapped to readable price units.
- The selected near / standard / wide slot is stored per asset, so AI can adapt the numeric range without breaking the user's selection.
- Collection range can expand automatically in unusually volatile conditions while keeping each market's existing safety floor.

## v2.4.0 impact-focus pass

- Order Maps still collect the broad L2 range, but the UI now renders only market-impacting wall zones.
- Nearby price levels are consolidated into zones before display, then filtered by absolute floor, percentile, and share of the side's largest wall.
- At most three important zones per side are displayed to prevent red/green overplotting on iPhone.
- Minor walls remain available to internal calculations/history and are not discarded at ingestion.
- Historical wall tracks use the same significance filter plus a minimum persistence rule.
- Actual liquidation-cluster rows are also filtered to major clusters; small clusters stay in the underlying dataset.
- KIOXIA's visible wall floor was recalibrated upward so small MEXC book noise no longer looks like a market-moving event.
