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
  relayTimeoutMs: 10000,
  maxTradeWindowMs: 60 * 60 * 1000,
  wsStaleMs: 15000,
  liqBiasRangePct: 0.10,
};

const ASSETS = [
  { symbol:'BTC', name:'Bitcoin', heatmap:true },
  { symbol:'ETH', name:'Ethereum', heatmap:true },
  { symbol:'SOL', name:'Solana', heatmap:true },
  { symbol:'XRP', name:'XRP', heatmap:false },
  { symbol:'ZEC', name:'Zcash', heatmap:false },
];

const state = {
  asset: ASSETS[0],
  ws:null,
  wsBackoff:1000,
  tradeEvents:[],
  flowWindowMs:300000,
  ctxByCoin:new Map(),
  latestPrice:null,
  heatmap:null,
  timers:[],
  switching:false,
  lastWsAt:0,
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
  state.tradeEvents=[]; state.heatmap=null; state.latestPrice=null;
  renderAssetTabs(); renderBase(); renderFlow(); renderHeatmap(); renderLiqBias(); renderRelaySettings();
  connectWs(true);
  await Promise.allSettled([fetchMeta(), fetchHeatmap()]);
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

async function fetchMeta(){
  try{
    const res=await fetch(CONFIG.infoUrl,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'metaAndAssetCtxs'}),cache:'no-store'});
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
    setText('statusInfo','正常');
    renderBase(); renderPressure();
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
    ws.send(JSON.stringify({method:'subscribe',subscription:{type:'trades',coin:state.asset.symbol}}));
    ws.send(JSON.stringify({method:'subscribe',subscription:{type:'allMids'}}));
  };
  ws.onmessage=(ev)=>{
    state.lastWsAt=Date.now();
    let msg; try{msg=JSON.parse(ev.data);}catch{return;}
    if(msg.channel==='trades' && Array.isArray(msg.data)) ingestTrades(msg.data);
    if(msg.channel==='allMids' && msg.data?.mids){
      const p=Number(msg.data.mids[state.asset.symbol]);
      if(Number.isFinite(p)){ state.latestPrice=p; setText('price',priceFmt(p)); renderHeatmap(); renderLiqBias(); renderPressure(); }
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
  renderFlow(); renderBase(); renderPressure();
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
      setText('statusHeatmap','正常'); setText('statusHeatmapRoute',route.name);
      renderHeatmap(); renderLiqBias(); renderPressure(); return;
    }catch(err){ lastErr=err; console.warn('heatmap route failed',route.name,err); }
  }
  state.heatmap=null; setText('statusHeatmap','取得失敗'); setText('statusHeatmapRoute',relayBase?'Relay / Direct失敗':'Relay未設定 / Direct失敗');
  console.warn('heatmap all routes failed',lastErr);
  renderHeatmap(); renderLiqBias(); renderPressure();
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
function selectVisibleLevels(){
  const spot=state.latestPrice || state.ctxByCoin.get(state.asset.symbol)?.markPx;
  const lv=state.heatmap?.levels||[];
  if(!Number.isFinite(spot)) return {spot,above:[],below:[]};
  const below=lv.filter(x=>x.side==='long'&&x.price<spot).sort((a,b)=>b.price-a.price).slice(0,8);
  const above=lv.filter(x=>x.side==='short'&&x.price>spot).sort((a,b)=>a.price-b.price).slice(0,8);
  return {spot,above,below};
}

function renderHeatmap(){
  const host=$('heatmap'), note=$('heatmapNotice'), summary=$('clusterSummary');
  host.textContent=''; note.classList.add('hidden'); summary.classList.add('hidden'); summary.textContent='';
  if(!state.asset.heatmap){
    note.textContent=`${state.asset.symbol}の実ポジション清算マップは現在未対応。価格・OI・Funding・Takerフローはリアルタイムです。`;
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
  const addRows=(arr,side)=>arr.forEach(x=>{
    const d=distPct(x.price,spot);
    const row=document.createElement('div'); row.className='liq-row';
    const wallet=x.walletCount?` · ${x.walletCount} wallets`:'';
    row.innerHTML=`<div class="liq-price"><b>${priceFmt(x.price)}</b><small>${Number.isFinite(d)?(d*100).toFixed(2)+'%':''}${wallet}</small></div><div class="liq-track"><div class="liq-fill ${side}" style="width:${clamp(x.notional/max*100,2,100)}%"></div></div><div class="liq-value ${side==='short'?'green':'red'}">${money(x.notional)}</div>`;
    host.appendChild(row);
  });
  addRows(above,'short');
  const cur=document.createElement('div'); cur.className='current-line'; cur.textContent=`現在 ${priceFmt(spot)}`; host.appendChild(cur);
  addRows(below,'long');

  const topShort=[...above].sort((a,b)=>b.notional-a.notional)[0];
  const topLong=[...below].sort((a,b)=>b.notional-a.notional)[0];
  if(topShort||topLong){
    summary.innerHTML=`<div><span>上側最大</span><b class="green">${topShort?`${priceFmt(topShort.price)} · ${money(topShort.notional)}`:'—'}</b></div><div><span>下側最大</span><b class="red">${topLong?`${priceFmt(topLong.price)} · ${money(topLong.notional)}`:'—'}</b></div>`;
    summary.classList.remove('hidden');
  }

  const age=Math.max(0,Date.now()-state.heatmap.timestamp);
  setText('heatmapAge',age<120000?'LIVE':`${Math.round(age/60000)}分前`);
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

function renderPressure(){
  const f=flowTotals(); const flow=f.total?f.buy/f.total:0.5;
  const funding=state.ctxByCoin.get(state.asset.symbol)?.funding || 0;
  let up=50+(flow-.5)*30, down=50-(flow-.5)*30;
  const b=liquidationBias();
  if(b){ const skew=b.shortPct-b.longPct; up+=skew*32; down-=skew*32; }
  const fAdj=clamp(funding*12000,-10,10); up-=fAdj; down+=fAdj;
  setText('upScore',Math.round(clamp(up,0,100))+'/100'); setText('downScore',Math.round(clamp(down,0,100))+'/100');
}

function setupTimers(){
  state.timers.forEach(clearInterval); state.timers=[];
  state.timers.push(setInterval(fetchMeta,CONFIG.infoPollMs));
  state.timers.push(setInterval(fetchHeatmap,CONFIG.heatmapPollMs));
  state.timers.push(setInterval(()=>{
    state.tradeEvents=state.tradeEvents.filter(x=>x.ts>=Date.now()-CONFIG.maxTradeWindowMs);
    renderFlow(); renderPressure();
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

$('refreshBtn').addEventListener('click',()=>Promise.allSettled([fetchMeta(),fetchHeatmap()]));
$('testRelayBtn')?.addEventListener('click',testRelay);
$('clearRelayBtn')?.addEventListener('click',clearRelay);
$('flowWindow').addEventListener('change',(e)=>{ state.flowWindowMs=Number(e.target.value)||300000; renderFlow(); renderPressure(); });
window.addEventListener('online',()=>{connectWs(true); fetchMeta(); fetchHeatmap();});
window.addEventListener('offline',()=>setStatus('error','OFFLINE'));
document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible'){ connectWs(); fetchMeta(); fetchHeatmap(); } });

(async function init(){
  renderAssetTabs(); renderBase(); renderFlow(); renderHeatmap(); renderLiqBias(); renderRelaySettings();
  connectWs(); setupTimers();
  await Promise.allSettled([fetchMeta(),fetchHeatmap()]);
  if('serviceWorker' in navigator){
    try{
      const reg=await navigator.serviceWorker.register('./sw.js');
      reg.update().catch(()=>{});
    }catch(err){ console.warn('service worker',err); }
  }
})();
