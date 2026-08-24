'use strict';

const DEFAULT_RELAY = 'https://liqpulse-relay.lightrain-heart.workers.dev';

const CONFIG = {
  infoUrl: 'https://api.hyperliquid.xyz/info',
  wsUrl: 'wss://api.hyperliquid.xyz/ws',
  heatmapDirect: 'https://trade.hyperperps.app/api/public/heatmap/',
  // Optional first-party relay. Set once in-app after deploying relay-worker.js to Cloudflare Workers.
  relayBase: localStorage.getItem('liqpulse_relay_base') || DEFAULT_RELAY,
  infoPollMs: 15000,
  heatmapPollMs: 60000,
  positioningPollMs: 60000,
  orderBookPollMs: 10000,
  sp500MapPollMs: 120000,
  mexcTradesPollMs: 4000,
  mexcKlinePollMs: 60000,
  relayTimeoutMs: 10000,
  maxTradeWindowMs: 60 * 60 * 1000,
  wsStaleMs: 15000,
  liqBiasRangePct: 0.10,
  radarRangePct: 0.05,
  snapshotRetentionMs: 6 * 60 * 60 * 1000,
  marketSnapshotMinMs: 45000,
  decisionLookbackMs: 15 * 60 * 1000,
};

const ASSETS = [
  { symbol:'BTC', name:'Bitcoin', type:'crypto', heatmap:true, positioning:true, dex:'', apiCoin:'BTC', estimatedZones:true,
    orderMap:{title:'BTC Whale Order Map',subtitle:'局面を動かし得る重要大口壁だけを価格×時間で可視化 / Hyperliquid L2',capture:10000,ranges:[1000,3000,5000],defaultRange:3000,bucket:100,minNotional:100000,strongWall:10000000,impactShare:.18,impactQuantile:.80,impactMaxPerSide:3} },
  { symbol:'ETH', name:'Ethereum', type:'crypto', heatmap:true, positioning:true, dex:'', apiCoin:'ETH', estimatedZones:true,
    orderMap:{title:'ETH Whale Order Map',subtitle:'Ethereumの局面級大口壁だけを価格×時間で可視化 / Hyperliquid L2',capture:1200,ranges:[100,250,500],defaultRange:250,bucket:10,minNotional:75000,strongWall:2000000,impactShare:.18,impactQuantile:.80,impactMaxPerSide:3} },
  { symbol:'SOL', name:'Solana', type:'crypto', heatmap:true, positioning:true, dex:'', apiCoin:'SOL', estimatedZones:true,
    orderMap:{title:'SOL Whale Order Map',subtitle:'Solanaの局面級大口壁だけを価格×時間で可視化 / Hyperliquid L2',capture:150,ranges:[5,15,30],defaultRange:15,bucket:1,minNotional:50000,strongWall:750000,impactShare:.18,impactQuantile:.80,impactMaxPerSide:3} },
  { symbol:'XRP', name:'XRP', type:'crypto', heatmap:true, positioning:true, dex:'', apiCoin:'XRP', estimatedZones:true },
  { symbol:'ZEC', name:'Zcash', type:'crypto', heatmap:true, positioning:true, dex:'', apiCoin:'ZEC', estimatedZones:true },
  { symbol:'SP500', name:'S&P 500', type:'index', heatmap:false, positioning:false, dex:'xyz', apiCoin:'xyz:SP500', estimatedZones:true,
    orderMap:{title:'S&P 500 Liquidity Order Map',subtitle:'xyz:SP500永久先物の局面級大口流動性だけを可視化（現物指数全体の板ではありません）',capture:1000,ranges:[100,250,500],defaultRange:250,bucket:10,minNotional:100000,strongWall:2000000,impactShare:.18,impactQuantile:.80,impactMaxPerSide:3} },
  { symbol:'KIOXIA', name:'Kioxia', type:'stockFuture', source:'mexc', provider:'MEXC Stock Futures', heatmap:false, positioning:false, estimatedZones:true,
    apiSymbol:'KIOXIASTOCK_USDT', contractSize:0.001,
    orderMap:{title:'KIOXIA Whale Order Map',subtitle:'MEXC KIOXIAUSDTの局面級大口壁だけを価格×時間で可視化 / MEXC Futures L2',capture:80,ranges:[5,15,30],defaultRange:15,bucket:0.5,minNotional:5000,strongWall:250000,impactShare:.22,impactQuantile:.80,impactMaxPerSide:3,tierNotionals:[2000000,1000000,500000,250000,100000]} },
  { symbol:'GOLD', name:'Gold', type:'commodity', heatmap:false, positioning:false, dex:'xyz', apiCoin:'xyz:GOLD', estimatedZones:true },
  { symbol:'SILVER', name:'Silver', type:'commodity', heatmap:false, positioning:false, dex:'xyz', apiCoin:'xyz:SILVER', estimatedZones:true },
];

// Adaptive Order Map range model. Each market starts from a market-appropriate
// percentage profile, then expands when the most recent hour is unusually volatile.
// Values are intentionally snapped to human-readable price units so the controls
// stay useful on an iPhone instead of changing by tiny amounts every refresh.
const WHALE_RANGE_POLICIES = {
  BTC:{basePct:[0.0125,0.035,0.064],volMult:[0.70,1.50,2.60]},
  ETH:{basePct:[0.0180,0.055,0.110],volMult:[0.75,1.60,2.80]},
  SOL:{basePct:[0.0250,0.075,0.150],volMult:[0.75,1.60,2.80]},
  SP500:{basePct:[0.0125,0.032,0.064],volMult:[0.70,1.50,2.60]},
  KIOXIA:{basePct:[0.0160,0.045,0.095],volMult:[0.80,1.70,3.00]},
};
const LAST_ASSET_KEY='liqpulse_last_asset';
// Cold starts always open on BTC. We still remember the last asset for diagnostics/history,
// but do not let a previous session unexpectedly change the startup screen.
const initialAsset=ASSETS.find(x=>x.symbol==='BTC') || ASSETS[0];

const state = {
  asset: initialAsset,
  ws:null,
  wsBackoff:1000,
  tradeEvents:[],
  tradeSeenKeys:new Map(),
  lastExternalTradeAt:0,
  externalCandles:[],
  flowWindowMs:300000,
  clusterDepth:5,
  ctxByCoin:new Map(),
  latestPrice:null,
  heatmap:null,
  positioning:null,
  orderbook:null,
  sp500Map:null,
  sp500MapLimit:80,
  timers:[],
  switching:false,
  lastWsAt:0,
  decision:null,
  whaleHistory:[],
  whaleTracks:[],
  whaleLastBookAt:0,
  whaleLookbackMs:3 * 60 * 60 * 1000,
  whaleDisplayRangeUsd:null,
  whaleRangeSlot:null,
  whaleChartZoom:null,
  assetEpoch:0,
  advancedOpen:false,
  diagnosticsOpen:false,
  freshness:{ws:0,meta:0,heatmap:0,positioning:0,orderbook:0,sp500:0},
  sourceErrors:{},
};

const $ = (id) => document.getElementById(id);

function money(v){
  if(!Number.isFinite(v)) return '—';
  const a=Math.abs(v), sign=v<0?'-':'';
  if(a>=1e9) return `${sign}$${(a/1e9).toFixed(2)}B`;
  if(a>=1e6) return `${sign}$${(a/1e6).toFixed(1)}M`;
  if(a>=1e3) return `${sign}$${(a/1e3).toFixed(1)}K`;
  return `${sign}$${a.toFixed(0)}`;
}
function priceFmt(v){
  if(!Number.isFinite(v)) return '—';
  const d=v>=1000?0:v>=10?2:v>=1?3:5;
  return '$'+v.toLocaleString(undefined,{minimumFractionDigits:d,maximumFractionDigits:d});
}
function pct(v,digits=4){ return Number.isFinite(v)?`${(v*100).toFixed(digits)}%`:'—'; }
function distPct(price,spot){ return Number.isFinite(price)&&Number.isFinite(spot)&&spot!==0?(price/spot-1):NaN; }
function clamp(v,min,max){ return Math.max(min,Math.min(max,v)); }
function setStatus(kind,text){ const el=$('connBadge'); el.className=`status ${kind}`; el.querySelector('b').textContent=text; }
function setText(id,text){ const el=$(id); if(el) el.textContent=text; }
function isCryptoAsset(asset=state.asset){ return asset?.type==='crypto'; }
function currentEpoch(){ return state.assetEpoch; }
function requestStillCurrent(epoch,symbol){ return epoch===state.assetEpoch && symbol===state.asset.symbol; }
function markFresh(source,ts=Date.now()){ state.freshness[source]=ts; }
function ageMs(source){ const ts=Number(state.freshness[source])||0; return ts?Math.max(0,Date.now()-ts):Infinity; }
function freshnessLabel(ms){ if(!Number.isFinite(ms)) return '未取得'; if(ms<15000) return 'LIVE'; if(ms<60000) return `${Math.max(1,Math.round(ms/1000))}秒前`; return `${Math.round(ms/60000)}分前`; }
function setTone(el,tone){ if(!el) return; el.classList.remove('green','red','neutral-text'); if(tone==='up')el.classList.add('green'); else if(tone==='down')el.classList.add('red'); else el.classList.add('neutral-text'); }

function renderAssetTabs(){
  const el=$('assetTabs'); el.textContent='';
  for(const a of ASSETS){
    const b=document.createElement('button');
    b.className='asset-btn'+(a.symbol===state.asset.symbol?' active':'');
    b.textContent=a.symbol;
    b.onclick=()=>switchAsset(a.symbol);
    el.appendChild(b);
  }
}

function updateAssetSpecificPanels(){
  const posCard=$('positioningCard');
  if(posCard) posCard.classList.toggle('hidden',!state.asset.positioning);
  const finviz=$('finvizMapCard');
  if(finviz) finviz.classList.toggle('hidden',state.asset.symbol!=='SP500');
  const command=$('sp500CommandCard');
  if(command) command.classList.toggle('hidden',state.asset.symbol!=='SP500');
  const whale=$('btcWhaleCard');
  if(whale) whale.classList.toggle('hidden',!state.asset.orderMap);
  const mexc=$('mexcStockCard');
  if(mexc) mexc.classList.toggle('hidden',state.asset.source!=='mexc');
}

async function switchAsset(symbol){
  if(state.switching || symbol===state.asset.symbol) return;
  const next=ASSETS.find(x=>x.symbol===symbol)||ASSETS[0];
  state.switching=true;
  state.assetEpoch+=1;
  state.asset=next;
  try{localStorage.setItem(LAST_ASSET_KEY,next.symbol);}catch{}
  state.tradeEvents=[]; state.tradeSeenKeys=new Map(); state.lastExternalTradeAt=0; state.externalCandles=[]; state.heatmap=null; state.positioning=null; state.orderbook=null; state.sp500Map=null; state.latestPrice=null; state.decision=null;
  state.freshness={ws:0,meta:0,heatmap:0,positioning:0,orderbook:0,sp500:0}; state.sourceErrors={};
  if(next.orderMap){ state.whaleHistory=loadWhaleHistory(); state.whaleTracks=loadWhaleTracks(); } else { state.whaleHistory=[]; state.whaleTracks=[]; }
  state.whaleLastBookAt=0; state.whaleDisplayRangeUsd=null; state.whaleRangeSlot=null; state.whaleChartZoom=null;
  renderAssetTabs(); updateAssetSpecificPanels(); renderBase(); renderMexcOverview(); renderFlow(); renderHeatmap(); renderLiqBias(); renderRadar(); renderPositioning(); renderDecisionEngine(); renderQuickView(); renderSp500Command(); renderWhaleOrderMap(); renderRelaySettings(); renderVisibilityControls();
  connectWs(true);
  state.switching=false;
  void Promise.allSettled([fetchMeta(), fetchHeatmap(), fetchPositioning(), fetchOrderBook(), fetchSp500Map(), fetchExternalTrades(), fetchExternalCandles()]);
}

function renderBase(){
  setText('assetName',state.asset.name);
  setText('marketSource',state.asset.provider || (state.asset.dex?'Hyperliquid HIP-3':'Hyperliquid'));
  setText('markLabel',state.asset.source==='mexc'?'Fair':'Mark');
  setText('oiLabel',state.asset.source==='mexc'?'OI*':'OI');
  const c=state.ctxByCoin.get(state.asset.symbol), live=Number.isFinite(state.latestPrice)?state.latestPrice:c?.markPx;
  setText('price',priceFmt(live)); setText('markPx',c?priceFmt(c.markPx):'—'); setText('openInterest',c?money(c.openInterestUsd):'—'); setText('funding',c?pct(c.funding,4):'—');
  const freshest=Math.min(ageMs('ws'),ageMs('meta'));
  setText('heroFreshness',freshnessLabel(freshest));
  const q=dataQualityMetrics(); setText('heroDataQuality',`データ品質 ${q.score}`);
  const qEl=$('heroDataQuality'); if(qEl){qEl.className=`pill quality-${q.score>=70?'good':q.score>=45?'mid':'low'}`;qEl.title=q.missing.length?`不足: ${q.missing.join(', ')}`:'主要データ取得済み';}
  const fEl=$('funding'); if(fEl){const f=Number(c?.funding);setTone(fEl,Number.isFinite(f)?(f>0.0001?'down':f<-0.0001?'up':'neutral'):'neutral');}
  renderMexcOverview();
}



function marketSnapshotKey(symbol){ return `liqpulse_market_snapshots_${symbol}`; }
function loadMarketSnapshots(symbol){
  try{
    const raw=JSON.parse(localStorage.getItem(marketSnapshotKey(symbol))||'[]');
    const cutoff=Date.now()-CONFIG.snapshotRetentionMs;
    return Array.isArray(raw)?raw.filter(x=>Number(x?.ts)>=cutoff):[];
  }catch{return []}
}
function saveMarketSnapshot(symbol,ctx,price){
  if(!ctx || !Number.isFinite(ctx.openInterestUsd)) return;
  const list=loadMarketSnapshots(symbol), now=Date.now(), last=list[list.length-1];
  if(last && now-last.ts<CONFIG.marketSnapshotMinMs) return;
  list.push({ts:now,oi:ctx.openInterestUsd,price:Number.isFinite(price)?price:ctx.markPx,funding:ctx.funding});
  try{localStorage.setItem(marketSnapshotKey(symbol),JSON.stringify(list.slice(-360)));}catch{}
}
function previousMarketSnapshot(symbol,lookbackMs=CONFIG.decisionLookbackMs){
  const list=loadMarketSnapshots(symbol); if(!list.length) return null;
  const target=Date.now()-lookbackMs; let best=null,delta=Infinity;
  for(const x of list){ const d=Math.abs(x.ts-target); if(d<delta){delta=d;best=x;} }
  return best && delta<=10*60*1000 ? best : null;
}
function marketMomentum(){
  const ctx=state.ctxByCoin.get(state.asset.symbol), spot=state.latestPrice||ctx?.markPx;
  if(!ctx||!Number.isFinite(ctx.openInterestUsd)||!Number.isFinite(spot)) return null;
  const prev=previousMarketSnapshot(state.asset.symbol); if(!prev) return {oiChange:null,priceChange:null};
  const oiChange=prev.oi>0?(ctx.openInterestUsd-prev.oi)/prev.oi:null;
  const priceChange=prev.price>0?(spot-prev.price)/prev.price:null;
  return {oiChange,priceChange};
}

async function fetchMeta(){
  const epoch=currentEpoch(), asset={...state.asset}, symbol=asset.symbol;
  try{
    if(asset.source==='mexc'){
      const relayBase=(CONFIG.relayBase||'').replace(/\/$/,'');
      if(!relayBase) throw new Error('Relay not configured');
      const raw=await fetchJsonWithTimeout(`${relayBase}/mexc/market/${encodeURIComponent(symbol)}`,CONFIG.relayTimeoutMs);
      if(raw?.error) throw new Error(raw.error);
      const fair=Number(raw.fairPrice), last=Number(raw.lastPrice), index=Number(raw.indexPrice), oiUsd=Number(raw.openInterestUsd), funding=Number(raw.fundingRate);
      const c={markPx:Number.isFinite(fair)?fair:last,funding,openInterestUsd:oiUsd,indexPrice:index,lastPrice:last,basis:Number(raw.basis),riseFallRate:Number(raw.riseFallRate),high24:Number(raw.high24Price),low24:Number(raw.lower24Price),amount24:Number(raw.amount24),holdVol:Number(raw.holdVol),contractSize:Number(raw.contractSize),apiSymbol:raw.apiSymbol||asset.apiSymbol};
      if(!Number.isFinite(c.markPx)) throw new Error('Invalid MEXC market response');
      state.ctxByCoin.set(symbol,c);
      if(requestStillCurrent(epoch,symbol)){
        state.latestPrice=Number.isFinite(last)?last:c.markPx;
        saveMarketSnapshot(symbol,c,state.latestPrice); markFresh('meta',Number(raw.timestamp)||Date.now()); state.sourceErrors.meta=null;
        setStatus('online','MEXC');
      }
    }else if(asset.dex){
      const relayBase=(CONFIG.relayBase||'').replace(/\/$/,'');
      if(!relayBase) throw new Error('Relay not configured');
      const raw=await fetchJsonWithTimeout(`${relayBase}/market/${encodeURIComponent(symbol)}`,CONFIG.relayTimeoutMs);
      if(raw?.error) throw new Error(raw.error);
      const c={markPx:Number(raw.markPx),funding:Number(raw.funding),openInterestUsd:Number(raw.openInterestUsd)};
      if(!Number.isFinite(c.markPx)) throw new Error('Invalid HIP-3 market response');
      state.ctxByCoin.set(symbol,c);
      if(requestStillCurrent(epoch,symbol)){
        if(!Number.isFinite(state.latestPrice)) state.latestPrice=c.markPx;
        saveMarketSnapshot(symbol,c,state.latestPrice||c.markPx); markFresh('meta'); state.sourceErrors.meta=null;
      }
    }else{
      const res=await fetch(CONFIG.infoUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'metaAndAssetCtxs'}),cache:'no-store'});
      if(!res.ok) throw new Error(`HTTP ${res.status}`);
      const data=await res.json(), meta=data?.[0], ctxs=data?.[1];
      if(!meta?.universe || !Array.isArray(ctxs)) throw new Error('Unexpected response');
      meta.universe.forEach((u,i)=>{
        const c=ctxs[i]; if(!c) return;
        const markPx=Number(c.markPx), oi=Number(c.openInterest);
        state.ctxByCoin.set(u.name,{markPx,funding:Number(c.funding),openInterestUsd:oi*markPx});
      });
      if(requestStillCurrent(epoch,symbol)){
        const c=state.ctxByCoin.get(symbol);
        if(c && !Number.isFinite(state.latestPrice)) state.latestPrice=c.markPx;
        if(c) saveMarketSnapshot(symbol,c,state.latestPrice||c.markPx);
        markFresh('meta'); state.sourceErrors.meta=null;
      }
    }
    if(!requestStillCurrent(epoch,symbol)) return;
    setText('statusInfo','正常'); renderBase(); renderPressure(); renderDecisionEngine(); renderQuickView();
  }catch(err){
    if(!requestStillCurrent(epoch,symbol)) return;
    state.sourceErrors.meta=String(err?.message||err); console.warn('meta',err); setText('statusInfo','取得失敗'); renderBase(); renderQuickView();
  }
}

function connectWs(force=false){
  if(force && state.ws){ try{state.ws.onclose=null;state.ws.onmessage=null;state.ws.close();}catch{} state.ws=null; }
  if(state.asset.source==='mexc'){
    if(state.ws){try{state.ws.onclose=null;state.ws.close();}catch{} state.ws=null;}
    state.lastWsAt=Date.now(); setStatus('online','MEXC'); setText('statusWs','MEXC REST');
    return;
  }
  if(state.ws && (state.ws.readyState===0 || state.ws.readyState===1)) return;
  const epoch=currentEpoch(), symbol=state.asset.symbol, coin=state.asset.apiCoin||symbol, isDex=Boolean(state.asset.dex);
  setStatus('offline','接続中'); setText('statusWs','接続中');
  const ws=new WebSocket(CONFIG.wsUrl); state.ws=ws;
  ws.onopen=()=>{
    if(!requestStillCurrent(epoch,symbol)){try{ws.close();}catch{}return;}
    state.wsBackoff=1000; state.lastWsAt=Date.now(); markFresh('ws'); setStatus('online','LIVE'); setText('statusWs','LIVE');
    ws.send(JSON.stringify({method:'subscribe',subscription:{type:'trades',coin}}));
    if(!isDex) ws.send(JSON.stringify({method:'subscribe',subscription:{type:'allMids'}}));
  };
  ws.onmessage=(ev)=>{
    if(!requestStillCurrent(epoch,symbol)) return;
    state.lastWsAt=Date.now(); markFresh('ws');
    let msg; try{msg=JSON.parse(ev.data);}catch{return;}
    if(msg.channel==='trades' && Array.isArray(msg.data)) ingestTrades(msg.data);
    if(msg.channel==='allMids' && msg.data?.mids){
      const p=Number(msg.data.mids[symbol]);
      if(Number.isFinite(p)){ state.latestPrice=p; setText('price',priceFmt(p)); renderHeatmap(); renderLiqBias(); renderPressure(); renderRadar(); renderDecisionEngine(); renderQuickView(); renderBase(); }
    }
  };
  ws.onerror=()=>{ if(requestStillCurrent(epoch,symbol)) setStatus('error','再接続'); };
  ws.onclose=()=>{
    if(state.ws!==ws || !requestStillCurrent(epoch,symbol)) return;
    setText('statusWs','再接続中'); setStatus('error','再接続');
    const wait=state.wsBackoff; state.wsBackoff=Math.min(30000,state.wsBackoff*2);
    setTimeout(()=>{ if(requestStillCurrent(epoch,symbol)) connectWs(); },wait);
  };
}

function ingestTrades(trades){
  const now=Date.now();
  for(const t of trades){
    const px=Number(t.px), sz=Number(t.sz), ts=Number(t.time)||now, key=t.key||t.id||null;
    if(!Number.isFinite(px)||!Number.isFinite(sz)) continue;
    if(key && state.tradeSeenKeys.has(String(key))) continue;
    if(key) state.tradeSeenKeys.set(String(key),ts);
    state.tradeEvents.push({ts,usd:px*sz,buy:t.side==='B',price:px});
    state.latestPrice=px;
  }
  const cutoff=now-CONFIG.maxTradeWindowMs;
  state.tradeEvents=state.tradeEvents.filter(x=>x.ts>=cutoff);
  for(const [k,ts] of state.tradeSeenKeys){ if(ts<cutoff) state.tradeSeenKeys.delete(k); }
  if(state.tradeSeenKeys.size>6000){ const entries=[...state.tradeSeenKeys.entries()].sort((a,b)=>a[1]-b[1]).slice(-4000);state.tradeSeenKeys=new Map(entries); }
  renderFlow(); renderBase(); renderPressure(); renderDecisionEngine(); renderWhaleOrderMap();
}

function flowTotals(windowMs=state.flowWindowMs){
  const cutoff=Date.now()-windowMs; let buy=0,sell=0,count=0;
  for(const t of state.tradeEvents){ if(t.ts<cutoff) continue; count++; if(t.buy) buy+=t.usd; else sell+=t.usd; }
  return {buy,sell,count,total:buy+sell};
}
function renderFlow(){
  const f=flowTotals(), bp=f.total?f.buy/f.total:0.5, sp=1-bp;
  setText('buyPct',(bp*100).toFixed(1)+'%'); setText('sellPct',(sp*100).toFixed(1)+'%');
  $('buyBar').style.width=(bp*100)+'%'; $('sellBar').style.width=(sp*100)+'%';
  setText('buyUsd',money(f.buy)); setText('sellUsd',money(f.sell));
  setText('buyUsd2',money(f.buy)); setText('sellUsd2',money(f.sell));
  setText('tradeCount',`${f.count.toLocaleString()} trades`);
}

async function fetchExternalTrades(){
  const epoch=currentEpoch(), asset={...state.asset}, symbol=asset.symbol;
  if(asset.source!=='mexc') return;
  const relayBase=(CONFIG.relayBase||'').replace(/\/$/,'');
  if(!relayBase) return;
  try{
    const raw=await fetchJsonWithTimeout(`${relayBase}/mexc/deals/${encodeURIComponent(symbol)}`,CONFIG.relayTimeoutMs);
    if(!requestStillCurrent(epoch,symbol)) return;
    const trades=Array.isArray(raw?.trades)?raw.trades:[];
    if(trades.length) ingestTrades(trades);
    const ts=Number(raw?.timestamp)||Date.now(); state.lastExternalTradeAt=ts; state.lastWsAt=ts; markFresh('ws',ts); state.sourceErrors.ws=null;
    setStatus('online','MEXC'); setText('statusWs','MEXC LIVE'); renderBase(); renderMexcOverview();
  }catch(err){
    if(!requestStillCurrent(epoch,symbol)) return;
    state.sourceErrors.ws=String(err?.message||err); setText('statusWs','MEXC取得失敗'); console.warn('mexc deals',err);
  }
}

async function fetchExternalCandles(){
  const epoch=currentEpoch(), asset={...state.asset}, symbol=asset.symbol;
  if(asset.source!=='mexc') return;
  const relayBase=(CONFIG.relayBase||'').replace(/\/$/,''); if(!relayBase) return;
  try{
    const raw=await fetchJsonWithTimeout(`${relayBase}/mexc/kline/${encodeURIComponent(symbol)}?interval=Min1&hours=6`,CONFIG.relayTimeoutMs);
    if(!requestStillCurrent(epoch,symbol)) return;
    const rows=Array.isArray(raw?.candles)?raw.candles:[];
    state.externalCandles=rows.map(x=>({ts:Number(x.ts),o:Number(x.o),h:Number(x.h),l:Number(x.l),c:Number(x.c)})).filter(x=>[x.ts,x.o,x.h,x.l,x.c].every(Number.isFinite));
  }catch(err){ if(requestStillCurrent(epoch,symbol)) console.warn('mexc kline',err); }
}

async function fetchJsonWithTimeout(url,timeoutMs=10000){
  const ac=new AbortController(); const timer=setTimeout(()=>ac.abort(),timeoutMs);
  try{
    const res=await fetch(url,{cache:'no-store',signal:ac.signal,headers:{'accept':'application/json,text/plain,*/*'}});
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const text=await res.text();
    return JSON.parse(text);
  }finally{ clearTimeout(timer); }
}


async function postInfoJson(body,timeoutMs=10000){
  const ac=new AbortController(); const timer=setTimeout(()=>ac.abort(),timeoutMs);
  try{
    const res=await fetch(CONFIG.infoUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),cache:'no-store',signal:ac.signal});
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  }finally{ clearTimeout(timer); }
}
function normalizeOrderBook(raw){
  const levels=raw?.levels;
  if(!Array.isArray(levels)||levels.length<2) return null;
  const conv=(arr,side)=>(Array.isArray(arr)?arr:[]).map(x=>{
    const price=Number(x?.px), size=Number(x?.sz), n=Number(x?.n);
    return {price,size,notional:Number.isFinite(price)&&Number.isFinite(size)?price*size:NaN,n:Number.isFinite(n)?n:null,side};
  }).filter(x=>Number.isFinite(x.price)&&Number.isFinite(x.notional)&&x.notional>0);
  const wide=raw?.wideLevels;
  return {
    bids:conv(levels[0],'bid'), asks:conv(levels[1],'ask'),
    wideBids:Array.isArray(wide)&&wide.length>=2?conv(wide[0],'bid'):conv(levels[0],'bid'),
    wideAsks:Array.isArray(wide)&&wide.length>=2?conv(wide[1],'ask'):conv(levels[1],'ask'),
    timestamp:Number(raw?.time)||Date.now(), coin:raw?.coin||state.asset.apiCoin
  };
}
async function fetchOrderBook(){
  const epoch=currentEpoch(), asset={...state.asset}, symbol=asset.symbol;
  if(!asset.estimatedZones){ if(requestStillCurrent(epoch,symbol)){state.orderbook=null;setText('statusOrderBook','対象外');renderQuickView();} return; }
  const relayBase=(CONFIG.relayBase||'').replace(/\/$/,'');
  let raw=null,err=null;
  if(relayBase){
    try{ raw=await fetchJsonWithTimeout(asset.source==='mexc'?`${relayBase}/mexc/book/${encodeURIComponent(symbol)}`:`${relayBase}/book/${encodeURIComponent(symbol)}`,CONFIG.relayTimeoutMs); }catch(e){err=e;}
  }
  if(!raw && asset.source!=='mexc'){
    try{ raw=await postInfoJson({type:'l2Book',coin:asset.apiCoin||symbol,nSigFigs:5}); }catch(e){err=e;}
  }
  if(!requestStillCurrent(epoch,symbol)) return;
  const ob=normalizeOrderBook(raw); state.orderbook=ob;
  if(ob){ markFresh('orderbook',Number(ob.timestamp)||Date.now()); state.sourceErrors.orderbook=null; recordWhaleSnapshot(ob); }
  else state.sourceErrors.orderbook=String(err?.message||err||'invalid order book');
  setText('statusOrderBook',ob?'正常':'取得失敗');
  if(!ob) console.warn('orderbook',err);
  renderQuickView(); renderDecisionEngine(); renderWhaleOrderMap(); renderRadar(); renderBase();
}

function estimatedTriggerZones(){
  const ob=state.orderbook, spot=state.latestPrice||state.ctxByCoin.get(state.asset.symbol)?.markPx;
  if(!ob||!Number.isFinite(spot)) return null;
  const asks=ob.wideAsks?.length?ob.wideAsks:ob.asks;
  const bids=ob.wideBids?.length?ob.wideBids:ob.bids;
  const maxDistance=state.asset.source==='mexc'?0.10:(isCryptoAsset()?0.08:0.03);
  const choose=(rows,dir)=>{
    const filtered=rows.filter(x=>{const d=(x.price/spot)-1; return dir==='up'?(d>0&&d<=maxDistance):(d<0&&d>=-maxDistance);});
    if(!filtered.length) return null;
    return filtered.map(x=>{
      const distance=Math.abs((x.price/spot)-1);
      const proximity=1/Math.max(distance,0.00045);
      const score=x.notional*Math.sqrt(proximity);
      return {...x,distance,score};
    }).sort((a,b)=>b.score-a.score)[0];
  };
  const up=choose(asks,'up'), down=choose(bids,'down');
  const inRange=(rows)=>rows.filter(x=>Math.abs(x.price/spot-1)<=0.02);
  const nearBids=inRange(bids), nearAsks=inRange(asks);
  const bidTotal=nearBids.reduce((a,x)=>a+x.notional,0), askTotal=nearAsks.reduce((a,x)=>a+x.notional,0);
  const total=bidTotal+askTotal;
  return {up,down,bidTotal,askTotal,bidPct:total?bidTotal/total:.5,askPct:total?askTotal/total:.5,rangePct:0.02};
}


function whaleConfig(){ return state.asset?.orderMap||null; }
function whaleSnapshotKey(symbol=state.asset.symbol){ return `liqpulse_order_map_walls_v3_${symbol}`; }
function whaleTrackKey(symbol=state.asset.symbol){ return `liqpulse_order_map_tracks_v3_${symbol}`; }
const WHALE_RETENTION_MS=6*60*60*1000;
const WHALE_CHART_ZOOM_OPTIONS=[1,1.35,1.7];
function rangeCompact(v){
  if(!Number.isFinite(v)) return '—';
  if(v>=1000 && v%1000===0) return `${v/1000}k`;
  if(v>=1000) return `${(v/1000).toFixed(1)}k`;
  return Number.isInteger(v)?String(v):v.toFixed(1);
}
function niceRangeCeil(raw){
  if(!Number.isFinite(raw)||raw<=0) return 0;
  const pow=10**Math.floor(Math.log10(raw)), n=raw/pow;
  const steps=[1,1.5,2,2.5,3,4,5,7.5,10];
  const step=steps.find(x=>n<=x+1e-9) ?? 10;
  return Number((step*pow).toPrecision(12));
}
function whaleRecentRangePct(){
  const spot=state.latestPrice||state.ctxByCoin.get(state.asset.symbol)?.markPx;
  if(!Number.isFinite(spot)||spot<=0) return NaN;
  const end=Date.now(), start=end-60*60*1000;
  const candles=whaleCandles(start,end);
  const prices=[];
  for(const c of candles){
    for(const v of [c.l,c.h,c.c]) if(Number.isFinite(v)&&v>0) prices.push(v);
  }
  if(prices.length<4){
    for(const p of whalePricePoints(start,end)) if(Number.isFinite(p.price)&&p.price>0) prices.push(p.price);
  }
  if(prices.length<3) return NaN;
  prices.sort((a,b)=>a-b);
  const q=(pct)=>prices[Math.min(prices.length-1,Math.max(0,Math.floor((prices.length-1)*pct)))];
  const lo=prices.length>=12?q(0.05):prices[0], hi=prices.length>=12?q(0.95):prices[prices.length-1];
  return clamp((hi-lo)/spot,0,0.35);
}
function whaleRangeDecision(){
  const cfg=whaleConfig();
  if(!cfg) return {ranges:[],capture:0,volPct:NaN,mode:'対象外'};
  const fallbackRanges=Array.isArray(cfg.ranges)&&cfg.ranges.length===3?cfg.ranges:[1,3,5];
  const fallbackCapture=Number(cfg.capture)||fallbackRanges[2]*2;
  const spot=state.latestPrice||state.ctxByCoin.get(state.asset.symbol)?.markPx;
  if(!Number.isFinite(spot)||spot<=0) return {ranges:[...fallbackRanges],capture:fallbackCapture,volPct:NaN,mode:'初期プロファイル'};
  const policy=WHALE_RANGE_POLICIES[state.asset.symbol]||{basePct:[0.02,0.06,0.12],volMult:[0.75,1.6,2.8]};
  const volPct=whaleRecentRangePct();
  const ranges=policy.basePct.map((basePct,i)=>{
    const base=spot*basePct;
    const volDriven=Number.isFinite(volPct)?spot*volPct*policy.volMult[i]:0;
    return niceRangeCeil(Math.max(base,volDriven));
  });
  for(let i=1;i<ranges.length;i++){
    if(!(ranges[i]>ranges[i-1])) ranges[i]=niceRangeCeil(ranges[i-1]*1.5+Number.EPSILON);
  }
  const captureRaw=Math.max(fallbackCapture,ranges[2]*2);
  const capture=captureRaw<=fallbackCapture*1.05?fallbackCapture:niceRangeCeil(captureRaw);
  return {ranges,capture,volPct,mode:Number.isFinite(volPct)?'価格＋1H変動':'価格プロファイル'};
}
function whaleCaptureRangeUsd(){ return whaleRangeDecision().capture; }
function whaleDisplayRangeOptions(){ return whaleRangeDecision().ranges; }
function loadWhaleRangeSlot(){
  const slotKey=`liqpulse_order_map_range_slot_${state.asset.symbol}`;
  const savedRaw=localStorage.getItem(slotKey);
  if(savedRaw!==null){
    const saved=Number(savedRaw);
    if(Number.isInteger(saved)&&saved>=0&&saved<=2) return saved;
  }
  // Migrate the old saved absolute range to the closest of the new AI-generated slots.
  const oldRaw=localStorage.getItem(`liqpulse_order_map_display_range_${state.asset.symbol}`);
  const opts=whaleDisplayRangeOptions();
  if(oldRaw!==null&&opts.length){
    const old=Number(oldRaw);
    if(Number.isFinite(old)){
      let best=1,bestDist=Infinity;
      opts.forEach((v,i)=>{const d=Math.abs(v-old);if(d<bestDist){best=i;bestDist=d;}});
      return best;
    }
  }
  return 1;
}
function whaleRangeSlot(){
  return Number.isInteger(state.whaleRangeSlot)&&state.whaleRangeSlot>=0&&state.whaleRangeSlot<=2?state.whaleRangeSlot:loadWhaleRangeSlot();
}
function loadWhaleChartZoom(){
  const key=`liqpulse_order_map_chart_zoom_${state.asset.symbol}`;
  const v=Number(localStorage.getItem(key));
  return WHALE_CHART_ZOOM_OPTIONS.includes(v)?v:1;
}
function whaleDisplayRangeUsd(){
  const opts=whaleDisplayRangeOptions(),slot=whaleRangeSlot();
  return opts[slot]??opts[1]??opts[0]??0;
}
function whaleChartZoom(){ return WHALE_CHART_ZOOM_OPTIONS.includes(state.whaleChartZoom)?state.whaleChartZoom:loadWhaleChartZoom(); }
function loadWhaleHistory(){
  try{
    let rawText=localStorage.getItem(whaleSnapshotKey());
    if(!rawText && state.asset.symbol==='BTC') rawText=localStorage.getItem('liqpulse_btc_whale_walls_v2');
    const raw=JSON.parse(rawText||'[]'), cutoff=Date.now()-WHALE_RETENTION_MS;
    return Array.isArray(raw)?raw.filter(x=>Number(x.ts)>=cutoff):[];
  }catch{return []}
}
function saveWhaleHistory(){ try{ localStorage.setItem(whaleSnapshotKey(),JSON.stringify(state.whaleHistory.slice(-360))); }catch{} }
function loadWhaleTracks(){
  try{
    let rawText=localStorage.getItem(whaleTrackKey());
    if(!rawText && state.asset.symbol==='BTC') rawText=localStorage.getItem('liqpulse_btc_whale_tracks_v2');
    const raw=JSON.parse(rawText||'[]'), cutoff=Date.now()-WHALE_RETENTION_MS;
    return Array.isArray(raw)?raw.filter(x=>Number(x.lastSeen||x.firstSeen)>=cutoff).slice(-320):[];
  }catch{return []}
}
function saveWhaleTracks(){ try{ localStorage.setItem(whaleTrackKey(),JSON.stringify(state.whaleTracks.slice(-320))); }catch{} }
function whaleRows(ob,spot){
  const capture=whaleCaptureRangeUsd(); if(!capture) return [];
  const asks=(ob?.wideAsks?.length?ob.wideAsks:ob?.asks)||[];
  const bids=(ob?.wideBids?.length?ob.wideBids:ob?.bids)||[];
  return [...asks.map(x=>({...x,side:'sell'})),...bids.map(x=>({...x,side:'buy'}))]
    .filter(x=>Number.isFinite(x.price)&&Number.isFinite(x.notional)&&Math.abs(x.price-spot)<=capture);
}
function selectWhaleWalls(rows){
  if(!rows.length) return [];
  const notionals=rows.map(x=>x.notional).sort((a,b)=>a-b);
  const q=notionals[Math.max(0,Math.floor((notionals.length-1)*.52))]||0;
  const threshold=Math.max(Number(whaleConfig()?.minNotional)||50000,q);
  return rows.filter(x=>x.notional>=threshold).sort((a,b)=>b.notional-a.notional).slice(0,64)
    .map(x=>({price:x.price,notional:x.notional,side:x.side,n:x.n||null}));
}
function whaleTier(notional){
  const t=whaleConfig()?.tierNotionals;
  const levels=Array.isArray(t)&&t.length===5?t:[100000000,50000000,25000000,10000000,5000000];
  if(notional>=levels[0]) return {label:'MEGA',width:10,alpha:.98};
  if(notional>=levels[1]) return {label:'XL',width:8,alpha:.94};
  if(notional>=levels[2]) return {label:'L',width:6.5,alpha:.90};
  if(notional>=levels[3]) return {label:'M',width:5,alpha:.84};
  if(notional>=levels[4]) return {label:'S',width:3.8,alpha:.76};
  return {label:'',width:2.4,alpha:.66};
}
function whaleStrongWallNotional(){ return Number(whaleConfig()?.strongWall)||10000000; }
function whaleQuantile(values,q=.8){
  const a=(values||[]).map(Number).filter(Number.isFinite).sort((x,y)=>x-y); if(!a.length) return 0;
  const pos=(a.length-1)*clamp(Number(q)||0,0,1),lo=Math.floor(pos),hi=Math.ceil(pos); if(lo===hi) return a[lo];
  return a[lo]+(a[hi]-a[lo])*(pos-lo);
}
function whaleImpactThreshold(items){
  const cfg=whaleConfig()||{}, vals=(items||[]).map(x=>Number(x.notional??x.maxNotional??x.lastNotional)).filter(Number.isFinite); if(!vals.length) return Infinity;
  const max=Math.max(...vals), q=whaleQuantile(vals,Number(cfg.impactQuantile)||.80), share=Number(cfg.impactShare)||.18;
  return Math.max(whaleStrongWallNotional(),q,max*share);
}
function whaleImpactZoneGap(range=whaleDisplayRangeUsd()){
  const cfg=whaleConfig()||{}, bucket=Math.max(Number(cfg.bucket)||1,Number.EPSILON);
  return Math.max(bucket*2.5,Math.max(1,Number(range)||1)*.055);
}
function mergeWhaleImpactZones(walls,spot,range=whaleCaptureRangeUsd()){
  const base=mergeWhaleBands(walls,spot).filter(x=>Math.abs(x.price-spot)<=range), gap=whaleImpactZoneGap(range), out=[];
  for(const side of ['sell','buy']){
    const arr=base.filter(x=>x.side===side).sort((a,b)=>a.price-b.price); let cur=null;
    for(const x of arr){
      if(cur && x.price-cur.lastPrice<=gap){
        const total=cur.notional+x.notional; cur.price=(cur.price*cur.notional+x.price*x.notional)/total; cur.notional=total; cur.maxNotional=Math.max(cur.maxNotional||0,x.maxNotional||0); cur.count=(cur.count||0)+(x.count||1); cur.lastPrice=x.price;
      }else{ if(cur) out.push(cur); cur={...x,lastPrice:x.price}; }
    }
    if(cur) out.push(cur);
  }
  return out.map(({lastPrice,...x})=>x);
}
function significantWhaleZones(walls,spot,range=whaleCaptureRangeUsd()){
  const zones=mergeWhaleImpactZones(walls,spot,range), maxPer=Math.max(1,Number(whaleConfig()?.impactMaxPerSide)||3), out=[];
  for(const side of ['sell','buy']){
    const arr=zones.filter(x=>x.side===side), threshold=whaleImpactThreshold(arr);
    out.push(...arr.filter(x=>x.notional>=threshold).sort((a,b)=>b.notional-a.notional).slice(0,maxPer));
  }
  return out.sort((a,b)=>b.notional-a.notional);
}
function significantWhaleTracks(tracks,spot,minP,maxP,displayRange,start,end){
  const cfg=whaleConfig()||{}, gap=whaleImpactZoneGap(displayRange), maxPer=Math.max(1,Number(cfg.impactMaxPerSide)||3), out=[];
  for(const side of ['sell','buy']){
    const arr=(tracks||[]).filter(t=>t.side===side&&(t.lastSeen||0)>=start&&t.price>=minP&&t.price<=maxP)
      .map(t=>({...t,notional:Number(t.maxNotional||t.lastNotional)||0,duration:Math.max(0,Math.min(end,t.endedAt||end)-Math.max(start,t.firstSeen||start))}));
    const threshold=whaleImpactThreshold(arr); const selected=[];
    const ranked=arr.filter(t=>t.notional>=threshold&&(t.duration>=20000||t.notional>=threshold*1.6))
      .sort((a,b)=>(b.notional*(1+Math.min(2,b.duration/600000)*.12))-(a.notional*(1+Math.min(2,a.duration/600000)*.12)));
    for(const t of ranked){ if(selected.some(x=>Math.abs(x.price-t.price)<gap)) continue; selected.push(t); if(selected.length>=maxPer) break; }
    out.push(...selected);
  }
  return out.sort((a,b)=>b.notional-a.notional);
}
function mergeWhaleBands(walls,spot){
  const cfg=whaleConfig(); if(!cfg) return [];
  const bucket=Math.max(Number(cfg.bucket)||1,Number.EPSILON), map=new Map();
  for(const w of walls){
    const price=Math.round(w.price/bucket)*bucket, key=`${w.side}:${price}`;
    const prev=map.get(key)||{side:w.side,price,notional:0,count:0,maxNotional:0};
    prev.notional+=w.notional; prev.count+=1; prev.maxNotional=Math.max(prev.maxNotional,w.notional); map.set(key,prev);
  }
  return [...map.values()].filter(x=>Math.abs(x.price-spot)<=whaleCaptureRangeUsd()).sort((a,b)=>b.notional-a.notional);
}
function whaleTrackTolerance(spot){
  const bucket=Number(whaleConfig()?.bucket)||1;
  return Math.max(bucket*.35,spot*.00022);
}
function updateWhaleTracks(walls,spot,now){
  if(!state.whaleTracks.length) state.whaleTracks=loadWhaleTracks();
  const tolerance=whaleTrackTolerance(spot), matched=new Set();
  for(const wall of walls){
    let best=-1,bestDist=Infinity;
    for(let i=0;i<state.whaleTracks.length;i++){
      const t=state.whaleTracks[i]; if(t.side!==wall.side||t.endedAt) continue;
      const d=Math.abs(t.price-wall.price); if(d<=tolerance&&d<bestDist){best=i;bestDist=d;}
    }
    if(best>=0){
      const t=state.whaleTracks[best]; matched.add(t.id); const samples=(t.samples||1)+1;
      t.price=(t.price*(samples-1)+wall.price)/samples; t.lastSeen=now; t.lastNotional=wall.notional; t.maxNotional=Math.max(t.maxNotional||0,wall.notional); t.samples=samples;
    }else{
      const t={id:`${state.asset.symbol}-${wall.side}-${now}-${Math.round(wall.price*100)}`,side:wall.side,price:wall.price,firstSeen:now,lastSeen:now,endedAt:null,lastNotional:wall.notional,maxNotional:wall.notional,samples:1};
      state.whaleTracks.push(t); matched.add(t.id);
    }
  }
  for(const t of state.whaleTracks){ if(!t.endedAt&&!matched.has(t.id)&&now-(t.lastSeen||0)>25000) t.endedAt=t.lastSeen||now; }
  const cutoff=now-WHALE_RETENTION_MS;
  state.whaleTracks=state.whaleTracks.filter(t=>(t.lastSeen||t.firstSeen)>=cutoff).slice(-320); saveWhaleTracks();
}
function recordWhaleSnapshot(ob){
  if(!state.asset.orderMap||!ob) return;
  const now=Date.now(); if(state.whaleLastBookAt && now-state.whaleLastBookAt<9000) return; state.whaleLastBookAt=now;
  const spot=state.latestPrice||state.ctxByCoin.get(state.asset.symbol)?.markPx; if(!Number.isFinite(spot)) return;
  const walls=selectWhaleWalls(whaleRows(ob,spot)); updateWhaleTracks(walls,spot,now);
  const prev=state.whaleHistory[state.whaleHistory.length-1];
  if(!prev||now-prev.ts>=30000){ state.whaleHistory.push({ts:now,spot,walls:walls.slice(0,24)}); state.whaleHistory=state.whaleHistory.filter(x=>now-x.ts<=WHALE_RETENTION_MS).slice(-360); saveWhaleHistory(); }
}
function whaleMetrics(){
  if(!state.asset.orderMap) return null;
  const ob=state.orderbook, spot=state.latestPrice||state.ctxByCoin.get(state.asset.symbol)?.markPx; if(!ob||!Number.isFinite(spot)) return null;
  const rows=whaleRows(ob,spot), walls=selectWhaleWalls(rows), impactZones=significantWhaleZones(walls,spot,whaleCaptureRangeUsd());
  const sells=impactZones.filter(x=>x.side==='sell'&&x.price>=spot), buys=impactZones.filter(x=>x.side==='buy'&&x.price<=spot);
  const sellTotal=sells.reduce((a,x)=>a+x.notional,0), buyTotal=buys.reduce((a,x)=>a+x.notional,0);
  const nearestSell=[...sells].sort((a,b)=>a.price-b.price)[0]||null, nearestBuy=[...buys].sort((a,b)=>b.price-a.price)[0]||null;
  return {spot,walls,impactZones,sells,buys,sellTotal,buyTotal,nearestSell,nearestBuy};
}
function whalePricePoints(start,end){
  const symbol=state.asset.symbol;
  const snaps=loadMarketSnapshots(symbol).filter(x=>x.ts>=start&&x.ts<=end&&Number.isFinite(x.price)).map(x=>({ts:x.ts,price:x.price}));
  const trades=state.tradeEvents.filter(t=>t.ts>=start&&t.ts<=end&&Number.isFinite(t.price)).map(t=>({ts:t.ts,price:t.price}));
  const pts=[...snaps,...trades]; if(Number.isFinite(state.latestPrice)) pts.push({ts:end,price:state.latestPrice});
  return pts.sort((a,b)=>a.ts-b.ts);
}
function whaleCandles(start,end){
  if(state.asset.source==='mexc'&&state.externalCandles.length){
    return state.externalCandles.filter(c=>c.ts>=start&&c.ts<=end).sort((a,b)=>a.ts-b.ts);
  }
  const pts=whalePricePoints(start,end), bucket=5*60*1000, map=new Map();
  for(const p of pts){ const k=Math.floor(p.ts/bucket)*bucket; let c=map.get(k); if(!c){c={ts:k,o:p.price,h:p.price,l:p.price,c:p.price};map.set(k,c);} else {c.h=Math.max(c.h,p.price);c.l=Math.min(c.l,p.price);c.c=p.price;} }
  return [...map.values()].sort((a,b)=>a.ts-b.ts);
}
function formatDuration(ms){
  if(!Number.isFinite(ms)||ms<0) return '—'; if(ms<60000) return `${Math.max(1,Math.round(ms/1000))}s`; if(ms<3600000) return `${Math.round(ms/60000)}m`; return `${(ms/3600000).toFixed(ms<10800000?1:0)}h`;
}
function activeTrackForWall(wall,spot){
  const tol=Math.max(whaleTrackTolerance(spot),whaleImpactZoneGap(whaleDisplayRangeUsd())*.65), tracks=state.whaleTracks.length?state.whaleTracks:loadWhaleTracks();
  return tracks.filter(t=>!t.endedAt&&t.side===wall.side&&Math.abs(t.price-wall.price)<=tol).sort((a,b)=>Math.abs(a.price-wall.price)-Math.abs(b.price-wall.price))[0]||null;
}
function renderWhaleCanvas(metrics){
  const canvas=$('whaleCanvas'); if(!canvas||!state.asset.orderMap) return;
  const zoom=whaleChartZoom(), baseH=window.matchMedia('(max-width: 600px)').matches?390:420;
  canvas.style.height=`${Math.round(baseH*zoom)}px`;
  const rect=canvas.getBoundingClientRect(),dpr=Math.min(2,window.devicePixelRatio||1),w=Math.max(320,Math.floor(rect.width)),h=Math.max(350,Math.floor(rect.height));
  if(canvas.width!==Math.floor(w*dpr)||canvas.height!==Math.floor(h*dpr)){canvas.width=Math.floor(w*dpr);canvas.height=Math.floor(h*dpr);}
  const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);ctx.fillStyle='#070d15';ctx.fillRect(0,0,w,h);
  const pad={l:10,r:64,t:22,b:32},iw=w-pad.l-pad.r,ih=h-pad.t-pad.b;
  const spot=metrics?.spot||state.latestPrice||state.ctxByCoin.get(state.asset.symbol)?.markPx;if(!Number.isFinite(spot)) return;
  const end=Date.now(),lookback=state.whaleLookbackMs||3*60*60*1000,start=end-lookback,displayRange=whaleDisplayRangeUsd(),minP=spot-displayRange,maxP=spot+displayRange;
  const py=p=>pad.t+(maxP-p)/(maxP-minP)*ih,tx=ts=>pad.l+clamp((ts-start)/lookback,0,1)*iw,currentY=py(spot);
  const placedLabelYs=[currentY], labelGap=state.asset.symbol==='SOL'?13:15;
  const canPlaceLabel=(y,gap=labelGap)=>{if(y<pad.t+10||y>pad.t+ih-5||placedLabelYs.some(v=>Math.abs(v-y)<gap))return false;placedLabelYs.push(y);return true;};
  ctx.font='9px -apple-system,BlinkMacSystemFont,sans-serif';
  for(let i=0;i<=4;i++){ const y=pad.t+ih*i/4,p=maxP-(maxP-minP)*i/4;ctx.strokeStyle='#172131';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(pad.l,y);ctx.lineTo(pad.l+iw,y);ctx.stroke();ctx.fillStyle='#65768b';ctx.fillText(priceFmt(p),pad.l+iw+6,y+3); }
  for(let i=0;i<=4;i++){ const x=pad.l+iw*i/4,ts=start+lookback*i/4,d=new Date(ts);ctx.strokeStyle='rgba(28,42,61,.62)';ctx.beginPath();ctx.moveTo(x,pad.t);ctx.lineTo(x,pad.t+ih);ctx.stroke();ctx.fillStyle='#596b82';ctx.font='8px -apple-system,BlinkMacSystemFont,sans-serif';ctx.fillText(d.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}),Math.max(pad.l,x-15),h-8); }
  ctx.fillStyle='#71839a';ctx.font='8px -apple-system,BlinkMacSystemFont,sans-serif';ctx.fillText(`表示 ±$${rangeCompact(displayRange)} / 収集 ±$${rangeCompact(whaleCaptureRangeUsd())} / ${Math.round(lookback/3600000)}H`,pad.l+4,pad.t+10);
  const rawTracks=state.whaleTracks.length?state.whaleTracks:loadWhaleTracks(), tracks=significantWhaleTracks(rawTracks,spot,minP,maxP,displayRange,start,end);
  const maxN=Math.max(1,...tracks.map(t=>t.maxNotional||t.lastNotional||0),...(metrics?.impactZones||[]).map(x=>x.notional||0));
  for(const t of tracks){
    const x1=tx(Math.max(start,t.firstSeen)),x2=tx(Math.min(end,t.endedAt||end)),y=py(t.price),n=t.maxNotional||t.lastNotional||0,active=!t.endedAt,tier=whaleTier(n),strength=Math.sqrt(n/maxN),base=t.side==='sell'?[255,72,100]:[37,211,154];
    if(active&&n>=whaleStrongWallNotional()){ctx.strokeStyle=`rgba(${base[0]},${base[1]},${base[2]},${Math.min(.18,.05+.12*strength)})`;ctx.lineWidth=Math.max(12,tier.width*2.2);ctx.beginPath();ctx.moveTo(x1,y);ctx.lineTo(x2,y);ctx.stroke();}
    ctx.strokeStyle=`rgba(${base[0]},${base[1]},${base[2]},${Math.min(1,(active?.32:.10)+tier.alpha*.58*strength)})`;ctx.lineWidth=active?Math.max(tier.width,2.2+7.5*strength):Math.max(1.3,tier.width*.45);if(!active)ctx.setLineDash([7,5]);ctx.beginPath();ctx.moveTo(x1,y);ctx.lineTo(x2,y);ctx.stroke();ctx.setLineDash([]);
    if(active&&x2-x1>34&&n>=Math.max(Number(whaleConfig()?.minNotional)||0,whaleStrongWallNotional()/2)&&canPlaceLabel(y)){ctx.fillStyle=t.side==='sell'?'rgba(255,126,145,.94)':'rgba(96,230,187,.94)';ctx.font='7px -apple-system,BlinkMacSystemFont,sans-serif';ctx.fillText(`${tier.label?`${tier.label} `:''}${money(n)}`,Math.min(Math.max(pad.l+4,x2-54),pad.l+iw-52),y-5);}
  }
  const currentBands=(metrics?.impactZones||significantWhaleZones(metrics?.walls||[],spot,displayRange)).filter(b=>Math.abs(b.price-spot)<=displayRange).slice(0,6);
  for(const b of currentBands){
    const y=py(b.price),tier=whaleTier(b.notional),base=b.side==='sell'?[255,72,100]:[37,211,154],x1=pad.l+iw*.73,x2=pad.l+iw;
    ctx.strokeStyle=`rgba(${base[0]},${base[1]},${base[2]},${tier.alpha})`;ctx.lineWidth=tier.width;ctx.beginPath();ctx.moveTo(x1,y);ctx.lineTo(x2,y);ctx.stroke();
    if(b.notional>=whaleStrongWallNotional()&&canPlaceLabel(y)){ctx.fillStyle=`rgba(${base[0]},${base[1]},${base[2]},.96)`;ctx.font='7px -apple-system,BlinkMacSystemFont,sans-serif';ctx.fillText(`${money(b.notional)} @ ${priceFmt(b.price).replace('$','')}`,Math.max(pad.l,x1-92),y-5);}
  }
  const candles=whaleCandles(start,end),candleW=Math.max(2,Math.min(7,iw/Math.max(20,candles.length)*.62));
  for(const c of candles){ if(c.h<minP||c.l>maxP)continue;const x=tx(c.ts+2.5*60*1000),up=c.c>=c.o,col=up?'#35c99b':'#e45770';ctx.strokeStyle=col;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(x,py(c.h));ctx.lineTo(x,py(c.l));ctx.stroke();const y1=py(Math.max(c.o,c.c)),y2=py(Math.min(c.o,c.c));ctx.fillStyle=col;ctx.fillRect(x-candleW/2,y1,candleW,Math.max(1,y2-y1)); }
  ctx.strokeStyle='#ffbd42';ctx.lineWidth=1.6;ctx.setLineDash([6,4]);ctx.beginPath();ctx.moveTo(pad.l,currentY);ctx.lineTo(pad.l+iw,currentY);ctx.stroke();ctx.setLineDash([]);
  ctx.font='bold 9px -apple-system,BlinkMacSystemFont,sans-serif';ctx.fillStyle='#ffbd42';ctx.fillText(`現在 ${priceFmt(spot).replace('$','')}`,pad.l+5,Math.max(pad.t+12,currentY-7));
  const badgeText=priceFmt(spot),tw=ctx.measureText(badgeText).width,bx=pad.l+iw+3,by=clamp(currentY-9,pad.t,pad.t+ih-18);ctx.fillStyle='#c88d24';ctx.fillRect(bx,by,Math.min(tw+10,pad.r-4),18);ctx.fillStyle='#08101b';ctx.font='bold 8px -apple-system,BlinkMacSystemFont,sans-serif';ctx.fillText(badgeText,bx+4,by+12);
}
function renderWhaleControls(){
  const cfg=whaleConfig(); if(!cfg) return;
  const decision=whaleRangeDecision(), ranges=decision.ranges, slot=whaleRangeSlot();
  const names=['近距離','標準','広域'];
  document.querySelectorAll('[data-whale-range-slot]').forEach((b,i)=>{
    const v=ranges[i]??ranges[1]??ranges[0]??0;
    b.textContent=`±${rangeCompact(v)}`;
    b.dataset.whaleRange=String(v);
    b.classList.toggle('active',i===slot);
    b.setAttribute('aria-label',`${names[i]||'価格幅'} ${priceFmt(v)}`);
    b.title=`AI ${names[i]||'価格幅'}: ±${priceFmt(v).replace('$','')}`;
  });
  document.querySelectorAll('[data-whale-hours]').forEach(b=>b.classList.toggle('active',Number(b.dataset.whaleHours)===Math.round((state.whaleLookbackMs||10800000)/3600000)));
  document.querySelectorAll('[data-whale-zoom]').forEach(b=>b.classList.toggle('active',Number(b.dataset.whaleZoom)===whaleChartZoom()));
}
function renderWhaleOrderMap(){
  const card=$('btcWhaleCard'); if(!card) return; if(!state.asset.orderMap){card.classList.add('hidden');return;} card.classList.remove('hidden');
  const cfg=whaleConfig(), rangeDecision=whaleRangeDecision(), displayRange=whaleDisplayRangeUsd(), zoom=whaleChartZoom();
  setText('whaleTitle',cfg.title); setText('whaleSubtitle',cfg.subtitle); setText('whaleLegendPrice',`${state.asset.symbol}価格`);
  setText('whaleHint',state.asset.source==='mexc'?'赤=重要な大口売り指値、緑=重要な大口買い指値。MEXC Futures公開L2板は広く収集しつつ、画面には局面を動かし得る上位の壁だけを表示します。小規模板は内部分析には残します。消失壁は約定・キャンセルの断定ではなく、実清算ラインでもありません。':'赤=重要な大口売り指値、緑=重要な大口買い指値。L2板は広く収集しつつ、画面には局面を動かし得る上位の壁だけを表示します。横方向の長さ=継続時間、太さ=最大注文額。小規模板は内部分析には残します。CoinGlass等の取引所横断データではなくHyperliquid L2由来です。');
  const canvas=$('whaleCanvas'); if(canvas) canvas.setAttribute('aria-label',`${state.asset.symbol} 大口注文マップ`);
  const volText=Number.isFinite(rangeDecision.volPct)?` / 1H変動 ${(rangeDecision.volPct*100).toFixed(2)}%`:'';
  setText('whaleRangeStatus',`AI ${rangeDecision.mode}: 表示 ±$${rangeCompact(displayRange)} / 収集 ±$${rangeCompact(rangeDecision.capture)}${volText} / ${zoom===1?'標準':zoom===1.35?'拡大':'最大'} / 重要壁のみ表示`);
  setText('whaleSellTotalMeta',`AI収集範囲 ±$${rangeCompact(rangeDecision.capture)}`); setText('whaleBuyTotalMeta',`AI収集範囲 ±$${rangeCompact(rangeDecision.capture)}`);
  renderWhaleControls();
  const m=whaleMetrics(); if(!m){setText('whalePressureBadge','取得中');setText('whaleBookAge','—');setText('whaleOrderList','');return;}
  const fmt=x=>x?priceFmt(x.price):'—'; setText('whaleNearestSell',fmt(m.nearestSell)); setText('whaleNearestBuy',fmt(m.nearestBuy));
  setText('whaleNearestSellMeta',m.nearestSell?`+${((m.nearestSell.price/m.spot-1)*100).toFixed(2)}% / ${money(m.nearestSell.notional)}`:'—'); setText('whaleNearestBuyMeta',m.nearestBuy?`${((m.nearestBuy.price/m.spot-1)*100).toFixed(2)}% / ${money(m.nearestBuy.notional)}`:'—'); setText('whaleSellTotal',money(m.sellTotal)); setText('whaleBuyTotal',money(m.buyTotal));
  const total=m.sellTotal+m.buyTotal,sellPct=total?m.sellTotal/total:.5,badge=$('whalePressureBadge'); let label=total?'重要壁均衡':'局面級なし',tone='neutral'; if(total&&sellPct>=.62){label='重要売り壁優勢';tone='down';}else if(total&&sellPct<=.38){label='重要買い壁優勢';tone='up';} if(badge){badge.textContent=label;badge.className=`signal-badge ${tone}`;} setText('whaleBookAge',state.asset.source==='mexc'?'MEXC LIVE + 履歴':'LIVE + 履歴');
  let insight=total?'局面級の大口壁はおおむね拮抗しています。':'現在の収集範囲内に、局面を動かす水準の重要大口壁はありません。小規模板は画面から除外し、内部分析だけに保持しています。'; if(total&&sellPct>=.62) insight=`重要な上側売り壁が優勢 (${(sellPct*100).toFixed(0)}%)。壁が長時間残るか、吸収・消失するかを監視。`; else if(total&&sellPct<=.38) insight=`重要な下側買い壁が優勢 (${((1-sellPct)*100).toFixed(0)}%)。買い支えの継続時間と壁の消失を監視。`;
  if(m.nearestSell&&Math.abs(m.nearestSell.price/m.spot-1)<.004) insight+=' 直上0.4%以内に重要売り壁あり。'; if(m.nearestBuy&&Math.abs(m.nearestBuy.price/m.spot-1)<.004) insight+=' 直下0.4%以内に重要買い壁あり。';
  const bands=m.impactZones||[],topSell=bands.filter(x=>x.side==='sell'&&x.price>m.spot).sort((a,b)=>b.notional-a.notional)[0],topBuy=bands.filter(x=>x.side==='buy'&&x.price<m.spot).sort((a,b)=>b.notional-a.notional)[0]; if(topSell) insight+=` 強い上壁 ${priceFmt(topSell.price)} (${money(topSell.notional)})。`; if(topBuy) insight+=` 強い下壁 ${priceFmt(topBuy.price)} (${money(topBuy.notional)})。`; setText('whaleInsight',insight);
  const list=$('whaleOrderList'); if(list){list.textContent='';const top=[...(m.impactZones||[])].sort((a,b)=>b.notional-a.notional).slice(0,6),max=Math.max(1,...top.map(x=>x.notional));if(!top.length){const empty=document.createElement('div');empty.className='whale-empty';empty.textContent='現在、表示対象となる局面級の大口壁はありません。';list.appendChild(empty);}for(const x of top){const row=document.createElement('div');row.className=`whale-order-row ${x.side}`;const p=document.createElement('b');p.textContent=priceFmt(x.price);const bar=document.createElement('div');bar.className='bar';const i=document.createElement('i');i.style.width=`${Math.max(8,100*x.notional/max)}%`;bar.appendChild(i);const val=document.createElement('strong');val.textContent=money(x.notional);const ds=document.createElement('small');const d=(x.price/m.spot-1)*100,tr=activeTrackForWall(x,m.spot);ds.textContent=`${d>=0?'+':''}${d.toFixed(2)}% · ${tr?formatDuration(Date.now()-tr.firstSeen):'new'}`;row.append(p,bar,val,ds);list.appendChild(row);}}
  renderWhaleCanvas(m);
}
function setWhaleLookback(hours){ const h=[1,3,6].includes(Number(hours))?Number(hours):3; state.whaleLookbackMs=h*60*60*1000; renderWhaleOrderMap(); }
function setWhaleRangeSlot(slot){
  if(!whaleConfig()) return;
  const n=Number(slot); if(!Number.isInteger(n)||n<0||n>2) return;
  state.whaleRangeSlot=n; state.whaleDisplayRangeUsd=null;
  try{localStorage.setItem(`liqpulse_order_map_range_slot_${state.asset.symbol}`,String(n));}catch{}
  renderWhaleOrderMap();
}
function setWhaleDisplayRange(range){
  // Backward-compatible helper for old cached HTML. Convert an absolute value to the nearest current AI slot.
  const n=Number(range),opts=whaleDisplayRangeOptions(); if(!opts.length) return;
  let slot=1,best=Infinity; opts.forEach((v,i)=>{const d=Math.abs(v-n);if(d<best){best=d;slot=i;}}); setWhaleRangeSlot(slot);
}
function setWhaleChartZoom(value){
  const z=WHALE_CHART_ZOOM_OPTIONS.includes(Number(value))?Number(value):1; state.whaleChartZoom=z;
  try{localStorage.setItem(`liqpulse_order_map_chart_zoom_${state.asset.symbol}`,String(z));}catch{} renderWhaleOrderMap();
}

function sp500ChangeClass(v){
  if(!Number.isFinite(v)) return 'flat';
  if(v>=2) return 'up5'; if(v>=1) return 'up4'; if(v>=0.5) return 'up3'; if(v>=0.15) return 'up2'; if(v>0.02) return 'up1';
  if(v<=-2) return 'down5'; if(v<=-1) return 'down4'; if(v<=-0.5) return 'down3'; if(v<=-0.15) return 'down2'; if(v<-0.02) return 'down1';
  return 'flat';
}
function sp500SnapshotKey(){ return 'liqpulse_sp500_breadth_snapshots'; }
function loadSp500Snapshots(){
  try{
    const raw=JSON.parse(localStorage.getItem(sp500SnapshotKey())||'[]');
    return Array.isArray(raw)?raw:[];
  }catch{return [];}
}
function saveSp500Snapshot(data){
  if(!data?.rows?.length) return;
  const a=sp500Analytics(data,false);
  if(!a) return;
  const now=Date.now();
  let arr=loadSp500Snapshots().filter(x=>now-Number(x.ts||0)<=6*60*60*1000);
  const last=arr[arr.length-1];
  if(!last || now-Number(last.ts||0)>=60000){
    arr.push({ts:now,advPct:a.advPct,equalWeighted:a.equalWeighted,capWeighted:a.capWeighted,health:a.healthScore});
    if(arr.length>360) arr=arr.slice(-360);
    try{localStorage.setItem(sp500SnapshotKey(),JSON.stringify(arr));}catch{}
  }
}
function sp500Snapshot15m(){
  const arr=loadSp500Snapshots();
  if(!arr.length) return null;
  const target=Date.now()-15*60*1000;
  let best=null;
  for(const x of arr){ if(Number(x.ts)<=target) best=x; else break; }
  return best;
}
function sp500Analytics(data=state.sp500Map,withHistory=true){
  const rows=data?.rows;
  if(!Array.isArray(rows)||!rows.length) return null;
  const valid=rows.filter(r=>Number.isFinite(Number(r.change)));
  if(!valid.length) return null;
  const adv=valid.filter(r=>Number(r.change)>0.02).length;
  const dec=valid.filter(r=>Number(r.change)<-0.02).length;
  const flat=valid.length-adv-dec;
  const advPct=adv/valid.length;
  const equalWeighted=valid.reduce((a,r)=>a+Number(r.change),0)/valid.length;
  const capWeighted=Number(data.summary?.capWeightedChange);

  const groups=new Map();
  for(const r of valid){
    const sec=r.sector||'Other';
    if(!groups.has(sec)) groups.set(sec,[]);
    groups.get(sec).push(r);
  }
  const sectorStats=[];
  for(const [sector,list] of groups){
    const cap=list.reduce((a,r)=>a+(Number(r.marketCap)>0?Number(r.marketCap):0),0);
    const weighted=cap?list.reduce((a,r)=>a+(Number(r.marketCap)>0?Number(r.marketCap):0)*Number(r.change),0)/cap:list.reduce((a,r)=>a+Number(r.change),0)/list.length;
    sectorStats.push({sector,change:weighted});
  }
  const positiveSectors=sectorStats.filter(x=>x.change>0.05).length;
  const negativeSectors=sectorStats.filter(x=>x.change<-0.05).length;
  const sectorPct=sectorStats.length?positiveSectors/sectorStats.length:0.5;

  const byTicker=new Map(valid.map(r=>[String(r.ticker).toUpperCase(),r]));
  const megaGroups=[['AAPL'],['MSFT'],['NVDA'],['AMZN'],['META'],['GOOG','GOOGL'],['TSLA']];
  const megaMoves=[];
  for(const names of megaGroups){
    const vals=names.map(n=>byTicker.get(n)).filter(Boolean).map(r=>Number(r.change)).filter(Number.isFinite);
    if(vals.length) megaMoves.push(vals.reduce((a,b)=>a+b,0)/vals.length);
  }
  const mega7=megaMoves.length?megaMoves.reduce((a,b)=>a+b,0)/megaMoves.length:NaN;
  const capVsEqual=Number.isFinite(capWeighted)?capWeighted-equalWeighted:NaN;

  let score=50;
  score += (advPct-.5)*56;
  score += clamp(equalWeighted/2,-1,1)*12;
  if(Number.isFinite(capWeighted)) score += clamp(capWeighted/2,-1,1)*10;
  score += (sectorPct-.5)*18;
  if(Number.isFinite(mega7)) score += clamp(mega7/2,-1,1)*4;
  const healthScore=Math.round(clamp(score,0,100));

  let breadthRegime='均衡';
  if(healthScore>=72) breadthRegime='広範な上昇';
  else if(healthScore>=60) breadthRegime='上昇優勢';
  else if(healthScore<=28) breadthRegime='広範な下落';
  else if(healthScore<=40) breadthRegime='下落優勢';

  let concentration='均衡型';
  if(Number.isFinite(capVsEqual)){
    if(capVsEqual>=0.35) concentration='大型株主導';
    else if(capVsEqual<=-0.35) concentration='中小型まで強い';
  }

  let change15m=null;
  if(withHistory){
    const old=sp500Snapshot15m();
    if(old){
      change15m={advPct:advPct-Number(old.advPct),health:healthScore-Number(old.health),capWeighted:Number.isFinite(capWeighted)?capWeighted-Number(old.capWeighted):NaN};
    }
  }
  const sortedSectors=[...sectorStats].sort((a,b)=>b.change-a.change);
  const strongestSector=sortedSectors[0]||null, weakestSector=sortedSectors[sortedSectors.length-1]||null;
  const capContribution=(r)=>Number.isFinite(Number(r.marketCap))&&Number.isFinite(Number(r.change))?Number(r.marketCap)*Number(r.change):0;
  const contributors=[...valid].sort((a,b)=>capContribution(b)-capContribution(a));
  const topLeader=contributors[0]||null, topLaggard=contributors[contributors.length-1]||null;
  const dispersion=Math.sqrt(valid.reduce((a,r)=>a+Math.pow(Number(r.change)-equalWeighted,2),0)/valid.length);
  return {adv,dec,flat,total:valid.length,advPct,equalWeighted,capWeighted,capVsEqual,mega7,megaCount:megaMoves.length,sectorStats,positiveSectors,negativeSectors,sectorCount:sectorStats.length,sectorPct,healthScore,breadthRegime,concentration,change15m,strongestSector,weakestSector,topLeader,topLaggard,dispersion};
}
function renderSp500Command(){
  const card=$('sp500CommandCard');
  if(!card) return;
  if(state.asset.symbol!=='SP500') return;
  const a=sp500Analytics();
  if(!a){
    setText('sp500CommandAction','判定待ち'); setText('sp500CommandConfidence','信頼度 —'); setText('sp500HealthScore','—'); setText('sp500HealthLabel','取得中');
    setText('sp500AdvPct','—'); setText('sp500AdvMeta','—'); setText('sp500EqualWeighted','—'); setText('sp500WeightDivergence','—'); setText('sp500Mega7','—'); setText('sp500Mega7Meta','—'); setText('sp500PositiveSectors','—'); setText('sp500SectorMeta','—');
    setText('sp500StrongSector','—'); setText('sp500StrongSectorMeta','—'); setText('sp500WeakSector','—'); setText('sp500WeakSectorMeta','—'); setText('sp500TopLeader','—'); setText('sp500TopLeaderMeta','—'); setText('sp500TopLaggard','—'); setText('sp500TopLaggardMeta','—'); setText('sp500RiskStrip','市場内部リスクを分析中');
    setText('sp500CommandAdvice','S&P 500構成銘柄データを取得後に総合判断します。');
    return;
  }
  const d=decisionMetrics();
  const delta=d.up-d.down;
  let action='見送り', tone='neutral';
  if(d.confidence>=58 && Math.abs(delta)>=16){ action=delta>0?'LONG候補':'SHORT候補'; tone=delta>0?'up':'down'; }
  if(d.confidence>=74 && Math.abs(delta)>=28){ action=delta>0?'LONG優先':'SHORT優先'; }
  setText('sp500CommandAction',action); setText('sp500CommandConfidence',`信頼度 ${d.confidence}%`);
  const actionEl=$('sp500CommandAction'); if(actionEl) actionEl.className=tone==='up'?'green':tone==='down'?'red':'';
  const badge=$('sp500CommandBadge'); if(badge){ badge.textContent=a.breadthRegime; badge.className=`signal-badge ${a.healthScore>=60?'up':a.healthScore<=40?'down':'neutral'}`; }
  setText('sp500HealthScore',`${a.healthScore}/100`); setText('sp500HealthLabel',a.concentration);
  setText('sp500AdvPct',`${(a.advPct*100).toFixed(1)}%`); setText('sp500AdvMeta',`${a.adv}上昇 / ${a.dec}下落 / ${a.flat}横ばい`);
  setText('sp500EqualWeighted',`${a.equalWeighted>=0?'+':''}${a.equalWeighted.toFixed(2)}%`); setText('sp500WeightDivergence',Number.isFinite(a.capVsEqual)?`時価加重との差 ${a.capVsEqual>=0?'+':''}${a.capVsEqual.toFixed(2)}pt`:'—');
  setText('sp500Mega7',Number.isFinite(a.mega7)?`${a.mega7>=0?'+':''}${a.mega7.toFixed(2)}%`:'—'); setText('sp500Mega7Meta',`${a.megaCount}/7社取得`);
  setText('sp500PositiveSectors',`${a.positiveSectors}/${a.sectorCount}`); setText('sp500SectorMeta',a.change15m?`健全度15分 ${a.change15m.health>=0?'+':''}${a.change15m.health}`:'TradingView業種分類');
  setText('sp500StrongSector',a.strongestSector?.sector||'—'); setText('sp500StrongSectorMeta',a.strongestSector?`${a.strongestSector.change>=0?'+':''}${a.strongestSector.change.toFixed(2)}%`:'—');
  setText('sp500WeakSector',a.weakestSector?.sector||'—'); setText('sp500WeakSectorMeta',a.weakestSector?`${a.weakestSector.change>=0?'+':''}${a.weakestSector.change.toFixed(2)}%`:'—');
  setText('sp500TopLeader',a.topLeader?.ticker||'—'); setText('sp500TopLeaderMeta',a.topLeader?`${Number(a.topLeader.change)>=0?'+':''}${Number(a.topLeader.change).toFixed(2)}%`:'—');
  setText('sp500TopLaggard',a.topLaggard?.ticker||'—'); setText('sp500TopLaggardMeta',a.topLaggard?`${Number(a.topLaggard.change)>=0?'+':''}${Number(a.topLaggard.change).toFixed(2)}%`:'—');
  let risk='内部は概ね安定', riskTone='up';
  if(a.advPct<0.45 && Number.isFinite(a.capWeighted) && a.capWeighted>0.15){ risk='指数上昇に対して参加率が低い：大型株依存に注意'; riskTone='down'; }
  else if(Number.isFinite(a.capVsEqual) && a.capVsEqual>0.45){ risk='時価総額加重が等ウェイトを大幅上回る：大型株偏重'; riskTone='neutral'; }
  else if(a.dispersion>2.2){ risk='銘柄間のばらつきが大きい：指数だけで判断しにくい'; riskTone='neutral'; }
  else if(a.healthScore>=68 && a.advPct>=0.62){ risk='広い銘柄参加を伴う上昇：内部構造は良好'; riskTone='up'; }
  else if(a.healthScore<=35 && a.advPct<=0.40){ risk='広範囲の下落：下方向リスクが高い'; riskTone='down'; }
  const rs=$('sp500RiskStrip'); if(rs){rs.textContent=risk;rs.className=`sp500-risk-strip ${riskTone}`;}

  let advice=`${a.breadthRegime}。${a.concentration}です。`;
  if(a.healthScore>=65 && a.advPct>=0.60) advice+=' 上昇参加率が高く、指数上昇の中身も比較的強い状態です。';
  else if(a.healthScore<=35 && a.advPct<=0.40) advice+=' 下落参加率が高く、幅広い売りが出ています。';
  else if(Number.isFinite(a.capVsEqual) && a.capVsEqual>0.35) advice+=' 指数は大型株に支えられているため、見た目ほど全面高ではありません。';
  else if(Number.isFinite(a.capVsEqual) && a.capVsEqual<-0.35) advice+=' 大型株以外にも買いが広がっており、市場内部は指数以上に強めです。';
  if(action==='見送り') advice+=' AI総合条件はまだエントリー基準未満です。';
  else advice+=` AI総合では${action}です。`;
  setText('sp500CommandAdvice',advice);
}

function renderSp500Map(){
  const grid=$('sp500MapGrid'); if(!grid) return;
  grid.textContent='';
  if(state.asset.symbol!=='SP500') return;
  const data=state.sp500Map;
  if(!data?.rows?.length){
    const d=document.createElement('div'); d.className='sp500-map-error'; d.textContent='S&P 500構成銘柄データを取得できません。数分後に再取得します。'; grid.appendChild(d);
    setText('sp500MapStatus','取得待ち'); setText('sp500Mood','—'); setText('sp500Breadth','—'); setText('sp500Weighted','—'); return;
  }
  const rows=data.rows.slice(0,state.sp500MapLimit||80);
  const adv=Number(data.summary?.advancers)||0, dec=Number(data.summary?.decliners)||0, flat=Number(data.summary?.unchanged)||0;
  const weighted=Number(data.summary?.capWeightedChange);
  let mood='均衡'; if(Number.isFinite(weighted)){ if(weighted>=0.7) mood='強い上昇'; else if(weighted>=0.2) mood='上昇優勢'; else if(weighted<=-0.7) mood='強い下落'; else if(weighted<=-0.2) mood='下落優勢'; }
  setText('sp500Mood',mood); setText('sp500Breadth',`${adv} / ${dec}${flat?` / ${flat}`:''}`); setText('sp500Weighted',Number.isFinite(weighted)?`${weighted>=0?'+':''}${weighted.toFixed(2)}%`:'—');
  const age=Math.max(0,Math.round((Date.now()-Number(data.timestamp||Date.now()))/1000)); setText('sp500MapStatus',`${data.rows.length}銘柄 / ${age<60?'更新直後':Math.round(age/60)+'分前'}`);
  const groups=new Map();
  for(const r of rows){ const sec=r.sector||'Other'; if(!groups.has(sec)) groups.set(sec,[]); groups.get(sec).push(r); }
  const sorted=[...groups.entries()].sort((a,b)=>b[1].reduce((x,r)=>x+(Number(r.marketCap)||0),0)-a[1].reduce((x,r)=>x+(Number(r.marketCap)||0),0));
  for(const [sector,list] of sorted){
    const cap=list.reduce((a,r)=>a+(Number(r.marketCap)||0),0); const w=cap?list.reduce((a,r)=>a+(Number(r.marketCap)||0)*Number(r.change||0),0)/cap:0;
    const sec=document.createElement('section'); sec.className='map-sector';
    const head=document.createElement('div'); head.className='map-sector-head'; const hb=document.createElement('b'); hb.textContent=sector; const hs=document.createElement('span'); hs.textContent=`${w>=0?'+':''}${w.toFixed(2)}%`; hs.className=w>0.02?'green':w<-0.02?'red':''; head.append(hb,hs); sec.appendChild(head);
    const tiles=document.createElement('div'); tiles.className='map-sector-tiles';
    list.forEach((r,i)=>{ const t=document.createElement('div'); const rank=Number(r.rank)||999; t.className=`map-tile ${sp500ChangeClass(Number(r.change))} ${rank<=10?'rank-xl':rank<=35?'rank-lg':'rank-md'}`; t.title=`${r.ticker} ${r.description||''} ${Number(r.change)>=0?'+':''}${Number(r.change).toFixed(2)}%`; const b=document.createElement('b'); b.textContent=r.ticker; const sm=document.createElement('small'); const ch=Number(r.change); sm.textContent=Number.isFinite(ch)?`${ch>=0?'+':''}${ch.toFixed(2)}%`:'—'; t.append(b,sm); tiles.appendChild(t); });
    sec.appendChild(tiles); grid.appendChild(sec);
  }
  renderDecisionEngine();
}
async function fetchSp500Map(){
  const epoch=currentEpoch(), symbol=state.asset.symbol;
  if(symbol!=='SP500'){ if(requestStillCurrent(epoch,symbol)){state.sp500Map=null;renderSp500Map();} return; }
  const relayBase=(CONFIG.relayBase||'').replace(/\/$/,'');
  if(!relayBase){ renderSp500Map(); return; }
  setText('sp500MapStatus','市場データ取得中');
  try{
    const raw=await fetchJsonWithTimeout(`${relayBase}/sp500-map`,CONFIG.relayTimeoutMs+5000);
    if(raw?.error || !Array.isArray(raw?.rows)) throw new Error(raw?.error||'invalid map response');
    if(!requestStillCurrent(epoch,symbol)) return;
    state.sp500Map=raw; markFresh('sp500',Number(raw.timestamp)||Date.now()); state.sourceErrors.sp500=null; saveSp500Snapshot(raw); renderSp500Map(); renderQuickView(); renderBase();
  }catch(err){
    if(!requestStillCurrent(epoch,symbol)) return;
    console.warn('sp500-map',err); state.sourceErrors.sp500=String(err?.message||err); state.sp500Map=null; renderSp500Map(); renderQuickView(); renderBase();
  }
}


async function fetchHeatmap(){
  const epoch=currentEpoch(), asset={...state.asset}, symbol=asset.symbol;
  if(!asset.heatmap){
    if(requestStillCurrent(epoch,symbol)){ setText('statusHeatmap','対象外'); setText('statusHeatmapRoute','—'); state.heatmap=null; renderHeatmap(); renderLiqBias(); renderQuickView(); }
    return;
  }
  setText('statusHeatmap','取得中'); setText('statusHeatmapRoute','接続中');
  const direct=CONFIG.heatmapDirect+encodeURIComponent(symbol), relayBase=(CONFIG.relayBase||'').replace(/\/$/,'');
  const routes=[]; if(relayBase) routes.push({name:'Relay',url:`${relayBase}/heatmap/${encodeURIComponent(symbol)}`}); routes.push({name:'Direct',url:direct});
  let lastErr=null;
  for(const route of routes){
    try{
      const raw=await fetchJsonWithTimeout(route.url,CONFIG.relayTimeoutMs);
      if(!requestStillCurrent(epoch,symbol)) return;
      const normalized=normalizeHeatmap(raw);
      if(!normalized.levels.length) throw new Error('No recognized liquidation levels');
      state.heatmap=normalized; markFresh('heatmap',Number(normalized.timestamp)||Date.now()); state.sourceErrors.heatmap=null; saveHeatmapSnapshot();
      setText('statusHeatmap','正常'); setText('statusHeatmapRoute',route.name);
      renderHeatmap(); renderLiqBias(); renderPressure(); renderDecisionEngine(); renderQuickView(); renderBase(); return;
    }catch(err){ lastErr=err; if(requestStillCurrent(epoch,symbol)) console.warn('heatmap route failed',route.name,err); }
  }
  if(!requestStillCurrent(epoch,symbol)) return;
  state.heatmap=null; state.sourceErrors.heatmap=String(lastErr?.message||lastErr||'unavailable'); setText('statusHeatmap','実データ未取得'); setText('statusHeatmapRoute',relayBase?'Relay / Direct確認済み':'Direct確認済み');
  renderHeatmap(); renderLiqBias(); renderRadar(); renderPressure(); renderDecisionEngine(); renderQuickView(); renderBase();
}


function normalizeHeatmap(raw){
  const levels=[];
  const liveSpot=state.latestPrice || state.ctxByCoin.get(state.asset.symbol)?.markPx;
  const sourceSpot=Number(raw?.spot_at_compute ?? raw?.spotAtCompute ?? raw?._meta?.spot_at_compute);
  const spot=Number.isFinite(liveSpot)?liveSpot:(Number.isFinite(sourceSpot)?sourceSpot:NaN);

  const pushLevel=(obj,forcedSide='')=>{
    if(!obj || typeof obj!=='object') return;
    const price=Number(obj.price ?? obj.liqPrice ?? obj.liquidationPrice ?? obj.level ?? obj.px ?? obj.price_level ?? obj.priceLevel);
    const notional=Number(obj.notional_usd ?? obj.notionalUsd ?? obj.notional ?? obj.sizeUsd ?? obj.size_usd ?? obj.usd ?? obj.value ?? obj.totalNotional ?? obj.total_notional ?? obj.size);
    if(!Number.isFinite(price) || !Number.isFinite(notional) || notional<=0) return;
    let side=String(forcedSide || obj.side || obj.direction || obj.positionSide || obj.position_side || obj.type || '').toLowerCase();
    if(side.includes('short') || side==='s') side='short';
    else if(side.includes('long') || side==='l') side='long';
    else side=Number.isFinite(spot)?(price>spot?'short':'long'):'';
    if(side!=='long' && side!=='short') return;
    const walletCount=Number(obj.wallet_count ?? obj.walletCount ?? obj.wallets ?? obj.accounts ?? obj.account_count ?? obj.accountCount);
    const sourceDistancePct=Number(obj.distance_pct ?? obj.distancePct ?? obj.distance_percent ?? obj.distancePercent);
    levels.push({
      price,
      notional,
      side,
      walletCount:Number.isFinite(walletCount)?walletCount:null,
      sourceDistancePct:Number.isFinite(sourceDistancePct)?sourceDistancePct:null
    });
  };

  // HyperPerps whale-heatmap v4: explicit parser first.
  // Example: {spot_at_compute, updated_at, longs:[...], shorts:[...]}
  if(Array.isArray(raw?.longs)) raw.longs.forEach(x=>pushLevel(x,'long'));
  if(Array.isArray(raw?.shorts)) raw.shorts.forEach(x=>pushLevel(x,'short'));
  if(Array.isArray(raw?.data?.longs)) raw.data.longs.forEach(x=>pushLevel(x,'long'));
  if(Array.isArray(raw?.data?.shorts)) raw.data.shorts.forEach(x=>pushLevel(x,'short'));

  // Generic fallback for future/alternate schemas.
  const maybePush=(obj,sideHint='')=>{
    if(!obj || typeof obj!=='object' || Array.isArray(obj)) return;
    pushLevel(obj,sideHint);
    const keys=Object.keys(obj);
    if(keys.length===1){
      const kp=Number(keys[0]), kv=Number(obj[keys[0]]);
      if(Number.isFinite(kp)&&Number.isFinite(kv)&&kv>0){
        const inferred=sideHint || (Number.isFinite(spot)?(kp>spot?'short':'long'):'');
        if(inferred==='long'||inferred==='short') levels.push({price:kp,notional:kv,side:inferred,walletCount:null,sourceDistancePct:null});
      }
    }
  };

  const walk=(node,hint='',depth=0)=>{
    if(depth>8 || node==null) return;
    if(Array.isArray(node)){
      if(node.length>=2 && Number.isFinite(Number(node[0])) && Number.isFinite(Number(node[1]))){
        const p=Number(node[0]), n=Number(node[1]);
        let side=String(node[2]??hint??'').toLowerCase();
        if(side.includes('short')||side==='s') side='short';
        else if(side.includes('long')||side==='l') side='long';
        else side=Number.isFinite(spot)?(p>spot?'short':'long'):'';
        if(n>0 && (side==='long'||side==='short')) levels.push({price:p,notional:n,side,walletCount:null,sourceDistancePct:null});
        return;
      }
      node.forEach(x=>walk(x,hint,depth+1));
      return;
    }
    if(typeof node!=='object') return;
    maybePush(node,hint);
    for(const [k,v] of Object.entries(node)){
      const kh=k.toLowerCase(); let next=hint;
      if(kh.includes('short')) next='short';
      if(kh.includes('long')) next='long';
      if(kh.includes('liq')||kh.includes('cluster')||kh.includes('level')||kh.includes('bucket')||kh.includes('heatmap')||typeof v==='object') walk(v,next,depth+1);
    }
  };
  walk(raw);

  const merged=new Map();
  for(const x of levels){
    if(!Number.isFinite(x.price)||!Number.isFinite(x.notional)||x.notional<=0) continue;
    if(x.side!=='long'&&x.side!=='short') continue;
    const key=`${x.side}:${x.price.toFixed(8)}`;
    const prev=merged.get(key);
    if(!prev || x.notional>prev.notional) merged.set(key,x);
  }

  const tsRaw=Number(raw?.updated_at ?? raw?.timestamp ?? raw?.updatedAt ?? raw?.time ?? raw?.generated_at ?? raw?.generatedAt ?? raw?._meta?.as_of);
  let ts;
  if(Number.isFinite(tsRaw)) ts=tsRaw<1e12?tsRaw*1000:tsRaw;
  else {
    const iso=Date.parse(raw?._meta?.as_of ?? raw?.as_of ?? '');
    ts=Number.isFinite(iso)?iso:Date.now();
  }
  return {levels:[...merged.values()],timestamp:ts,raw,sourceSpot:Number.isFinite(sourceSpot)?sourceSpot:null};
}
function snapshotKey(symbol){ return `liqpulse_heatmap_snapshots_${symbol}`; }
function loadSnapshots(symbol){
  try{
    const raw=JSON.parse(localStorage.getItem(snapshotKey(symbol))||'[]');
    const cutoff=Date.now()-CONFIG.snapshotRetentionMs;
    return Array.isArray(raw)?raw.filter(x=>Number(x?.ts)>=cutoff):[];
  }catch{return []}
}
function aggregateRange(levels,spot,rangePct=CONFIG.radarRangePct){
  let short=0,long=0;
  for(const x of levels||[]){
    const d=(x.price/spot)-1;
    if(x.side==='short' && d>0 && d<=rangePct) short+=x.notional;
    if(x.side==='long' && d<0 && -d<=rangePct) long+=x.notional;
  }
  return {short,long};
}
function saveHeatmapSnapshot(){
  const spot=state.latestPrice || state.ctxByCoin.get(state.asset.symbol)?.markPx;
  if(!Number.isFinite(spot)||!state.heatmap?.levels?.length) return;
  const agg=aggregateRange(state.heatmap.levels,spot);
  const list=loadSnapshots(state.asset.symbol);
  const last=list[list.length-1];
  if(last && Date.now()-last.ts<45000) return;
  list.push({ts:Date.now(),short:agg.short,long:agg.long,spot});
  try{localStorage.setItem(snapshotKey(state.asset.symbol),JSON.stringify(list.slice(-360)));}catch{}
}
function momentum15m(side,current){
  const list=loadSnapshots(state.asset.symbol);
  if(!list.length||!Number.isFinite(current)) return null;
  const target=Date.now()-15*60*1000;
  let prev=null,best=Infinity;
  for(const x of list){ const d=Math.abs(x.ts-target); if(d<best){best=d;prev=x;} }
  if(!prev || best>10*60*1000) return null;
  const base=Number(prev[side]);
  if(!Number.isFinite(base)||base<=0) return null;
  return (current-base)/base;
}
function radarMetrics(){
  const spot=state.latestPrice || state.ctxByCoin.get(state.asset.symbol)?.markPx;
  const lv=state.heatmap?.levels||[];
  if(!Number.isFinite(spot)||!lv.length) return null;
  const shorts=lv.filter(x=>x.side==='short'&&x.price>spot).sort((a,b)=>a.price-b.price);
  const longs=lv.filter(x=>x.side==='long'&&x.price<spot).sort((a,b)=>b.price-a.price);
  const totals=aggregateRange(lv,spot);
  return {spot,nearestShort:shorts[0]||null,nearestLong:longs[0]||null,totals,
    shortMomentum:momentum15m('short',totals.short),longMomentum:momentum15m('long',totals.long)};
}
function fmtMomentum(v){
  if(!Number.isFinite(v)) return '15分変化 —';
  const sign=v>0?'+':''; return `15分変化 ${sign}${(v*100).toFixed(1)}%`;
}
function renderRadar(){
  const r=radarMetrics();
  if(r){
    setText('nearestShortLabel','↑ 最寄りショート清算'); setText('nearestLongLabel','↓ 最寄りロング清算');
    setText('short5Label','上側清算総額 ±5%'); setText('long5Label','下側清算総額 ±5%');
    const ns=r.nearestShort,nl=r.nearestLong;
    setText('nearestShort',ns?priceFmt(ns.price):'—');
    setText('nearestShortMeta',ns?`${(distPct(ns.price,r.spot)*100).toFixed(2)}% · ${money(ns.notional)}${ns.walletCount?` · ${ns.walletCount} wallets`:''}`:'—');
    setText('nearestLong',nl?priceFmt(nl.price):'—');
    setText('nearestLongMeta',nl?`${Math.abs(distPct(nl.price,r.spot)*100).toFixed(2)}% · ${money(nl.notional)}${nl.walletCount?` · ${nl.walletCount} wallets`:''}`:'—');
    setText('short5Total',money(r.totals.short)); setText('long5Total',money(r.totals.long));
    setText('shortMomentum',fmtMomentum(r.shortMomentum)); setText('longMomentum',fmtMomentum(r.longMomentum));
    const total=r.totals.short+r.totals.long; const shortPct=total?r.totals.short/total:.5;
    let badge='均衡', reason='±5%の清算想定額はおおむね均衡しています。';
    if(shortPct>=.62){badge='上側優勢';reason=`上側ショート清算が±5%内の${(shortPct*100).toFixed(0)}%を占めています。上抜け時のスクイーズ燃料が相対的に大きい状態です。`;}
    else if(shortPct<=.38){badge='下側優勢';reason=`下側ロング清算が±5%内の${((1-shortPct)*100).toFixed(0)}%を占めています。下抜け時のカスケード燃料が相対的に大きい状態です。`;}
    setText('radarBiasBadge',badge); setText('radarReason',reason); return;
  }
  const ez=estimatedTriggerZones();
  if(ez){
    setText('nearestShortLabel','↑ 推定上側反応帯'); setText('nearestLongLabel','↓ 推定下側反応帯');
    setText('short5Label','売り板厚 上位10'); setText('long5Label','買い板厚 上位10');
    setText('nearestShort',ez.up?priceFmt(ez.up.price):'—'); setText('nearestLong',ez.down?priceFmt(ez.down.price):'—');
    setText('nearestShortMeta',ez.up?`+${(ez.up.distance*100).toFixed(2)}% · 板 ${money(ez.up.notional)}`:'—');
    setText('nearestLongMeta',ez.down?`-${(ez.down.distance*100).toFixed(2)}% · 板 ${money(ez.down.notional)}`:'—');
    setText('short5Total',money(ez.askTotal)); setText('long5Total',money(ez.bidTotal));
    setText('shortMomentum','実清算ではありません'); setText('longMomentum','実清算ではありません');
    const side=ez.bidPct>=.58?'買い板優勢':ez.askPct>=.58?'売り板優勢':'板均衡';
    setText('radarBiasBadge','L2推定');
    setText('radarReason',`${side}。実清算データがないため、${state.asset.source==='mexc'?'MEXC Futures':'Hyperliquid'}のL2板から近い大口反応帯を推定表示しています。清算価格・利確価格を直接観測したものではありません。`); return;
  }
  ['nearestShort','nearestLong','short5Total','long5Total'].forEach(id=>setText(id,'—'));
  setText('nearestShortMeta','—');setText('nearestLongMeta','—');setText('shortMomentum','—');setText('longMomentum','—');setText('radarBiasBadge','分析待ち');setText('radarReason','清算またはL2板データ取得後に表示します。');
}
function impactfulLiquidationLevels(levels,spot,side){
  const arr=(levels||[]).filter(x=>x.side===side&&Number.isFinite(x.price)&&Number.isFinite(x.notional)&&((side==='long'&&x.price<spot)||(side==='short'&&x.price>spot)));
  if(!arr.length) return [];
  const vals=arr.map(x=>x.notional),max=Math.max(...vals),threshold=Math.max(whaleQuantile(vals,.72),max*.15);
  const important=arr.filter(x=>x.notional>=threshold), byDistance=[...important].sort((a,b)=>Math.abs(a.price-spot)-Math.abs(b.price-spot)), bySize=[...important].sort((a,b)=>b.notional-a.notional), picked=[];
  for(const x of [...byDistance.slice(0,1),...bySize]){ if(!picked.includes(x)) picked.push(x); if(picked.length>=state.clusterDepth) break; }
  return picked.sort((a,b)=>side==='short'?a.price-b.price:b.price-a.price);
}
function selectVisibleLevels(){
  const spot=state.latestPrice || state.ctxByCoin.get(state.asset.symbol)?.markPx;
  const lv=state.heatmap?.levels||[];
  if(!Number.isFinite(spot)) return {spot,above:[],below:[]};
  const below=impactfulLiquidationLevels(lv,spot,'long');
  const above=impactfulLiquidationLevels(lv,spot,'short');
  return {spot,above,below};
}

function renderHeatmap(){
  const host=$('heatmap'), note=$('heatmapNotice'), summary=$('clusterSummary');
  host.textContent=''; note.classList.add('hidden'); summary.classList.add('hidden'); summary.textContent=''; renderRadar();
  if(!state.asset.heatmap){
    if(state.asset.source==='mexc') note.textContent=`${state.asset.symbol}はMEXC公開APIで実清算クラスターが提供されないため、MEXC L2板の推定反応帯・Taker・OI・Funding・Index乖離を使って分析します。推定反応帯は強制清算価格ではありません。`;
    else note.textContent=`${state.asset.symbol}の実清算クラスターは上流ソースから取得できませんでした。取得可能な価格・OI・Funding・Taker・L2板を使って分析します。`;
    note.classList.remove('hidden'); setText('heatmapAge',state.asset.source==='mexc'?'MEXC L2':'未対応'); return;
  }
  if(!state.heatmap?.levels?.length){
    if(state.orderbook){
      note.textContent='実清算クラスターは取得できていません。代わりにHyperliquid L2板から推定反応帯を算出し、上部のQuick ViewとRadarに表示しています。推定反応帯は強制清算価格ではありません。';
      setText('heatmapAge','L2代替');
    }else{
      note.textContent=CONFIG.relayBase?'実清算データを取得できませんでした。Relay / Directを再試行しつつ、L2板取得後は推定反応帯へ自動フォールバックします。':'SafariのCORS制限でDirect取得できない場合があります。標準Relayの接続を確認してください。';
      setText('heatmapAge','取得待ち');
    }
    note.classList.remove('hidden'); return;
  }
  const {spot,above,below}=selectVisibleLevels();
  if(!above.length&&!below.length){
    note.textContent='清算データ形式は取得できましたが、現在値の上下に有効なクラスターを認識できません。'; note.classList.remove('hidden'); return;
  }
  const max=Math.max(1,...below.map(x=>x.notional),...above.map(x=>x.notional));
  const topShort=[...above].sort((a,b)=>b.notional-a.notional)[0];
  const topLong=[...below].sort((a,b)=>b.notional-a.notional)[0];
  const nearestShort=above[0]||null, nearestLong=below[0]||null;
  const addRows=(arr,side)=>arr.forEach(x=>{
    const d=distPct(x.price,spot),row=document.createElement('div');row.className='liq-row';
    let label='',labelClass='';
    if(x===nearestShort||x===nearestLong){label='一次トリガー';labelClass='trigger';}
    if(x===topShort){label=label?`${label} / 最大`:'上値の壁';labelClass='major-short';}
    if(x===topLong){label=label?`${label} / 最大`:'主要クラスター';labelClass='major-long';}
    const priceBox=document.createElement('div');priceBox.className='liq-price';
    const pb=document.createElement('b');pb.textContent=priceFmt(x.price);
    const ps=document.createElement('small');ps.textContent=`${Number.isFinite(d)?(d*100).toFixed(2)+'%':''}${x.walletCount?` · ${x.walletCount} wallets`:''}`;
    priceBox.append(pb,ps);
    if(label){const em=document.createElement('em');em.className=`liq-label ${labelClass}`;em.textContent=label;priceBox.appendChild(em);}
    const track=document.createElement('div');track.className='liq-track';const fill=document.createElement('div');fill.className=`liq-fill ${side}`;fill.style.width=`${clamp(x.notional/max*100,2,100)}%`;track.appendChild(fill);
    const value=document.createElement('div');value.className=`liq-value ${side==='short'?'green':'red'}`;value.textContent=money(x.notional);
    row.append(priceBox,track,value);host.appendChild(row);
  });
  addRows([...above].reverse(),'short');
  const cur=document.createElement('div'); cur.className='current-line'; cur.textContent=`現在 ${priceFmt(spot)}`; host.appendChild(cur);
  addRows(below,'long');

  if(topShort||topLong){
    summary.textContent='';
    const mk=(label,value,cls)=>{const d=document.createElement('div'),sp=document.createElement('span'),b=document.createElement('b');sp.textContent=label;b.className=cls;b.textContent=value;d.append(sp,b);return d;};
    summary.append(mk('上側最大',topShort?`${priceFmt(topShort.price)} · ${money(topShort.notional)}`:'—','green'),mk('下側最大',topLong?`${priceFmt(topLong.price)} · ${money(topLong.notional)}`:'—','red'));
    summary.classList.remove('hidden');
  }

  const age=Math.max(0,Date.now()-state.heatmap.timestamp);
  setText('heatmapAge',age<120000?'LIVE':`${Math.round(age/60000)}分前`);
  renderRadar();
}

function liquidationBias(){
  const spot=state.latestPrice || state.ctxByCoin.get(state.asset.symbol)?.markPx;
  const lv=state.heatmap?.levels||[];
  if(!Number.isFinite(spot)||!lv.length) return null;
  let short=0,long=0;
  for(const x of lv){
    const d=Math.abs(x.price-spot)/spot;
    if(d>CONFIG.liqBiasRangePct) continue;
    const w=Math.exp(-d*22);
    if(x.side==='short'&&x.price>spot) short+=x.notional*w;
    if(x.side==='long'&&x.price<spot) long+=x.notional*w;
  }
  const total=short+long;
  return total?{short,long,total,shortPct:short/total,longPct:long/total}:null;
}
function renderLiqBias(){
  const b=liquidationBias();
  if(!b){ setText('shortLiqPct','—'); setText('longLiqPct','—'); $('shortLiqBar').style.width='50%'; $('longLiqBar').style.width='50%'; return; }
  setText('shortLiqPct',(b.shortPct*100).toFixed(1)+'%'); setText('longLiqPct',(b.longPct*100).toFixed(1)+'%');
  $('shortLiqBar').style.width=(b.shortPct*100)+'%'; $('longLiqBar').style.width=(b.longPct*100)+'%';
}


function normalizeRatioPoint(value){
  if(!value || typeof value!=='object') return null;
  let long=Number(value.longAccount ?? value.long_account ?? value.longPosition ?? value.long_position);
  let short=Number(value.shortAccount ?? value.short_account ?? value.shortPosition ?? value.short_position);
  const ratio=Number(value.longShortRatio ?? value.long_short_ratio ?? value.ratio);
  if(!Number.isFinite(long) || !Number.isFinite(short)){
    if(Number.isFinite(ratio) && ratio>=0){ long=ratio/(1+ratio); short=1/(1+ratio); }
  }
  if(!Number.isFinite(long)||!Number.isFinite(short)) return null;
  if(long>1 || short>1){ const total=long+short; if(total>0){long/=total; short/=total;} }
  const total=long+short;
  if(total<=0) return null;
  long/=total; short/=total;
  return {long,short,ratio:short>0?long/short:Infinity,timestamp:Number(value.timestamp)||Date.now()};
}

async function fetchPositioning(){
  const epoch=currentEpoch(), asset={...state.asset}, symbol=asset.symbol;
  if(!asset.positioning){ if(requestStillCurrent(epoch,symbol)){state.positioning=null;setText('statusPositioning','対象外');renderPositioning();renderQuickView();} return; }
  const relayBase=(CONFIG.relayBase||'').replace(/\/$/,'');
  if(!relayBase){ if(requestStillCurrent(epoch,symbol)){state.positioning=null;setText('statusPositioning','Relay未設定');renderPositioning();renderQuickView();} return; }
  setText('statusPositioning','取得中');
  try{
    const raw=await fetchJsonWithTimeout(`${relayBase}/positioning/${encodeURIComponent(symbol)}`,CONFIG.relayTimeoutMs);
    if(!requestStillCurrent(epoch,symbol)) return;
    const global=normalizeRatioPoint(raw?.global), topAccounts=normalizeRatioPoint(raw?.topAccounts), topPositions=normalizeRatioPoint(raw?.topPositions);
    if(!global&&!topAccounts&&!topPositions) throw new Error(raw?.error||'No ratio data');
    state.positioning={global,topAccounts,topPositions,sources:raw?.sources||{},timestamp:Number(raw?.timestamp)||Date.now(),errors:raw?.errors||[]};
    markFresh('positioning',state.positioning.timestamp); state.sourceErrors.positioning=null; setText('statusPositioning','正常'); renderPositioning(); renderPressure(); renderDecisionEngine(); renderQuickView(); renderBase();
  }catch(err){
    if(!requestStillCurrent(epoch,symbol)) return;
    console.warn('positioning',err); state.sourceErrors.positioning=String(err?.message||err); state.positioning=null; setText('statusPositioning','取得失敗'); renderPositioning(); renderPressure(); renderDecisionEngine(); renderQuickView(); renderBase();
  }
}

function setRatioView(prefix,point){
  const l=$(prefix+'Long'), s=$(prefix+'Short'), lb=$(prefix+'LongBar'), sb=$(prefix+'ShortBar'), r=$(prefix+'Ratio');
  if(!point){ if(l)l.textContent='取得不可'; if(s)s.textContent=''; if(r)r.textContent='L/S —'; if(lb)lb.style.width='50%'; if(sb)sb.style.width='50%'; return; }
  if(l)l.textContent=(point.long*100).toFixed(1)+'%'; if(s)s.textContent=(point.short*100).toFixed(1)+'%';
  if(r)r.textContent=`L/S ${Number.isFinite(point.ratio)?point.ratio.toFixed(2):'∞'}`;
  if(lb)lb.style.width=(point.long*100)+'%'; if(sb)sb.style.width=(point.short*100)+'%';
}
function renderPositioning(){
  const p=state.positioning;
  setRatioView('globalLs',p?.global||null); setRatioView('topAccountLs',p?.topAccounts||null); setRatioView('topPositionLs',p?.topPositions||null);
  const ta=$('topAccountRow'),tp=$('topPositionRow');
  if(ta) ta.classList.toggle('hidden',!p?.topAccounts);
  if(tp) tp.classList.toggle('hidden',!p?.topPositions);
  const age=$('positioningAge');
  if(age){
    if(!p) age.textContent='取得待ち';
    else { const ms=Math.max(0,Date.now()-p.timestamp); age.textContent=ms<120000?'5分データ':`${Math.round(ms/60000)}分前`; }
  }
  const note=$('positioningNote');
  if(note){
    if(!p){ note.textContent='公開Long/Short統計は現在取得できません。方向判定は他の取得済みデータだけで計算します。'; }
    else{
      const gs=p.sources?.global||'不明';
      const extras=[p.sources?.topAccounts&&'Top Account',p.sources?.topPositions&&'Top Position'].filter(Boolean);
      note.textContent=`全口座: ${gs}${extras.length?` / ${extras.join('・')}`:' / Top Trader統計なし'}。Hyperliquid建玉比率ではありません。`;
    }
  }
}

function freshnessScore(source,fullMs,staleMs){
  const age=ageMs(source);
  if(!Number.isFinite(age)) return 0;
  if(age<=fullMs) return 1;
  if(age>=staleMs) return 0;
  return 1-(age-fullMs)/(staleMs-fullMs);
}
function dataQualityMetrics(){
  const asset=state.asset;
  const ctx=state.ctxByCoin.get(asset.symbol);
  const flow=flowTotals();
  const items=[];
  const add=(name,weight,score)=>items.push({name,weight,score:clamp(Number(score)||0,0,1)});
  add('価格',18,Number.isFinite(state.latestPrice||ctx?.markPx)?Math.max(freshnessScore('ws',30000,120000),freshnessScore('meta',60000,240000)):0);
  add('OI/Funding',16,ctx&&Number.isFinite(ctx.openInterestUsd)?freshnessScore('meta',60000,240000):0);
  add('Taker',14,flow.total>0?freshnessScore('ws',30000,120000):0);
  add('L2板',14,state.orderbook?freshnessScore('orderbook',25000,120000):0);
  if(asset.positioning) add('L/S',12,state.positioning?freshnessScore('positioning',120000,600000):0);
  if(asset.heatmap){
    const liqScore=state.heatmap?.levels?.length?freshnessScore('heatmap',120000,600000):(state.orderbook?0.55*freshnessScore('orderbook',25000,120000):0);
    add('清算/反応帯',18,liqScore);
  }
  if(asset.symbol==='SP500') add('市場内部',26,state.sp500Map?.rows?.length?freshnessScore('sp500',180000,900000):0);
  if(asset.source==='mexc') add('Index乖離',12,ctx&&Number.isFinite(ctx.basis)?freshnessScore('meta',60000,240000):0);
  const total=items.reduce((a,x)=>a+x.weight,0)||1;
  const score=Math.round(items.reduce((a,x)=>a+x.weight*x.score,0)/total*100);
  const missing=items.filter(x=>x.score<0.25).map(x=>x.name);
  const label=score>=85?'非常に良好':score>=70?'良好':score>=55?'一部欠損':score>=35?'低め':'不足';
  return {score,label,items,missing};
}
function decisionMetrics(){
  const flowRaw=flowTotals(), buyShare=flowRaw.total?flowRaw.buy/flowRaw.total:NaN;
  const liq=liquidationBias();
  const pos=state.positioning?.topPositions || state.positioning?.global || null;
  const ctx=state.ctxByCoin.get(state.asset.symbol);
  const funding=Number(ctx?.funding);
  const mm=marketMomentum();
  const radar=radarMetrics();
  const ez=estimatedTriggerZones();
  const parts=[];
  const add=(name,score,weight,reason='')=>{
    if(!Number.isFinite(score)||weight<=0) return;
    parts.push({name,score:clamp(score,-1,1),weight,reason});
  };

  if(liq){
    const score=clamp((liq.shortPct-liq.longPct)*1.7,-1,1);
    add('清算偏り',score,.22,`${score>=0?'上側ショート':'下側ロング'}清算燃料 ${(Math.max(liq.shortPct,liq.longPct)*100).toFixed(0)}%`);
  }
  if(Number.isFinite(buyShare)){
    const score=clamp((buyShare-.5)*2,-1,1);
    add('Taker',score,.22,`成行 ${score>=0?'買い':'売り'} ${(Math.max(buyShare,1-buyShare)*100).toFixed(0)}%`);
  }
  if(pos){
    // Treat public L/S primarily as crowding/squeeze risk rather than directional conviction.
    const score=clamp((pos.short-pos.long)*2,-1,1);
    add('L/S',score,.10,`口座比 ${pos.ratio.toFixed(2)} / ${pos.long>=pos.short?'Long':'Short'} ${(Math.max(pos.long,pos.short)*100).toFixed(1)}%`);
  }
  if(Number.isFinite(funding)){
    const score=clamp(-funding/0.0003,-1,1);
    add('Funding',score,.08,`Funding ${pct(funding,4)}`);
  }
  if(state.asset.source==='mexc'&&Number.isFinite(Number(ctx?.basis))){
    const basis=Number(ctx.basis), score=clamp(-basis/0.006,-1,1);
    add('Index乖離',score,.10,`MEXC/Index乖離 ${basis>=0?'+':''}${(basis*100).toFixed(2)}%`);
  }
  if(mm&&Number.isFinite(mm.priceChange)&&Number.isFinite(mm.oiChange)){
    const priceStrength=clamp(Math.abs(mm.priceChange)/0.012,0,1), oiStrength=clamp(Math.abs(mm.oiChange)/0.025,0,1);
    let score=Math.sign(mm.priceChange||0)*priceStrength*(mm.oiChange>=0?(0.45+0.55*oiStrength):(0.25+0.25*oiStrength));
    add('OI/価格',score,.12,`15分 価格 ${mm.priceChange>=0?'+':''}${(mm.priceChange*100).toFixed(2)}% / OI ${mm.oiChange>=0?'+':''}${(mm.oiChange*100).toFixed(2)}%`);
  }
  if(ez){
    const score=clamp((ez.bidPct-ez.askPct)*2,-1,1);
    add('L2板',score,.14,`近傍板 ${score>=0?'買い':'売り'} ${(Math.max(ez.bidPct,ez.askPct)*100).toFixed(0)}%`);
  }
  if(radar?.nearestShort&&radar?.nearestLong){
    const su=Math.max(Math.abs(distPct(radar.nearestShort.price,radar.spot)),0.0005), ld=Math.max(Math.abs(distPct(radar.nearestLong.price,radar.spot)),0.0005);
    const sf=radar.nearestShort.notional/su, lf=radar.nearestLong.notional/ld, total=sf+lf;
    if(total>0) add('最寄り清算',clamp((sf-lf)/total,-1,1),.12,'最寄り清算の距離×規模');
  }
  if(state.asset.symbol==='SP500'){
    const sp=sp500Analytics();
    if(sp){
      add('市場参加率',clamp((sp.advPct-.5)*2,-1,1),.22,`上昇参加率 ${(sp.advPct*100).toFixed(0)}%`);
      add('等ウェイト',clamp(sp.equalWeighted/1.5,-1,1),.12,`等ウェイト ${sp.equalWeighted>=0?'+':''}${sp.equalWeighted.toFixed(2)}%`);
      if(Number.isFinite(sp.capWeighted)) add('時価加重',clamp(sp.capWeighted/1.5,-1,1),.10,`時価加重 ${sp.capWeighted>=0?'+':''}${sp.capWeighted.toFixed(2)}%`);
      add('業種参加',clamp((sp.sectorPct-.5)*2,-1,1),.10,`上昇業種 ${sp.positiveSectors}/${sp.sectorCount}`);
    }
  }

  const weight=parts.reduce((a,x)=>a+x.weight,0);
  const avg=weight?parts.reduce((a,x)=>a+x.score*x.weight,0)/weight:0;
  const up=clamp(50+avg*50,0,100), down=100-up;
  const quality=dataQualityMetrics();
  const strength=Math.abs(avg);
  const confidence=Math.round(clamp(quality.score*(0.12+0.88*strength),0,100));
  let label='中立',tone='neutral';
  if(up>=67){label='上方向優勢';tone='up';}
  else if(up>=57){label='やや上方向';tone='up';}
  else if(up<=33){label='下方向優勢';tone='down';}
  else if(up<=43){label='やや下方向';tone='down';}
  const reasons=[...parts].sort((a,b)=>Math.abs(b.score*b.weight)-Math.abs(a.score*a.weight)).filter(x=>x.reason).slice(0,4).map(x=>x.reason);
  return {up,down,avg,confidence,label,tone,reasons,used:parts.map(x=>x.name),mm,quality,parts};
}
function quickDecision(){
  const d=decisionMetrics(), radar=radarMetrics(), delta=d.up-d.down, edge=Math.abs(delta);
  let dominance='均衡',dominanceTone='neutral';
  if(delta>=10){dominance='LONG優勢';dominanceTone='up';} else if(delta<=-10){dominance='SHORT優勢';dominanceTone='down';}
  let action='見送り',actionTone='neutral';
  if(d.confidence>=52&&edge>=18){action=delta>0?'LONG候補':'SHORT候補';actionTone=delta>0?'up':'down';}
  if(d.confidence>=72&&edge>=32){action=delta>0?'LONG優先':'SHORT優先';}
  const flow=flowTotals(),bp=flow.total?flow.buy/flow.total:.5,mm=d.mm;
  let alert='通常',alertTone='neutral';
  if(flow.total>0&&(bp>=.85||bp<=.15)){alert=bp>.5?'買いフロー急増':'売りフロー急増';alertTone=bp>.5?'up':'down';}
  if(mm&&(Number.isFinite(mm.priceChange)&&Math.abs(mm.priceChange)>=.012||Number.isFinite(mm.oiChange)&&Math.abs(mm.oiChange)>=.025)){alert='急変警戒';alertTone=delta>=0?'up':'down';}
  if(d.quality.score<45){alert='データ不足';alertTone='neutral';action='見送り';actionTone='neutral';}
  return {d,radar,dominance,dominanceTone,action,actionTone,alert,alertTone,edge};
}
function renderQuickSignalGrid(d){
  const flow=flowTotals(), bp=flow.total?flow.buy/flow.total:NaN;
  const pos=state.positioning?.global||state.positioning?.topPositions;
  const ctx=state.ctxByCoin.get(state.asset.symbol), f=Number(ctx?.funding), mm=d.mm;
  setText('quickTaker',Number.isFinite(bp)?`${(bp*100).toFixed(1)} / ${((1-bp)*100).toFixed(1)}`:'—');
  setText('quickTakerMeta',Number.isFinite(bp)?`BUY / SELL · ${state.flowWindowMs/60000}分`:'取引データ待ち'); setTone($('quickTaker'),Number.isFinite(bp)?(bp>.55?'up':bp<.45?'down':'neutral'):'neutral');
  if(state.asset.source==='mexc'){
    const basis=Number(ctx?.basis); setText('quickPositioningLabel','Index乖離');
    setText('quickPositioning',Number.isFinite(basis)?`${basis>=0?'+':''}${(basis*100).toFixed(2)}%`:'—');
    setText('quickPositioningMeta',Number.isFinite(Number(ctx?.indexPrice))?`Index ${priceFmt(Number(ctx.indexPrice))}`:'Index取得待ち');
    setTone($('quickPositioning'),Number.isFinite(basis)?(basis>0.005?'down':basis<-0.005?'up':'neutral'):'neutral');
  }else{
    setText('quickPositioningLabel','Long / Short');
    setText('quickPositioning',pos?`L ${Math.round(pos.long*100)} / S ${Math.round(pos.short*100)}`:'—');
    setText('quickPositioningMeta',pos?`${state.positioning?.sources?.global||'公開統計'} · 混雑度 L/S ${Number.isFinite(pos.ratio)?pos.ratio.toFixed(2):'—'}`:'公開統計待ち'); setTone($('quickPositioning'),'neutral');
  }
  let fs='中立',ft='neutral'; if(Number.isFinite(f)){if(f>0.0001){fs='Long過熱';ft='down';}else if(f<-0.0001){fs='Short過熱';ft='up';}}
  setText('quickFunding',Number.isFinite(f)?pct(f,4):'—'); setText('quickFundingMeta',Number.isFinite(f)?fs:'取得待ち'); setTone($('quickFunding'),ft);
  setText('quickOi',mm&&Number.isFinite(mm.oiChange)?`${mm.oiChange>=0?'+':''}${(mm.oiChange*100).toFixed(2)}%`:'—');
  setText('quickOiMeta',mm&&Number.isFinite(mm.priceChange)?`価格 ${mm.priceChange>=0?'+':''}${(mm.priceChange*100).toFixed(2)}%`:'15分履歴を蓄積中'); setTone($('quickOi'),mm&&Number.isFinite(mm.oiChange)?(mm.oiChange>0?'up':mm.oiChange<0?'down':'neutral'):'neutral');
}
function renderMexcOverview(){
  const card=$('mexcStockCard'); if(!card) return;
  const active=state.asset.source==='mexc'; card.classList.toggle('hidden',!active); if(!active) return;
  const c=state.ctxByCoin.get(state.asset.symbol)||{};
  const basis=Number(c.basis), rise=Number(c.riseFallRate), high=Number(c.high24), low=Number(c.low24), index=Number(c.indexPrice), fair=Number(c.markPx);
  setText('mexcContractName',c.apiSymbol||state.asset.apiSymbol||'KIOXIASTOCK_USDT');
  setText('mexcIndexPrice',priceFmt(index)); setText('mexcFairPrice',priceFmt(fair));
  setText('mexcBasis',Number.isFinite(basis)?`${basis>=0?'+':''}${(basis*100).toFixed(2)}%`:'—'); setTone($('mexcBasis'),Number.isFinite(basis)?(basis>0.005?'down':basis<-0.005?'up':'neutral'):'neutral');
  setText('mexc24Change',Number.isFinite(rise)?`${rise>=0?'+':''}${(rise*100).toFixed(2)}%`:'—'); setTone($('mexc24Change'),Number.isFinite(rise)?(rise>0?'up':rise<0?'down':'neutral'):'neutral');
  setText('mexc24Range',Number.isFinite(high)&&Number.isFinite(low)?`${priceFmt(low)} – ${priceFmt(high)}`:'—');
  setText('mexcTurnover',money(Number(c.amount24)));
  let risk='Index乖離は通常範囲'; let tone='neutral';
  if(Number.isFinite(basis)&&Math.abs(basis)>=0.015){risk=`Index乖離 ${(basis*100).toFixed(2)}%：急変・スプレッド拡大に注意`;tone='down';}
  else if(Number.isFinite(basis)&&Math.abs(basis)>=0.006){risk=`Index乖離 ${(basis*100).toFixed(2)}%：やや拡大`;tone=basis>0?'down':'up';}
  setText('mexcRiskStrip',risk); const strip=$('mexcRiskStrip'); if(strip) strip.className=`mexc-risk-strip ${tone}`;
}

function renderQuickView(){
  const q=quickDecision(),{d,radar}=q,actualLiq=Boolean(state.heatmap?.levels?.length);
  const liqTitle=document.querySelector('.quick-liq-title');
  const mexc=state.asset.source==='mexc';
  if(liqTitle) liqTitle.textContent=actualLiq?'直近の実清算ライン':(mexc?'直近のMEXC L2反応ライン':'直近の推定反応ライン');
  setText('quickLineMode',actualLiq?'実清算':(mexc?'MEXC L2':'L2推定'));
  setText('quickDominance',q.dominance); setText('quickDominanceMeta',`LONG ${Math.round(d.up)} / SHORT ${Math.round(d.down)}`);
  setText('quickAction',q.action); setText('quickActionMeta',`信頼度 ${d.confidence}%`);
  setTone($('quickDominance'),q.dominanceTone); setTone($('quickAction'),q.actionTone);
  const badge=$('quickAlert'); if(badge){badge.textContent=q.alert;badge.className=`signal-badge ${q.alertTone}`;}
  setText('quickDataQuality',`品質 ${d.quality.score}`);
  const qel=$('quickDataQuality'); if(qel) qel.title=d.quality.missing.length?`不足: ${d.quality.missing.join(', ')}`:'主要データ取得済み';
  renderQuickSignalGrid(d);

  const ez=estimatedTriggerZones();
  const shortLine=radar?.nearestShort || ez?.up || null, longLine=radar?.nearestLong || ez?.down || null;
  const refSpot=radar?.spot||state.latestPrice||state.ctxByCoin.get(state.asset.symbol)?.markPx;
  if(shortLine){const ds=Math.abs(distPct(shortLine.price,refSpot));setText('quickShortLine',priceFmt(shortLine.price));setText('quickShortLineMeta',`${actualLiq?'実清算':(mexc?'MEXC L2':'L2推定')}${Number.isFinite(ds)?` · +${(ds*100).toFixed(2)}%`:''} · ${money(shortLine.notional)}`);} else {setText('quickShortLine','—');setText('quickShortLineMeta','上側データ待ち');}
  if(longLine){const dl=Math.abs(distPct(longLine.price,refSpot));setText('quickLongLine',priceFmt(longLine.price));setText('quickLongLineMeta',`${actualLiq?'実清算':(mexc?'MEXC L2':'L2推定')}${Number.isFinite(dl)?` · -${(dl*100).toFixed(2)}%`:''} · ${money(longLine.notional)}`);} else {setText('quickLongLine','—');setText('quickLongLineMeta','下側データ待ち');}

  let advice='方向感は拮抗。条件が揃うまで待機。';
  if(q.action.startsWith('LONG')) advice=`LONG側の条件が優勢。直上ラインとTaker継続を確認し、崩れたら再判定。`;
  else if(q.action.startsWith('SHORT')) advice=`SHORT側の条件が優勢。直下ラインとTaker継続を確認し、反転したら再判定。`;
  else if(q.dominance==='LONG優勢') advice='LONG優勢だが信頼度不足。追いかけず見送り優先。';
  else if(q.dominance==='SHORT優勢') advice='SHORT優勢だが信頼度不足。追いかけず見送り優先。';
  if(d.quality.score<45) advice=`主要データが不足しています（品質 ${d.quality.score}/100）。方向判定よりデータ復旧を優先。`;
  setText('quickAdvice',advice);
  renderBase();
}
function renderDecisionEngine(){
  const d=decisionMetrics(); state.decision=d;
  setText('engineUp',Math.round(d.up)); setText('engineDown',Math.round(d.down));
  const ub=$('engineUpBar'),db=$('engineDownBar'); if(ub)ub.style.width=d.up+'%';if(db)db.style.width=d.down+'%';
  setText('engineLabel',d.label);setText('engineConfidence',`信頼度 ${d.confidence}%`);
  const eb=$('engineLabel');if(eb)eb.className=`signal-badge ${d.tone}`;
  const reasons=$('engineReasons');if(reasons){reasons.textContent='';(d.reasons.length?d.reasons:['主要データを取得中']).forEach(x=>{const li=document.createElement('li');li.textContent=x;reasons.appendChild(li);});}
  const mm=d.mm;setText('oi15m',mm&&Number.isFinite(mm.oiChange)?`${mm.oiChange>=0?'+':''}${(mm.oiChange*100).toFixed(2)}%`:'—');setText('price15m',mm&&Number.isFinite(mm.priceChange)?`${mm.priceChange>=0?'+':''}${(mm.priceChange*100).toFixed(2)}%`:'—');
  const f=Number(state.ctxByCoin.get(state.asset.symbol)?.funding);let fs='中立';if(Number.isFinite(f)){if(f>0.0001)fs='Long過熱寄り';else if(f<-0.0001)fs='Short過熱寄り';}setText('fundingState',fs);setText('positionSource',state.positioning?.sources?.global||'—');
  if(state.asset.symbol==='SP500') renderSp500Command();
}

function renderPressure(){
  const f=flowTotals(); const flow=f.total?f.buy/f.total:0.5;
  const funding=state.ctxByCoin.get(state.asset.symbol)?.funding || 0;
  let up=50+(flow-.5)*30, down=50-(flow-.5)*30;
  const b=liquidationBias();
  if(b){ const skew=b.shortPct-b.longPct; up+=skew*32; down-=skew*32; }
  const fAdj=clamp(funding*12000,-10,10); up-=fAdj; down+=fAdj;
  const pos=state.positioning?.topPositions || state.positioning?.global;
  if(pos){
    const crowd=clamp((pos.long-pos.short)*12,-7,7);
    // Crowded longs slightly increase downside squeeze risk; crowded shorts do the reverse.
    up-=crowd; down+=crowd;
  }
  setText('upScore',Math.round(clamp(up,0,100))+'/100'); setText('downScore',Math.round(clamp(down,0,100))+'/100');
}

function setupTimers(){
  state.timers.forEach(clearInterval); state.timers=[];
  state.timers.push(setInterval(fetchMeta,CONFIG.infoPollMs));
  state.timers.push(setInterval(fetchHeatmap,CONFIG.heatmapPollMs));
  state.timers.push(setInterval(fetchPositioning,CONFIG.positioningPollMs));
  state.timers.push(setInterval(fetchOrderBook,CONFIG.orderBookPollMs));
  state.timers.push(setInterval(fetchSp500Map,CONFIG.sp500MapPollMs));
  state.timers.push(setInterval(fetchExternalTrades,CONFIG.mexcTradesPollMs));
  state.timers.push(setInterval(fetchExternalCandles,CONFIG.mexcKlinePollMs));
  state.timers.push(setInterval(()=>{
    state.tradeEvents=state.tradeEvents.filter(x=>x.ts>=Date.now()-CONFIG.maxTradeWindowMs);
    renderFlow(); renderPressure(); renderDecisionEngine(); renderQuickView(); renderBase();
    if(Date.now()-state.lastWsAt>CONFIG.wsStaleMs && state.ws?.readyState===1){ try{state.ws.close();}catch{} }
  },5000));
}


function renderVisibilityControls(){
  document.querySelectorAll('.advanced-panel').forEach(el=>el.classList.toggle('panel-collapsed',!state.advancedOpen));
  const ab=$('advancedToggle'); if(ab){ab.textContent=state.advancedOpen?'詳細を閉じる':'詳細を表示';ab.setAttribute('aria-expanded',String(state.advancedOpen));}
  document.querySelectorAll('.diagnostics-panel').forEach(el=>el.classList.toggle('panel-collapsed',!state.diagnosticsOpen));
  const db=$('diagnosticsToggle'); if(db){db.textContent=state.diagnosticsOpen?'設定を閉じる':'設定を表示';db.setAttribute('aria-expanded',String(state.diagnosticsOpen));}
}
function toggleAdvanced(){ state.advancedOpen=!state.advancedOpen; try{localStorage.setItem('liqpulse_advanced_open',state.advancedOpen?'1':'0');}catch{} renderVisibilityControls(); }
function toggleDiagnostics(){ state.diagnosticsOpen=!state.diagnosticsOpen; try{localStorage.setItem('liqpulse_diagnostics_open',state.diagnosticsOpen?'1':'0');}catch{} renderVisibilityControls(); }

function renderRelaySettings(){
  const input=$('relayUrl');
  if(input) input.value=CONFIG.relayBase||'';
  const badge=$('relayBadge');
  if(badge) badge.textContent=CONFIG.relayBase?'設定済み':'未設定';
}
async function testRelay(){
  const input=$('relayUrl');
  const btn=$('testRelayBtn');
  const msg=$('relayTestResult');
  const base=(input?.value||'').trim().replace(/\/$/,'');
  if(!base){ if(msg) msg.textContent='Relay URLを入力してください。'; return; }
  try{
    if(btn) btn.disabled=true;
    if(msg) msg.textContent='接続テスト中…';
    const raw=await fetchJsonWithTimeout(`${base}/heatmap/BTC`,CONFIG.relayTimeoutMs);
    const normalized=normalizeHeatmap(raw);
    if(!normalized.levels.length) throw new Error('清算レベルを認識できません');
    CONFIG.relayBase=base;
    localStorage.setItem('liqpulse_relay_base',base);
    renderRelaySettings();
    if(msg) msg.textContent=`成功: ${normalized.levels.length} levels`;
    await fetchHeatmap();
  }catch(err){
    console.warn('relay test',err);
    if(msg) msg.textContent=`失敗: ${err?.message||'接続できません'}`;
  }finally{ if(btn) btn.disabled=false; }
}
function clearRelay(){
  CONFIG.relayBase=DEFAULT_RELAY; localStorage.removeItem('liqpulse_relay_base'); renderRelaySettings();
  const msg=$('relayTestResult'); if(msg) msg.textContent='標準Relay URLに戻しました。';
}

$('refreshBtn').addEventListener('click',()=>Promise.allSettled([fetchMeta(),fetchHeatmap(),fetchPositioning(),fetchOrderBook(),fetchSp500Map(),fetchExternalTrades(),fetchExternalCandles()]));
$('testRelayBtn')?.addEventListener('click',testRelay);
$('clearRelayBtn')?.addEventListener('click',clearRelay);
$('flowWindow').addEventListener('change',(e)=>{ state.flowWindowMs=Number(e.target.value)||300000; renderFlow(); renderPressure(); });
$('clusterDepth')?.addEventListener('change',(e)=>{ state.clusterDepth=Number(e.target.value)||5; renderHeatmap(); });
$('sp500MapLimit')?.addEventListener('change',(e)=>{ state.sp500MapLimit=Number(e.target.value)||50; renderSp500Map(); });
document.querySelectorAll('[data-whale-range-slot]').forEach(btn=>btn.addEventListener('click',()=>setWhaleRangeSlot(Number(btn.dataset.whaleRangeSlot))));
$('advancedToggle')?.addEventListener('click',toggleAdvanced);
$('diagnosticsToggle')?.addEventListener('click',toggleDiagnostics);
window.addEventListener('online',()=>{connectWs(true); fetchMeta(); fetchHeatmap(); fetchPositioning(); fetchOrderBook(); fetchSp500Map(); fetchExternalTrades(); fetchExternalCandles();});
window.addEventListener('offline',()=>setStatus('error','OFFLINE'));
document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible'){ connectWs(); fetchMeta(); fetchHeatmap(); fetchPositioning(); fetchOrderBook(); fetchSp500Map(); fetchExternalTrades(); fetchExternalCandles(); } });

(async function init(){
  if(state.asset.orderMap){ state.whaleHistory=loadWhaleHistory(); state.whaleTracks=loadWhaleTracks(); }
  state.advancedOpen=localStorage.getItem('liqpulse_advanced_open')==='1';
  state.diagnosticsOpen=localStorage.getItem('liqpulse_diagnostics_open')==='1';
  renderAssetTabs(); updateAssetSpecificPanels(); renderVisibilityControls(); renderBase(); renderMexcOverview(); renderFlow(); renderHeatmap(); renderLiqBias(); renderRadar(); renderPositioning(); renderDecisionEngine(); renderQuickView(); renderSp500Command(); renderWhaleOrderMap(); renderRelaySettings();
  connectWs(); setupTimers();
  await Promise.allSettled([fetchMeta(),fetchHeatmap(),fetchPositioning(),fetchOrderBook(),fetchSp500Map(),fetchExternalTrades(),fetchExternalCandles()]);
  if('serviceWorker' in navigator){
    try{
      const reg=await navigator.serviceWorker.register('./sw.js');
      reg.update().catch(()=>{});
    }catch(err){ console.warn('service worker',err); }
  }
})();

// LiqPulse v2.4.0
