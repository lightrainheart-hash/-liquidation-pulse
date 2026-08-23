'use strict';

const CONFIG = {
  infoUrl: 'https://api.hyperliquid.xyz/info',
  wsUrl: 'wss://api.hyperliquid.xyz/ws',
  heatmapBase: 'https://trade.hyperperps.app/api/public/heatmap/',
  infoPollMs: 15000,
  heatmapPollMs: 60000,
  tradeWindowMs: 5 * 60 * 1000,
  wsStaleMs: 12000,
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
function pct(v, digits=4){
  if(!Number.isFinite(v)) return '—';
  return `${(v*100).toFixed(digits)}%`;
}
function clamp(v,min,max){return Math.max(min,Math.min(max,v));}
function setStatus(kind,text){
  const el=$('connBadge'); el.className=`status ${kind}`; el.querySelector('b').textContent=text;
}

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
  renderAssetTabs(); renderBase(); renderFlow(); renderHeatmap();
  connectWs(true);
  await Promise.allSettled([fetchMeta(), fetchHeatmap()]);
  state.switching=false;
}

function renderBase(){
  $('assetName').textContent=state.asset.name;
  $('price').textContent=priceFmt(state.latestPrice);
  const c=state.ctxByCoin.get(state.asset.symbol);
  $('markPx').textContent=c?priceFmt(c.markPx):'—';
  $('openInterest').textContent=c?money(c.openInterestUsd):'—';
  $('funding').textContent=c?pct(c.funding,4):'—';
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
    $('statusInfo').textContent='正常';
    renderBase(); renderPressure();
  }catch(err){
    console.warn('meta',err); $('statusInfo').textContent='取得失敗';
  }
}

function connectWs(force=false){
  if(force && state.ws){ try{state.ws.onclose=null; state.ws.close();}catch{} state.ws=null; }
  if(state.ws && (state.ws.readyState===0 || state.ws.readyState===1)) return;
  setStatus('offline','接続中'); $('statusWs').textContent='接続中';
  const ws=new WebSocket(CONFIG.wsUrl); state.ws=ws;
  ws.onopen=()=>{
    state.wsBackoff=1000; state.lastWsAt=Date.now(); setStatus('online','LIVE'); $('statusWs').textContent='LIVE';
    ws.send(JSON.stringify({method:'subscribe',subscription:{type:'trades',coin:state.asset.symbol}}));
    ws.send(JSON.stringify({method:'subscribe',subscription:{type:'allMids'}}));
  };
  ws.onmessage=(ev)=>{
    state.lastWsAt=Date.now();
    let msg; try{msg=JSON.parse(ev.data);}catch{return;}
    if(msg.channel==='trades' && Array.isArray(msg.data)) ingestTrades(msg.data);
    if(msg.channel==='allMids' && msg.data?.mids){
      const p=Number(msg.data.mids[state.asset.symbol]); if(Number.isFinite(p)){state.latestPrice=p; $('price').textContent=priceFmt(p); renderHeatmap();}
    }
  };
  ws.onerror=()=>{setStatus('error','再接続');};
  ws.onclose=()=>{
    if(state.ws!==ws) return;
    $('statusWs').textContent='再接続中'; setStatus('error','再接続');
    const wait=state.wsBackoff; state.wsBackoff=Math.min(30000,state.wsBackoff*2);
    setTimeout(()=>connectWs(),wait);
  };
}

function ingestTrades(trades){
  const now=Date.now();
  for(const t of trades){
    const px=Number(t.px), sz=Number(t.sz), ts=Number(t.time)||now;
    if(!Number.isFinite(px)||!Number.isFinite(sz)) continue;
    // Hyperliquid trade side: B = aggressive buyer, A = aggressive seller.
    state.tradeEvents.push({ts,usd:px*sz,buy:t.side==='B'});
    state.latestPrice=px;
  }
  state.tradeEvents=state.tradeEvents.filter(x=>x.ts>=now-CONFIG.tradeWindowMs);
  renderFlow(); renderBase(); renderPressure();
}

function flowTotals(){
  const cutoff=Date.now()-CONFIG.tradeWindowMs; let buy=0,sell=0,count=0;
  for(const t of state.tradeEvents){if(t.ts<cutoff) continue; count++; if(t.buy) buy+=t.usd; else sell+=t.usd;}
  return {buy,sell,count,total:buy+sell};
}
function renderFlow(){
  const f=flowTotals(), lp=f.total?f.buy/f.total:0.5, sp=1-lp;
  $('longPct').textContent=(lp*100).toFixed(1)+'%'; $('shortPct').textContent=(sp*100).toFixed(1)+'%';
  $('longBar').style.width=(lp*100)+'%'; $('shortBar').style.width=(sp*100)+'%';
  $('buyUsd').textContent=money(f.buy); $('sellUsd').textContent=money(f.sell); $('tradeCount').textContent=`${f.count.toLocaleString()} trades`;
}

async function fetchHeatmap(){
  if(!state.asset.heatmap){
    $('statusHeatmap').textContent='未対応'; state.heatmap=null; renderHeatmap(); return;
  }
  $('statusHeatmap').textContent='取得中';
  try{
    const res=await fetch(CONFIG.heatmapBase+encodeURIComponent(state.asset.symbol),{cache:'no-store'});
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw=await res.json();
    state.heatmap=normalizeHeatmap(raw);
    $('statusHeatmap').textContent=state.heatmap.levels.length?'正常':'形式未対応';
  }catch(err){
    console.warn('heatmap',err); state.heatmap=null; $('statusHeatmap').textContent='取得失敗';
  }
  renderHeatmap(); renderPressure();
}

function normalizeHeatmap(raw){
  // The public API is intentionally parsed defensively because the provider marks the endpoint as public but may evolve its schema.
  const levels=[];
  const push=(x,sideHint)=>{
    if(!x||typeof x!=='object') return;
    const p=Number(x.price ?? x.liqPrice ?? x.liquidationPrice ?? x.level ?? x.px);
    const n=Number(x.notional ?? x.sizeUsd ?? x.usd ?? x.value ?? x.size ?? x.totalNotional);
    let side=(x.side ?? x.direction ?? x.type ?? sideHint ?? '').toString().toLowerCase();
    if(side.includes('short')||side==='s') side='short'; else if(side.includes('long')||side==='l') side='long'; else side='';
    if(Number.isFinite(p)&&Number.isFinite(n)&&n>0) levels.push({price:p,notional:n,side});
  };
  const walk=(node,keyHint='',depth=0)=>{
    if(depth>5 || node==null) return;
    if(Array.isArray(node)){ node.forEach(x=>{push(x,keyHint); if(typeof x==='object') walk(x,keyHint,depth+1);}); return; }
    if(typeof node!=='object') return;
    for(const [k,v] of Object.entries(node)){
      const kh=k.toLowerCase(); let hint=keyHint;
      if(kh.includes('short')) hint='short'; if(kh.includes('long')) hint='long';
      if(Array.isArray(v)||typeof v==='object') walk(v,hint,depth+1);
    }
  };
  walk(raw);
  // deduplicate; infer side from spot when absent
  const spot=state.latestPrice || state.ctxByCoin.get(state.asset.symbol)?.markPx;
  const m=new Map();
  for(const x of levels){
    if(!x.side && Number.isFinite(spot)) x.side=x.price>spot?'short':'long';
    const key=`${x.side}:${x.price.toFixed(6)}`; const prev=m.get(key); if(!prev||x.notional>prev.notional)m.set(key,x);
  }
  const ts=Number(raw?.timestamp ?? raw?.updatedAt ?? raw?.updated_at ?? raw?.time) || Date.now();
  return {levels:[...m.values()],timestamp:ts<1e12?ts*1000:ts,raw};
}

function renderHeatmap(){
  const host=$('heatmap'), note=$('heatmapNotice'); host.textContent=''; note.classList.add('hidden');
  if(!state.asset.heatmap){
    note.textContent=`${state.asset.symbol}の実ポジション清算マップはV0.1では未対応。価格・OI・Funding・取引フローはリアルタイム表示します。`;
    note.classList.remove('hidden'); $('heatmapAge').textContent='未対応'; return;
  }
  if(!state.heatmap?.levels?.length){
    note.textContent='清算データ取得待ち。HyperPerps公開APIがSafariから直接取得できない場合は、次版でCloudflareの軽量プロキシを追加します。';
    note.classList.remove('hidden'); $('heatmapAge').textContent='取得待ち'; return;
  }
  const spot=state.latestPrice || state.ctxByCoin.get(state.asset.symbol)?.markPx;
  const lv=state.heatmap.levels.filter(x=>x.side==='long'||x.side==='short');
  const below=lv.filter(x=>x.side==='long').sort((a,b)=>b.price-a.price).slice(0,8);
  const above=lv.filter(x=>x.side==='short').sort((a,b)=>a.price-b.price).slice(0,8);
  const max=Math.max(1,...below.map(x=>x.notional),...above.map(x=>x.notional));
  const addRows=(arr,side)=>arr.forEach(x=>{
    const row=document.createElement('div'); row.className='liq-row';
    row.innerHTML=`<div class="liq-price">${priceFmt(x.price)}</div><div class="liq-track"><div class="liq-fill ${side}" style="width:${clamp(x.notional/max*100,2,100)}%"></div></div><div class="liq-value ${side==='short'?'green':'red'}">${money(x.notional)}</div>`;
    host.appendChild(row);
  });
  addRows(above,'short');
  const cur=document.createElement('div'); cur.className='current-line'; cur.textContent=`現在 ${priceFmt(spot)}`; host.appendChild(cur);
  addRows(below,'long');
  const age=Math.max(0,Date.now()-state.heatmap.timestamp); $('heatmapAge').textContent=age<120000?'LIVE':`${Math.round(age/60000)}分前`;
}

function renderPressure(){
  const f=flowTotals(); const flow=f.total?f.buy/f.total:0.5;
  const funding=state.ctxByCoin.get(state.asset.symbol)?.funding || 0;
  let up=50+(flow-.5)*45, down=50-(flow-.5)*45;
  const lv=state.heatmap?.levels||[], spot=state.latestPrice;
  if(Number.isFinite(spot)&&lv.length){
    let s=0,l=0;
    for(const x of lv){const dist=Math.abs(x.price-spot)/spot; const w=Math.exp(-dist*18); if(x.side==='short')s+=x.notional*w; if(x.side==='long')l+=x.notional*w;}
    const tot=s+l; if(tot){const skew=(s-l)/tot; up+=skew*30; down-=skew*30;}
  }
  // Positive funding mildly penalizes upside squeeze and increases long-cascade vulnerability.
  const fAdj=clamp(funding*12000,-10,10); up-=fAdj; down+=fAdj;
  $('upScore').textContent=Math.round(clamp(up,0,100))+'/100'; $('downScore').textContent=Math.round(clamp(down,0,100))+'/100';
}

function setupTimers(){
  state.timers.forEach(clearInterval); state.timers=[];
  state.timers.push(setInterval(fetchMeta,CONFIG.infoPollMs));
  state.timers.push(setInterval(fetchHeatmap,CONFIG.heatmapPollMs));
  state.timers.push(setInterval(()=>{
    renderFlow(); renderPressure();
    if(Date.now()-state.lastWsAt>CONFIG.wsStaleMs && state.ws?.readyState===1){try{state.ws.close();}catch{}}
  },5000));
}

$('refreshBtn').addEventListener('click',()=>Promise.allSettled([fetchMeta(),fetchHeatmap()]));
window.addEventListener('online',()=>{connectWs(true); fetchMeta(); fetchHeatmap();});
window.addEventListener('offline',()=>setStatus('error','OFFLINE'));
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){connectWs(); fetchMeta(); fetchHeatmap();}});

(async function init(){
  renderAssetTabs(); renderBase(); renderFlow(); renderHeatmap();
  connectWs(); setupTimers();
  await Promise.allSettled([fetchMeta(),fetchHeatmap()]);
  if('serviceWorker' in navigator){ navigator.serviceWorker.register('./sw.js').catch(console.warn); }
})();
