# LiqPulse v2.0.0

Major quality and UX overhaul focused on mobile readability, data integrity, and consistent behavior across every currently supported crypto market.

## Supported markets

- Crypto: BTC / ETH / SOL / XRP / ZEC
- Other markets kept available: SP500 / GOLD / SILVER

## v2.0.0 highlights

### Unified crypto Quick View
Every crypto now uses the same top-level decision layout:

- LONG / SHORT dominance score
- Candidate / wait decision with confidence
- Data quality score
- Taker Buy / Sell
- Public Long / Short crowding ratio
- Funding state
- 15-minute OI / price momentum
- Nearest actual liquidation levels when available
- Automatic L2 estimated reaction zones when actual liquidation data is unavailable

Actual liquidation data and L2 estimates are explicitly labeled and never mixed silently.

### Cleaner mobile layout

- Essential information remains at the top.
- Detailed liquidation / positioning / flow panels are collapsed by default behind `詳細分析`.
- Relay and diagnostics are collapsed separately.
- Missing Top Trader rows are hidden instead of filling the screen with repeated `取得不可` rows.
- Last selected market is remembered.

### Reliability improvements

- Asset-switch requests are generation-scoped so stale async responses cannot overwrite the newly selected market.
- Asset switching no longer blocks while slow upstream requests are still pending.
- Data freshness is tracked independently for WebSocket, market metadata, liquidation data, positioning, L2 order book, and SP500 breadth.
- Decision confidence is now reduced when data quality/freshness is poor.
- No unavailable metric is fabricated to fill a gap.

### BTC Whale Order Map

- Fixed current BTC price line so it is always rendered on top of liquidity bands.
- Current price is shown both as a yellow dashed line and a right-axis price badge.
- ±$1k / ±$3k / ±$5k display ranges remain available.
- BTC L2 collection remains ±$10,000 regardless of display range.
- 1H / 3H / 6H wall history and chart-height zoom remain available.
- Historical wall labels are de-conflicted with the current-price line.

### L2 depth upgrade for all supported markets

The Cloudflare Worker now requests multi-resolution Hyperliquid L2 books for every supported market, not BTC only. Distance bands use separate aggregation levels so overlapping books are not double-counted.

## Signal semantics

`LONG候補` / `SHORT候補` are analytical candidates, not guaranteed trade instructions. The score combines currently available public market data. When confidence or data quality is insufficient, LiqPulse intentionally returns `見送り`.

Public Long / Short statistics are treated primarily as crowding/squeeze-risk inputs rather than direct bullish/bearish proof.

## Deployment

1. Upload **all files** from this folder to the GitHub repository root.
2. Commit to `main`.
3. Cloudflare Workers Builds should redeploy `index.js` / `wrangler.jsonc` automatically.
4. Confirm `/health` returns version `2.0.0`.
5. Fully close and reopen the iPhone PWA if an old Service Worker view is still visible.

## Validation performed

- JavaScript syntax checks: app / Worker / Service Worker
- Worker source parity: `index.js` and `relay-worker.js`
- HTML duplicate-ID check
- HTML ↔ JavaScript static ID reference check
- CSS parser validation
- Headless mobile UI test with mocked BTC / ETH / SOL / XRP / ZEC / SP500 data
- BTC Whale chart render test, including persistent current-price line
