# LiqPulse v2.2.0

## KIOXIA / MEXC Stock Futures

- Adds **KIOXIA** as a first-class LiqPulse tab using MEXC `KIOXIASTOCK_USDT` public Futures market data.
- Source domain: `https://api.mexc.com` via the existing Cloudflare relay.
- Uses MEXC Last / Fair / Index / Funding / 24h data and `holdVol`.
- OI* is an estimated notional: `holdVol × contractSize (0.001 KIOXIA) × Fair Price`.
- Polls public MEXC recent deals and derives Taker Buy / Sell flow.
- Adds KIOXIA Whale Order Map from MEXC Futures L2 with 1H / 3H / 6H history.
- KIOXIA map display ranges: ±5 / ±15 / ±30; collection range: ±80.
- Adds Index-basis monitoring and uses it as a modest contrarian/overheat input to the AI decision engine.
- No MEXC API key is required. No order placement is implemented.
- MEXC does not provide the same public liquidation-cluster / public account L/S data used elsewhere, so LiqPulse labels KIOXIA reaction zones as **MEXC L2 estimates**, never as real liquidation prices.

## Existing markets

- Cold start remains BTC.
- BTC / ETH / SOL / SP500 Order Maps remain available.
- XRP / ZEC / GOLD / SILVER remain supported with their existing public-data fallbacks.

## Deployment

Upload **all files** to the GitHub repository and commit to `main`. Cloudflare Workers Builds should deploy automatically. Verify `/health` reports `2.2.0`.
