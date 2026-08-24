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
  { symbol:'BTC', name:'Bitcoin', heatmap:true, positioning:true, dex:'', apiCoin:'BTC', estimatedZones:true },
  { symbol:'ETH', name:'Ethereum', heatmap:true, positioning:true, dex:'', apiCoin:'ETH', estimatedZones:true },
  { symbol:'SOL', name:'Solana', heatmap:true, positioning:true, dex:'', apiCoin:'SOL', estimatedZones:true },
  { symbol:'XRP', name:'XRP', heatmap:true, positioning:true, dex:'', apiCoin:'XRP', estimatedZones:true },
  { symbol:'ZEC', name:'Zcash', heatmap:true, positioning:true, dex:'', apiCoin:'ZEC', estimatedZones:true },
  { symbol:'SP500', name:'S&P 500', heatmap:false, positioning:false, dex:'xyz', apiCoin:'xyz:SP500', estimatedZones:true },
  { symbol:'GOLD', name:'Gold', heatmap:false, positioning:false, dex:'xyz', apiCoin:'xyz:GOLD', estimatedZones:true },
  { symbol:'SILVER', name:'Silver', heatmap:false, positioning:false, dex:'xyz', apiCoin:'xyz:SILVER', estimatedZones:true },
];

const state = {
  asset: ASSETS.find(x=>x.symbol==='SP500') || ASSETS[0],
  ws:null,
  wsBackoff:1000,
  tradeEvents:[],
  flowWindowMs:300000,
  clusterDepth:8,
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
  if(whale) whale.classList.toggle('hidden',state.asset.symbol!=='BTC');
}

async function switchAsset(symbol){
  if(state.switching || symbol===state.asset.symbol) return;
  state.switching=true;
  state.asset=ASSETS.find(x=>x.symbol===symbol)||ASSETS[0];
  state.tradeEvents=[]; state.heatmap=null; state.positioning=null; state.orderbook=null; state.sp500Map=null; state.latestPrice=null; state.whaleHistory=[]; state.whaleTracks=[]; state.whaleLastBookAt=0;
  renderAssetTabs(); updateAssetSpecificPanels(); renderBase(); renderFlow(); renderHeatmap(); renderLiqBias(); renderRadar(); renderPositioning(); renderDecisionEngine(); renderQuickView(); renderSp500Command(); renderWhaleOrderMap(); renderRelaySettings();
  connectWs(true);
  await Promise.allSettled([fetchMeta(), fetchHeatmap(), fetchPositioning(), fetchOrderBook(), fetchSp500Map()]);
  state.switching=false;
}

function renderBase(){
  setText('assetName',state.asset.name);
  setText('price',priceFmt(state.latestPrice));
  const c=state.ctxByCoin.get(state.asset.symbol);
  setText('markPx',c?priceFmt(c.markPx):'—');
  setText('openInterest',c?money(c.openInterestUsd):'—');
  setText('funding',c?pct(c.funding,4):'—');
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
  try{
    let data;
    // HIP-3 markets are fetched through our Worker so iOS/CORS and dex handling stay consistent.
    if(state.asset.dex){
      const relayBase=(CONFIG.relayBase||'').replace(/\/$/,'');
      if(!relayBase) throw new Error('Relay not configured');
      const raw=await fetchJsonWithTimeout(`${relayBase}/market/${encodeURIComponent(state.asset.symbol)}`,CONFIG.relayTimeoutMs);
      if(raw?.error) throw new Error(raw.error);
      const c={markPx:Number(raw.markPx),funding:Number(raw.funding),openInterestUsd:Number(raw.openInterestUsd)};
      if(!Number.isFinite(c.markPx)) throw new Error('Invalid HIP-3 market response');
      state.ctxByCoin.set(state.asset.symbol,c);
      if(!state.latestPrice) state.latestPrice=c.markPx;
      saveMarketSnapshot(state.asset.symbol,c,state.latestPrice||c.markPx);
    }else{
      const req={type:'metaAndAssetCtxs'};
      const res=await fetch(CONFIG.infoUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(req),cache:'no-store'});
      if(!res.ok) throw new Error(`HTTP ${res.status}`);
      data=await res.json();
      const meta=data?.[0], ctxs=data?.[1];
      if(!meta?.universe || !Array.isArray(ctxs)) throw new Error('Unexpected response');
      meta.universe.forEach((u,i)=>{
        const c=ctxs[i]; if(!c) return;
        const markPx=Number(c.markPx), oi=Number(c.openInterest);
        state.ctxByCoin.set(u.name,{markPx,funding:Number(c.funding),openInterestUsd:oi*markPx});
      });
      const c=state.ctxByCoin.get(state.asset.symbol);
      if(c && !state.latestPrice) state.latestPrice=c.markPx;
      if(c) saveMarketSnapshot(state.asset.symbol,c,state.latestPrice||c.markPx);
    }
    setText('statusInfo','正常');
    renderBase(); renderPressure(); renderDecisionEngine();
  }catch(err){
    console.warn('meta',err); setText('statusInfo','取得失敗');
  }
}

function connectWs(force=false){
  if(force && state.ws){ try{state.ws.onclose=null; state.ws.close();}catch{} state.ws=null; }
  if(state.ws && (state.ws.readyState===0 || state.ws.readyState===1)) return;
  setStatus('offline','接続中'); setText('statusWs','接続中');
  const ws=new WebSocket(CONFIG.wsUrl); state.ws=ws;
  ws.onopen=()=>{
    state.wsBackoff=1000; state.lastWsAt=Date.now(); setStatus('online','LIVE'); setText('statusWs','LIVE');
    ws.send(JSON.stringify({method:'subscribe',subscription:{type:'trades',coin:state.asset.apiCoin||state.asset.symbol}}));
    if(!state.asset.dex) ws.send(JSON.stringify({method:'subscribe',subscription:{type:'allMids'}}));
  };
  ws.onmessage=(ev)=>{
    state.lastWsAt=Date.now();
    let msg; try{msg=JSON.parse(ev.data);}catch{return;}
    if(msg.channel==='trades' && Array.isArray(msg.data)) ingestTrades(msg.data);
    if(msg.channel==='allMids' && msg.data?.mids){
      const p=Number(msg.data.mids[state.asset.symbol]);
      if(Number.isFinite(p)){ state.latestPrice=p; setText('price',priceFmt(p)); renderHeatmap(); renderLiqBias(); renderPressure(); renderRadar(); renderDecisionEngine(); }
    }
  };
  ws.onerror=()=>setStatus('error','再接続');
  ws.onclose=()=>{
    if(state.ws!==ws) return;
    setText('statusWs','再接続中'); setStatus('error','再接続');
    const wait=state.wsBackoff; state.wsBackoff=Math.min(30000,state.wsBackoff*2);
    setTimeout(()=>connectWs(),wait);
  };
}

function ingestTrades(trades){
  const now=Date.now();
  for(const t of trades){
    const px=Number(t.px), sz=Number(t.sz), ts=Number(t.time)||now;
    if(!Number.isFinite(px)||!Number.isFinite(sz)) continue;
    state.tradeEvents.push({ts,usd:px*sz,buy:t.side==='B',price:px});
    state.latestPrice=px;
  }
  state.tradeEvents=state.tradeEvents.filter(x=>x.ts>=now-CONFIG.maxTradeWindowMs);
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
  if(!state.asset.estimatedZones){ state.orderbook=null; renderQuickView(); return; }
  const relayBase=(CONFIG.relayBase||'').replace(/\/$/,'');
  let raw=null,err=null;
  if(relayBase){
    try{ raw=await fetchJsonWithTimeout(`${relayBase}/book/${encodeURIComponent(state.asset.symbol)}`,CONFIG.relayTimeoutMs); }catch(e){err=e;}
  }
  if(!raw){
    try{ raw=await postInfoJson({type:'l2Book',coin:state.asset.apiCoin||state.asset.symbol,nSigFigs:5}); }catch(e){err=e;}
  }
  const ob=normalizeOrderBook(raw);
  state.orderbook=ob;
  if(ob) recordWhaleSnapshot(ob);
  setText('statusOrderBook',ob?'正常':'取得失敗');
  if(!ob) console.warn('orderbook',err);
  renderQuickView(); renderDecisionEngine(); renderWhaleOrderMap();
}
function estimatedTriggerZones(){
  const ob=state.orderbook, spot=state.latestPrice||state.ctxByCoin.get(state.asset.symbol)?.markPx;
  if(!ob||!Number.isFinite(spot)) return null;
  const choose=(rows,dir)=>{
    const filtered=rows.filter(x=>{const d=(x.price/spot)-1; return dir==='up'?(d>0&&d<=0.05):(d<0&&d>=-0.05);});
    if(!filtered.length) return null;
    // Emphasize large nearby walls without pretending they are liquidation levels.
    return filtered.map(x=>{const d=Math.abs((x.price/spot)-1);return {...x,distance:d,score:x.notional/Math.max(d,0.0005)};})
      .sort((a,b)=>b.score-a.score)[0];
  };
  const up=choose(ob.asks,'up'), down=choose(ob.bids,'down');
  const bidTotal=ob.bids.slice(0,10).reduce((a,x)=>a+x.notional,0), askTotal=ob.asks.slice(0,10).reduce((a,x)=>a+x.notional,0);
  const total=bidTotal+askTotal;
  return {up,down,bidTotal,askTotal,bidPct:total?bidTotal/total:.5,askPct:total?askTotal/total:.5};
}



function whaleSnapshotKey(){ return 'liqpulse_btc_whale_walls_v2'; }
function whaleTrackKey(){ return 'liqpulse_btc_whale_tracks_v2'; }
const WHALE_RETENTION_MS=6*60*60*1000;
const WHALE_CAPTURE_RANGE_USD=10000;
const WHALE_DISPLAY_RANGE_DEFAULT_USD=3000;
const WHALE_DISPLAY_RANGE_OPTIONS=[1000,3000,5000];
const WHALE_CHART_ZOOM_OPTIONS=[1,1.35,1.7];
function loadWhaleDisplayRange(){
  const v=Number(localStorage.getItem('liqpulse_whale_display_range_usd'));
  return WHALE_DISPLAY_RANGE_OPTIONS.includes(v)?v:WHALE_DISPLAY_RANGE_DEFAULT_USD;
}
function loadWhaleChartZoom(){
  const v=Number(localStorage.getItem('liqpulse_whale_chart_zoom'));
  return WHALE_CHART_ZOOM_OPTIONS.includes(v)?v:1;
}
function whaleDisplayRangeUsd(){ return state.whaleDisplayRangeUsd||loadWhaleDisplayRange(); }
function whaleChartZoom(){ return state.whaleChartZoom||loadWhaleChartZoom(); }
function loadWhaleHistory(){
  try{ const raw=JSON.parse(localStorage.getItem(whaleSnapshotKey())||'[]'); const cutoff=Date.now()-WHALE_RETENTION_MS; return Array.isArray(raw)?raw.filter(x=>Number(x.ts)>=cutoff):[]; }catch{return []}
}
function saveWhaleHistory(){
  try{ localStorage.setItem(whaleSnapshotKey(),JSON.stringify(state.whaleHistory.slice(-360))); }catch{}
}
function loadWhaleTracks(){
  try{
    const raw=JSON.parse(localStorage.getItem(whaleTrackKey())||'[]'), cutoff=Date.now()-WHALE_RETENTION_MS;
    return Array.isArray(raw)?raw.filter(x=>Number(x.lastSeen||x.firstSeen)>=cutoff).slice(-320):[];
  }catch{return []}
}
function saveWhaleTracks(){
  try{ localStorage.setItem(whaleTrackKey(),JSON.stringify(state.whaleTracks.slice(-320))); }catch{}
}
function whaleRows(ob,spot){
  const asks=(ob?.wideAsks?.length?ob.wideAsks:ob?.asks)||[];
  const bids=(ob?.wideBids?.length?ob.wideBids:ob?.bids)||[];
  return [...asks.map(x=>({...x,side:'sell'})),...bids.map(x=>({...x,side:'buy'}))]
    .filter(x=>Number.isFinite(x.price)&&Number.isFinite(x.notional)&&Math.abs(x.price-spot)<=WHALE_CAPTURE_RANGE_USD);
}
function selectWhaleWalls(rows){
  if(!rows.length) return [];
  const notionals=rows.map(x=>x.notional).sort((a,b)=>a-b);
  const q=notionals[Math.max(0,Math.floor((notionals.length-1)*.52))]||0;
  const threshold=Math.max(100000,q);
  return rows.filter(x=>x.notional>=threshold).sort((a,b)=>b.notional-a.notional).slice(0,64)
    .map(x=>({price:x.price,notional:x.notional,side:x.side,n:x.n||null}));
}
function whaleTier(notional){
  if(notional>=100000000) return {label:'MEGA',width:10,alpha:.98};
  if(notional>=50000000) return {label:'XL',width:8,alpha:.94};
  if(notional>=25000000) return {label:'L',width:6.5,alpha:.90};
  if(notional>=10000000) return {label:'M',width:5,alpha:.84};
  if(notional>=5000000) return {label:'S',width:3.8,alpha:.76};
  return {label:'',width:2.4,alpha:.66};
}
function mergeWhaleBands(walls,spot){
  const bucket=100, map=new Map();
  for(const w of walls){
    const price=Math.round(w.price/bucket)*bucket, key=`${w.side}:${price}`;
    const prev=map.get(key)||{side:w.side,price,notional:0,count:0,maxNotional:0};
    prev.notional+=w.notional; prev.count+=1; prev.maxNotional=Math.max(prev.maxNotional,w.notional); map.set(key,prev);
  }
  return [...map.values()].filter(x=>Math.abs(x.price-spot)<=WHALE_CAPTURE_RANGE_USD).sort((a,b)=>b.notional-a.notional);
}

function updateWhaleTracks(walls,spot,now){
  if(!state.whaleTracks.length) state.whaleTracks=loadWhaleTracks();
  const tolerance=Math.max(12,spot*.00022), matched=new Set();
  for(const wall of walls){
    let best=-1,bestDist=Infinity;
    for(let i=0;i<state.whaleTracks.length;i++){
      const t=state.whaleTracks[i];
      if(t.side!==wall.side||t.endedAt) continue;
      const d=Math.abs(t.price-wall.price);
      if(d<=tolerance&&d<bestDist){best=i;bestDist=d;}
    }
    if(best>=0){
      const t=state.whaleTracks[best]; matched.add(t.id);
      const samples=(t.samples||1)+1;
      t.price=(t.price*(samples-1)+wall.price)/samples;
      t.lastSeen=now; t.lastNotional=wall.notional; t.maxNotional=Math.max(t.maxNotional||0,wall.notional); t.samples=samples;
    }else{
      const t={id:`${wall.side}-${now}-${Math.round(wall.price*10)}`,side:wall.side,price:wall.price,firstSeen:now,lastSeen:now,endedAt:null,lastNotional:wall.notional,maxNotional:wall.notional,samples:1};
      state.whaleTracks.push(t); matched.add(t.id);
    }
  }
  for(const t of state.whaleTracks){
    if(!t.endedAt&&!matched.has(t.id)&&now-(t.lastSeen||0)>25000) t.endedAt=t.lastSeen||now;
  }
  const cutoff=now-WHALE_RETENTION_MS;
  state.whaleTracks=state.whaleTracks.filter(t=>(t.lastSeen||t.firstSeen)>=cutoff).slice(-320);
  saveWhaleTracks();
}
function recordWhaleSnapshot(ob){
  if(state.asset.symbol!=='BTC'||!ob) return;
  const now=Date.now(); if(state.whaleLastBookAt && now-state.whaleLastBookAt<9000) return; state.whaleLastBookAt=now;
  const spot=state.latestPrice||state.ctxByCoin.get('BTC')?.markPx; if(!Number.isFinite(spot)) return;
  const walls=selectWhaleWalls(whaleRows(ob,spot));
  updateWhaleTracks(walls,spot,now);
  // Lightweight snapshots keep chart fallback/history without exhausting mobile localStorage.
  const prev=state.whaleHistory[state.whaleHistory.length-1];
  if(!prev||now-prev.ts>=30000){
    state.whaleHistory.push({ts:now,spot,walls:walls.slice(0,24)});
    state.whaleHistory=state.whaleHistory.filter(x=>now-x.ts<=WHALE_RETENTION_MS).slice(-360); saveWhaleHistory();
  }
}
function whaleMetrics(){
  if(state.asset.symbol!=='BTC') return null;
  const ob=state.orderbook, spot=state.latestPrice||state.ctxByCoin.get('BTC')?.markPx; if(!ob||!Number.isFinite(spot)) return null;
  const rows=whaleRows(ob,spot), walls=selectWhaleWalls(rows);
  const sells=walls.filter(x=>x.side==='sell'&&x.price>=spot), buys=walls.filter(x=>x.side==='buy'&&x.price<=spot);
  const sellTotal=sells.reduce((a,x)=>a+x.notional,0), buyTotal=buys.reduce((a,x)=>a+x.notional,0);
  const nearestSell=[...sells].sort((a,b)=>a.price-b.price)[0]||null, nearestBuy=[...buys].sort((a,b)=>b.price-a.price)[0]||null;
  return {spot,walls,sells,buys,sellTotal,buyTotal,nearestSell,nearestBuy};
}
function whalePricePoints(start,end){
  const snaps=loadMarketSnapshots('BTC').filter(x=>x.ts>=start&&x.ts<=end&&Number.isFinite(x.price)).map(x=>({ts:x.ts,price:x.price}));
  const trades=state.tradeEvents.filter(t=>t.ts>=start&&t.ts<=end&&Number.isFinite(t.price)).map(t=>({ts:t.ts,price:t.price}));
  const pts=[...snaps,...trades]; if(Number.isFinite(state.latestPrice)) pts.push({ts:end,price:state.latestPrice});
  return pts.sort((a,b)=>a.ts-b.ts);
}
function whaleCandles(start,end){
  const pts=whalePricePoints(start,end), bucket=5*60*1000, map=new Map();
  for(const p of pts){ const k=Math.floor(p.ts/bucket)*bucket; let c=map.get(k); if(!c){c={ts:k,o:p.price,h:p.price,l:p.price,c:p.price};map.set(k,c);} else {c.h=Math.max(c.h,p.price);c.l=Math.min(c.l,p.price);c.c=p.price;} }
  return [...map.values()].sort((a,b)=>a.ts-b.ts);
}
function formatDuration(ms){
  if(!Number.isFinite(ms)||ms<0) return '—';
  if(ms<60000) return `${Math.max(1,Math.round(ms/1000))}s`;
  if(ms<3600000) return `${Math.round(ms/60000)}m`;
  return `${(ms/3600000).toFixed(ms<10800000?1:0)}h`;
}
function activeTrackForWall(wall,spot){
  const tol=Math.max(12,spot*.00022), tracks=state.whaleTracks.length?state.whaleTracks:loadWhaleTracks();
  return tracks.filter(t=>!t.endedAt&&t.side===wall.side&&Math.abs(t.price-wall.price)<=tol).sort((a,b)=>Math.abs(a.price-wall.price)-Math.abs(b.price-wall.price))[0]||null;
}
function renderWhaleCanvas(metrics){
  const canvas=$('whaleCanvas'); if(!canvas||state.asset.symbol!=='BTC') return;
  const zoom=whaleChartZoom();
  const baseH=window.matchMedia('(max-width: 600px)').matches?370:390;
  canvas.style.height=`${Math.round(baseH*zoom)}px`;
  const rect=canvas.getBoundingClientRect(), dpr=Math.min(2,window.devicePixelRatio||1), w=Math.max(320,Math.floor(rect.width)), h=Math.max(330,Math.floor(rect.height));
  if(canvas.width!==Math.floor(w*dpr)||canvas.height!==Math.floor(h*dpr)){canvas.width=Math.floor(w*dpr);canvas.height=Math.floor(h*dpr);} const ctx=canvas.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,w,h);
  ctx.fillStyle='#070d15';ctx.fillRect(0,0,w,h); const pad={l:8,r:58,t:18,b:30}; const iw=w-pad.l-pad.r, ih=h-pad.t-pad.b;
  const spot=metrics?.spot||state.latestPrice; if(!Number.isFinite(spot)) return;
  const end=Date.now(), lookback=state.whaleLookbackMs||3*60*60*1000, start=end-lookback;
  const displayRange=whaleDisplayRangeUsd();
  const minP=spot-displayRange, maxP=spot+displayRange;
  const py=p=>pad.t+(maxP-p)/(maxP-minP)*ih, tx=ts=>pad.l+clamp((ts-start)/lookback,0,1)*iw;
  // horizontal price grid
  ctx.font='9px -apple-system, sans-serif'; for(let i=0;i<=4;i++){const y=pad.t+ih*i/4;ctx.strokeStyle='#172131';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(pad.l,y);ctx.lineTo(pad.l+iw,y);ctx.stroke();const p=maxP-(maxP-minP)*i/4;ctx.fillStyle='#64758b';ctx.fillText('$'+Math.round(p).toLocaleString(),pad.l+iw+5,y+3);}
  // time grid + labels
  const timeSteps=4; for(let i=0;i<=timeSteps;i++){const x=pad.l+iw*i/timeSteps;ctx.strokeStyle='rgba(28,42,61,.65)';ctx.beginPath();ctx.moveTo(x,pad.t);ctx.lineTo(x,pad.t+ih);ctx.stroke();const ts=start+lookback*i/timeSteps,d=new Date(ts);const label=d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});ctx.fillStyle='#596b82';ctx.font='8px -apple-system, sans-serif';ctx.fillText(label,Math.max(pad.l,x-15),h-8);}
  ctx.fillStyle='#6f8199';ctx.font='8px -apple-system, sans-serif';ctx.fillText(`表示 ±$${displayRange.toLocaleString()} / 収集 ±$${WHALE_CAPTURE_RANGE_USD.toLocaleString()} / ${Math.round(lookback/3600000)}H履歴`,pad.l+4,pad.t+10);
  // persistent whale wall tracks: horizontal price bands with duration encoded by x-length.
  const tracks=(state.whaleTracks.length?state.whaleTracks:loadWhaleTracks()).filter(t=>(t.lastSeen||0)>=start&&t.price>=minP&&t.price<=maxP);
  const maxN=Math.max(1,...tracks.map(t=>t.maxNotional||t.lastNotional||0),...(metrics?.walls||[]).map(x=>x.notional||0));
  for(const t of tracks){
    const x1=tx(Math.max(start,t.firstSeen)), x2=tx(Math.min(end,t.endedAt||end)), y=py(t.price), n=t.maxNotional||t.lastNotional||0;
    const active=!t.endedAt, tier=whaleTier(n), strength=Math.sqrt(n/maxN);
    const alpha=Math.min(1,(active?.32:.10)+tier.alpha*.58*strength);
    const base=t.side==='sell'?[255,72,100]:[37,211,154];
    ctx.strokeStyle=`rgba(${base[0]},${base[1]},${base[2]},${alpha})`;
    ctx.lineWidth=active?Math.max(tier.width,2.2+7.5*strength):Math.max(1.3,tier.width*.45);
    if(!active) ctx.setLineDash([7,5]);
    ctx.beginPath();ctx.moveTo(x1,y);ctx.lineTo(x2,y);ctx.stroke();ctx.setLineDash([]);
    // soft band/glow for major walls, visually closer to institutional heat maps.
    if(active&&n>=10000000){
      ctx.strokeStyle=`rgba(${base[0]},${base[1]},${base[2]},${Math.min(.18,.05+.12*strength)})`;
      ctx.lineWidth=Math.max(12,tier.width*2.2);ctx.beginPath();ctx.moveTo(x1,y);ctx.lineTo(x2,y);ctx.stroke();
    }
    if(active&&x2-x1>34&&n>=5000000&&canPlaceWhaleLabel(y,12)){
      ctx.fillStyle=t.side==='sell'?'rgba(255,126,145,.92)':'rgba(96,230,187,.92)';ctx.font='7px -apple-system, sans-serif';
      const txt=`${tier.label?`${tier.label} `:''}${money(n)}`;ctx.fillText(txt,Math.min(x2-48,w-112),y-5);
    }
  }
  // De-clutter labels on small screens: keep a minimum vertical gap while preserving the strongest walls.
  const placedLabelYs=[];
  const canPlaceWhaleLabel=(y,gap=13)=>{ if(placedLabelYs.some(v=>Math.abs(v-y)<gap)) return false; placedLabelYs.push(y); return true; };
  // Current snapshot bands: guarantees distant large round-number liquidity is visible immediately.
  const currentBands=mergeWhaleBands(metrics?.walls||[],spot).filter(b=>Math.abs(b.price-spot)<=displayRange).slice(0,18);
  for(const b of currentBands){
    const y=py(b.price), tier=whaleTier(b.notional), base=b.side==='sell'?[255,72,100]:[37,211,154];
    const x1=pad.l+iw*.73, x2=pad.l+iw;
    ctx.strokeStyle=`rgba(${base[0]},${base[1]},${base[2]},${tier.alpha})`;ctx.lineWidth=tier.width;
    ctx.beginPath();ctx.moveTo(x1,y);ctx.lineTo(x2,y);ctx.stroke();
    if(b.notional>=10000000&&canPlaceWhaleLabel(y,14)){ctx.fillStyle=`rgba(${base[0]},${base[1]},${base[2]},.95)`;ctx.font='7px -apple-system, sans-serif';ctx.fillText(`${money(b.notional)} @ ${Math.round(b.price).toLocaleString()}`,Math.max(pad.l,x1-92),y-5);}
  }
  // 5m BTC candles, intentionally subtle so whale walls remain the primary visual layer.
  const candles=whaleCandles(start,end), candleW=Math.max(2,Math.min(7,iw/Math.max(20,candles.length)*.62));
  for(const c of candles){ if(c.h<minP||c.l>maxP) continue; const x=tx(c.ts+2.5*60*1000), up=c.c>=c.o, col=up?'#35c99b':'#e45770';ctx.strokeStyle=col;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(x,py(c.h));ctx.lineTo(x,py(c.l));ctx.stroke();const y1=py(Math.max(c.o,c.c)),y2=py(Math.min(c.o,c.c));ctx.fillStyle=col;ctx.fillRect(x-candleW/2,y1,candleW,Math.max(1,y2-y1)); }
  // current price
  ctx.strokeStyle='#f0b84a';ctx.lineWidth=1;ctx.setLineDash([5,4]);ctx.beginPath();ctx.moveTo(pad.l,py(spot));ctx.lineTo(pad.l+iw,py(spot));ctx.stroke();ctx.setLineDash([]);ctx.fillStyle='#f0b84a';ctx.font='9px -apple-system, sans-serif';ctx.fillText('現在 '+Math.round(spot).toLocaleString(),pad.l+4,py(spot)-5);
}
function renderWhaleOrderMap(){
  const card=$('btcWhaleCard'); if(!card) return; if(state.asset.symbol!=='BTC'){card.classList.add('hidden');return;} card.classList.remove('hidden');
  const displayRange=whaleDisplayRangeUsd();
  const zoom=whaleChartZoom();
  setText('whaleRangeStatus',`表示 ±$${displayRange.toLocaleString()} / 収集 ±$${WHALE_CAPTURE_RANGE_USD.toLocaleString()} / ${zoom===1?'標準':zoom===1.35?'拡大':'最大'}`);
  document.querySelectorAll('[data-whale-range]').forEach(b=>b.classList.toggle('active',Number(b.dataset.whaleRange)===displayRange));
  document.querySelectorAll('[data-whale-zoom]').forEach(b=>b.classList.toggle('active',Number(b.dataset.whaleZoom)===zoom));
  const m=whaleMetrics(); if(!m){setText('whalePressureBadge','取得中');setText('whaleBookAge','—');return;}
  const fmt=(x)=>x?priceFmt(x.price):'—'; setText('whaleNearestSell',fmt(m.nearestSell)); setText('whaleNearestBuy',fmt(m.nearestBuy)); setText('whaleNearestSellMeta',m.nearestSell?`+${((m.nearestSell.price/m.spot-1)*100).toFixed(2)}% / ${money(m.nearestSell.notional)}`:'—'); setText('whaleNearestBuyMeta',m.nearestBuy?`${((m.nearestBuy.price/m.spot-1)*100).toFixed(2)}% / ${money(m.nearestBuy.notional)}`:'—'); setText('whaleSellTotal',money(m.sellTotal)); setText('whaleBuyTotal',money(m.buyTotal));
  const total=m.sellTotal+m.buyTotal, sellPct=total?m.sellTotal/total:.5; const badge=$('whalePressureBadge'); let label='均衡',tone='neutral'; if(sellPct>=.62){label='売り壁優勢';tone='down';}else if(sellPct<=.38){label='買い壁優勢';tone='up';} if(badge){badge.textContent=label;badge.className=`signal-badge ${tone}`;} setText('whaleBookAge','LIVE + 履歴');
  let insight='大口板は拮抗しています。'; if(sellPct>=.62) insight=`上側の大口売り壁が優勢 (${(sellPct*100).toFixed(0)}%)。壁が長時間残るか、吸収・消失するかを監視。`; else if(sellPct<=.38) insight=`下側の大口買い壁が優勢 (${((1-sellPct)*100).toFixed(0)}%)。買い支えの継続時間と壁の消失を監視。`; if(m.nearestSell&&Math.abs(m.nearestSell.price/m.spot-1)<.004) insight+=' 直上0.4%以内に大口売り壁あり。'; if(m.nearestBuy&&Math.abs(m.nearestBuy.price/m.spot-1)<.004) insight+=' 直下0.4%以内に大口買い壁あり。';
  const bands=mergeWhaleBands(m.walls,m.spot), topSell=bands.filter(x=>x.side==='sell'&&x.price>m.spot)[0], topBuy=bands.filter(x=>x.side==='buy'&&x.price<m.spot)[0];
  if(topSell&&topSell.notional>=10000000) insight+=` 強い上壁 ${priceFmt(topSell.price)} (${money(topSell.notional)})。`;
  if(topBuy&&topBuy.notional>=10000000) insight+=` 強い下壁 ${priceFmt(topBuy.price)} (${money(topBuy.notional)})。`;
  setText('whaleInsight',insight);
  const list=$('whaleOrderList'); if(list){list.textContent=''; const top=[...m.walls].sort((a,b)=>b.notional-a.notional).slice(0,10), max=Math.max(1,...top.map(x=>x.notional)); for(const x of top){const row=document.createElement('div');row.className=`whale-order-row ${x.side}`;const p=document.createElement('b');p.textContent=priceFmt(x.price);const bar=document.createElement('div');bar.className='bar';const i=document.createElement('i');i.style.width=`${Math.max(4,100*x.notional/max)}%`;bar.appendChild(i);const val=document.createElement('strong');val.textContent=money(x.notional);const ds=document.createElement('small');const d=(x.price/m.spot-1)*100, tr=activeTrackForWall(x,m.spot);ds.textContent=`${d>=0?'+':''}${d.toFixed(2)}% · ${tr?formatDuration(Date.now()-tr.firstSeen):'new'}`;row.append(p,bar,val,ds);list.appendChild(row);} }
  renderWhaleCanvas(m);
}
function setWhaleLookback(hours){
  const h=[1,3,6].includes(Number(hours))?Number(hours):3; state.whaleLookbackMs=h*60*60*1000;
  document.querySelectorAll('[data-whale-hours]').forEach(b=>b.classList.toggle('active',Number(b.dataset.whaleHours)===h));
  renderWhaleOrderMap();
}
function setWhaleDisplayRange(range){
  const r=WHALE_DISPLAY_RANGE_OPTIONS.includes(Number(range))?Number(range):WHALE_DISPLAY_RANGE_DEFAULT_USD;
  state.whaleDisplayRangeUsd=r;
  try{localStorage.setItem('liqpulse_whale_display_range_usd',String(r));}catch{}
  document.querySelectorAll('[data-whale-range]').forEach(b=>b.classList.toggle('active',Number(b.dataset.whaleRange)===r));
  renderWhaleOrderMap();
}
function setWhaleChartZoom(value){
  const z=WHALE_CHART_ZOOM_OPTIONS.includes(Number(value))?Number(value):1;
  state.whaleChartZoom=z;
  try{localStorage.setItem('liqpulse_whale_chart_zoom',String(z));}catch{}
  document.querySelectorAll('[data-whale-zoom]').forEach(b=>b.classList.toggle('active',Number(b.dataset.whaleZoom)===z));
  renderWhaleOrderMap();
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
  if(state.asset.symbol!=='SP500'){ state.sp500Map=null; renderSp500Map(); return; }
  const relayBase=(CONFIG.relayBase||'').replace(/\/$/,'');
  if(!relayBase){ renderSp500Map(); return; }
  setText('sp500MapStatus','市場データ取得中');
  try{
    const raw=await fetchJsonWithTimeout(`${relayBase}/sp500-map`,CONFIG.relayTimeoutMs+5000);
    if(raw?.error || !Array.isArray(raw?.rows)) throw new Error(raw?.error||'invalid map response');
    state.sp500Map=raw; saveSp500Snapshot(raw); renderSp500Map();
  }catch(err){ console.warn('sp500-map',err); state.sp500Map=null; renderSp500Map(); }
}

async function fetchHeatmap(){
  if(!state.asset.heatmap){
    setText('statusHeatmap','未対応'); setText('statusHeatmapRoute','—'); state.heatmap=null; renderHeatmap(); renderLiqBias(); return;
  }
  setText('statusHeatmap','取得中'); setText('statusHeatmapRoute','接続中');
  const direct=CONFIG.heatmapDirect+encodeURIComponent(state.asset.symbol);
  const relayBase=(CONFIG.relayBase||'').replace(/\/$/,'');
  const routes=[];
  if(relayBase) routes.push({name:'Relay',url:`${relayBase}/heatmap/${encodeURIComponent(state.asset.symbol)}`});
  routes.push({name:'Direct',url:direct});
  let lastErr=null;
  for(const route of routes){
    try{
      const raw=await fetchJsonWithTimeout(route.url,CONFIG.relayTimeoutMs);
      const normalized=normalizeHeatmap(raw);
      if(!normalized.levels.length) throw new Error('No recognized liquidation levels');
      state.heatmap=normalized;
      saveHeatmapSnapshot();
      setText('statusHeatmap','正常'); setText('statusHeatmapRoute',route.name);
      renderHeatmap(); renderLiqBias(); renderPressure(); renderDecisionEngine(); return;
    }catch(err){ lastErr=err; console.warn('heatmap route failed',route.name,err); }
  }
  state.heatmap=null; setText('statusHeatmap','実データ未取得'); setText('statusHeatmapRoute',relayBase?'Relay / Direct確認済み':'Direct確認済み');
  console.warn('heatmap all routes failed',lastErr);
  renderHeatmap(); renderLiqBias(); renderRadar(); renderPressure(); renderDecisionEngine(); renderQuickView();
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
    setText('radarReason',`${side}。実清算データがないため、HyperliquidのL2板から近い大口反応帯を推定表示しています。清算価格・利確価格を直接観測したものではありません。`); return;
  }
  ['nearestShort','nearestLong','short5Total','long5Total'].forEach(id=>setText(id,'—'));
  setText('nearestShortMeta','—');setText('nearestLongMeta','—');setText('shortMomentum','—');setText('longMomentum','—');setText('radarBiasBadge','分析待ち');setText('radarReason','清算またはL2板データ取得後に表示します。');
}
function selectVisibleLevels(){
  const spot=state.latestPrice || state.ctxByCoin.get(state.asset.symbol)?.markPx;
  const lv=state.heatmap?.levels||[];
  if(!Number.isFinite(spot)) return {spot,above:[],below:[]};
  const below=lv.filter(x=>x.side==='long'&&x.price<spot).sort((a,b)=>b.price-a.price).slice(0,state.clusterDepth);
  const above=lv.filter(x=>x.side==='short'&&x.price>spot).sort((a,b)=>a.price-b.price).slice(0,state.clusterDepth);
  return {spot,above,below};
}

function renderHeatmap(){
  const host=$('heatmap'), note=$('heatmapNotice'), summary=$('clusterSummary');
  host.textContent=''; note.classList.add('hidden'); summary.classList.add('hidden'); summary.textContent=''; renderRadar();
  if(!state.asset.heatmap){
    note.textContent=`${state.asset.symbol}の実清算クラスターは上流ソースから取得できませんでした。価格・OI・Funding・Taker・Long/Shortは引き続きリアルタイム表示します。`;
    note.classList.remove('hidden'); setText('heatmapAge','未対応'); return;
  }
  if(!state.heatmap?.levels?.length){
    note.textContent=CONFIG.relayBase?'清算データを取得できませんでした。RelayとDirectの両方を再試行します。':'SafariのCORS制限でDirect取得できない場合があります。設定からCloudflare Relay URLを登録してください。';
    note.classList.remove('hidden'); setText('heatmapAge','取得待ち'); return;
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
    const d=distPct(x.price,spot);
    const row=document.createElement('div'); row.className='liq-row';
    const wallet=x.walletCount?` · ${x.walletCount} wallets`:'';
    let label=''; let labelClass='';
    if(x===nearestShort||x===nearestLong){label='一次トリガー';labelClass='trigger';}
    if(x===topShort){label=label?`${label} / 最大`:'上値の壁';labelClass='major-short';}
    if(x===topLong){label=label?`${label} / 最大`:'主要クラスター';labelClass='major-long';}
    const badge=label?`<em class="liq-label ${labelClass}">${label}</em>`:'';
    row.innerHTML=`<div class="liq-price"><b>${priceFmt(x.price)}</b><small>${Number.isFinite(d)?(d*100).toFixed(2)+'%':''}${wallet}</small>${badge}</div><div class="liq-track"><div class="liq-fill ${side}" style="width:${clamp(x.notional/max*100,2,100)}%"></div></div><div class="liq-value ${side==='short'?'green':'red'}">${money(x.notional)}</div>`;
    host.appendChild(row);
  });
  addRows([...above].reverse(),'short');
  const cur=document.createElement('div'); cur.className='current-line'; cur.textContent=`現在 ${priceFmt(spot)}`; host.appendChild(cur);
  addRows(below,'long');

  if(topShort||topLong){
    summary.innerHTML=`<div><span>上側最大</span><b class="green">${topShort?`${priceFmt(topShort.price)} · ${money(topShort.notional)}`:'—'}</b></div><div><span>下側最大</span><b class="red">${topLong?`${priceFmt(topLong.price)} · ${money(topLong.notional)}`:'—'}</b></div>`;
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
  if(!state.asset.positioning){ state.positioning=null; setText('statusPositioning','対象外'); renderPositioning(); return; }
  const relayBase=(CONFIG.relayBase||'').replace(/\/$/,'');
  if(!relayBase){ state.positioning=null; setText('statusPositioning','Relay未設定'); renderPositioning(); return; }
  setText('statusPositioning','取得中');
  try{
    const raw=await fetchJsonWithTimeout(`${relayBase}/positioning/${encodeURIComponent(state.asset.symbol)}`,CONFIG.relayTimeoutMs);
    const global=normalizeRatioPoint(raw?.global);
    const topAccounts=normalizeRatioPoint(raw?.topAccounts);
    const topPositions=normalizeRatioPoint(raw?.topPositions);
    if(!global&&!topAccounts&&!topPositions) throw new Error(raw?.error||'No ratio data');
    state.positioning={global,topAccounts,topPositions,sources:raw?.sources||{},timestamp:Number(raw?.timestamp)||Date.now(),errors:raw?.errors||[]};
    setText('statusPositioning','正常'); renderPositioning(); renderPressure(); renderDecisionEngine();
  }catch(err){
    console.warn('positioning',err); state.positioning=null; setText('statusPositioning','取得失敗'); renderPositioning(); renderPressure(); renderDecisionEngine();
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
  const age=$('positioningAge');
  if(age){
    if(!p){ age.textContent='取得待ち'; }
    else { const ms=Math.max(0,Date.now()-p.timestamp); age.textContent=ms<120000?'5分データ':`${Math.round(ms/60000)}分前`; }
  }
  const note=$('positioningNote');
  if(note){
    if(!p){
      note.textContent='公開Long/Short統計を取得できるとここに表示します。';
    }else{
      const gs=p.sources?.global||'不明';
      const ta=p.sources?.topAccounts;
      const tp=p.sources?.topPositions;
      let text=`全口座: ${gs}`;
      if(ta||tp) text+=` / Top Trader: ${ta||tp}`;
      else text+=' / Top Trader: 取得不可';
      text+='。Hyperliquid建玉比率ではありません。';
      note.textContent=text;
    }
  }
}


function decisionMetrics(){
  const flowRaw=flowTotals(), flow=flowRaw.total?flowRaw.buy/flowRaw.total:0.5;
  const liq=liquidationBias();
  const pos=state.positioning?.topPositions || state.positioning?.global || null;
  const ctx=state.ctxByCoin.get(state.asset.symbol);
  const funding=Number(ctx?.funding)||0;
  const mm=marketMomentum();
  const radar=radarMetrics();

  // Score = probability-like directional pressure index, not a price forecast.
  let up=50, weight=0, used=[];
  if(liq){ up += (liq.shortPct-.5)*44; weight+=30; used.push('清算偏り'); }
  if(flowRaw.total>0){ up += (flow-.5)*28; weight+=25; used.push('Taker'); }
  if(pos){
    // Crowded shorts can fuel an upside squeeze; crowded longs can fuel downside liquidation.
    up += (pos.short-pos.long)*24; weight+=20; used.push('L/S');
  }
  if(Number.isFinite(funding)){
    // Positive funding = longs pay shorts, so extreme positive funding is a mild downside-risk input.
    up -= clamp(funding*10000,-1,1)*6; weight+=10; used.push('Funding');
  }
  if(mm && Number.isFinite(mm.oiChange) && Number.isFinite(mm.priceChange)){
    const oiStrength=clamp(Math.abs(mm.oiChange)/0.02,0,1);
    if(mm.oiChange>0){ up += Math.sign(mm.priceChange||0)*6*oiStrength; }
    weight+=10; used.push('OI変化');
  }
  const ez=estimatedTriggerZones();
  if(ez){
    // More bid depth supports downside absorption; more ask depth supports upside resistance.
    up += (ez.bidPct-.5)*16; weight+=15; used.push('L2板');
  }
  if(radar?.nearestShort && radar?.nearestLong){
    const su=Math.abs(distPct(radar.nearestShort.price,radar.spot));
    const ld=Math.abs(distPct(radar.nearestLong.price,radar.spot));
    const sFuel=radar.nearestShort.notional/Math.max(su,0.0005);
    const lFuel=radar.nearestLong.notional/Math.max(ld,0.0005);
    const sum=sFuel+lFuel;
    if(sum>0) up += ((sFuel/sum)-.5)*10;
    weight+=5; used.push('最寄り清算');
  }
  if(state.asset.symbol==='SP500'){
    const sp=sp500Analytics();
    if(sp){
      up += (sp.advPct-.5)*34;
      up += clamp(sp.equalWeighted/2,-1,1)*8;
      if(Number.isFinite(sp.capWeighted)) up += clamp(sp.capWeighted/2,-1,1)*7;
      up += (sp.sectorPct-.5)*10;
      if(Number.isFinite(sp.mega7)) up += clamp(sp.mega7/2,-1,1)*4;
      weight+=35; used.push('S&P500内部');
    }
  }
  up=clamp(up,0,100); const down=100-up;
  const spread=Math.abs(up-50)*2;
  const completeness=clamp(weight/100,0,1);
  const confidence=Math.round(clamp(spread*0.65 + completeness*35,0,100));
  let label='中立', tone='neutral';
  if(up>=62){label='上方向スクイーズ警戒';tone='up';}
  else if(up>=55){label='やや上方向';tone='up';}
  else if(up<=38){label='下方向カスケード警戒';tone='down';}
  else if(up<=45){label='やや下方向';tone='down';}

  const reasons=[];
  if(liq){
    reasons.push(liq.shortPct>liq.longPct
      ? `上側の距離加重清算が優勢 (${(liq.shortPct*100).toFixed(0)}%)`
      : `下側の距離加重清算が優勢 (${(liq.longPct*100).toFixed(0)}%)`);
  }
  if(flowRaw.total>0){ reasons.push(`Takerは ${flow>=.5?'買い':'売り'} ${(Math.max(flow,1-flow)*100).toFixed(0)}%`); }
  if(pos){ reasons.push(`全口座L/S ${pos.ratio.toFixed(2)} (${pos.long>.5?'Long':'Short'} ${(Math.max(pos.long,pos.short)*100).toFixed(1)}%)`); }
  if(mm && Number.isFinite(mm.oiChange)){
    reasons.push(`OI 15分 ${mm.oiChange>=0?'+':''}${(mm.oiChange*100).toFixed(2)}%${Number.isFinite(mm.priceChange)?` / 価格 ${mm.priceChange>=0?'+':''}${(mm.priceChange*100).toFixed(2)}%`:''}`);
  }
  if(ez){ reasons.push(`L2板 ${ez.bidPct>=.5?'買い':'売り'}側 ${(Math.max(ez.bidPct,ez.askPct)*100).toFixed(0)}%`); }
  if(state.asset.symbol==='SP500'){
    const sp=sp500Analytics();
    if(sp) reasons.unshift(`S&P500参加率 ${(sp.advPct*100).toFixed(0)}% / 健全度 ${sp.healthScore}`);
  }
  return {up,down,confidence,label,tone,reasons:reasons.slice(0,4),used,mm};
}

function quickDecision(){
  const d=decisionMetrics();
  const radar=radarMetrics();
  const delta=d.up-d.down;
  let dominance='均衡', dominanceTone='neutral';
  if(delta>=8){ dominance='LONG優勢'; dominanceTone='up'; }
  else if(delta<=-8){ dominance='SHORT優勢'; dominanceTone='down'; }

  // Do not force a trade when the signal is weak or incomplete.
  let action='見送り', actionTone='neutral';
  const edge=Math.abs(delta);
  if(d.confidence>=55 && edge>=16){
    if(delta>0){ action='LONG候補'; actionTone='up'; }
    else { action='SHORT候補'; actionTone='down'; }
  }
  if(d.confidence>=70 && edge>=28){
    action=delta>0?'LONG優先':'SHORT優先';
  }

  const flow=flowTotals();
  const buyPct=flow.total?flow.buy/flow.total:0.5;
  const mm=d.mm;
  let alert='通常', alertTone='neutral';
  const extremeFlow=flow.total>0 && (buyPct>=0.85 || buyPct<=0.15);
  const fastPrice=mm && Number.isFinite(mm.priceChange) && Math.abs(mm.priceChange)>=0.01;
  const fastOi=mm && Number.isFinite(mm.oiChange) && Math.abs(mm.oiChange)>=0.02;
  if(extremeFlow){ alert=buyPct>.5?'買いフロー急増':'売りフロー急増'; alertTone=buyPct>.5?'up':'down'; }
  if(fastPrice || fastOi){ alert='急変警戒'; alertTone=delta>=0?'up':'down'; }

  return {d,radar,dominance,dominanceTone,action,actionTone,alert,alertTone,edge};
}
function renderQuickView(){
  const q=quickDecision();
  const {d,radar}=q;
  const isSp500=state.asset.symbol==='SP500';
  const liqTitle=document.querySelector('.quick-liq-title');
  if(liqTitle) liqTitle.textContent=isSp500?'直近の推定反応ライン':'直近の清算ライン';
  setText('quickDominance',q.dominance);
  setText('quickDominanceMeta',`LONG ${Math.round(d.up)} / SHORT ${Math.round(d.down)}`);
  setText('quickAction',q.action);
  setText('quickActionMeta',`信頼度 ${d.confidence}%`);

  const dom=$('quickDominance'); if(dom) dom.className=q.dominanceTone==='up'?'green':q.dominanceTone==='down'?'red':'';
  const act=$('quickAction'); if(act) act.className=q.actionTone==='up'?'green':q.actionTone==='down'?'red':'';
  const badge=$('quickAlert'); if(badge){ badge.textContent=q.alert; badge.className=`signal-badge ${q.alertTone}`; }

  if(radar?.nearestShort){
    const ds=Math.abs(distPct(radar.nearestShort.price,radar.spot));
    setText('quickShortLine',priceFmt(radar.nearestShort.price));
    setText('quickShortLineMeta',`現在値から +${(ds*100).toFixed(2)}% / ${money(radar.nearestShort.notional)}`);
  }else{
    const ez=estimatedTriggerZones();
    if(ez?.up){ setText('quickShortLine',priceFmt(ez.up.price)); setText('quickShortLineMeta',`推定上側反応帯 +${(ez.up.distance*100).toFixed(2)}% / 板 ${money(ez.up.notional)} ※実清算ではありません`); }
    else { setText('quickShortLine','—'); setText('quickShortLineMeta',state.asset.heatmap?'実清算データ待ち':'推定上側反応帯を計算中'); }
  }
  if(radar?.nearestLong){
    const dl=Math.abs(distPct(radar.nearestLong.price,radar.spot));
    setText('quickLongLine',priceFmt(radar.nearestLong.price));
    setText('quickLongLineMeta',`現在値から -${(dl*100).toFixed(2)}% / ${money(radar.nearestLong.notional)}`);
  }else{
    const ez=estimatedTriggerZones();
    if(ez?.down){ setText('quickLongLine',priceFmt(ez.down.price)); setText('quickLongLineMeta',`推定下側反応帯 -${(ez.down.distance*100).toFixed(2)}% / 板 ${money(ez.down.notional)} ※実清算ではありません`); }
    else { setText('quickLongLine','—'); setText('quickLongLineMeta',state.asset.heatmap?'実清算データ待ち':'推定下側反応帯を計算中'); }
  }

  let advice='方向感は拮抗しています。無理なエントリーは避ける判定です。';
  if(q.action.startsWith('LONG')) advice=`${q.dominance}。現状はLONG側を優先候補。ただし清算ライン到達や急変時は再判定してください。`;
  else if(q.action.startsWith('SHORT')) advice=`${q.dominance}。現状はSHORT側を優先候補。ただし清算ライン到達や急変時は再判定してください。`;
  else if(q.dominance==='LONG優勢') advice=`LONG側がやや優勢ですが信頼度が不足しています。現在は見送り優先です。`;
  else if(q.dominance==='SHORT優勢') advice=`SHORT側がやや優勢ですが信頼度が不足しています。現在は見送り優先です。`;
  setText('quickAdvice',advice);
}

function renderDecisionEngine(){
  const d=decisionMetrics(); state.decision=d;
  if(!d) return;
  setText('engineUp',Math.round(d.up)); setText('engineDown',Math.round(d.down));
  $('engineUpBar').style.width=d.up+'%'; $('engineDownBar').style.width=d.down+'%';
  setText('engineLabel',d.label); setText('engineConfidence',`信頼度 ${d.confidence}%`);
  const badge=$('engineLabel'); if(badge) badge.className=`signal-badge ${d.tone}`;
  const reasons=$('engineReasons');
  if(reasons){ reasons.textContent=''; d.reasons.forEach(x=>{const li=document.createElement('li');li.textContent=x;reasons.appendChild(li);}); }
  const mm=d.mm;
  setText('oi15m',mm&&Number.isFinite(mm.oiChange)?`${mm.oiChange>=0?'+':''}${(mm.oiChange*100).toFixed(2)}%`:'—');
  setText('price15m',mm&&Number.isFinite(mm.priceChange)?`${mm.priceChange>=0?'+':''}${(mm.priceChange*100).toFixed(2)}%`:'—');
  const f=Number(state.ctxByCoin.get(state.asset.symbol)?.funding);
  let fs='中立'; if(Number.isFinite(f)){ if(f>0.0001) fs='Long過熱寄り'; else if(f<-0.0001) fs='Short過熱寄り'; }
  setText('fundingState',fs);
  setText('positionSource',state.positioning?.sources?.global||'—');
  renderQuickView();
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
  state.timers.push(setInterval(()=>{
    state.tradeEvents=state.tradeEvents.filter(x=>x.ts>=Date.now()-CONFIG.maxTradeWindowMs);
    renderFlow(); renderPressure(); renderDecisionEngine();
    if(Date.now()-state.lastWsAt>CONFIG.wsStaleMs && state.ws?.readyState===1){ try{state.ws.close();}catch{} }
  },5000));
}


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

$('refreshBtn').addEventListener('click',()=>Promise.allSettled([fetchMeta(),fetchHeatmap(),fetchPositioning(),fetchOrderBook(),fetchSp500Map()]));
$('testRelayBtn')?.addEventListener('click',testRelay);
$('clearRelayBtn')?.addEventListener('click',clearRelay);
$('flowWindow').addEventListener('change',(e)=>{ state.flowWindowMs=Number(e.target.value)||300000; renderFlow(); renderPressure(); });
$('clusterDepth')?.addEventListener('change',(e)=>{ state.clusterDepth=Number(e.target.value)||8; renderHeatmap(); });
$('sp500MapLimit')?.addEventListener('change',(e)=>{ state.sp500MapLimit=Number(e.target.value)||80; renderSp500Map(); });
window.addEventListener('online',()=>{connectWs(true); fetchMeta(); fetchHeatmap(); fetchPositioning(); fetchOrderBook(); fetchSp500Map();});
window.addEventListener('offline',()=>setStatus('error','OFFLINE'));
document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible'){ connectWs(); fetchMeta(); fetchHeatmap(); fetchPositioning(); fetchOrderBook(); fetchSp500Map(); } });

(async function init(){
  state.whaleHistory=loadWhaleHistory();
  state.whaleTracks=loadWhaleTracks();
  renderAssetTabs(); updateAssetSpecificPanels(); renderBase(); renderFlow(); renderHeatmap(); renderLiqBias(); renderRadar(); renderPositioning(); renderDecisionEngine(); renderQuickView(); renderSp500Command(); renderWhaleOrderMap(); renderRelaySettings();
  connectWs(); setupTimers();
  await Promise.allSettled([fetchMeta(),fetchHeatmap(),fetchPositioning(),fetchOrderBook(),fetchSp500Map()]);
  if('serviceWorker' in navigator){
    try{
      const reg=await navigator.serviceWorker.register('./sw.js');
      reg.update().catch(()=>{});
    }catch(err){ console.warn('service worker',err); }
  }
})();

// LiqPulse v1.2.0
