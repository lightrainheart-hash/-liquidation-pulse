// LiqPulse v0.3 — Cloudflare Worker relay
// Deploy as a Worker, then paste its https://*.workers.dev URL into LiqPulse settings.
// Public market data only. No API keys, cookies, or user data are forwarded.

const ALLOWED_SYMBOLS = new Set(['BTC', 'ETH', 'SOL']);
const UPSTREAM = 'https://trade.hyperperps.app/api/public/heatmap/';
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

export default {
  async fetch(request) {
    const headers = corsHeaders(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'GET') return new Response('Method Not Allowed', { status: 405, headers });

    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({ ok: true, service: 'liqpulse-relay', version: '0.3.0' }, { headers });
    }

    const match = url.pathname.match(/^\/heatmap\/([A-Za-z0-9_-]+)$/);
    if (!match) return new Response('Not Found', { status: 404, headers });
    const symbol = match[1].toUpperCase();
    if (!ALLOWED_SYMBOLS.has(symbol)) return new Response('Unsupported symbol', { status: 400, headers });

    try {
      const upstream = await fetch(UPSTREAM + encodeURIComponent(symbol), {
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
  },
};
