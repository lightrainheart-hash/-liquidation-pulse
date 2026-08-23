// LiqPulse v0.9.0 — Cloudflare Worker relay
// Public market data only. No API keys, cookies, or user data are forwarded.

const ALLOWED_HEATMAP_SYMBOLS = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'ZEC']);
const ALLOWED_POSITIONING_SYMBOLS = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'ZEC']);
const BOOK_COINS = { BTC:'BTC', ETH:'ETH', SOL:'SOL', XRP:'XRP', ZEC:'ZEC', SP500:'xyz:SP500', GOLD:'xyz:GOLD', SILVER:'xyz:SILVER' };
const HYPERLIQUID_INFO='https://api.hyperliquid.xyz/info';
const HEATMAP_UPSTREAM = 'https://trade.hyperperps.app/api/public/heatmap/';
const BINANCE_FUTURES_DATA = 'https://fapi.binance.com/futures/data/';
const BYBIT_V5 = 'https://api.bybit.com/v5/market/account-ratio';
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

async function fetchBinancePositioning(pair) {
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
  return { results, errors };
}

async function fetchBybitGlobal(pair) {
  const params = new URLSearchParams({ category: 'linear', symbol: pair, period: '5min', limit: '1' });
  const data = await fetchJson(`${BYBIT_V5}?${params}`, { cacheTtl: 20, cacheEverything: true });
  if (Number(data?.retCode) !== 0) throw new Error(`Bybit retCode ${data?.retCode}: ${data?.retMsg || 'unknown error'}`);
  const item = Array.isArray(data?.result?.list) ? data.result.list[0] : null;
  if (!item) throw new Error('Bybit returned no ratio rows');
  const long = Number(item.buyRatio);
  const short = Number(item.sellRatio);
  const timestamp = Number(item.timestamp) || Date.now();
  if (!Number.isFinite(long) || !Number.isFinite(short) || long < 0 || short < 0) throw new Error('Bybit ratio fields invalid');
  return {
    longAccount: long,
    shortAccount: short,
    longShortRatio: short > 0 ? long / short : null,
    timestamp,
  };
}

async function handlePositioning(symbol, headers) {
  if (!ALLOWED_POSITIONING_SYMBOLS.has(symbol)) {
    return Response.json({ error: 'unsupported_symbol' }, { status: 400, headers });
  }
  const pair = `${symbol}USDT`;
  const { results, errors } = await fetchBinancePositioning(pair);
  let globalSource = results.global ? 'Binance USDⓈ-M' : null;

  // Binance may reject some Cloudflare egress IPs. Fall back to Bybit for the all-account ratio.
  if (!results.global) {
    try {
      results.global = await fetchBybitGlobal(pair);
      globalSource = 'Bybit Linear';
    } catch (error) {
      errors.push(`bybitGlobal:${String(error?.message || error)}`);
    }
  }

  if (!results.global && !results.topAccounts && !results.topPositions) {
    return Response.json({
      error: 'positioning_upstream_failed',
      symbol,
      sourcesTried: ['Binance USDⓈ-M', 'Bybit Linear'],
      errors,
    }, { status: 502, headers });
  }

  const timestamps = [results.global, results.topAccounts, results.topPositions]
    .map(x => Number(x?.timestamp)).filter(Number.isFinite);

  return Response.json({
    symbol,
    pair,
    period: '5m',
    timestamp: timestamps.length ? Math.max(...timestamps) : Date.now(),
    global: results.global,
    topAccounts: results.topAccounts,
    topPositions: results.topPositions,
    sources: {
      global: globalSource,
      topAccounts: results.topAccounts ? 'Binance USDⓈ-M' : null,
      topPositions: results.topPositions ? 'Binance USDⓈ-M' : null,
    },
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
      return Response.json({ ok: true, service: 'liqpulse-relay', version: '0.9.0' }, { headers });
    }

    if (url.pathname === '/capabilities') {
      return Response.json({
        version: '0.9.0',
        market: ['BTC','ETH','SOL','XRP','ZEC','SP500','GOLD','SILVER'],
        heatmap: ['BTC','ETH','SOL','XRP','ZEC'],
        positioning: ['BTC','ETH','SOL','XRP','ZEC'],
        orderBook: ['BTC','ETH','SOL','XRP','ZEC','SP500','GOLD','SILVER'],
        hip3: ['xyz:SP500','xyz:GOLD','xyz:SILVER'],
        note: 'Heatmap availability depends on the upstream public source for each symbol.'
      }, { headers });
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

    const bookMatch = url.pathname.match(/^\/book\/([A-Za-z0-9_-]+)$/);
    if (bookMatch) {
      const symbol=bookMatch[1].toUpperCase(), coin=BOOK_COINS[symbol];
      if(!coin) return Response.json({error:'unsupported_symbol'}, {status:400,headers});
      try{
        const upstream=await fetch(HYPERLIQUID_INFO,{method:'POST',headers:{'content-type':'application/json','accept':'application/json'},body:JSON.stringify({type:'l2Book',coin,nSigFigs:5})});
        const text=await upstream.text();
        const outHeaders=new Headers(headers); outHeaders.set('Content-Type','application/json; charset=utf-8'); outHeaders.set('Cache-Control','public, max-age=5');
        return new Response(text,{status:upstream.status,headers:outHeaders});
      }catch(error){ return Response.json({error:'book_upstream_failed',message:String(error?.message||error)},{status:502,headers}); }
    }

    const positioningMatch = url.pathname.match(/^\/positioning\/([A-Za-z0-9_-]+)$/);
    if (positioningMatch) return handlePositioning(positioningMatch[1].toUpperCase(), headers);

    return new Response('Not Found', { status: 404, headers });
  },
};
