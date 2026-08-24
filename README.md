# LiqPulse v2.1.0

## BTC Whale Order History Map

- BTC Whale Order Map display range is current price ±$3,000, while L2 measurement/history capture extends to ±$10,000.
- Worker combines Hyperliquid L2 books at multiple aggregation granularities (5/3/2 significant figures) so real resting liquidity farther from spot can be visualized without inventing levels.
- Whale walls are tracked over time in localStorage for up to 6 hours.
- Chart supports 1H / 3H / 6H history.
- Horizontal line length = observed wall lifetime; thickness = maximum observed notional.
- 5-minute BTC candles are drawn behind whale walls.
- Disappeared walls are shown as dashed/transparent historical segments. Disappearance does not prove cancellation or execution.
- Current wall list includes estimated observed duration.

## Data caveat

This is a Hyperliquid-derived order-map, not CoinGlass exchange-wide proprietary whale-order data. Aggregated L2 levels are real order-book aggregates returned by Hyperliquid; LiqPulse does not fabricate distant orders.

## Deployment

Upload all files to the GitHub repository and commit to `main`. Cloudflare Workers Builds should deploy automatically.

- v1.3.1: mobile chart display tightened to ±$3,000 while BTC whale-wall collection/storage remains wide at ±$10,000.

- v2.1.0: BTC Whale Map adds ±$1k / ±$3k / ±$5k display-range switches while retaining ±$10k collection. Adds Standard / Large / Max chart-height zoom and automatic label de-cluttering for mobile readability.


## v2.1.0
- Cold start is always BTC.
- Order Map is available for BTC, ETH, SOL, and SP500.
- Order Map history, range, and zoom are stored per asset.
- SP500 Order Map represents Hyperliquid xyz:SP500 perpetual L2 liquidity, not the full cash-index constituent order book.
- Removed sticky asset-tab overlay that could cover card headings on iPhone.
