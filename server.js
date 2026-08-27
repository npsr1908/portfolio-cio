
const http = require("http");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const url = require("url");
const { spawn } = require("child_process");

const ROOT = __dirname;
const DATA = path.join(ROOT, "data");
const SNAPSHOT = path.join(DATA, "portfolio_snapshot.json");
const DB = path.join(DATA, "analysis_runs.json");
const WEB = path.join(ROOT, "web");
const MASTER_META = JSON.parse(fs.readFileSync(path.join(ROOT, "portfolio_cio_master_metadata.json"), "utf8"));
const INSTRUMENT_META = MASTER_META.instruments || {};
const CAP_META = Object.fromEntries(Object.entries(INSTRUMENT_META).map(([k,v])=>[k,v.market_cap]));
const ANALYSIS_STATE = path.join(DATA,"analysis_status.json");

function loadAnalysisState(){
  try{return JSON.parse(fs.readFileSync(ANALYSIS_STATE,"utf8"));}
  catch{return {run_id:null,started_at:null,completed_at:null,total:0,completed:0,running:0,status:"idle",message:"Ready",stocks:{}};}
}
function saveAnalysisState(s){fs.writeFileSync(ANALYSIS_STATE,JSON.stringify(s,null,2),"utf8");}
function capFor(symbol){return CAP_META[symbol]||"Unclassified";}


let kiteService = null;
let kiteLoadError = null;


function errorDetails(e) {
  return {
    message: e?.message || String(e),
    tool: e?.tool || null,
    raw: e?.raw || null
  };
}

async function loadKiteService() {
  if (kiteService) return kiteService;
  try {
    const mod = await import(pathToFileURL(path.join(ROOT, "kite_service.mjs")).href);
    kiteService = mod;
    return mod;
  } catch (e) {
    kiteLoadError = e;
    throw e;
  }
}

function loadSnapshot() {
  try { return JSON.parse(fs.readFileSync(SNAPSHOT, "utf8")); }
  catch {
    return {
      as_of:null, source:"Awaiting first Zerodha/Kite sync",
      invested:0, value:0, pnl:0, pnl_pct:0,
      health_score:null, health_label:"Construction Health",
      risk_level:"No portfolio data", risk_basis:"",
      holdings:[]
    };
  }
}
function loadRuns() {
  try { return JSON.parse(fs.readFileSync(DB, "utf8")); } catch { return []; }
}
function saveRuns(runs) { fs.writeFileSync(DB, JSON.stringify(runs, null, 2), "utf8"); }

function send(res, status, type, body) {
  res.writeHead(status, {"Content-Type": type, "Cache-Control":"no-store"});
  res.end(body);
}
function json(res, status, obj) { send(res, status, "application/json; charset=utf-8", JSON.stringify(obj)); }
function safeFile(p) {
  const full = path.normalize(path.join(WEB, p));
  return full.startsWith(path.normalize(WEB)) ? full : null;
}
async function body(req) {
  return await new Promise((resolve, reject) => {
    let d="";
    req.on("data", c => d += c);
    req.on("end", () => {
      if (!d) return resolve({});
      try { resolve(JSON.parse(d)); } catch { resolve({}); }
    });
    req.on("error", reject);
  });
}



function unwrapToolResult(result) {
  if (!result) return null;
  if (result.structuredContent) return result.structuredContent;
  if (result.data) return result.data;
  if (Array.isArray(result.content)) {
    const texts = result.content.filter(x => x && x.type === "text").map(x => x.text);
    for (const txt of texts) {
      try { return JSON.parse(txt); } catch {}
    }
    if (texts.length) return texts.join("\n");
  }
  return result;
}

function findHoldingsArray(obj) {
  if (Array.isArray(obj)) return obj;
  if (!obj || typeof obj !== "object") return null;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (Array.isArray(v) && v.some(x => x && typeof x === "object" &&
        ("tradingsymbol" in x || "symbol" in x || "average_price" in x || "averagePrice" in x))) {
      return v;
    }
  }
  for (const k of Object.keys(obj)) {
    const nested = findHoldingsArray(obj[k]);
    if (nested) return nested;
  }
  return null;
}

function num(v) {
  if (typeof v === "string") v = v.replace(/,/g, "").replace(/₹/g, "").trim();
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return null;
}


function normalizeHolding(x) {
  const symbol = pick(x, ["tradingsymbol","trading_symbol","symbol","Trading Symbol","Symbol"]);
  const exchange = pick(x, ["exchange","Exchange"]) || "";
  const quantity = num(pick(x, ["quantity","qty","Quantity"]));
  const avg = num(pick(x, ["average_price","avg_price","averagePrice","Average Price","Avg Price"]));
  const ltp = num(pick(x, ["last_price","ltp","last_traded_price","Last Price","LTP","Current Price"]));
  const close = num(pick(x, ["close_price","close","Close"]));
  const investedRaw = pick(x, ["invested","invested_value","Invested","Invested Value"]);
  const valueRaw = pick(x, ["current_value","value","Current Value","CurrentValue"]);
  const pnlRaw = pick(x, ["pnl","P&L","pnl_value","P&L Value"]);
  const invested = investedRaw !== null ? num(investedRaw) : quantity * avg;
  const value = valueRaw !== null ? num(valueRaw) : quantity * ltp;
  const pnl = pnlRaw !== null ? num(pnlRaw) : value - invested;
  const pnlPctRaw = pick(x, ["pnl_pct","pnl_percent","P&L %","P&L%","pnlPercentage"]);
  const pnlPct = pnlPctRaw !== null ? num(String(pnlPctRaw).replace("%","")) : (invested ? pnl / invested * 100 : 0);
  const sym = String(symbol || "").trim();
  const ex = String(exchange || "").trim();
  const meta = INSTRUMENT_META[sym] || {};
  const instrumentToken = pick(x, ["instrument_token","instrumentToken","token","Instrument Token"]);
  return {
    symbol: sym,
    exchange: ex,
    instrument_token: instrumentToken !== null ? num(instrumentToken) : null,
    quantity, avg_price: avg, ltp, close_price: close,
    invested: +invested.toFixed(2), value: +value.toFixed(2), pnl: +pnl.toFixed(2),
    pnl_pct: +pnlPct.toFixed(2),
    instrument_type:meta.instrument_type||"EQUITY",
    industry:meta.industry||"Unclassified",
    status:"SYNCED",
    research_status:"live_holdings_synced",
    theme:meta.portfolio_cio_theme||"Unclassified",
    market_cap:meta.market_cap||"Unclassified"
  };
}

function parseMarkdownTable(text) {
  if (typeof text !== "string") return [];
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const tableLines = lines.filter(line => line.includes("|"));
  if (tableLines.length < 2) return [];
  const rows = tableLines.map(line => line.replace(/^\||\|$/g, "").split("|").map(c => c.trim()));
  const isSep = row => row.every(c => /^:?-{3,}:?$/.test(c.replace(/\s/g,"")));
  let headerIdx = -1;
  for (let i=0;i<rows.length;i++) {
    if (!isSep(rows[i]) && rows[i].some(c => /symbol|trading|quantity|average|ltp|price|p&l|profit/i.test(c))) {
      headerIdx = i; break;
    }
  }
  if (headerIdx < 0) return [];
  const headers = rows[headerIdx].map(h => h.toLowerCase().replace(/\s+/g," ").trim());
  const out = [];
  for (let i=headerIdx+1;i<rows.length;i++) {
    if (isSep(rows[i])) continue;
    if (rows[i].length < Math.min(headers.length,2)) continue;
    const o = {};
    headers.forEach((h,idx) => o[h] = rows[i][idx] ?? "");
    out.push(o);
  }
  // Convert common textual headers to our normalized object shape.
  return out.map(o => {
    const find = (patterns) => {
      const key = Object.keys(o).find(k => patterns.some(p => p.test(k)));
      return key ? o[key] : null;
    };
    return {
      symbol: find([/trading ?symbol/,/^symbol$/i]),
      exchange: find([/^exchange$/i]),
      quantity: find([/quantity|qty/]),
      avg_price: find([/average.*price|avg.*price/]),
      ltp: find([/^ltp$/i,/last.*price/i,/current.*price/i]),
      invested: find([/invested/]),
      value: find([/current.*value|^value$/i]),
      pnl: find([/^p&l$|p&l.*value|profit.*loss/i]),
      pnl_pct: find([/p&l.*%|pnl.*%|pnl.*percent/i])
    };
  });
}

function parseHoldingsPayload(raw) {
  const arr = findHoldingsArray(raw);
  if (arr && arr.length) return arr;

  if (typeof raw === "string") {
    const parsed = parseMarkdownTable(raw);
    if (parsed.length) return parsed;
    // Try embedded JSON within a larger text response.
    const candidates = [...raw.matchAll(/(\[\s*\{[\s\S]*?\}\s*\]|\{\s*"[^"]+"\s*:\s*\[[\s\S]*?\]\s*\})/g)];
    for (const m of candidates) {
      try {
        const j = JSON.parse(m[1]);
        const a = findHoldingsArray(j);
        if (a && a.length) return a;
      } catch {}
    }
  }
  return [];
}

async function fetchLiveHoldings() {
  const ks = await loadKiteService();
  const result = await ks.callReadOnlyTool("get_holdings", {});
  const raw = unwrapToolResult(result);

  const arr = parseHoldingsPayload(raw);
  if (!arr.length) {
    const preview = typeof raw === "string" ? raw.slice(0, 1200) : JSON.stringify(raw).slice(0, 1200);
    throw new Error("Kite returned holdings data, but the application could not recognize the holdings list. Preview: " + preview);
  }

  const holdings = arr.map(normalizeHolding).filter(h => h.symbol);
  if (!holdings.length) {
    throw new Error("Kite returned a holdings payload, but no trading symbols could be extracted.");
  }

  const value = holdings.reduce((s,h) => s + h.value, 0);
  const invested = holdings.reduce((s,h) => s + h.invested, 0);
  const pnl = holdings.reduce((s,h) => s + h.pnl, 0);

  holdings.forEach(h => {
    h.weight = value ? +(h.value / value * 100).toFixed(2) : 0;
    const meta=INSTRUMENT_META[h.symbol]||{};
    h.instrument_type=h.instrument_type||meta.instrument_type||"EQUITY";
    h.industry=h.industry||meta.industry||"Unclassified";
    h.theme=meta.portfolio_cio_theme||h.theme||"Unclassified";
    h.market_cap=meta.market_cap||h.market_cap||"Unclassified";
    h.status="SYNCED";
    h.analysis_progress="0%";
  });

  const construction=calculateConstructionHealth(holdings);
  const snap = {
    as_of: new Date().toISOString(),
    source: "Zerodha/Kite MCP — live read-only sync",
    invested: +invested.toFixed(2),
    value: +value.toFixed(2),
    pnl: +pnl.toFixed(2),
    pnl_pct: invested ? +(pnl/invested*100).toFixed(2) : 0,
    health_score: construction.score,
    health_label: "Construction Health",
    risk_level: construction.risk,
    risk_basis: construction.details,
    holdings
  };

  fs.writeFileSync(SNAPSHOT, JSON.stringify(snap, null, 2), "utf8");
  return snap;
}



function calculateConstructionHealth(holdings){
  if(!holdings?.length) return {score:null,risk:"No portfolio data"};
  const total=holdings.reduce((s,h)=>s+(Number(h.value)||0),0);
  const weights=holdings.map(h=>total?(Number(h.value)||0)/total*100:0).sort((a,b)=>b-a);
  const top1=weights[0]||0, top5=weights.slice(0,5).reduce((a,b)=>a+b,0);
  const micro=holdings.filter(h=>(Number(h.value)||0)<1500).length;

  const themeMap={};
  for(const h of holdings){
    const theme=h.theme||"Unclassified";
    themeMap[theme]=(themeMap[theme]||0)+(Number(h.value)||0);
  }
  const topTheme=Object.values(themeMap).sort((a,b)=>b-a)[0]||0;
  const topThemePct=total?topTheme/total*100:0;

  // Construction-only score. It measures concentration/fragmentation, not business quality.
  const concentrationPenalty=Math.min(30, Math.max(0,(top1-10))*3.5);
  const top5Penalty=Math.min(10, Math.max(0,(top5-35))*1.0);
  const fragmentationPenalty=Math.min(10, micro*0.6);
  const themePenalty=Math.min(8, Math.max(0,(topThemePct-20))*0.4);
  const score=Math.max(0,Math.min(100,Math.round(100-concentrationPenalty-top5Penalty-fragmentationPenalty-themePenalty)));

  let risk="Low";
  if(top1>=15 || micro>=12 || top5>=40) risk="Elevated";
  else if(top1>=10 || top5>=35 || micro>=7) risk="Moderate";

  return {score,risk,details:{top1:+top1.toFixed(2),top5:+top5.toFixed(2),micro,topTheme:+topThemePct.toFixed(2)}};
}

function unwrapText(result){return Array.isArray(result?.content)?result.content.filter(x=>x?.type==="text").map(x=>x.text).join("\n"):"";}
function unwrapJson(result){const txt=unwrapText(result); if(txt){try{return JSON.parse(txt);}catch{}} return result?.structuredContent||result;}
function findArray(o){if(Array.isArray(o))return o;if(!o||typeof o!=="object")return null;for(const k of Object.keys(o)){if(Array.isArray(o[k]))return o[k];}for(const k of Object.keys(o)){const a=findArray(o[k]);if(a)return a;}return null;}
function sma(a,n){return a.length>=n?a.slice(-n).reduce((x,y)=>x+y,0)/n:null;}
function ema(a,n){if(a.length<n)return[];let e=sma(a.slice(0,n),n),k=2/(n+1),o=[e];for(let i=n;i<a.length;i++){e=a[i]*k+e*(1-k);o.push(e)}return o;}
function rsi(a,n=14){if(a.length<=n)return null;let g=0,l=0;for(let i=1;i<=n;i++){let d=a[i]-a[i-1];g+=Math.max(d,0);l+=Math.max(-d,0)}g/=n;l/=n;for(let i=n+1;i<a.length;i++){let d=a[i]-a[i-1];g=(g*(n-1)+Math.max(d,0))/n;l=(l*(n-1)+Math.max(-d,0))/n}return l===0?100:100-100/(1+g/l);}
function macd(a){if(a.length<35)return null;let f=ema(a,12),s=ema(a,26),ml=[];for(let i=0;i<s.length;i++)ml.push(f[i+14]-s[i]);let sg=ema(ml,9);let m=ml.at(-1),q=sg.at(-1);return {macd:m,signal:q,hist:m-q};}
function parseCandles(raw){let a=findArray(raw)||[];return a.map(x=>Array.isArray(x)?{date:x[0],open:+x[1],high:+x[2],low:+x[3],close:+x[4],volume:+(x[5]||0)}:{date:x.date??x.timestamp,open:+x.open,high:+x.high,low:+x.low,close:+x.close,volume:+(x.volume||0)}).filter(x=>Number.isFinite(x.close)).sort((a,b)=>new Date(a.date)-new Date(b.date));}
function technical(rows){
 const c=rows.map(x=>x.close), last=rows.at(-1), lows=rows.slice(-60).map(x=>x.low), highs=rows.slice(-60).map(x=>x.high);
 const below=lows.filter(x=>x<last.close).sort((a,b)=>b-a), above=highs.filter(x=>x>last.close).sort((a,b)=>a-b);
 const sr={support:below.length?below.slice(0,5).reduce((a,b)=>a+b,0)/Math.min(5,below.length):Math.min(...lows),resistance:above.length?above.slice(0,5).reduce((a,b)=>a+b,0)/Math.min(5,above.length):Math.max(...highs)};
 const vols=rows.map(x=>x.volume||0), av=sma(vols,20);
 const tr=[]; for(let i=1;i<rows.length;i++){const pc=rows[i-1].close;tr.push(Math.max(rows[i].high-rows[i].low,Math.abs(rows[i].high-pc),Math.abs(rows[i].low-pc)))} 
 return {last_close:last.close,date:last.date,observations:rows.length,sma20:sma(c,20),sma50:sma(c,50),sma100:sma(c,100),sma200:sma(c,200),rsi14:rsi(c),macd:macd(c),atr14:sma(tr,14),support:sr.support,resistance:sr.resistance,volume_ratio:av&&last.volume?last.volume/av:null,trend:(sma(c,200)&&last.close>sma(c,200))?"Bullish":(sma(c,50)&&last.close>sma(c,50)?"Mixed":"Bearish")};
}

function technicalAction(tech){
  if(!tech) return {action:"REVIEW",score:0,reasons:["Technical data unavailable"]};

  let score=0, reasons=[];
  const p=Number(tech.last_close), s20=Number(tech.sma20), s50=Number(tech.sma50),
        s100=Number(tech.sma100), s200=Number(tech.sma200),
        r=Number(tech.rsi14), mh=Number(tech.macd?.hist), vr=Number(tech.volume_ratio),
        sup=Number(tech.support), res=Number(tech.resistance);

  if(Number.isFinite(p)&&Number.isFinite(s200)){
    if(p>s200){score+=2;reasons.push("Price above 200 DMA");}
    else {score-=2;reasons.push("Price below 200 DMA");}
  }
  if(Number.isFinite(p)&&Number.isFinite(s50)){
    if(p>s50){score+=1;reasons.push("Price above 50 DMA");}
    else {score-=1;reasons.push("Price below 50 DMA");}
  }
  if(Number.isFinite(s20)&&Number.isFinite(s50)){
    if(s20>s50){score+=1;reasons.push("20 DMA above 50 DMA");}
    else {score-=1;reasons.push("20 DMA below 50 DMA");}
  }
  if(Number.isFinite(mh)){
    if(mh>0){score+=2;reasons.push("MACD histogram positive");}
    else {score-=2;reasons.push("MACD histogram negative");}
  }
  if(Number.isFinite(r)){
    if(r>=45&&r<=65){score+=1;reasons.push("RSI in constructive range");}
    else if(r>70){score-=1;reasons.push("RSI overbought");}
    else if(r<30){score+=1;reasons.push("RSI oversold / rebound zone");}
    else if(r<40){score-=1;reasons.push("RSI weak");}
  }
  if(Number.isFinite(vr)&&Number.isFinite(res)&&p>res){
    if(vr>=1.2){score+=3;reasons.push("Breakout with above-average volume");}
    else {score+=1;reasons.push("Price above resistance");}
  }
  if(Number.isFinite(vr)&&Number.isFinite(sup)&&p<sup){
    score-=3;reasons.push("Breakdown below support");
  }
  if(Number.isFinite(p)&&Number.isFinite(sup)&&p>sup&&p<=sup*1.03){
    score+=1;reasons.push("Price near support");
  }

  let action="HOLD";
  if(score>=5) action="BUY";
  else if(score<=-5) action="SELL";

  return {action,score,reasons};
}

function histArgs(schema,token,fromDate,toDate){
  const p=schema?.inputSchema?.properties||{},a={};
  if(p.instrument_token)a.instrument_token=token;
  if(p.from_date)a.from_date=fromDate;
  else if(p.from)a.from=fromDate;
  if(p.to_date)a.to_date=toDate;
  else if(p.to)a.to=toDate;
  if(p.interval)a.interval="day";
  if(p.continuous)a.continuous=false;
  if(p.oi)a.oi=false;
  return a;
}
const server = http.createServer(async (req,res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  try {
    if (req.method==="GET" && pathname==="/api/health") {
      let status = {connected:false, authenticated:false};
      try { status = (await loadKiteService()).getStatus(); } catch {}
      return json(res,200,{
        status:"ok", app:"Portfolio CIO", mode:"snapshot",
        zerodha_connected:status.authenticated,
        mcp_connected:status.connected,
        mcp_error:kiteLoadError?.message || null
      });
    }

    if (req.method==="POST" && pathname==="/api/kite/connect") {
      const ks = await loadKiteService();
      const r = await ks.connectKite();
      return json(res,200,r);
    }

    if (req.method==="POST" && pathname==="/api/kite/login-redirect") {
      // Respond immediately with a branded waiting screen. The actual Kite
      // OAuth URL is fetched by this page after it has rendered, so the user
      // never sees a blank/loading browser tab while MCP prepares the session.
      res.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"});
      res.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Portfolio CIO — Preparing Zerodha Login</title>
<style>
:root{font-family:Segoe UI,Arial,sans-serif;color:#eef3ff;background:#050914}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{display:grid;place-items:center;overflow:hidden;background:
radial-gradient(circle at 18% 35%,rgba(122,65,255,.16),transparent 30%),
radial-gradient(circle at 84% 32%,rgba(40,147,255,.16),transparent 31%),
#050914}
.bg{position:fixed;inset:0;pointer-events:none;overflow:hidden}
.grid{position:absolute;inset:auto -10% -18% -10%;height:52%;opacity:.34;
background:linear-gradient(rgba(79,122,255,.15) 1px,transparent 1px),linear-gradient(90deg,rgba(79,122,255,.15) 1px,transparent 1px);
background-size:42px 42px;transform:perspective(720px) rotateX(66deg);transform-origin:center bottom;
mask-image:linear-gradient(to top,#000,transparent 78%)}
.glow{position:absolute;width:460px;height:460px;border-radius:50%;filter:blur(80px);opacity:.14;background:#5d55ff;left:-120px;top:18%;animation:drift 7s ease-in-out infinite}
.glow.r{left:auto;right:-130px;top:24%;background:#12aaff;animation-delay:-2.4s}
.card{position:relative;z-index:2;width:min(560px,calc(100vw - 42px));padding:42px 36px;border:1px solid rgba(115,155,255,.22);
border-radius:24px;background:linear-gradient(145deg,rgba(16,25,38,.94),rgba(7,12,20,.96));
box-shadow:0 24px 100px rgba(0,0,0,.42),0 0 55px rgba(54,101,255,.08);text-align:center}
.logo{font-size:11px;letter-spacing:.19em;color:#81b0ff;font-weight:900}
h1{margin:14px 0 8px;font-size:28px}
p{margin:0;color:#aebbd0;line-height:1.6}
.loader{width:72px;height:72px;margin:0 auto 22px;position:relative}
.ring{position:absolute;inset:0;border-radius:50%;border:3px solid rgba(108,153,255,.17);border-top-color:#62b6ff;border-right-color:#9358ff;animation:spin 1.05s linear infinite}
.ring2{position:absolute;inset:9px;border-radius:50%;border:2px solid rgba(83,211,150,.15);border-bottom-color:#43d88e;animation:spin 1.8s linear infinite reverse}
.core{position:absolute;inset:23px;border-radius:50%;background:radial-gradient(circle,#6fe2ff,#5b60ff 55%,transparent 68%);box-shadow:0 0 28px rgba(93,163,255,.6);animation:pulse 1.4s ease-in-out infinite}
.steps{display:flex;justify-content:center;gap:8px;margin-top:20px;flex-wrap:wrap}
.step{padding:7px 10px;border-radius:999px;background:#111b28;color:#6f829e;font-size:11px;border:1px solid rgba(255,255,255,.05)}
.step.active{color:#dbe8ff;border-color:rgba(112,160,255,.28);box-shadow:0 0 18px rgba(80,142,255,.08)}
.marketline{height:2px;margin:26px 4% 0;background:linear-gradient(90deg,transparent,#8059ff,#4bbdff,#40dc93,transparent);background-size:220% 100%;animation:flow 3s linear infinite;opacity:.8}
.note{margin-top:16px;font-size:11px;color:#6f819b}
@keyframes spin{to{transform:rotate(360deg)}}@keyframes pulse{50%{transform:scale(1.18);opacity:.78}}
@keyframes drift{50%{transform:translate3d(22px,-12px,0)}}@keyframes flow{to{background-position:220% 0}}
</style>
</head>
<body>
<div class="bg"><div class="grid"></div><div class="glow"></div><div class="glow r"></div></div>
<div class="card">
  <div class="loader"><div class="ring"></div><div class="ring2"></div><div class="core"></div></div>
  <div class="logo">PORTFOLIO CIO · SECURE CONNECTION</div>
  <h1>Your Zerodha login is preparing</h1>
  <p>Please wait a moment while Portfolio CIO securely prepares the authentication page.</p>
  <div class="steps">
    <span class="step active" id="s1">Preparing secure session</span>
    <span class="step" id="s2">Opening Zerodha</span>
    <span class="step" id="s3">Ready to login</span>
  </div>
  <div class="marketline"></div>
  <div class="note">This screen is temporary. You will be redirected automatically.</div>
</div>
<script>
const activate=id=>document.getElementById(id)?.classList.add("active");
(async()=>{
  try{
    const r=await fetch("/api/kite/login-target",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
    const j=await r.json();
    if(!j.loginLink) throw new Error(j.message||"Kite did not return a Zerodha authorization URL.");
    activate("s2"); activate("s3");
    setTimeout(()=>location.replace(j.loginLink),350);
  }catch(e){
    document.querySelector("h1").textContent="Unable to prepare Zerodha login";
    document.querySelector("p").textContent=e.message||"Please return to Portfolio CIO and try again.";
    document.querySelector(".note").textContent="You can close this tab and retry Let's Get Started.";
  }
})();
</script>
</body>
</html>`);
      return;
    }

    if (req.method==="POST" && pathname==="/api/kite/login-target") {
      const ks = await loadKiteService();
      try {
        await ks.connectKite();
        const r = await ks.login();
        const loginLink = r?.loginLink;
        if(!loginLink) {
          return json(res,500,{status:"error",message:"Kite did not return a Zerodha authorization URL.",raw:r});
        }
        return json(res,200,{status:"ok",loginLink,needsUserAction:r.needsUserAction,message:r.message});
      } catch (e) {
        return json(res,500,{status:"error",message:e?.message||String(e),error:errorDetails(e)});
      }
    }

    if (req.method==="POST" && pathname==="/api/kite/login") {
      const ks = await loadKiteService();
      await ks.connectKite();
      try {
        const r = await ks.login();
        return json(res,200,{
          status:"ok",
          authenticated:false,
          loginLink:r.loginLink,
          needsUserAction:r.needsUserAction,
          message:r.message
        });
      } catch (e) {
        return json(res,500,{status:"error",authenticated:false,error:errorDetails(e)});
      }
    }

    if (req.method==="POST" && pathname==="/api/kite/logout") {
      try {
        const ks = await loadKiteService();
        const r = await ks.logoutKite();
        return json(res,200,r);
      } catch (e) {
        return json(res,500,{status:"error",authenticated:false,error:errorDetails(e)});
      }
    }

    if (req.method==="POST" && pathname==="/api/kite/verify") {
      const ks = await loadKiteService();
      await ks.connectKite();
      try {
        const r = await ks.verifyAuthenticated();
        return json(res,200,{status:"ok",...r,statusText:r.authenticated?"authenticated":"not_authenticated"});
      } catch (e) {
        return json(res,500,{status:"error",error:errorDetails(e)});
      }
    }



    if (req.method==="GET" && pathname==="/api/kite/tools") {
      const ks = await loadKiteService();
      const r = await ks.listTools();
      return json(res,200,r);
    }

    if (req.method==="GET" && pathname==="/api/kite/holdings") {
      const ks = await loadKiteService();
      const r = await ks.callReadOnlyTool("get_holdings",{});
      return json(res,200,{status:"ok",result:r});
    }


    if (req.method==="POST" && pathname==="/api/kite/sync") {
      const ks = await loadKiteService();
      try {
        await ks.connectKite();

        // Ensure the MCP session has performed its login step before get_holdings.
        // This is read-only and never places/modifies orders or GTTs.
        const verified = await ks.verifyAuthenticated();
        if (!verified.authenticated) {
          return json(res,401,{
            status:"error",
            stage:"login",
            message:"Kite MCP session is not authenticated. Click Connect Zerodha and complete the returned Zerodha login link first.",
            verification:verified
          });
        }

        try {
          const live = await fetchLiveHoldings();
          const previousState=loadAnalysisState();
          const freshState={
            ...previousState,
            total:(live.holdings||[]).length,
            stocks:{},
            manual_symbols:Array.isArray(previousState.manual_symbols)?previousState.manual_symbols:[],
            manual_started_symbols:Array.isArray(previousState.manual_started_symbols)?previousState.manual_started_symbols:[]
          };
          (live.holdings||[]).forEach(h=>{
            const prior=previousState.stocks?.[h.symbol];
            freshState.stocks[h.symbol]=(prior && /^(ANALYZING|QUEUED|TECHNICAL )/.test(String(prior.status||"")))
              ? prior
              : {status:"SYNCED",progress:0,action:"—"};
          });
          const finished=Object.values(freshState.stocks).filter(x=>/^TECHNICAL /.test(String(x?.status||""))).length;
          const running=Object.values(freshState.stocks).filter(x=>/^(ANALYZING|QUEUED)$/.test(String(x?.status||""))).length;
          freshState.completed=finished;
          freshState.running=running;
          freshState.status=running>0?"running":(finished>0?"complete":"idle");
          freshState.message=finished>0?`Analysis retained · ${finished}/${freshState.total}`:"Holdings synced. Click Analyze on a stock or Analyse All.";
          saveAnalysisState(freshState);
          const runs = loadRuns();
          const run = {
            id:runs.length+1,
            run_at:new Date().toISOString(),
            mode:"live_sync",
            source:"Kite MCP",
            note:`Synced ${live.holdings.length} holdings from Zerodha.`
          };
          runs.push(run); saveRuns(runs);
          return json(res,200,{status:"ok",snapshot:live,run});
        } catch (holdErr) {
          return json(res,500,{
            status:"error",
            stage:"get_holdings",
            error:errorDetails(holdErr),
            debug_file:"data/kite_holdings_last_raw.json"
          });
        }
      } catch (e) {
        return json(res,500,{status:"error",stage:"connect",error:errorDetails(e)});
      }
    }


    if (req.method==="GET" && pathname==="/api/analysis/status") {
      const state=loadAnalysisState();
      const rows=state.stocks&&typeof state.stocks==="object"?Object.values(state.stocks):[];
      const terminal=/^TECHNICAL (READY|ERROR|RATE LIMITED|INSUFFICIENT DATA)$/i;
      const runningRows=rows.filter(r=>/^(ANALYZING|QUEUED)$/i.test(String(r?.status||""))).length;
      const completedRows=rows.filter(r=>terminal.test(String(r?.status||""))).length;
      state.total=Number(state.total||rows.length||0);
      state.completed=Math.min(state.total,completedRows);
      state.running=runningRows;
      if(state.status==="running" && state.running===0 && state.completed>=state.total && state.total>0){
        state.status="complete";
        state.completed_at=state.completed_at||new Date().toISOString();
        state.message=`Analysis complete · ${state.completed}/${state.total}`;
      }
      saveAnalysisState(state);
      return json(res,200,state);
    }

    if (req.method==="GET" && pathname.startsWith("/api/analysis/stock/")) {
      const sym=decodeURIComponent(pathname.split("/").pop()).toUpperCase();
      const st=loadAnalysisState();
      return json(res,200,{symbol:sym,...(st.stocks?.[sym]||{status:"NOT ANALYZED",progress:0})});
    }


    if (req.method==="POST" && pathname==="/api/analysis/start-one") {
      const b=await body(req), sym=String(b.symbol||"").toUpperCase();
      const s=loadSnapshot(), row=s.holdings.find(h=>h.symbol===sym);
      if(!row) return json(res,404,{status:"error",message:`${sym} is not in current holdings.`});
      const state=loadAnalysisState();
      const activeBatch=state.status==="running" && Array.isArray(state.manual_symbols) && state.manual_symbols.length>0;

      // A new click during an active run extends the current manual queue.
      // A click after the previous run completed starts a fresh 1-item batch.
      if(!activeBatch){
        state.manual_symbols=[];
        state.manual_started=[];
        state.manual_started_symbols=[];
        state.manual_started_count=0;
        state.manual_completed_count=0;
        state.started_at=new Date().toISOString();
      }

      state.manual_symbols=Array.isArray(state.manual_symbols)?state.manual_symbols:[];
      if(!state.manual_symbols.includes(sym)) state.manual_symbols.push(sym);

      state.run_id=Date.now().toString();
      state.completed_at=null;
      state.total=state.manual_symbols.length;
      state.running=(state.running||0)+1;
      state.status="running";
      state.message=`Analyzing ${sym}`;
      state.stocks=state.stocks||{};
      state.stocks[sym]={status:"QUEUED",progress:0,action:"QUEUED"};
      saveAnalysisState(state);

      // Return immediately with the queue count; the async worker below marks
      // the stock STARTED when its historical-data request begins.

      (async()=>{
        try{
          const ks=await loadKiteService(), tools=await ks.listTools();
          const hs=(tools.tools||[]).find(x=>x.name==="get_historical_data");
          const to=new Date(), from=new Date(to); from.setDate(from.getDate()-420);
          const fromDate=from.toISOString().slice(0,19).replace("T"," ");
          const toDate=to.toISOString().slice(0,19).replace("T"," ");
          // Mark this stock as started. The manual progress bar is based on
          // started jobs within the current selected batch (not completed jobs).
          state.manual_started_symbols=Array.isArray(state.manual_started_symbols)?state.manual_started_symbols:[];
          if(!state.manual_started_symbols.includes(sym)) state.manual_started_symbols.push(sym);
          state.manual_started_count=state.manual_started_symbols.length;
          state.stocks[sym]={status:"ANALYZING",progress:50,action:"ANALYZING"};
          state.message=`Analyzing ${sym} · ${state.manual_started_count}/${state.total}`;
          saveAnalysisState(state);

          // Small cooldown after a user-triggered analysis to avoid colliding
          // with an immediately preceding Kite MCP request.
          await new Promise(r=>setTimeout(r,1800));
          const raw=await ks.callReadOnlyTool("get_historical_data",histArgs(hs,row.instrument_token,fromDate,toDate));
          const candles=parseCandles(unwrapJson(raw));
          if(candles.length<30){
            state.stocks[sym]={status:"TECHNICAL INSUFFICIENT DATA",progress:100,action:"REVIEW",last_error:"Less than 30 candles returned"};
          }else{            const tech=technical(candles);
            const decision=technicalAction(tech);
            state.stocks[sym]={
              status:"TECHNICAL READY",
              progress:100,
              action:decision.action,
              action_score:decision.score,
              action_reasons:decision.reasons,
              technical:tech,
              updated_at:new Date().toISOString(),
              note:"Technical action only. Final CIO decision still requires fundamentals, valuation and portfolio fit."
            };
          }
        }catch(e){
          const msg=String(e?.message||"");
          const rateLimited=/\b429\b|too many requests|rate.?limit/i.test(msg);
          state.stocks[sym]={
            status:rateLimited?"TECHNICAL RATE LIMITED":"TECHNICAL ERROR",
            progress:100,
            action:"REVIEW",
            last_error:rateLimited
              ?"Kite MCP rate-limited this analysis after automatic retries."
              :msg
          };
        }finally{
          state.running=Math.max(0,(state.running||1)-1);
          const batchSymbols=Array.isArray(state.manual_symbols)?state.manual_symbols:[];
          state.manual_completed_count=batchSymbols.filter(x=>state.stocks?.[x]?.status==="TECHNICAL READY").length;
          state.status=state.running>0?"running":"complete";
          state.completed_at=state.running>0?null:new Date().toISOString();
          state.message=state.running>0
            ?`${sym} analysis complete · ${state.manual_started_count||0}/${state.total} started`
            :`Analysis complete · ${state.manual_started_count||0}/${state.total} started`;
          saveAnalysisState(state);
        }
      })();

      return json(res,200,{status:"started",state});
    }

    if (req.method==="POST" && pathname==="/api/analysis/start") {
      const s=loadSnapshot();
      const existing=loadAnalysisState();

      // Do not allow two portfolio-wide runs to overlap.
      if(existing.status==="running"){
        return json(res,409,{
          status:"error",
          message:"Analyse All is already running. Let the current queue finish before starting another."
        });
      }

      const symbols=(s.holdings||[]).filter(h=>h.instrument_token).map(h=>h.symbol);
      if(!symbols.length){
        return json(res,400,{status:"error",message:"No holdings with Kite instrument tokens are available for analysis."});
      }

      const runId=Date.now().toString();
      const state={
        run_id:runId,
        mode:"all",
        started_at:new Date().toISOString(),
        completed_at:null,
        total:symbols.length,
        completed:0,
        started_count:0,
        running:0,
        status:"running",
        message:`Analysis queued · 0/${symbols.length}`,
        manual_symbols:[],
        manual_started_symbols:[],
        stocks:{}
      };

      symbols.forEach(sym=>{
        state.stocks[sym]={
          status:"QUEUED",
          progress:0,
          action:"—",
          last_error:null
        };
      });
      saveAnalysisState(state);

      (async()=>{
        let ks=null;
        let hs=null;

        try{
          // IMPORTANT: one MCP session, one historical-data request at a time.
          // This avoids the previous 3-worker burst that caused 429s.
          ks=await loadKiteService();
          const tools=await ks.listTools();
          hs=(tools.tools||[]).find(x=>x.name==="get_historical_data");
          if(!hs) throw new Error("Kite MCP get_historical_data tool is unavailable.");

          for(let i=0;i<symbols.length;i++){
            const sym=symbols[i];
            const row=s.holdings.find(h=>h.symbol===sym);
            if(!row || !row.instrument_token){
              state.stocks[sym]={
                status:"TECHNICAL ERROR",
                progress:100,
                action:"REVIEW",
                last_error:"No instrument token available."
              };
              state.completed++;
              state.started_count++;
              state.message=`Skipped ${sym} · ${state.completed}/${state.total}`;
              saveAnalysisState(state);
              continue;
            }

            // Mark the stock as the current queue item.
            state.running=1;
            state.started_count=i+1;
            state.stocks[sym]={
              status:"ANALYZING",
              progress:0,
              action:"ANALYZING",
              last_error:null
            };
            state.message=`Analyzing ${sym} · ${state.completed}/${state.total}`;
            saveAnalysisState(state);

            try{
              const to=new Date();
              const from=new Date(to);
              from.setDate(from.getDate()-420);
              const fromDate=from.toISOString().slice(0,19).replace("T"," ");
              const toDate=to.toISOString().slice(0,19).replace("T"," ");

              // Conservative pacing between Kite MCP requests.
              if(i>0){
                await new Promise(r=>setTimeout(r,2500));
              }

              const raw=await ks.callReadOnlyTool(
                "get_historical_data",
                histArgs(hs,row.instrument_token,fromDate,toDate)
              );

              const candles=parseCandles(unwrapJson(raw));

              if(candles.length<30){
                state.stocks[sym]={
                  status:"TECHNICAL INSUFFICIENT DATA",
                  progress:100,
                  action:"REVIEW",
                  last_error:"Less than 30 candles returned."
                };
              }else{
                const tech=technical(candles);
                const decision=technicalAction(tech);

                state.stocks[sym]={
                  status:"TECHNICAL READY",
                  progress:100,
                  action:decision.action,
                  action_score:decision.score,
                  action_reasons:decision.reasons,
                  technical:tech,
                  updated_at:new Date().toISOString(),
                  last_error:null,
                  note:"Technical action only; final CIO decision requires fundamental, valuation and portfolio-fit research."
                };
              }
            }catch(e){
              const msg=String(e?.message||"");
              const rateLimited=/\b429\b|too many requests|rate.?limit/i.test(msg);

              // A stock-level failure must NOT abort the rest of Analyse All.
              state.stocks[sym]={
                status:rateLimited?"TECHNICAL RATE LIMITED":"TECHNICAL ERROR",
                progress:100,
                action:"REVIEW",
                last_error:rateLimited
                  ?"Kite MCP rate-limited this stock after automatic retries."
                  :msg
              };
            }finally{
              state.running=0;
              state.completed++;
              state.message=`Analysis progress · ${state.completed}/${state.total}`;
              saveAnalysisState(state);
            }
          }

          const terminal=/^TECHNICAL (READY|ERROR|RATE LIMITED|INSUFFICIENT DATA)$/i;
          state.completed=Object.values(state.stocks||{}).filter(r=>terminal.test(String(r?.status||""))).length;
          state.running=Object.values(state.stocks||{}).filter(r=>/^(ANALYZING|QUEUED)$/i.test(String(r?.status||""))).length;
          state.status="complete";
          state.completed_at=new Date().toISOString();
          state.message=`Analysis complete · ${state.completed}/${state.total}`;
          saveAnalysisState(state);

        }catch(e){
          // Only a truly global failure stops the queue.
          state.status="error";
          state.running=0;
          state.completed_at=new Date().toISOString();
          state.message=`Analyse All stopped: ${e.message}`;
          saveAnalysisState(state);
        }
      })();

      return json(res,200,{
        status:"started",
        mode:"all",
        run_id:runId,
        total:symbols.length,
        message:"Analyse All started with a controlled sequential queue."
      });
    }

    if (req.method==="POST" && pathname==="/api/analysis/run") {
      const runs = loadRuns();
      const run = {
        id:runs.length+1, run_at:new Date().toISOString(),
        mode:parsed.query.mode || "portfolio",
        source:"snapshot",
        note:"V1.3 records analysis request; live Kite MCP retrieval is available after authentication."
      };
      runs.push(run); saveRuns(runs);
      return json(res,200,{status:"queued",...run});
    }


    if (req.method==="POST" && pathname==="/api/technical") {
      const b=await body(req), symbol=String(b.symbol||"").toUpperCase(), ks=await loadKiteService();
      const tools=await ks.listTools(), hs=(tools.tools||[]).find(x=>x.name==="get_historical_data");
      let token=b.instrument_token;
      let resolvedExchange=b.exchange||"NSE";
      if(!token){
        try{
          const live=await fetchLiveHoldings();
          const hit=live.holdings.find(x=>x.symbol===symbol);
          if(hit){ token=hit.instrument_token; resolvedExchange=hit.exchange||resolvedExchange; }
        }catch{}
      }
      if(!token)return json(res,404,{status:"error",message:`Could not resolve ${symbol} to a Kite instrument token. For a stock outside the portfolio, instrument-search will be enabled in the next patch.`});
      const to=new Date(), from=new Date(to); from.setDate(from.getDate()-420);
      const fromStr=from.toISOString().slice(0,19).replace("T"," ");
      const toStr=to.toISOString().slice(0,19).replace("T"," ");
      const args=histArgs(hs,token,fromStr,toStr);
      // Safety fallback for MCP schema variants: Kite currently requires from_date/to_date.
      if(args.from_date===undefined && args.from===undefined){args.from_date=fromStr;}
      if(args.to_date===undefined && args.to===undefined){args.to_date=toStr;}
      if(args.interval===undefined){args.interval="day";}
      let raw=await ks.callReadOnlyTool("get_historical_data",args);
      const rows=parseCandles(unwrapJson(raw));
      if(rows.length<30)return json(res,422,{status:"error",message:"Insufficient historical candles returned.",rows:rows.length});
      return json(res,200,{status:"ok",symbol,exchange:resolvedExchange,instrument_token:token,technical:technical(rows)});
    }


function firstMatch(text, patterns){
  for(const p of patterns){const m=text.match(p);if(m)return(m[1]||m[0]).trim();}
  return null;
}
function numFrom(v){const m=String(v??"").replace(/,/g,"").match(/-?\d+(?:\.\d+)?/);return m?Number(m[0]):null;}
function normalizeNoData(value){
  if(value===null||value===undefined||value==="") return value;
  if(Array.isArray(value)) return value.map(normalizeNoData);
  if(typeof value==="object") return value;
  return String(value).replace(/\bDATA\s+UNAVAILABLE\b/gi,"ESTIMATED / DERIVED FROM AVAILABLE DATA");
}
function unwrapJsonResponse(text){
  const raw=String(text||"").replace(/^\uFEFF/,"").trim();
  const fenced=raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate=(fenced?fenced[1]:raw).trim();
  try{return JSON.parse(candidate);}catch{}
  const start=candidate.indexOf("{");
  const end=candidate.lastIndexOf("}");
  if(start>=0&&end>start){
    try{return JSON.parse(candidate.slice(start,end+1));}catch{}
  }
  return null;
}
function parseCioResponse(text){
  const raw=String(text||"").replace(/\r/g,"").trim();
  const json=unwrapJsonResponse(raw);
  if(json){
    const q=(json.final_cio_response && typeof json.final_cio_response==="object")
      ? json.final_cio_response
      : (json.cio_response && typeof json.cio_response==="object" ? json.cio_response : json);

    const actionRaw=q.action??q.ACTION??"";
    const actionMatch=String(actionRaw).match(/\b(BUY|ACCUMULATE|HOLD|WAIT|REDUCE|SELL|REBALANCE|REVIEW)\b/i);
    const textVal=(...keys)=>{
      for(const k of keys){if(q[k]!==undefined&&q[k]!==null&&q[k]!=="")return normalizeNoData(q[k]);}
      return null;
    };
    const numberVal=(...keys)=>{
      for(const k of keys){
        const v=q[k];
        if(typeof v==="number"&&Number.isFinite(v))return v;
        const m=String(v??"").replace(/,/g,"").match(/-?\d+(?:\.\d+)?/);
        if(m)return Number(m[0]);
      }
      return null;
    };
    const bullets=v=>{
      if(Array.isArray(v))return v.map(normalizeNoData).map(x=>String(x)).filter(Boolean).slice(0,10);
      if(v===null||v===undefined||v==="")return [];
      return String(normalizeNoData(v)).split(/\n|;\s+(?=[A-Z])/).map(x=>x.replace(/^\s*[-*•]\s*/,"").trim()).filter(Boolean).slice(0,10);
    };
    const buy=q.buy||q.BUY||q.trade_plan?.buy||{};
    const sell=q.sell||q.SELL||q.trade_plan?.sell||{};
    const allocation=q.allocation||q.rebalance||{};
    const tp=q.trade_plan||q.tradePlan||q.TRADE_PLAN||{};

    return normalizeCioParsed({
      format:"json",
      action:actionMatch?actionMatch[1].toUpperCase():null,
      confidence:textVal("confidence","CONFIDENCE"),
      fundamental:textVal("fundamental","FUNDAMENTAL"),
      valuation:textVal("valuation","VALUATION"),
      technical:textVal("technical","TECHNICAL"),
      risk:textVal("risk","RISK"),
      portfolio_fit:textVal("portfolio_fit","portfolioFit","PORTFOLIO_FIT"),
      target_weight:numberVal("target_weight","targetWeight","TARGET_WEIGHT"),
      target_weight_text:textVal("target_weight_text","target_weight","targetWeight","TARGET_WEIGHT"),
      shares_to_sell:numberVal("shares_to_sell","sharesToSell","SHARES_TO_SELL"),
      shares_to_sell_text:textVal("shares_to_sell_text","shares_to_sell","sharesToSell","SHARES_TO_SELL"),
      sell_price_range:textVal("sell_price_range","sellPriceRange","SELL_PRICE_RANGE", "sell?.price_range"),
      shares_to_buy:numberVal("shares_to_buy","sharesToBuy","SHARES_TO_BUY"),
      shares_to_buy_text:textVal("shares_to_buy_text","shares_to_buy","sharesToBuy","SHARES_TO_BUY"),
      buy_price_range:textVal("buy_price_range","buyPriceRange","BUY_PRICE_RANGE"),
      rebalance_action:textVal("rebalance_action","rebalanceAction","REBALANCE_ACTION"),
      key_positives:bullets(q.key_positives??q.keyPositives??q.KEY_POSITIVES),
      key_negatives:bullets(q.key_negatives??q.keyNegatives??q.KEY_NEGATIVES),
      facts:textVal("facts","FACTS","fact","FACT"),
      analysis:textVal("analysis","ANALYSIS"),
      reasoning:textVal("reasoning","REASONING"),
      price_action:textVal("price_action","priceAction","PRICE_ACTION"),
      trade_plan:normalizeNoData(tp),
      portfolio_action_plan:normalizeNoData(q.portfolio_action_plan??q.portfolioActionPlan??q.PORTFOLIO_ACTION_PLAN??[]),
      buy_plan:normalizeNoData(buy),
      sell_plan:normalizeNoData(sell),
      risk_controls:normalizeNoData(q.risk_controls??q.riskControls),
      raw
    });
  }

  // Backward-compatible legacy parser.
  const fields=[
    "ACTION","CONFIDENCE","FUNDAMENTAL","VALUATION","TECHNICAL","RISK",
    "PORTFOLIO_FIT","KEY_POSITIVES","KEY_NEGATIVES","SHARES_TO_SELL",
    "SELL_PRICE_RANGE","SHARES_TO_BUY","BUY_PRICE_RANGE","TARGET_WEIGHT",
    "REBALANCE_ACTION","REASONING","PRICE_ACTION"
  ];
  const nextField=fields.join("|");
  const get=(name)=>{
    const re=new RegExp("^\\s*"+name+"\\s*[:\\-]\\s*([\\s\\S]*?)(?=\\n\\s*(?:"+nextField+")\\s*[:\\-]|$)","im");
    const m=raw.match(re);
    return m?(m[1]||"").trim():null;
  };
  const cleanOne=v=>v?normalizeNoData(String(v).trim()):null;
  const numFrom=v=>{const m=String(v??"").replace(/,/g,"").match(/-?\\d+(?:\\.\\d+)?/);return m?Number(m[0]):null;};
  const bullets=v=>v?String(normalizeNoData(v)).split(/\n|;\s+(?=[A-Z])/).map(x=>x.replace(/^\s*[-*•]\s*/,"").trim()).filter(Boolean).slice(0,8):[];
  const actionRaw=get("ACTION")||get("RECOMMENDED_ACTION")||"";
  const actionMatch=String(actionRaw).match(/\b(BUY|ACCUMULATE|HOLD|WAIT|REDUCE|SELL)\b/i);

  return normalizeCioParsed({
    format:"legacy",
    action:actionMatch?actionMatch[1].toUpperCase():null,
    confidence:cleanOne(get("CONFIDENCE")),
    fundamental:cleanOne(get("FUNDAMENTAL")),
    valuation:cleanOne(get("VALUATION")),
    technical:cleanOne(get("TECHNICAL")),
    risk:cleanOne(get("RISK")),
    portfolio_fit:cleanOne(get("PORTFOLIO_FIT")),
    target_weight:numFrom(get("TARGET_WEIGHT")),
    target_weight_text:cleanOne(get("TARGET_WEIGHT")),
    shares_to_sell:numFrom(get("SHARES_TO_SELL")),
    shares_to_sell_text:cleanOne(get("SHARES_TO_SELL")),
    sell_price_range:cleanOne(get("SELL_PRICE_RANGE")),
    shares_to_buy:numFrom(get("SHARES_TO_BUY")),
    shares_to_buy_text:cleanOne(get("SHARES_TO_BUY")),
    buy_price_range:cleanOne(get("BUY_PRICE_RANGE")),
    rebalance_action:cleanOne(get("REBALANCE_ACTION")),
    key_positives:bullets(get("KEY_POSITIVES")),
    key_negatives:bullets(get("KEY_NEGATIVES")),
    facts:cleanOne(get("FACTS")||get("FACT")),
    analysis:cleanOne(get("ANALYSIS")),
    reasoning:cleanOne(get("REASONING")),
    price_action:cleanOne(get("PRICE_ACTION")),
    raw
  });
}
function normalizeCioParsed(p){
  const out={...p};
  out.key_positives=Array.isArray(out.key_positives)?out.key_positives:[];
  out.key_negatives=Array.isArray(out.key_negatives)?out.key_negatives:[];
  out.reasoning=normalizeNoData(out.reasoning);
  out.facts=normalizeNoData(out.facts);
  out.analysis=normalizeNoData(out.analysis);
  out.price_action=normalizeNoData(out.price_action);
  out.fundamental=normalizeNoData(out.fundamental);
  out.valuation=normalizeNoData(out.valuation);
  out.technical=normalizeNoData(out.technical);
  out.risk=normalizeNoData(out.risk);
  out.portfolio_fit=normalizeNoData(out.portfolio_fit);
  return out;
}


function deriveRange(technical, side){
  if(!technical)return null;
  const p=Number(technical.last_close), sup=Number(technical.support), res=Number(technical.resistance), atr=Number(technical.atr14);
  if(!Number.isFinite(p))return null;
  const safeAtr=Number.isFinite(atr)&&atr>0?atr:null;
  if(side==="BUY"){
    const lo=Number.isFinite(sup)?sup:(safeAtr?p-safeAtr*0.75:p*0.97);
    const hi=Number.isFinite(sup)
      ? Math.max(sup*1.015,Math.min(p, sup+(safeAtr?safeAtr*0.6:(p-sup)*0.35)))
      : (safeAtr?p-safeAtr*0.15:p);
    if(lo>0&&hi>0) return `₹${Math.round(lo).toLocaleString("en-IN")} – ₹${Math.round(hi).toLocaleString("en-IN")}`;
  }
  if(side==="SELL"){
    const lo=Number.isFinite(res)
      ? Math.min(p,res)
      : (safeAtr?p-safeAtr*0.15:p*0.99);
    const hi=Number.isFinite(res)
      ? Math.max(res*0.985,p)
      : (safeAtr?p+safeAtr*0.55:p*1.03);
    if(lo>0&&hi>0) return `₹${Math.round(lo).toLocaleString("en-IN")} – ₹${Math.round(hi).toLocaleString("en-IN")}`;
  }
  return null;
}
function buildCioAction(parsed,snapshot,symbol,technical){
  const h=(snapshot.holdings||[]).find(x=>x.symbol===symbol), total=Number(snapshot.value||0);
  const currentWeight=h&&total?Number(h.value)/total*100:null, action=parsed.action;
  const tech=technical||null;
  const buyRange=parsed.buy_price_range||deriveRange(tech,"BUY");
  const sellRange=parsed.sell_price_range||deriveRange(tech,"SELL");

  let summary="REVIEW", priority="NORMAL", reason="Research response received; review the extracted conclusions.";
  if(action==="SELL"){summary="SELL / EXIT";priority="HIGH";reason=h?`Research recommends SELL. Current portfolio weight is ${currentWeight.toFixed(2)}%.`:"Research recommends SELL for a stock not currently held.";}
  else if(action==="REDUCE"){summary="REDUCE";priority=currentWeight!=null&&currentWeight>=8?"HIGH":"NORMAL";reason=h?`Research recommends REDUCE. Current portfolio weight is ${currentWeight.toFixed(2)}%.`:"Research recommends REDUCE for a stock not currently held.";}
  else if(action==="BUY"||action==="ACCUMULATE"){summary=action;reason=h?`Research recommends ${action}; verify position sizing before adding.`:`Research recommends ${action}; consider a starter position only if portfolio fit is acceptable.`;}
  else if(action==="HOLD"||action==="WAIT"){summary=action;reason=action==="WAIT"?"Research recommends waiting for a better setup or valuation.":"Research recommends holding.";}

  const rebalance=[];
  const tradePlan=[];
  if(h&&(action==="SELL"||action==="REDUCE")){
    const cw=currentWeight, target=parsed.target_weight!=null?parsed.target_weight:(action==="SELL"?0:Math.min(10,Math.max(5,cw)));
    const tv=total*target/100, ltp=Number(h.ltp||tech?.last_close||0), sellValue=Math.max(0,Number(h.value||0)-tv);
    const shares=parsed.shares_to_sell!=null?parsed.shares_to_sell:(ltp>0?Math.floor(sellValue/ltp):null);
    const range=sellRange||"N/A";
    rebalance.push({type:"REDUCE",symbol,target_weight:target,suggested_sell_shares:shares,suggested_value:shares!=null?shares*ltp:sellValue,suggested_price_range:range,note:"Construction suggestion only; validate taxes, liquidity and thesis."});
    tradePlan.push({side:"SELL",symbol,shares:shares,price_range:range,reason:"Reduce portfolio concentration / follow CIO research action."});
    const themes={};(snapshot.holdings||[]).forEach(x=>{const k=x.theme||"Unclassified";themes[k]=(themes[k]||0)+Number(x.value||0);});
    const alt=Object.entries(themes).filter(([k])=>k!==(h.theme||"Unclassified")).sort((a,b)=>a[1]-b[1])[0];
    if(alt)rebalance.push({type:"DIVERSIFY",theme:alt[0],note:"Potential destination for released capital after independent stock selection and valuation review."});
  }
  if(action==="BUY"||action==="ACCUMULATE"){
    const shares=parsed.shares_to_buy!=null?parsed.shares_to_buy:null;
    const target=parsed.target_weight!=null?parsed.target_weight: (h&&currentWeight!=null?Math.max(currentWeight,2):2);
    const priceRange=buyRange||"N/A";
    rebalance.push({type:h?"ADD_POSITION":"STARTER_POSITION",symbol,suggested_target_weight:target,suggested_buy_shares:shares,suggested_price_range:priceRange,funding_note:"Prefer funding from oversized/concentrated positions rather than simply increasing portfolio risk."});
    tradePlan.push({side:"BUY",symbol,shares,price_range:priceRange,reason:h?"Gradual accumulation; use the stated buy zone.":"Starter position only; prefer a staged entry."});
  }

  return {
    symbol,held:!!h,action:summary,priority,reason,confidence:parsed.confidence,
    response_format:parsed.format||"legacy",
    scores:{fundamental:parsed.fundamental,valuation:parsed.valuation,technical:parsed.technical,risk:parsed.risk,portfolio_fit:parsed.portfolio_fit},
    key_positives:parsed.key_positives,key_negatives:parsed.key_negatives,
    facts:parsed.facts,analysis:parsed.analysis,reasoning:parsed.reasoning,
    shares_to_sell_text:parsed.shares_to_sell_text,
    sell_price_range:parsed.sell_price_range,
    shares_to_buy_text:parsed.shares_to_buy_text,
    buy_price_range:parsed.buy_price_range,
    target_weight_text:parsed.target_weight_text,
    rebalance_action:parsed.rebalance_action,
    price_action:parsed.price_action,
    portfolio_weight:currentWeight,rebalance,trade_plan:(parsed.trade_plan&&typeof parsed.trade_plan==="object"&&!Array.isArray(parsed.trade_plan))?parsed.trade_plan:tradePlan,
    portfolio_action_plan:Array.isArray(parsed.portfolio_action_plan)?parsed.portfolio_action_plan:[],
    price_source:tech?"Derived from Kite historical candles + research response":"Research response / unavailable",
    technical_levels:tech?{last_close:tech.last_close,support:tech.support,resistance:tech.resistance,atr14:tech.atr14}:null
  };
}

    if (req.method==="POST" && pathname==="/api/research-pack") {
      const b=await body(req), symbol=String(b.symbol||"").toUpperCase(), s=loadSnapshot(), h=s.holdings.find(x=>x.symbol===symbol);
      const pack={
        generated_at:new Date().toISOString(),
        symbol, held:!!h, holding:h||null,
        portfolio:{value:s.value,invested:s.invested,pnl:s.pnl,pnl_pct:s.pnl_pct},
        ask:[
          "Fundamental: revenue/PAT/EPS growth, ROE, ROCE, margins, debt, cash flow, promoter holding/pledge, valuation, latest results, management commentary, risks and competitive position.",
          "Technical: trend, recent candle structure, 20/50/100/200 DMA, RSI, MACD, volume, ATR/volatility, support, resistance, breakout/breakdown, swing highs/lows, demand/supply zones, entry zone, targets, stop-loss and invalidation.",
          "Price action: read recent candles and market structure, identify accumulation/distribution, breakout/retest/failure, momentum and trend quality.",
          "Portfolio fit: sector exposure, theme overlap, concentration, diversification, position sizing, correlation logic, target allocation and action.",
          "Trading/rebalancing: determine whether I should BUY, ACCUMULATE, HOLD, WAIT, REDUCE or SELL; specify practical share quantity and price range wherever a transaction is recommended.",
          "If capital is released through a SELL/REDUCE decision, explain where that capital should preferably be redeployed, including an existing holding or a NEW STOCK where justified.",

          "DATA / SOURCE RULE: Do NOT use the phrase DATA UNAVAILABLE anywhere in the response. Do NOT leave requested fields blank.",
          "Use the best available current or recent evidence from Zerodha/Kite data, NSE/BSE, exchange filings, company investor presentations, annual/quarterly reports, management commentary, credible financial reporting and reliable chart/technical-analysis sources.",
          "For support/resistance/entry/exit ranges, use recent swing highs/lows, candle highs/lows, consolidation ranges, moving-average clusters, ATR/volatility, volume behaviour, breakout/retest levels and demand/supply zones.",
          "For metrics that are not directly reported, use the latest available period or derive a reasonable value from verified inputs. Clearly label an analytical estimate as ESTIMATED: or DERIVED: rather than abandoning the field.",
          "Never invent a number and present it as a verified company fact.",

          "FACT vs ANALYSIS vs RECOMMENDATION: clearly distinguish FACT (verified/reported information), ANALYSIS (interpretation/inference) and RECOMMENDATION (CIO action).",
          "Do not make a BUY/SELL decision solely from price movement, valuation, technical indicators, profit/loss percentage or portfolio weight. Combine fundamentals + valuation + technicals + price action + risk + portfolio fit.",

          "For every SELL/REDUCE recommendation: provide shares to sell, practical sell-price range, reason, stop/invalidation where relevant, and where released capital should preferably be redeployed.",
          "For every BUY/ACCUMULATE recommendation: provide shares to buy, practical buy-price range, target weight, stop/invalidation, targets and reason.",
          "For HOLD/WAIT: explain exactly what should trigger the next action.",
          "Do not place any order. This is decision support only.",

          "FINAL CIO RESPONSE BLOCK: This is the ONLY part that must be JSON. Return detailed research normally above, then finish with a valid JSON object. Do not use Markdown code fences for this final block and do not write prose before or after the JSON inside this block.",
          "FINAL JSON MUST CONTAIN EXACTLY THESE TOP-LEVEL FIELDS: ACTION, CONFIDENCE, FUNDAMENTAL, VALUATION, TECHNICAL, RISK, PORTFOLIO_FIT, KEY_POSITIVES, KEY_NEGATIVES, SHARES_TO_SELL, SELL_PRICE_RANGE, SHARES_TO_BUY, BUY_PRICE_RANGE, TARGET_WEIGHT, REBALANCE_ACTION, REASONING.",
          "FINAL JSON RULES: Every field must be present; never use DATA UNAVAILABLE; do not leave fields blank; use NOT APPLICABLE only when a transaction genuinely does not apply; SHARES_TO_SELL and SHARES_TO_BUY must be numeric; SELL_PRICE_RANGE and BUY_PRICE_RANGE must contain a practical range whenever the corresponding shares value is greater than zero; TARGET_WEIGHT and REBALANCE_ACTION must always be provided.",
          "FINAL JSON SHAPE: Return one object with top-level fields ACTION, CONFIDENCE, FUNDAMENTAL, VALUATION, TECHNICAL, RISK, PORTFOLIO_FIT, KEY_POSITIVES, KEY_NEGATIVES, SHARES_TO_SELL, SELL_PRICE_RANGE, SHARES_TO_BUY, BUY_PRICE_RANGE, TARGET_WEIGHT, REBALANCE_ACTION and REASONING."
        ]
      };
      return json(res,200,{status:"ok",pack});
    }


    if (req.method==="POST" && pathname==="/api/research/submit-response") {
      const b=await body(req);
      const symbol=String(b.symbol||"").toUpperCase();
      const response=String(b.response||"").trim();
      if(!symbol||!response)return json(res,400,{status:"error",message:"Symbol and ChatGPT response are required."});
      const s=loadSnapshot(),parsed=parseCioResponse(response);
      const tech=b.technical&&typeof b.technical==="object"?b.technical:null;
      const decision=buildCioAction(parsed,s,symbol,tech);
      return json(res,200,{status:"ok",parsed,decision});
    }


function buildRebalancePlan(snapshot){
  const hs=(snapshot.holdings||[]).map(h=>({...h,value:num(h.value),ltp:num(h.ltp),weight:num(h.weight)}));
  const total=num(snapshot.value)||hs.reduce((a,h)=>a+h.value,0);
  hs.forEach(h=>{if(!h.weight&&total)h.weight=h.value/total*100;});

  const themeTotals={};
  const capTotals={};
  hs.forEach(h=>{
    const theme=h.theme||"Unclassified";
    themeTotals[theme]=(themeTotals[theme]||0)+h.value;
    const cap=h.market_cap||"Unknown";
    capTotals[cap]=(capTotals[cap]||0)+h.value;
  });

  const themeRows=Object.entries(themeTotals).map(([theme,value])=>({
    theme,value,pct:total?value/total*100:0
  })).sort((a,b)=>b.value-a.value);
  const capRows=Object.entries(capTotals).map(([cap,value])=>({
    cap,value,pct:total?value/total*100:0
  })).sort((a,b)=>b.value-a.value);

  const micro=hs.filter(h=>h.weight<0.50 || (h.value>0&&h.value<2500));
  const oversized=hs.filter(h=>h.weight>=12).sort((a,b)=>b.weight-a.weight);
  const watch=hs.filter(h=>h.weight>=8&&h.weight<12).sort((a,b)=>b.weight-a.weight);
  const largest=hs.slice().sort((a,b)=>b.weight-a.weight)[0];
  const top3=hs.slice().sort((a,b)=>b.weight-a.weight).slice(0,3).reduce((a,h)=>a+h.weight,0);
  const topTheme=themeRows[0]||{theme:"—",pct:0,value:0};
  const largeCap=capRows.find(x=>/large/i.test(x.cap))?.pct||0;

  let concentrationScore=100;
  if(largest) concentrationScore-=Math.min(35,Math.max(0,largest.weight-5)*3);
  concentrationScore-=Math.min(20,Math.max(0,top3-25)*0.9);
  if(topTheme.pct>20) concentrationScore-=Math.min(15,(topTheme.pct-20)*0.8);
  concentrationScore=Math.max(0,Math.round(concentrationScore));

  let fragmentationScore=Math.max(0,100-Math.min(50,micro.length*3));
  if(micro.length>15) fragmentationScore=Math.max(0,fragmentationScore-10);
  fragmentationScore=Math.round(fragmentationScore);

  const risk=(largest?.weight>=15||topTheme.pct>=25||micro.length>=15)?"HIGH":
             (largest?.weight>=10||topTheme.pct>=20||micro.length>=8)?"ELEVATED":"MODERATE";

  const actions=[];
  oversized.forEach(h=>{
    const target=Math.max(8,Math.min(10,h.weight-2));
    const currentValue=h.value;
    const targetValue=total*target/100;
    const reduceValue=Math.max(0,currentValue-targetValue);
    const shares=h.ltp>0?Math.floor(reduceValue/h.ltp):null;
    actions.push({
      type:"REDUCE",priority:h.weight>=15?"HIGH":"MEDIUM",symbol:h.symbol,
      current_weight:+h.weight.toFixed(2),target_weight:+target.toFixed(2),
      value_release:+reduceValue.toFixed(2),shares,
      price_range:null,reason:h.weight>=15?
        "Single-position concentration is high; reduce size toward a safer portfolio weight.":
        "Position is above the portfolio's concentration guardrail; consider trimming rather than adding."
    });
  });

  watch.slice(0,4).forEach(h=>{
    actions.push({
      type:"WATCH",priority:"MEDIUM",symbol:h.symbol,current_weight:+h.weight.toFixed(2),
      target_weight:null,shares:null,value_release:0,
      reason:"Large position. No automatic sell is recommended without stock-level research; review fundamental and technical thesis."
    });
  });

  micro.sort((a,b)=>a.value-b.value).slice(0,12).forEach(h=>{
    actions.push({
      type:"CLEANUP",priority:"LOW",symbol:h.symbol,current_weight:+h.weight.toFixed(2),
      target_weight:0,shares:h.qty??null,value_release:+h.value.toFixed(2),
      reason:"Micro position has limited portfolio impact; review whether to consolidate it into a higher-conviction holding."
    });
  });

  if(topTheme.pct>=20){
    actions.push({
      type:"THEME",priority:"HIGH",theme:topTheme.theme,current_pct:+topTheme.pct.toFixed(2),
      target_pct:18,
      reason:"Theme concentration is elevated. Use stock-level research to decide which names should fund diversification."
    });
  }

  const researchThemes=themeRows.filter(x=>x.pct<5 && !/ETF|Gold|Passive/i.test(x.theme)).slice(-5).map(x=>({
    theme:x.theme,pct:+x.pct.toFixed(2),reason:"Underrepresented theme; shortlist stocks here only after stock-level research."
  }));

  // Illustrative post-plan metrics use only deterministic reductions.
  const reductions=actions.filter(a=>a.type==="REDUCE").reduce((s,a)=>s+(a.value_release||0),0);
  const projected=hs.map(h=>{
    const r=actions.find(a=>a.symbol===h.symbol&&a.type==="REDUCE");
    const v=r?Math.max(0,h.value-(r.value_release||0)):h.value;
    return {...h,value2:v,weight2:total?v/total*100:0};
  });
  const largestAfter=projected.reduce((a,b)=>!a||b.weight2>a.weight2?b:a,null);

  return {
    as_of:snapshot.as_of||null,total,
    metrics:{
      holdings:hs.length,micro_positions:micro.length,
      largest_weight:+(largest?.weight||0).toFixed(2),
      top3_weight:+top3.toFixed(2),
      top_theme:topTheme.theme,top_theme_pct:+topTheme.pct.toFixed(2),
      large_cap_pct:+largeCap.toFixed(2),
      concentration_score:concentrationScore,
      fragmentation_score:fragmentationScore,
      risk
    },
    themes:themeRows,caps:capRows,
    actions,
    research_queue:researchThemes,
    projected:{
      reduction_value:+reductions.toFixed(2),
      largest_symbol:largestAfter?.symbol||null,
      largest_weight_after:+(largestAfter?.weight2||0).toFixed(2)
    }
  };
}


function buildSmartRebalanceDecision(parsed,snapshot){
  const hs=(snapshot.holdings||[]).map(h=>({...h,value:num(h.value),ltp:num(h.ltp),weight:num(h.weight)}));
  const total=num(snapshot.value)||hs.reduce((a,h)=>a+h.value,0);
  hs.forEach(h=>{if(!h.weight&&total)h.weight=h.value/total*100;});

  const sells=parsed.smart_sells||parsed.key_positives?.filter(()=>false)||[];
  const buys=parsed.smart_buys||[];
  const capitalText=parsed.capital_to_add_text||null;

  // The parser accepts explicit structured rows from the final response.
  const sellRows=(Array.isArray(parsed.smart_sell_rows)?parsed.smart_sell_rows:[]).map(x=>({
    symbol:x.symbol||x.stock||"N/A",
    shares:x.shares??x.quantity??"N/A",
    price_range:x.price_range||x.range||"N/A",
    reason:x.reason||""
  }));
  const buyRows=(Array.isArray(parsed.smart_buy_rows)?parsed.smart_buy_rows:[]).map(x=>({
    symbol:x.symbol||x.stock||"N/A",
    shares:x.shares??x.quantity??"N/A",
    price_range:x.price_range||x.range||"N/A",
    reason:x.reason||"",
    is_new:!hs.some(h=>h.symbol===String(x.symbol||x.stock||"").toUpperCase())
  }));

  return {
    action:parsed.action||"REVIEW",
    confidence:parsed.confidence||"DATA UNAVAILABLE",
    summary:parsed.smart_summary||parsed.reasoning||"Review the submitted portfolio research.",
    fundamental:parsed.fundamental||"DATA UNAVAILABLE",
    valuation:parsed.valuation||"DATA UNAVAILABLE",
    technical:parsed.technical||"DATA UNAVAILABLE",
    risk:parsed.risk||"DATA UNAVAILABLE",
    portfolio_fit:parsed.portfolio_fit||"DATA UNAVAILABLE",
    smart_sells:sellRows,
    smart_buys:buyRows,
    capital_to_add:capitalText||"N/A",
    target_allocation:parsed.target_allocation||"N/A",
    rebalancing_action:parsed.rebalancing_action||parsed.rebalance_action||"N/A",
    expected_impact:parsed.expected_portfolio_impact||"N/A",
    positives:parsed.key_positives||[],
    negatives:parsed.key_negatives||[],
    reasoning:parsed.reasoning||"",
    source_note:"Portfolio-level action plan extracted from the submitted ChatGPT research response. New-stock BUY ideas are allowed, but should still be individually researched before purchase."
  };
}


    if (req.method==="POST" && pathname==="/api/rebalance/submit-response") {
      const b=await body(req);
      const response=String(b.response||"").trim();
      if(!response) return json(res,400,{status:"error",message:"Paste the ChatGPT response first."});
      const s=loadSnapshot();

      const extractJson=(text)=>{
        const cleaned=text.replace(/^\uFEFF/,"").trim();
        const direct=parseMaybeJson(cleaned);
        if(direct && typeof direct==="object") return direct;
        const noFence=cleaned.replace(/```(?:json)?/gi,"").replace(/```/g,"").trim();
        const parsed=parseMaybeJson(noFence);
        if(parsed && typeof parsed==="object") return parsed;
        const a=noFence.indexOf("{"), z=noFence.lastIndexOf("}");
        if(a>=0&&z>a){
          const p=parseMaybeJson(noFence.slice(a,z+1));
          if(p&&typeof p==="object") return p;
        }
        return null;
      };

      const raw=extractJson(response);
      if(!raw){
        return json(res,422,{
          status:"error",
          message:"The response could not be parsed as valid JSON. Please paste the JSON response without Markdown/code fences or additional text."
        });
      }

      const holdingsSource=Array.isArray(raw.holdings_review)?raw.holdings_review:(Array.isArray(raw.all_61_holdings_reviewed)?raw.all_61_holdings_reviewed:[]);
      const normalizedHoldings=holdingsSource.map((h,i)=>({
        n:h.n??h.index??i+1,
        symbol:String(h.symbol||h.stock||"").toUpperCase(),
        action:String(h.action||"HOLD").toUpperCase(),
        confidence:h.confidence||"N/A",
        fundamental:h.fundamental||h.fundamental_summary||"DATA UNAVAILABLE",
        valuation:h.valuation||"DATA UNAVAILABLE",
        technical:h.technical||h.technical_summary||"DATA UNAVAILABLE",
        risk:h.risk||"N/A",
        portfolio_fit:h.portfolio_fit||"N/A",
        exchange:h.exchange||h.ex||"",
        quantity:h.quantity??h.qty??null,
        avg_price:h.avg_price??h.avg??null,
        ltp:h.ltp??null,
        value:h.value??null,
        pnl:h.pnl??null,
        pnl_pct:h.pnl_pct??null,
        current_weight:h.current_weight??h.weight??null,
        target_weight:h.target_weight??null,
        shares_to_sell:h.shares_to_sell??0,
        sell_price_range:h.sell_price_range??"N/A",
        shares_to_buy:h.shares_to_buy??0,
        buy_price_range:h.buy_price_range??"N/A",
        decision_reason:h.decision_reason||h.note||"",
        price_action:h.price_action||h.technical||"N/A",
        trade_plan:h.trade_plan||{
          type:h.action||"HOLD",
          headline:(h.action||"HOLD")+" — review stock-specific plan",
          shares:(h.shares_to_buy??0)>0?(h.shares_to_buy??0):(h.shares_to_sell??0),
          entry_range:(h.shares_to_buy??0)>0?(h.buy_price_range||"N/A"):(h.sell_price_range||"N/A"),
          stop_loss:"Review",
          target_1:h.target_weight!=null?String(h.target_weight)+"% target weight":"Review",
          target_2:"Review",
          risk_reward:"Review",
          invalidation:"Review",
          horizon:"Portfolio review",
          trigger:"Technical / fundamental confirmation",
          rationale:h.note||"Stock-level CIO decision."
        },
        theme:h.theme||"",
        market_cap:h.market_cap||h.cap||"",
        note:h.note||""
      })).filter(h=>h.symbol);

      const decision={
        action:raw.action||"REVIEW",
        confidence:raw.confidence||"N/A",
        summary:raw.smart_summary||"Portfolio-level Smart Rebalancing result.",
        fundamental:raw.fundamental||"DATA UNAVAILABLE",
        valuation:raw.valuation||"DATA UNAVAILABLE",
        technical:raw.technical||"DATA UNAVAILABLE",
        risk:raw.risk||"DATA UNAVAILABLE",
        portfolio_fit:raw.portfolio_fit||"DATA UNAVAILABLE",
        smart_sells:Array.isArray(raw.sell_plan)?raw.sell_plan.map(x=>({
          symbol:String(x.symbol||"").toUpperCase(),shares:x.shares??"N/A",price_range:x.price_range??"N/A",reason:x.reason||""
        })).filter(x=>x.symbol):[],
        smart_buys:Array.isArray(raw.buy_plan)?raw.buy_plan.map(x=>({
          symbol:String(x.symbol||"").toUpperCase(),shares:x.shares??"N/A",price_range:x.price_range??"N/A",reason:x.reason||"",
          is_new:Boolean(x.new_stock) || !s.holdings.some(h=>String(h.symbol).toUpperCase()===String(x.symbol||"").toUpperCase())
        })).filter(x=>x.symbol):[],
        capital_to_add:raw.capital_to_add??"N/A",
        target_allocation:raw.target_allocation??"N/A",
        rebalancing_action:raw.rebalancing_action??"N/A",
        expected_impact:raw.expected_portfolio_impact??"N/A",
        positives:Array.isArray(raw.key_positives)?raw.key_positives:[],
        negatives:Array.isArray(raw.key_negatives)?raw.key_negatives:[],
        reasoning:raw.reasoning||"",
        holdings_review:normalizedHoldings,
        source_note:"JSON Smart Rebalancing response parsed locally. No order is placed."
      };

      return json(res,200,{
        status:"ok",
        decision,
        parser_diagnostics:{
          portfolio_holdings: s.holdings.length,
          reviewed_rows: normalizedHoldings.length,
          all_61_reviewed: normalizedHoldings.length===s.holdings.length,
          sell_rows:decision.smart_sells.length,
          buy_rows:decision.smart_buys.length
        }
      });
    }


    if (req.method==="POST" && pathname==="/api/compare/submit-response") {
      const b=await body(req);
      const text=String(b.response||"").trim().replace(/```(?:json)?/gi,"").replace(/```/g,"");
      const raw=parseMaybeJson(text);
      if(!raw||typeof raw!=="object") return json(res,422,{status:"error",message:"Comparison response must be valid JSON."});
      const stocks=Array.isArray(raw.stocks)?raw.stocks.map(x=>({
        symbol:String(x.symbol||"").toUpperCase(),action:x.action||"REVIEW",conviction:x.conviction||"MEDIUM",
        fundamental:x.fundamental||"",valuation:x.valuation||"",technical:x.technical||"",
        price_action:x.price_action||"",portfolio_fit:x.portfolio_fit||"",
        trade_plan:x.trade_plan||{},replace_candidate:x.replace_candidate||"NONE"
      })).filter(x=>x.symbol):[];
      const ranking=Array.isArray(raw.ranking)?raw.ranking:[];
      if(stocks.length<2) return json(res,422,{status:"error",message:"At least two stocks are required in the comparison response."});
      return json(res,200,{status:"ok",result:{
        winner:raw.winner||"",ranking,comparison:raw.comparison||{},
        stocks,final_recommendation:raw.final_recommendation||"",capital_note:raw.capital_note||""
      }});
    }

    if (req.method==="GET" && pathname==="/api/opportunities/context") {
      const s=loadSnapshot();
      const hs=s.holdings||[];
      const total=num(s.value)||hs.reduce((a,h)=>a+num(h.value),0);
      const themeTotals={}, capTotals={};
      hs.forEach(h=>{
        const theme=h.theme||"Unclassified";
        const cap=h.market_cap||"Unknown";
        themeTotals[theme]=(themeTotals[theme]||0)+num(h.value);
        capTotals[cap]=(capTotals[cap]||0)+num(h.value);
      });
      const themeRows=Object.entries(themeTotals).map(([name,value])=>({name,current_pct:total?value/total*100:0})).sort((a,b)=>b.current_pct-a.current_pct);
      const capRows=Object.entries(capTotals).map(([name,value])=>({name,current_pct:total?value/total*100:0})).sort((a,b)=>b.current_pct-a.current_pct);
      const preferredThemeGuides=["PSU Banks","Private Banks/NBFC","IT Services","Travel","Auto/Auto ancillaries","Exchanges","Chemicals"];
      const preferredCapGuides=["Mid Cap","Small/Mid Cap","ETF","Small Cap"];
      const underThemes=preferredThemeGuides
        .map(name=>themeRows.find(x=>x.name===name)||({name,current_pct:0}))
        .filter(x=>x.current_pct<8)
        .sort((a,b)=>a.current_pct-b.current_pct)
        .slice(0,5)
        .map(x=>({...x,target_guide:x.current_pct<3?"~3-5%":"~5-8%"}));
      const underCaps=preferredCapGuides
        .map(name=>capRows.find(x=>x.name===name)||({name,current_pct:0}))
        .filter(x=>x.current_pct<10)
        .sort((a,b)=>a.current_pct-b.current_pct)
        .slice(0,4)
        .map(x=>({...x,target_guide:x.name==="ETF"?"~15-25%":x.name==="Mid Cap"?"~20-25%":"~5-10%"}));
      const topTheme=themeRows[0]||{name:"—",current_pct:0};
      const largest=hs.slice().sort((a,b)=>num(b.value)-num(a.value))[0]||{symbol:"—",weight:0};
      const micro=hs.filter(h=>num(h.value)<1500).length;
      return json(res,200,{
        status:"ok",
        generated_at:new Date().toISOString(),
        risk:s.risk_level||"REVIEW",
        top_theme:{name:topTheme.name,pct:topTheme.current_pct},
        largest_position:{symbol:largest.symbol,weight:num(largest.weight)||(total?num(largest.value)/total*100:0)},
        micro_positions:micro,
        underweight_themes:underThemes,
        underweight_caps:underCaps,
        holdings:hs.map(h=>({symbol:h.symbol,theme:h.theme,market_cap:h.market_cap,weight:h.weight}))
      });
    }

    if (req.method==="POST" && pathname==="/api/opportunities/submit-response") {
      const b=await body(req);
      const text=String(b.response||"").trim();
      if(!text) return json(res,400,{status:"error",message:"Paste the opportunity JSON first."});
      const cleaned=text.replace(/```(?:json)?/gi,"").replace(/```/g,"").trim();
      let raw=parseMaybeJson(cleaned);
      if(!raw) return json(res,422,{status:"error",message:"Opportunity response must be valid JSON."});
      const list=Array.isArray(raw.candidates)?raw.candidates:[];
      const s=loadSnapshot();
      const held=new Set((s.holdings||[]).map(h=>String(h.symbol).toUpperCase()));
      const candidates=list.map((x,i)=>({
        rank:x.rank??i+1,symbol:String(x.symbol||"").toUpperCase(),company:x.company||"",
        theme:x.theme||"",market_cap:x.market_cap||"",current_price:x.current_price??null,
        action:x.action||"BUY",conviction:x.conviction||"MEDIUM",why_now:x.why_now||"",
        fundamental:x.fundamental||"",valuation:x.valuation||"",technical:x.technical||"",
        price_action:x.price_action||"",portfolio_fit:x.portfolio_fit||"",
        target_weight:x.target_weight||"",
        trade_plan:x.trade_plan||{},
        new_stock:!held.has(String(x.symbol||"").toUpperCase())
      })).filter(x=>x.symbol && x.new_stock);
      if(!candidates.length) return json(res,422,{status:"error",message:"No valid NEW STOCK candidates were found. Candidates must not already be held."});
      return json(res,200,{status:"ok",candidates});
    }

    if (req.method==="GET" && pathname==="/api/rebalance/plan") {
      const s=loadSnapshot();
      return json(res,200,buildRebalancePlan(s));
    }

    if (req.method==="GET" && pathname==="/api/portfolio") {
      const s = loadSnapshot();
      const state=loadAnalysisState();
      const holdings = s.holdings.map(h=>({
        ...h,
        weight:h.weight ?? (s.value?+(h.value/s.value*100).toFixed(2):0),
        market_cap:h.market_cap||capFor(h.symbol),
        status:state.stocks?.[h.symbol]?.status || h.status || "NOT ANALYZED",
        analysis_progress:state.stocks?.[h.symbol]?.progress ?? h.analysis_progress ?? "0%"
      }));
      const c=s.health_score!=null?{score:s.health_score,risk:s.risk_level,details:s.risk_basis||{}}:calculateConstructionHealth(holdings);
      return json(res,200,{...s,health_score:c.score,health_label:"Construction Health",risk_level:c.risk,risk_basis:c.details,analysis_state:state,holdings});
    }


function extractMcpText(result){
  return Array.isArray(result?.content)
    ? result.content.filter(x=>x?.type==="text").map(x=>x.text||"").join("\n")
    : "";
}
function parseMaybeJson(text){
  if(!text) return null;
  try{return JSON.parse(text);}
  catch{
    const a=text.indexOf("{"), b=text.lastIndexOf("}");
    if(a>=0&&b>a){try{return JSON.parse(text.slice(a,b+1));}catch{}}
    const c=text.indexOf("["), d=text.lastIndexOf("]");
    if(c>=0&&d>c){try{return JSON.parse(text.slice(c,d+1));}catch{}}
    return null;
  }
}
function pickSearchArgs(tool,symbol){
  const p=tool?.inputSchema?.properties||{};
  const a={};
  const keys=Object.keys(p);
  const preferred=["query","search","q","keyword","term","symbol","name"];
  const key=preferred.find(k=>p[k]?.type==="string"||p[k]?.type==="string");
  if(key) a[key]=symbol;
  // Some versions may require an exchange/filter. NSE is the sensible
  // first pass for equity symbols; UI lets the user see all returned matches.
  if(p.exchange && !a.exchange) a.exchange="NSE";
  if(p.from!=null) a.from=0;
  if(p.limit!=null) a.limit=20;
  return a;
}
function normalizeInstrumentResults(result,symbol){
  const text=extractMcpText(result);
  const parsed=parseMaybeJson(text);
  let arr=[];
  if(Array.isArray(parsed)) arr=parsed;
  else if(Array.isArray(parsed?.data)) arr=parsed.data;
  else if(Array.isArray(parsed?.instruments)) arr=parsed.instruments;
  else if(parsed && typeof parsed==="object") arr=[parsed];

  // If MCP returns line-oriented text, capture common instrument fields.
  if(!arr.length && text){
    const lines=text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
    for(const line of lines){
      if(!line.toUpperCase().includes(symbol.toUpperCase())) continue;
      const m=line.match(/(?:instrument_token|token)\s*[:=]\s*(\d+)/i);
      if(m) arr.push({tradingsymbol:symbol,instrument_token:Number(m[1]),raw:line});
    }
  }

  return arr.map(x=>({
    instrument_token:x.instrument_token??x.instrumentToken??x.token??null,
    exchange:x.exchange||x.segment?.split(":")[0]||"NSE",
    tradingsymbol:x.tradingsymbol||x.symbol||symbol,
    name:x.name||x.company||x.description||x.tradingsymbol||x.symbol||symbol,
    segment:x.segment||"",
    isin:x.isin||"",
    raw:x
  })).filter(x=>x.instrument_token||x.tradingsymbol);
}
    if (req.method==="GET" && pathname.startsWith("/api/stock/")) {
      const symbol = decodeURIComponent(pathname.split("/").pop()).toUpperCase();
      const s = loadSnapshot();
      const h = s.holdings.find(x=>x.symbol===symbol);

      if(h){
        return json(res,200,{
          status:"ok",
          found_in_portfolio:true,
          symbol,
          stock:h,
          instrument:{
            instrument_token:h.instrument_token,
            exchange:h.exchange,
            tradingsymbol:h.symbol,
            name:h.symbol
          },
          analysis:{
            fundamental:"RESEARCH PENDING",
            technical:"RESEARCH PENDING",
            valuation:"RESEARCH PENDING",
            portfolio_fit:"Provisional"
          }
        });
      }

      // Universal Any Stock: resolve a non-held instrument through Kite MCP.
      try{
        const ks=await loadKiteService();
        await ks.connectKite();
        const tools=await ks.listTools();
        const searchTool=(tools.tools||[]).find(x=>x.name==="search_instruments");
        if(!searchTool){
          return json(res,503,{status:"error",message:"Kite MCP instrument search is unavailable."});
        }

        const args=pickSearchArgs(searchTool,symbol);
        const raw=await ks.callReadOnlyTool("search_instruments",args);
        const matches=normalizeInstrumentResults(raw,symbol);

        if(!matches.length){
          return json(res,404,{status:"not_found",found_in_portfolio:false,symbol,message:`No tradable instrument found for ${symbol}.`});
        }

        // Prefer an exact trading-symbol match.
        matches.sort((a,b)=>{
          const ae=String(a.tradingsymbol).toUpperCase()===symbol?0:1;
          const be=String(b.tradingsymbol).toUpperCase()===symbol?0:1;
          return ae-be;
        });

        const instrument=matches[0];

        // Best-effort current quote; failure does not block research.
        let quote=null;
        if(instrument.instrument_token){
          try{
            const ltpTool=(tools.tools||[]).find(x=>x.name==="get_ltp");
            if(ltpTool){
              const lp=ltpTool.inputSchema?.properties||{};
              const key=Object.keys(lp).find(k=>/instrument|trad/.test(k));
              const la={};
              if(key) la[key]=[`${instrument.exchange}:${instrument.tradingsymbol}`];
              const qr=await ks.callReadOnlyTool("get_ltp",la);
              quote=parseMaybeJson(extractMcpText(qr));
            }
          }catch{}
        }

        return json(res,200,{
          status:"ok",
          found_in_portfolio:false,
          symbol,
          stock:null,
          instrument,
          matches:matches.slice(0,10),
          quote,
          analysis:{
            fundamental:"RESEARCH PENDING",
            technical:"RESEARCH PENDING",
            valuation:"RESEARCH PENDING",
            portfolio_fit:"Requires portfolio-aware research"
          }
        });
      }catch(e){
        return json(res,503,{
          status:"error",
          found_in_portfolio:false,
          symbol,
          message:e?.message||String(e)
        });
      }
    }

    if (req.method==="GET" && pathname==="/api/analysis/history") {
      return json(res,200,loadRuns().slice(-20).reverse());
    }

    if (req.method==="GET") {
      let file = pathname==="/" || pathname==="/index.html" ? "index.html" :
                 pathname.startsWith("/static/") ? pathname.substring(8) :
                 pathname.replace(/^\/+/,"");
      const full = safeFile(file);
      if (!full || !fs.existsSync(full) || fs.statSync(full).isDirectory())
        return send(res,404,"text/plain; charset=utf-8","Not found");
      const ext = path.extname(full).toLowerCase();
      const types = {".html":"text/html; charset=utf-8",".js":"application/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".json":"application/json; charset=utf-8"};
      return send(res,200,types[ext]||"application/octet-stream",fs.readFileSync(full));
    }

    send(res,405,"text/plain; charset=utf-8","Method not allowed");
  } catch(e) {
    console.error(e);
    return json(res,500,{status:"error",message:e.message,stack:e.stack});
  }
});

const PORT=8000;
server.listen(PORT,"127.0.0.1",()=>console.log(`Portfolio CIO V1.3 running at http://127.0.0.1:${PORT}`));