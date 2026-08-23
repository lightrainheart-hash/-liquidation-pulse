// LiqPulse v0.5.0 — Cloudflare Worker relay
// Public market data only. No API keys, cookies, or user data are forwarded.

const ALLOWED_HEATMAP_SYMBOLS = new Set(['BTC', 'ETH', 'SOL']);
const ALLOWED_POSITIONING_SYMBOLS = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'ZEC']);
const HEATMAP_UPSTREAM = 'https://trade.hyperperps.app/api/public/heatmap/';
const BINANCE_FUTURES_DATA = 'https://fapi.binance.com/futures/data/';
const ALLOWED_ORIGINS = new Set([
  'https://lightrainheart-hash.github.io',
]);

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : 'https://lightrainheart-hash.github.io';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

async function fetchJson(url, cf = {}) {
  const response = await fetch(url, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
    cf,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 160)}`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Upstream returned non-JSON'); }
  return data;
}

function latestPoint(data) {
  if (Array.isArray(data)) return data.length ? data[data.length - 1] : null;
  return data && typeof data === 'object' ? data : null;
}

async function handlePositioning(symbol, headers) {
  if (!ALLOWED_POSITIONING_SYMBOLS.has(symbol)) {
    return Response.json({ error: 'unsupported_symbol' }, { status: 400, headers });
  }
  const pair = `${symbol}USDT`;
  const endpoints = {
    global: 'globalLongShortAccountRatio',
    topAccounts: 'topLongShortAccountRatio',
    topPositions: 'topLongShortPositionRatio',
  };
  const results = {};
  const errors = [];
  await Promise.all(Object.entries(endpoints).map(async ([key, endpoint]) => {
    const params = new URLSearchParams({ symbol: pair, period: '5m', limit: '1' });
    try {
      const data = await fetchJson(`${BINANCE_FUTURES_DATA}${endpoint}?${params}`, { cacheTtl: 20, cacheEverything: true });
      results[key] = latestPoint(data);
      if (!results[key]) errors.push(`${key}:empty`);
    } catch (error) {
      errors.push(`${key}:${String(error?.message || error)}`);
      results[key] = null;
    }
  }));
  if (!results.global && !results.topAccounts && !results.topPositions) {
    return Response.json({ error: 'positioning_upstream_failed', symbol, source: 'Binance USDⓈ-M', errors }, { status: 502, headers });
  }
  const timestamps = [results.global, results.topAccounts, results.topPositions]
    .map(x => Number(x?.timestamp)).filter(Number.isFinite);
  return Response.json({
    symbol,
    pair,
    source: 'Binance USDⓈ-M',
    period: '5m',
    timestamp: timestamps.length ? Math.max(...timestamps) : Date.now(),
    global: results.global,
    topAccounts: results.topAccounts,
    topPositions: results.topPositions,
    errors,
  }, { headers: { ...headers, 'Cache-Control': 'public, max-age=20' } });
}

export default {
  async fetch(request) {
    const headers = corsHeaders(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405, headers });

    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({ ok: true, service: 'liqpulse-relay', version: '0.5.0' }, { headers });
    }

    const heatmapMatch = url.pathname.match(/^\/heatmap\/([A-Za-z0-9_-]+)$/);
    if (heatmapMatch) {
      const symbol = heatmapMatch[1].toUpperCase();
      if (!ALLOWED_HEATMAP_SYMBOLS.has(symbol)) return new Response('Unsupported symbol', { status: 400, headers });
      try {
        const upstream = await fetch(HEATMAP_UPSTREAM + encodeURIComponent(symbol), {
          method: 'GET',
          headers: { 'Accept': 'application/json' },
          cf: { cacheTtl: 45, cacheEverything: true },
        });
        const body = await upstream.arrayBuffer();
        const outHeaders = new Headers(headers);
        outHeaders.set('Content-Type', upstream.headers.get('Content-Type') || 'application/json; charset=utf-8');
        outHeaders.set('Cache-Control', 'public, max-age=30');
        outHeaders.set('X-LiqPulse-Upstream-Status', String(upstream.status));
        return new Response(body, { status: upstream.status, headers: outHeaders });
      } catch (error) {
        return Response.json({ error: 'upstream_fetch_failed', message: String(error?.message || error) }, { status: 502, headers });
      }
    }

    const positioningMatch = url.pathname.match(/^\/positioning\/([A-Za-z0-9_-]+)$/);
    if (positioningMatch) return handlePositioning(positioningMatch[1].toUpperCase(), headers);

    return new Response('Not Found', { status: 404, headers });
  },
};
