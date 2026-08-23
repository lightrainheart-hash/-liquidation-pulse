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
  orderBookPollMs: 15000,
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
  asset: ASSETS[0],
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
  timers:[],
  switching:false,
  lastWsAt:0,
  decision:null,
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

async function switchAsset(symbol){
  if(state.switching || symbol===state.asset.symbol) return;
  state.switching=true;
  state.asset=ASSETS.find(x=>x.symbol===symbol)||ASSETS[0];
  state.tradeEvents=[]; state.heatmap=null; state.positioning=null; state.orderbook=null; state.latestPrice=null;
  renderAssetTabs(); renderBase(); renderFlow(); renderHeatmap(); renderLiqBias(); renderRadar(); renderPositioning(); renderDecisionEngine(); renderQuickView(); renderRelaySettings();
  connectWs(true);
  await Promise.allSettled([fetchMeta(), fetchHeatmap(), fetchPositioning(), fetchOrderBook()]);
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
    const req={type:'metaAndAssetCtxs'}; if(state.asset.dex) req.dex=state.asset.dex;
    const res=await fetch(CONFIG.infoUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(req),cache:'no-store'});
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const data=await res.json();
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
    state.tradeEvents.push({ts,usd:px*sz,buy:t.side==='B'});
    state.latestPrice=px;
  }
  state.tradeEvents=state.tradeEvents.filter(x=>x.ts>=now-CONFIG.maxTradeWindowMs);
  renderFlow(); renderBase(); renderPressure(); renderDecisionEngine();
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
  return {bids:conv(levels[0],'bid'),asks:conv(levels[1],'ask'),timestamp:Number(raw?.time)||Date.now(),coin:raw?.coin||state.asset.apiCoin};
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
  setText('statusOrderBook',ob?'正常':'取得失敗');
  if(!ob) console.warn('orderbook',err);
  renderQuickView(); renderDecisionEngine();
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
  if(!state.asset.positioning){ state.positioning=null; setText('statusPositioning','未対応'); renderPositioning(); return; }
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

$('refreshBtn').addEventListener('click',()=>Promise.allSettled([fetchMeta(),fetchHeatmap(),fetchPositioning(),fetchOrderBook()]));
$('testRelayBtn')?.addEventListener('click',testRelay);
$('clearRelayBtn')?.addEventListener('click',clearRelay);
$('flowWindow').addEventListener('change',(e)=>{ state.flowWindowMs=Number(e.target.value)||300000; renderFlow(); renderPressure(); });
$('clusterDepth')?.addEventListener('change',(e)=>{ state.clusterDepth=Number(e.target.value)||8; renderHeatmap(); });
window.addEventListener('online',()=>{connectWs(true); fetchMeta(); fetchHeatmap(); fetchPositioning(); fetchOrderBook();});
window.addEventListener('offline',()=>setStatus('error','OFFLINE'));
document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible'){ connectWs(); fetchMeta(); fetchHeatmap(); fetchPositioning(); fetchOrderBook(); } });

(async function init(){
  renderAssetTabs(); renderBase(); renderFlow(); renderHeatmap(); renderLiqBias(); renderRadar(); renderPositioning(); renderDecisionEngine(); renderQuickView(); renderRelaySettings();
  connectWs(); setupTimers();
  await Promise.allSettled([fetchMeta(),fetchHeatmap(),fetchPositioning(),fetchOrderBook()]);
  if('serviceWorker' in navigator){
    try{
      const reg=await navigator.serviceWorker.register('./sw.js');
      reg.update().catch(()=>{});
    }catch(err){ console.warn('service worker',err); }
  }
})();

// LiqPulse v0.9.0
