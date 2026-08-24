// LiqPulse v0.9.0 — Cloudflare Worker relay
// Public market data only. No API keys, cookies, or user data are forwarded.

const ALLOWED_HEATMAP_SYMBOLS = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'ZEC']);
const ALLOWED_POSITIONING_SYMBOLS = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'ZEC']);
const BOOK_COINS = { BTC:'BTC', ETH:'ETH', SOL:'SOL', XRP:'XRP', ZEC:'ZEC', SP500:'xyz:SP500', GOLD:'xyz:GOLD', SILVER:'xyz:SILVER' };
const MARKET_META = { SP500:{dex:'xyz',name:'SP500'}, GOLD:{dex:'xyz',name:'GOLD'}, SILVER:{dex:'xyz',name:'SILVER'} };
const HYPERLIQUID_INFO='https://api.hyperliquid.xyz/info';
const HEATMAP_UPSTREAM = 'https://trade.hyperperps.app/api/public/heatmap/';
const BINANCE_FUTURES_DATA = 'https://fapi.binance.com/futures/data/';
const BYBIT_V5 = 'https://api.bybit.com/v5/market/account-ratio';
const TRADINGVIEW_SCAN = 'https://scanner.tradingview.com/global/scan';
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
      return Response.json({ ok: true, service: 'liqpulse-relay', version: '1.3.2' }, { headers });
    }

    if (url.pathname === '/capabilities') {
      return Response.json({
        version: '1.3.2',
        market: ['BTC','ETH','SOL','XRP','ZEC','SP500','GOLD','SILVER'],
        heatmap: ['BTC','ETH','SOL','XRP','ZEC'],
        positioning: ['BTC','ETH','SOL','XRP','ZEC'],
        orderBook: ['BTC','ETH','SOL','XRP','ZEC','SP500','GOLD','SILVER'],
        hip3: ['xyz:SP500','xyz:GOLD','xyz:SILVER'],
        sp500Map: true,
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



    if (url.pathname === '/sp500-map') {
      try {
        const columns=['name','description','close','change','market_cap_basic','sector'];
        const payload={
          preset:'index_components_market_pages',
          symbols:{symbolset:['SYML:SP;SPX']},
          columns,
          sort:{sortBy:'market_cap_basic',sortOrder:'desc'},
          range:[0,550]
        };
        const upstream=await fetch(TRADINGVIEW_SCAN,{
          method:'POST',
          headers:{'content-type':'application/json','accept':'application/json','user-agent':'Mozilla/5.0','origin':'https://www.tradingview.com','referer':'https://www.tradingview.com/'},
          body:JSON.stringify(payload)
        });
        const text=await upstream.text();
        if(!upstream.ok) return Response.json({error:'sp500_map_upstream_http',status:upstream.status,body:text.slice(0,180)},{status:502,headers});
        let raw; try{raw=JSON.parse(text);}catch{return Response.json({error:'sp500_map_non_json'},{status:502,headers});}
        const rows=(Array.isArray(raw?.data)?raw.data:[]).map((item,idx)=>{
          const d=Array.isArray(item?.d)?item.d:[];
          const ticker=String(item?.s||'').split(':').pop();
          return {rank:idx+1,symbol:String(item?.s||''),ticker,name:d[0]||ticker,description:d[1]||'',close:Number(d[2]),change:Number(d[3]),marketCap:Number(d[4]),sector:d[5]||'Other'};
        }).filter(r=>r.ticker && Number.isFinite(r.change));
        if(!rows.length) return Response.json({error:'sp500_map_empty'},{status:502,headers});
        const advancers=rows.filter(r=>r.change>0.02).length, decliners=rows.filter(r=>r.change<-0.02).length, unchanged=rows.length-advancers-decliners;
        const cap=rows.reduce((a,r)=>a+(Number.isFinite(r.marketCap)&&r.marketCap>0?r.marketCap:0),0);
        const capWeightedChange=cap?rows.reduce((a,r)=>a+(Number.isFinite(r.marketCap)&&r.marketCap>0?r.marketCap:0)*r.change,0)/cap:null;
        return Response.json({source:'TradingView public screener',delayed:true,timestamp:Date.now(),totalCount:Number(raw?.totalCount)||rows.length,rows,summary:{advancers,decliners,unchanged,capWeightedChange}}, {headers:{...headers,'Cache-Control':'public, max-age=60'}});
      } catch(error) {
        return Response.json({error:'sp500_map_upstream_failed',message:String(error?.message||error)},{status:502,headers});
      }
    }

    const marketMatch = url.pathname.match(/^\/market\/([A-Za-z0-9_-]+)$/);
    if (marketMatch) {
      const symbol=marketMatch[1].toUpperCase(), cfg=MARKET_META[symbol];
      if(!cfg) return Response.json({error:'unsupported_symbol'}, {status:400,headers});
      try{
        const upstream=await fetch(HYPERLIQUID_INFO,{method:'POST',headers:{'content-type':'application/json','accept':'application/json'},body:JSON.stringify({type:'metaAndAssetCtxs',dex:cfg.dex})});
        if(!upstream.ok) return Response.json({error:'market_upstream_http',status:upstream.status},{status:502,headers});
        const data=await upstream.json(), meta=data?.[0], ctxs=data?.[1];
        if(!meta?.universe || !Array.isArray(ctxs)) return Response.json({error:'market_upstream_shape'},{status:502,headers});
        let i=meta.universe.findIndex(u=>String(u?.name||'').toUpperCase()===cfg.name || String(u?.name||'').toUpperCase()===`XYZ:${cfg.name}`);
        if(i<0) return Response.json({error:'market_symbol_not_found',available:meta.universe.map(u=>u?.name).filter(Boolean).slice(0,80)},{status:404,headers});
        const c=ctxs[i]||{}, markPx=Number(c.markPx), oi=Number(c.openInterest), funding=Number(c.funding);
        return Response.json({symbol,dex:cfg.dex,coin:meta.universe[i]?.name,markPx:Number.isFinite(markPx)?markPx:null,openInterest:Number.isFinite(oi)?oi:null,openInterestUsd:Number.isFinite(markPx)&&Number.isFinite(oi)?markPx*oi:null,funding:Number.isFinite(funding)?funding:null,timestamp:Date.now()},{headers});
      }catch(error){ return Response.json({error:'market_upstream_failed',message:String(error?.message||error)},{status:502,headers}); }
    }
    const bookMatch = url.pathname.match(/^\/book\/([A-Za-z0-9_-]+)$/);
    if (bookMatch) {
      const symbol=bookMatch[1].toUpperCase(), coin=BOOK_COINS[symbol];
      if(!coin) return Response.json({error:'unsupported_symbol'}, {status:400,headers});
      try{
        const fetchBook=async(nSigFigs)=>{
          const r=await fetch(HYPERLIQUID_INFO,{method:'POST',headers:{'content-type':'application/json','accept':'application/json'},body:JSON.stringify({type:'l2Book',coin,nSigFigs})});
          if(!r.ok) throw new Error(`l2Book ${nSigFigs}: HTTP ${r.status}`);
          return await r.json();
        };
        const precise=await fetchBook(5);
        if(symbol!=='BTC'){
          return Response.json(precise,{headers:{...headers,'Cache-Control':'public, max-age=5'}});
        }
        // BTC gets additional aggregated books so the UI can visualize real resting liquidity
        // across a much wider +/-$10,000 capture window. We never sum overlapping granularities.
        const [mid,coarse]=await Promise.all([fetchBook(3).catch(()=>null),fetchBook(2).catch(()=>null)]);
        const bestBid=Number(precise?.levels?.[0]?.[0]?.px), bestAsk=Number(precise?.levels?.[1]?.[0]?.px);
        const spot=Number.isFinite(bestBid)&&Number.isFinite(bestAsk)?(bestBid+bestAsk)/2:(Number(bestBid)||Number(bestAsk));
        const pick=(raw,side,minDist,maxDist)=>((raw?.levels?.[side]||[]).filter(x=>{
          const p=Number(x?.px), d=Math.abs(p-spot); return Number.isFinite(p)&&Number.isFinite(spot)&&d>=minDist&&d<maxDist;
        }));
        const wideBids=[...pick(precise,0,0,350),...pick(mid,0,350,2500),...pick(coarse,0,2500,10500)];
        const wideAsks=[...pick(precise,1,0,350),...pick(mid,1,350,2500),...pick(coarse,1,2500,10500)];
        return Response.json({...precise,wideLevels:[wideBids,wideAsks],wideMeta:{spot,rangeUsd:10000,sourceSigFigs:[5,3,2]}},{headers:{...headers,'Cache-Control':'public, max-age=5'}});
      }catch(error){ return Response.json({error:'book_upstream_failed',message:String(error?.message||error)},{status:502,headers}); }
    }

    const positioningMatch = url.pathname.match(/^\/positioning\/([A-Za-z0-9_-]+)$/);
    if (positioningMatch) return handlePositioning(positioningMatch[1].toUpperCase(), headers);

    return new Response('Not Found', { status: 404, headers });
  },
};
