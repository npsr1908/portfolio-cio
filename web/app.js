
let portfolio=null, currentView="dashboard"; let kiteConnected=false; let kiteAuthenticated=false;
const $=s=>document.querySelector(s);
const money=v=>"₹"+Number(v).toLocaleString("en-IN",{maximumFractionDigits:0});
const pct=v=>(Number(v)>=0?"+":"")+Number(v).toFixed(2)+"%";
function statusClass(s){return s.replace(/\s+/g,"_").replace("RESEARCH_PENDING","RESEARCH")}
function toast(msg){const t=$("#toast");t.textContent=msg;t.style.display="block";setTimeout(()=>t.style.display="none",2500)}
async function load(){
  // Do not render/load the cached portfolio until authentication is known.
  await refreshKiteStatus();
  if(kiteAuthenticated){
    await enterAuthenticatedApp(true);
  }else{
    showHome();
  }
}
function applyAnalysisState(st, shouldRender=true){
  if(!st || typeof st!=="object") return;
  portfolio.analysis_state=st;
  Object.entries(st.stocks||{}).forEach(([sym,row])=>{
    const h=portfolio.holdings.find(x=>x.symbol===sym);
    if(!h)return;
    if(/^(ANALYZING|QUEUED|TECHNICAL )/.test(String(row.status||""))){
      h.status=row.status;
      h.action=row.action||h.action||"REVIEW";
      h.action_score=row.action_score;
      h.action_reasons=row.action_reasons||[];
      h.analysis_progress=row.progress??h.analysis_progress??0;
      h.analysis_error=row.last_error||null;
      h.technical=row.technical||h.technical;
    }
  });
  if(shouldRender){
    // Only views with active progress indicators are re-rendered during the run.
    // Compare, Opportunities and Rebalance remain mounted and stable.
    if(currentView==="dashboard") renderDashboard();
    else if(currentView==="holdings") renderHoldings();
  }
}
async function refreshAnalysisStateIntoPortfolio(shouldRender=true){
  try{
    const r=await fetch("/api/analysis/status",{cache:"no-store"});
    const st=await r.json();
    applyAnalysisState(st,shouldRender);
    return st;
  }catch(e){return portfolio.analysis_state||null;}
}
async function fetchPortfolioSnapshot(){
  portfolio=await (await fetch("/api/portfolio")).json();
  await refreshAnalysisStateIntoPortfolio();
  window.__priorStatuses=Object.fromEntries((portfolio.holdings||[]).map(h=>[h.symbol,h.status]));
  const asOf=portfolio.as_of;
  $("#asOf").textContent=asOf ? ("Live sync: "+new Date(asOf).toLocaleString()) : "";
}
async function syncAfterLogin(){
  const r=await (await fetch("/api/kite/sync",{method:"POST"})).json();
  if(r.status!=="ok"){
    throw new Error(r.message||r?.error?.message||"Zerodha sync failed.");
  }
  portfolio=r.snapshot;
  await refreshAnalysisStateIntoPortfolio();
  window.__priorStatuses=Object.fromEntries((portfolio.holdings||[]).map(h=>[h.symbol,h.status]));
  $("#asOf").textContent="Live sync: "+new Date(portfolio.as_of).toLocaleString();
  renderAll();
}
async function enterAuthenticatedApp(syncLive=true){
  $("#homePage").style.display="none";
  $("#appShell").style.display="";
  try{
    if(syncLive) await syncAfterLogin();
    else {
      await fetchPortfolioSnapshot();
      renderAll();
    }
  }catch(e){
    toast("Could not load live portfolio: "+e.message);
  }
}
function showHome(message=""){
  $("#appShell").style.display="none";
  $("#homePage").style.display="";
  $("#homeStatus").textContent=message||"";
}
function setHomeStatus(message){
  $("#homeStatus").textContent=message||"";
}
async function refreshKiteStatus(){
  try{
    const s=await (await fetch("/api/health")).json();
    kiteConnected=!!s.mcp_connected;
    kiteAuthenticated=!!s.zerodha_connected;
    const el=$("#kiteStatus");
    if(el){
      if(kiteAuthenticated){
        el.textContent="Kite MCP: Connected";
        el.className="status connected";
      }else if(kiteConnected){
        el.textContent="Kite MCP: Ready — Login needed";
        el.className="status HOLD";
      }else{
        el.textContent="Kite MCP: Not connected";
        el.className="status RESEARCH";
      }
    }
    return s;
  }catch(e){
    kiteConnected=false;
    kiteAuthenticated=false;
    return null;
  }
}
async function verifyAndEnterApp(){
  const r=await (await fetch("/api/kite/verify",{method:"POST"})).json();
  if(!r.authenticated) return false;
  kiteAuthenticated=true;
  await refreshKiteStatus();
  setHomeStatus("Zerodha verified. Loading your live portfolio…");
  await enterAuthenticatedApp(true);
  return true;
}
async function startLoginFlow(){
  const b=$("#getStarted");
  if(b){b.disabled=true;b.classList.add("busy");}
  setHomeStatus("Preparing secure Zerodha login…");
  await fetch("/api/kite/logout",{method:"POST"}).catch(()=>{});
  kiteAuthenticated=false;
  kiteConnected=false;

  // Use a browser-native form submission targeted at a new tab. The server
  // waits for the real Kite authorization URL and then sends an HTTP redirect,
  // so the tab never starts as about:blank and the Portfolio CIO tab remains here.
  try{
    const form=document.createElement("form");
    form.method="POST";
    form.action="/api/kite/login-redirect";
    form.target="kiteLogin";
    form.style.display="none";
    document.body.appendChild(form);
    form.submit();
    form.remove();

    // Obtain a handle to the named popup without creating a blank tab.
    try{ window.kiteLoginWindow=window.open("","kiteLogin"); }catch{}

    setHomeStatus("Opening secure Zerodha login… Complete the login there; Portfolio CIO will verify automatically.");

    let attempts=0;
    const maxAttempts=120;
    while(attempts<maxAttempts){
      attempts++;
      await new Promise(r=>setTimeout(r,3000));
      const ok=await verifyAndEnterApp().catch(()=>false);
      if(ok){
        try{
          // Replace the Kite callback URL with a clean local page immediately
          // after the main app has verified the session.
          if(window.kiteLoginWindow && !window.kiteLoginWindow.closed){
            window.kiteLoginWindow.location.replace("/auth-complete.html");
            // Keep the readable "Authentication Complete" confirmation page
            // open long enough for the user to see it.
            setTimeout(()=>{try{window.kiteLoginWindow.close()}catch{}},10000);
          }
        }catch{}
        setHomeStatus("");
        return;
      }
      if(attempts%4===0){
        await refreshKiteStatus().catch(()=>{});
        setHomeStatus(
          kiteAuthenticated
            ? "Zerodha authentication detected. Finishing portfolio sync…"
            : "Waiting for Zerodha authentication…"
        );
      }
    }
    setHomeStatus("Login verification timed out. Please try Let's Get Started again.");
  }catch(e){
    setHomeStatus(e.message||"Login failed.");
  }finally{
    if(b){b.disabled=false;b.classList.remove("busy");}
  }
}
function nav(){
  document.querySelectorAll(".nav").forEach(b=>b.onclick=async()=>{
    document.querySelectorAll(".nav").forEach(x=>x.classList.remove("active"));
    b.classList.add("active");
    currentView=b.dataset.view;
    document.querySelectorAll(".view").forEach(v=>v.classList.remove("active"));
    $("#"+currentView).classList.add("active");
    $("#pageTitle").textContent={
      dashboard:"Portfolio Dashboard",
      holdings:"Holdings",
      research:"Research Stock",
      compare:"Compare Stocks",
      opportunities:"Opportunities",
      rebalance:"Rebalance"
    }[currentView];

    // Refresh the authoritative analysis state without rendering any intermediate
    // workspace. Then render the destination exactly once.
    const st=await refreshAnalysisStateIntoPortfolio(false);
    if(currentView==="dashboard") renderDashboard();
    else if(currentView==="holdings"){ renderHoldings(); if(st?.status==="running") renderBanner(); }
    else if(currentView==="research") renderResearch();
    else if(currentView==="compare") renderCompare();
    else if(currentView==="opportunities") renderOpportunities();
    else if(currentView==="rebalance") {
      const rbHost=$("#rebalance");
      const hasResult=!!(rbHost && __smartRebalanceSubmittedResult && rbHost.querySelector("#smartDecision .smart-result-shell"));
      if(!hasResult) renderRebalance();
    }
  })
}
function renderAll(){renderDashboard();renderHoldings();renderResearch();renderCompare();renderOpportunities();renderRebalance()}
function renderDashboard(){
 const hs=portfolio.holdings||[];
 const total=Number(portfolio.value||0);
 const top=[...hs].sort((a,b)=>Number(b.value||0)-Number(a.value||0)).slice(0,8);
 const losers=[...hs].sort((a,b)=>Number(a.pnl||0)-Number(b.pnl||0)).slice(0,6);
 const micro=hs.filter(h=>Number(h.value||0)<1500).length;

 const stateStocks=portfolio.analysis_state?.stocks||{};
 const analyzedRows=Object.values(stateStocks).filter(r=>/^TECHNICAL (READY|ERROR|RATE LIMITED|INSUFFICIENT DATA)$/i.test(String(r?.status||"")));
 const readyRows=Object.values(stateStocks).filter(r=>String(r?.status||"").toUpperCase()==="TECHNICAL READY");
 const analyzed=Math.min(hs.length,analyzedRows.length);
 const buyCount=readyRows.filter(r=>/^(BUY|ACCUMULATE)$/i.test(String(r.action||""))).length;
 const sellCount=readyRows.filter(r=>/^(SELL|REDUCE)$/i.test(String(r.action||""))).length;
 const holdWaitCount=readyRows.filter(r=>/^(HOLD|WAIT|REVIEW)$/i.test(String(r.action||""))).length;
 const actionCount=buyCount+sellCount+holdWaitCount;

 const themeTotals={};
 hs.forEach(h=>{const k=h.theme||"Unclassified";themeTotals[k]=(themeTotals[k]||0)+Number(h.value||0);});
 const topTheme=Object.entries(themeTotals).sort((a,b)=>b[1]-a[1])[0];
 const topThemePct=topTheme&&total ? topTheme[1]/total*100 : 0;
 const largest=top[0];
 const largestLoss=losers[0];
 const lossAbs=largestLoss?Math.abs(Number(largestLoss.pnl||0)):0;

 const concentrationTone=(largest?.weight||0)>=10 ? "negative" : "warning";
 const themeTone=topThemePct>=20 ? "negative" : "warning";
 const healthScore=portfolio.health_score;
 const riskLevel=portfolio.risk_level||"—";
 const riskBasis=portfolio.risk_basis||{};
 const top1=Number(riskBasis.top1||largest?.weight||0);
 const top5=Number(riskBasis.top5||0);
 const microRisk=Number(riskBasis.micro||micro);
 const topThemeRisk=Number(riskBasis.topTheme||topThemePct);

 $("#dashboard").innerHTML=`
 <div class="grid cards">
  <div class="card"><div class="label">Portfolio Value</div><div class="big">${money(portfolio.value)}</div><div class="muted">Invested ${money(portfolio.invested)}</div></div>
  <div class="card"><div class="label">Unrealised P&L</div><div class="big positive">${money(portfolio.pnl)}</div><div class="positive">${pct(portfolio.pnl_pct)}</div></div>
  <div class="card dashboard-metric-card health-metric" id="constructionHealthMetric">
    <button class="metric-info" data-scroll="constructionHealthInfo" title="Click to get more information" aria-label="More information about Construction Health">i</button>
    <div class="label">Construction Health</div>
    <div class="big warning">${healthScore==null?"—":healthScore+"/100"}</div>
    <div class="muted">Concentration + fragmentation</div>
  </div>
  <div class="card dashboard-metric-card risk-metric" id="portfolioRiskMetric">
    <button class="metric-info" data-scroll="portfolioRiskInfo" title="Click to get more information" aria-label="More information about Portfolio Risk">i</button>
    <div class="label">Portfolio Risk</div>
    <div class="big warning">${riskLevel}</div>
    <div class="muted">Sizing + concentration + fragmentation</div>
  </div>
 </div>

 <div class="dashboard-action-center">
   <div class="dashboard-action-head">
     <div><div class="eyebrow">CIO ACTION CENTER</div><h2>What needs attention?</h2><p class="muted">A live portfolio-level snapshot connecting concentration, technical coverage, losses, actions and diversification gaps to the relevant workspace.</p></div>
     <div class="dashboard-action-count"><b>${analyzed}/${hs.length}</b><span>holdings analyzed</span></div>
   </div>
   <div class="dashboard-action-grid">
     <div class="dashboard-action-card concentration">
       <div class="dash-accent">CONCENTRATION</div>
       <b>${largest?largest.symbol:"—"} · ${largest?Number(largest.weight||0).toFixed(2):"—"}%</b>
       <p>${largest&&Number(largest.weight||0)>=10?"Largest position is above the 10% sizing guardrail. Review sizing in Rebalance.":"Largest position is within the current sizing guardrail."}</p>
       <button class="dash-link" data-target="rebalance">Open Rebalance →</button>
     </div>
     <div class="dashboard-action-card research">
       <div class="dash-accent">TECHNICAL COVERAGE</div>
       <b>${analyzed}/${hs.length}</b>
       <p>${analyzed<hs.length?`${hs.length-analyzed} holdings still need technical analysis.`:"Technical analysis is complete for all synced holdings."}</p>
       <button class="dash-link" data-target="holdings">Open Holdings →</button>
     </div>
     <div class="dashboard-action-card loss">
       <div class="dash-accent">LARGEST DRAWDOWN</div>
       <b>${largestLoss?largestLoss.symbol:"—"} · ${largestLoss?money(lossAbs):"—"}</b>
       <p>${largestLoss?`${pct(largestLoss.pnl_pct)} unrealised P&L. Loss alone is not a sell signal; research the thesis and portfolio fit first.`:"No loss position detected."}</p>
       <button class="dash-link" data-target="research">Research Stock →</button>
     </div>
     <div class="dashboard-action-card diversification">
       <div class="dash-accent">DIVERSIFICATION</div>
       <b>${topTheme?`${topTheme[0]} · ${topThemePct.toFixed(1)}%`:"—"}</b>
       <p>${topTheme&&topThemePct>=20?`Theme concentration is elevated. Explore underweight themes and new-stock candidates.`:"Theme concentration is currently moderate."}</p>
       <button class="dash-link" data-target="opportunities">Find Opportunities →</button>
     </div>
   </div>
   <div class="dashboard-action-footer">
     <span>Technical ${analyzed}/${hs.length}</span>
     <span>BUY ${buyCount}</span>
     <span>SELL / REDUCE ${sellCount}</span>
     <span>HOLD / WAIT ${holdWaitCount}</span>
     <span>Micro positions ${micro}</span>
   </div>
 </div>

 <div class="grid two">
  <div class="panel">
   <h2>Largest Positions</h2>
   ${top.map(h=>`<div class="list-item">
     <span><b>${h.symbol}</b><small class="muted"> · ${h.theme}</small></span>
     <span>${money(h.value)} · ${Number(h.weight||0).toFixed(2)}%</span>
   </div>`).join("")}
  </div>

  <div class="panel attention-panel">
   <h2>Attention Queue</h2>
   <div class="attention-list">
    <div class="attention-row">
      <div><b>Largest concentration</b><small>Portfolio sizing</small></div>
      <b class="${concentrationTone}">${largest?`${largest.symbol} · ${Number(largest.weight||0).toFixed(2)}%`:"—"}</b>
    </div>
    <div class="attention-row">
      <div><b>Top theme exposure</b><small>Theme concentration</small></div>
      <b class="${themeTone}">${topTheme?`${topTheme[0]} · ${topThemePct.toFixed(2)}%`:"—"}</b>
    </div>
    <div class="attention-row">
      <div><b>Largest unrealised loss</b><small>₹ impact + drawdown</small></div>
      <b class="negative">${largestLoss?`${largestLoss.symbol} · ${money(lossAbs)} (${pct(largestLoss.pnl_pct)})`:"—"}</b>
    </div>
    <div class="attention-row">
      <div><b>Technical coverage</b><small>Completed analysis</small></div>
      <b class="attention-blue">${analyzed}/${hs.length}</b>
    </div>
    <div class="attention-row">
      <div><b>Action signals</b><small>From completed technical analysis</small></div>
      <b class="attention-green">${buyCount} BUY · ${sellCount} SELL / REDUCE</b>
    </div>
    <div class="attention-row">
      <div><b>Micro positions</b><small>Small-value fragmentation</small></div>
      <b class="attention-yellow">${micro}</b>
    </div>
   </div>
  </div>
 </div>

 <div class="dashboard-explain-grid">
   <section class="dashboard-explain-card construction-card" id="constructionHealthInfo">
     <div class="explain-head"><span class="explain-icon">◉</span><div><div class="eyebrow">HOW THE SCORE WORKS</div><h2>Construction Health · ${healthScore==null?"—":healthScore+"/100"}</h2></div></div>
     <p>The score measures <b>portfolio construction quality</b>, not whether the individual companies are good or bad. It starts at 100 and is reduced for concentration and fragmentation.</p>
     <div class="explain-metrics">
       <div><span>Top 1 weight</span><b>${top1.toFixed(2)}%</b><small>Penalty begins above 10%</small></div>
       <div><span>Top 5 weight</span><b>${top5.toFixed(2)}%</b><small>Penalty begins above 35%</small></div>
       <div><span>Micro positions</span><b>${microRisk}</b><small>0.6-point penalty each, capped</small></div>
       <div><span>Top theme</span><b>${topThemeRisk.toFixed(2)}%</b><small>Penalty begins above 20%</small></div>
     </div>
     <div class="explain-note">Formula used by the app: <b>100 − concentration penalty − top-5 penalty − fragmentation penalty − theme penalty</b>, bounded between 0 and 100.</div>
   </section>

   <section class="dashboard-explain-card risk-card" id="portfolioRiskInfo">
     <div class="explain-head"><span class="explain-icon">◈</span><div><div class="eyebrow">HOW RISK IS CLASSIFIED</div><h2>Portfolio Risk · ${riskLevel}</h2></div></div>
     <p>Portfolio Risk is a <b>construction-risk flag</b>. It is driven by position concentration, top-five concentration and the number of micro positions. It does not judge earnings quality.</p>
     <div class="explain-metrics">
       <div><span>Largest position</span><b>${top1.toFixed(2)}%</b><small>${top1>=15?"Elevated-risk zone":"Below elevated-risk threshold"}</small></div>
       <div><span>Top 5 exposure</span><b>${top5.toFixed(2)}%</b><small>${top5>=40?"Elevated-risk zone":"Below elevated-risk threshold"}</small></div>
       <div><span>Micro positions</span><b>${microRisk}</b><small>${microRisk>=12?"Elevated-risk zone":"Below elevated-risk threshold"}</small></div>
       <div><span>Theme exposure</span><b>${topThemeRisk.toFixed(2)}%</b><small>Included in health score</small></div>
     </div>
     <div class="risk-scale"><span class="${riskLevel==="Low"?"active":""}">LOW</span><span class="${riskLevel==="Moderate"?"active":""}">MODERATE</span><span class="${riskLevel==="Elevated"?"active":""}">ELEVATED</span><span class="${riskLevel==="HIGH"?"active":""}">HIGH</span></div>
     <div class="explain-note">Current risk: <b>${riskLevel}</b>. Use Rebalance to reduce concentration and fragmentation; do not interpret this as an automatic BUY/SELL call.</div>
   </section>
 </div>

 <div class="panel construction-snapshot-panel">
  <h2>Portfolio Construction Snapshot</h2>
  <div class="note">
   This score measures <b>portfolio construction</b> only.
   <span class="muted">Use Re-analyse to refresh Zerodha data. Use Analyse on an individual stock or Analyse All in Holdings to run technical analysis.</span>
  </div>
 </div>

 <div class="panel">
  <h2>Largest Losers</h2>
  <table>
   <thead><tr><th>Stock</th><th>Value</th><th>P&L</th><th>P&L %</th><th>Status</th></tr></thead>
   <tbody>${losers.map(h=>`<tr>
    <td><b>${h.symbol}</b></td>
    <td>${money(h.value)}</td>
    <td class="negative">${money(h.pnl)}</td>
    <td class="negative">${pct(h.pnl_pct)}</td>
    <td><span class="status ${statusClass(h.status)}">${h.status||"NOT ANALYZED"}</span></td>
   </tr>`).join("")}</tbody>
  </table>
 </div>`;

 document.querySelectorAll(".dash-link").forEach(btn=>btn.onclick=()=>{
   const target=btn.dataset.target;
   document.querySelectorAll(".nav").forEach(x=>x.classList.remove("active"));
   const nav=document.querySelector(`.nav[data-view="${target}"]`);
   if(nav) nav.classList.add("active");
   currentView=target;
   document.querySelectorAll(".view").forEach(v=>v.classList.remove("active"));
   $("#"+target).classList.add("active");
   $("#pageTitle").textContent={dashboard:"Portfolio Dashboard",holdings:"Holdings",research:"Research Stock",compare:"Compare Stocks",opportunities:"Opportunities",rebalance:"Rebalance"}[target]||"Portfolio";
 });

 document.querySelectorAll(".metric-info").forEach(btn=>btn.onclick=()=>{
   const el=document.getElementById(btn.dataset.scroll);
   if(el) el.scrollIntoView({behavior:"smooth",block:"center"});
 });
}


let __smartRebalanceSubmittedResult=null;
let __opportunitySubmittedResult=null;

const chartPalette=["#6ea8fe","#59d98e","#f1c75b","#ff788d","#9d8cff","#52c7d9","#f0a35b","#90a6b8","#d47cff","#7ed7a8"];
function groupValues(hs,key){const m={};hs.forEach(h=>{const k=h[key]||"Unclassified";m[k]=(m[k]||0)+Number(h.value||0)});return Object.entries(m).map(([name,value])=>({name,value}));}
function statusClass2(s){return String(s||"").replace(/\s+/g,"_")}
function polar(cx,cy,r,a){const rad=(a-90)*Math.PI/180;return [cx+r*Math.cos(rad),cy+r*Math.sin(rad)];}
function piePath(cx,cy,r,start,end){const [sx,sy]=polar(cx,cy,r,end),[ex,ey]=polar(cx,cy,r,start),large=end-start>180?1:0;return `M ${cx} ${cy} L ${sx} ${sy} A ${r} ${r} 0 ${large} 0 ${ex} ${ey} Z`;}
function renderInteractivePie(el,items,title){
  const total=items.reduce((a,b)=>a+b.value,0)||1;
  el.innerHTML=`<div class="interactive-pie-wrap"><div class="pie-svg-holder"></div><div class="legend"></div></div>`;
  const wrap=el.firstElementChild,holder=wrap.querySelector(".pie-svg-holder"),legend=wrap.querySelector(".legend");
  const NS="http://www.w3.org/2000/svg",svg=document.createElementNS(NS,"svg");
  svg.setAttribute("viewBox","0 0 220 220");svg.setAttribute("class","pie-svg");svg.setAttribute("aria-label",title);
  const cx=110,cy=110,r=86;let angle=0;

  const clearHighlight=()=>{
    svg.querySelectorAll(".pie-slice").forEach(s=>s.classList.remove("selected","dimmed"));
    legend.querySelectorAll(".legend-item").forEach(x=>x.classList.remove("selected","dimmed"));
  };
  const highlight=(i)=>{
    svg.querySelectorAll(".pie-slice").forEach((s,n)=>{
      s.classList.toggle("selected",n===i);
      s.classList.toggle("dimmed",n!==i);
    });
    legend.querySelectorAll(".legend-item").forEach((x,n)=>{
      x.classList.toggle("selected",n===i);
      x.classList.toggle("dimmed",n!==i);
    });
  };

  items.forEach((item,i)=>{
    const sweep=item.value/total*360;
    const path=document.createElementNS(NS,"path");
    path.setAttribute("d",piePath(cx,cy,r,angle,angle+sweep));
    path.setAttribute("fill",chartPalette[i%chartPalette.length]);
    path.setAttribute("class","pie-slice");
    const ttl=document.createElementNS(NS,"title");
    ttl.textContent=`${item.name}: ${(item.value/total*100).toFixed(1)}%`;
    path.appendChild(ttl);
    path.addEventListener("mouseenter",()=>highlight(i));
    path.addEventListener("mouseleave",clearHighlight);
    path.addEventListener("click",e=>e.preventDefault());
    svg.appendChild(path);
    angle+=sweep;
  });

  const hole=document.createElementNS(NS,"circle");
  hole.setAttribute("cx",cx);hole.setAttribute("cy",cy);hole.setAttribute("r","50");
  hole.setAttribute("fill","var(--panel)");hole.setAttribute("stroke","var(--border)");hole.setAttribute("stroke-width","1");
  svg.appendChild(hole);holder.appendChild(svg);

  items.forEach((item,i)=>{
    const li=document.createElement("div");li.className="legend-item";
    li.innerHTML=`<span class="legend-swatch" style="background:${chartPalette[i%chartPalette.length]}"></span><span>${item.name}</span><b>${(item.value/total*100).toFixed(1)}%</b>`;
    li.addEventListener("mouseenter",()=>highlight(i));
    li.addEventListener("mouseleave",clearHighlight);
    li.addEventListener("click",e=>e.preventDefault());
    legend.appendChild(li);
  });

  wrap.addEventListener("mouseleave",clearHighlight);
}
function renderHoldings(){
 const holdingRows=Array.isArray(portfolio.holdings)?portfolio.holdings:[];
 const uniqueValues=key=>[...new Set(holdingRows.map(h=>String(h?.[key]??"").trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
 const capOptions=uniqueValues("market_cap");
 const statusOptions=uniqueValues("status");
 const actionOptions=uniqueValues("action").map(v=>v==="—"?"":v);
 const themeOptions=uniqueValues("theme");
 const optionHtml=(value,label=value)=>`<option value="${String(value).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}">${String(label).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}</option>`;
 const capHtml=capOptions.map(v=>optionHtml(v)).join("");
 const statusHtml=statusOptions.map(v=>optionHtml(v)).join("");
 const actionHtml=actionOptions.filter(Boolean).map(v=>optionHtml(v)).join("");
 const themeHtml=themeOptions.map(v=>optionHtml(v)).join("");

 $("#holdings").innerHTML=`
 <div class="chart-row">
   <div class="panel chart-panel"><h2>Allocation by Theme</h2><div id="themeChart" class="pie-wrap"></div></div>
   <div class="panel chart-panel"><h2>Allocation by Market Cap</h2><div id="capChart" class="pie-wrap"></div></div>
 </div>
 <div class="panel">
   <div id="analysisBanner" class="analysis-banner"></div>
   <div class="hold-toolbar">
     <div class="hold-meta">
       <input id="holdSearch" style="width:250px;background:#0c1118;border:1px solid var(--border);color:var(--text);padding:9px;border-radius:9px" placeholder="Search stock/theme…">
       <select id="themeFilter" class="filter-select"><option value="">All Themes</option>${themeHtml}</select>
       <select id="capFilter" class="filter-select"><option value="">All Market Caps</option>${capHtml}</select>
       <select id="statusFilter" class="filter-select"><option value="">All Analysis Status</option>${statusHtml}</select>
       <select id="actionFilter" class="filter-select"><option value="">All Actions</option>${actionHtml}</select>
     </div>
     <div class="hold-meta">
       <button id="analyzeAll" class="btn primary">⚡ Analyse All</button>
       <button id="resetHoldSort" class="btn secondary">Reset Sort</button>
     </div>
   </div>
   <div style="overflow:auto">
   <table id="holdTable"><thead><tr>
    <th>Stock</th><th>Theme</th><th>Cap</th>
    <th class="sortable" data-key="weight">Weight<span class="sort-arrow"></span></th>
    <th class="sortable" data-key="quantity">Qty<span class="sort-arrow"></span></th>
    <th class="sortable" data-key="avg_price">Avg Price<span class="sort-arrow"></span></th>
    <th class="sortable" data-key="ltp">LTP<span class="sort-arrow"></span></th>
    <th class="sortable" data-key="value">Value<span class="sort-arrow"></span></th>
    <th class="sortable" data-key="pnl">P&L<span class="sort-arrow"></span></th>
    <th class="sortable" data-key="pnl_pct">P&L %<span class="sort-arrow"></span></th>
    <th>Status</th><th>Action</th><th>Analysis</th>
   </tr></thead><tbody></tbody></table></div>
 </div>`;

 let sortKey="value",sortDir="desc";

 function drawCharts(){
   const theme=groupValues(portfolio.holdings,"theme").sort((a,b)=>b.value-a.value).slice(0,8);
   const cap=groupValues(portfolio.holdings,"market_cap").sort((a,b)=>b.value-a.value);
   renderInteractivePie($("#themeChart"),theme,"Allocation by Theme");
   renderInteractivePie($("#capChart"),cap,"Allocation by Market Cap");
 }

 function showAnalysisWaitNotice(){
   const host=$("#analysisBanner");
   if(!host)return;
   host.classList.add("analysis-wait-active");
   host.style.display="";
   host.innerHTML=`<div class="analysis-wait-wrap">
     <div class="analysis-wait-copy">
       <div class="analysis-wait-title">⏳ Please wait for analysis to complete</div>
       <div class="analysis-wait-text">Analyse All is running through the portfolio sequentially. You can keep this tab open while it works; for the most reliable progress display, please avoid switching to another tab until the run is complete.</div>
     </div>
     <div class="analysis-wait-progress"><span style="width:0%"></span></div>
     <div class="analysis-wait-meta"><b id="analysisWaitProgress">0/${portfolio.holdings.length||61}</b><span>stocks analysed</span></div>
   </div>`;
 }

 function renderBanner(){
   const st=portfolio.analysis_state||{};
   const total=Number(st.total||portfolio.holdings.length||0);
   const terminal=/^TECHNICAL (READY|ERROR|RATE LIMITED|INSUFFICIENT DATA)$/i;
   const done=Math.min(total,Object.values(st.stocks||{}).filter(r=>terminal.test(String(r?.status||""))).length);
   const running=st.status==="running";
   if(running){
     const host=$("#analysisBanner");
     if(!host)return;
     if(!host.classList.contains("analysis-wait-active")) showAnalysisWaitNotice();
     const progressEl=host.querySelector(".analysis-wait-progress span");
     const countEl=host.querySelector("#analysisWaitProgress");
     const pctValue=total?Math.round(done/total*100):0;
     if(progressEl)progressEl.style.width=`${pctValue}%`;
     if(countEl)countEl.textContent=`${done}/${total}`;
     return;
   }

   if(st.status==="complete" || st.status==="error"){
     const host=$("#analysisBanner");
     if(host){
       host.classList.remove("analysis-wait-active");
       // Do not leave the completed progress bar occupying the Holdings page.
       // The completed state remains available in the status/action fields.
       host.innerHTML="";
       host.style.display="none";
     }
     return;
   }

   const host=$("#analysisBanner");
   if(host){
     host.classList.remove("analysis-wait-active");
     host.style.display="";
     host.innerHTML=`<div><b>Holdings synced. Click Analyse All to run technical analysis.</b></div><div><span class="cap-tag">${portfolio.holdings.length} holdings</span></div>`;
   }
 }
 function filtered(){
   const q=$("#holdSearch").value.toUpperCase();
   const theme=$("#themeFilter").value;
   const cap=$("#capFilter").value;
   const status=$("#statusFilter").value;
   const action=$("#actionFilter").value;
   return [...portfolio.holdings].filter(h=>
     (!q||h.symbol.includes(q)||String(h.theme||"").toUpperCase().includes(q)) &&
     (!theme||String(h.theme||"")===theme) &&
     (!cap||String(h.market_cap||"")===cap) &&
     (!status||String(h.status||"")===status) &&
     (!action||String(h.action||"—")===action)
   ).sort((a,b)=>{const av=Number(a[sortKey]??0),bv=Number(b[sortKey]??0);return sortDir==="asc"?av-bv:bv-av});
 }

 function actionBadge(action){
   const a=String(action||"—");
   const cls=a==="BUY"?"buy":a==="SELL"?"sell":a==="REBALANCE"?"rebalance":a==="HOLD"?"hold":"neutral";
   return `<span class="decision-badge ${cls}">${a}</span>`;
 }

 function renderTable(){
   $("#holdTable tbody").innerHTML=filtered().map(h=>`<tr>
     <td><b>${h.symbol}</b></td>
     <td><span class="pill">${h.theme||"Unclassified"}</span></td>
     <td><span class="cap-tag">${h.market_cap||"Unclassified"}</span></td>
     <td>${Number(h.weight||0).toFixed(2)}%</td><td>${h.quantity}</td>
     <td>${Number(h.avg_price||0).toFixed(2)}</td><td>${Number(h.ltp||0).toFixed(2)}</td>
     <td>${money(h.value)}</td>
     <td class="${h.pnl>=0?"positive":"negative"}">${money(h.pnl)}</td>
     <td class="${h.pnl_pct>=0?"positive":"negative"}">${pct(h.pnl_pct)}</td>
     <td><span class="analysis-status ${statusClass2(h.status)}">${h.status||"NOT ANALYZED"}</span></td>
     <td>${actionBadge(h.action)}</td>
     <td><button class="btn secondary analyze-stock" data-symbol="${h.symbol}">Analyze</button></td>
   </tr>`).join("");

   document.querySelectorAll("#holdTable th.sortable").forEach(th=>th.querySelector(".sort-arrow").textContent=th.dataset.key===sortKey?(sortDir==="asc"?" ↑":" ↓"):"");
   document.querySelectorAll(".analyze-stock").forEach(btn=>btn.onclick=async()=>{
     const sym=btn.dataset.symbol;btn.disabled=true;btn.textContent="Running…";await runSingleAnalysis(sym);btn.disabled=false;btn.textContent="Analyze";
   });
 }

 async function runSingleAnalysis(symbol){
   try{
     const r=await (await fetch("/api/analysis/start-one",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({symbol})})).json();
     if(r.status==="started"){
       const h=portfolio.holdings.find(x=>x.symbol===symbol);
       if(h){h.status="QUEUED";h.action="ANALYZING";}
       portfolio.analysis_state=r.state||portfolio.analysis_state;
       renderAll();
       toast(`${symbol}: technical analysis started.`);
       if(!analysisPoller)pollAnalysis();
     } else toast(r.message||`${symbol}: could not start analysis.`);
   }catch(e){toast(`${symbol}: ${e.message}`);}
 }

 function bind(){
   $("#holdSearch").oninput=renderTable;
   $("#themeFilter").onchange=renderTable;
   $("#capFilter").onchange=renderTable;
   $("#statusFilter").onchange=renderTable;
   $("#actionFilter").onchange=renderTable;
   document.querySelectorAll("#holdTable th.sortable").forEach(th=>th.onclick=()=>{if(sortKey===th.dataset.key)sortDir=sortDir==="asc"?"desc":"asc";else{sortKey=th.dataset.key;sortDir="desc"}renderTable()});
   $("#resetHoldSort").onclick=()=>{sortKey="value";sortDir="desc";renderTable()};
   $("#analyzeAll").onclick=async()=>{
     const b=$("#analyzeAll");b.disabled=true;b.textContent="Starting…";
     try{
       const r=await (await fetch("/api/analysis/start",{method:"POST"})).json();
       if(r.status==="started"){
         const st=await refreshAnalysisStateIntoPortfolio(false);
         applyAnalysisState(st,true);
         showAnalysisWaitNotice();
         toast(`Analyse All started: ${r.total} holdings.`);
         pollAnalysis();
       }else toast(r.message||"Could not start analysis.");
     }catch(e){toast("Could not start analysis: "+e.message);}
     finally{b.disabled=false;b.textContent="⚡ Analyse All";}
   };
 }
 drawCharts();renderBanner();renderTable();bind();
}
function renderResearch(){
 $("#research").innerHTML=`<div class="panel">
   <h2>Research Stock</h2>
   <p class="muted">Analyse any tradable stock — held or not held — using live Kite instrument lookup, local technical analysis and a free ChatGPT research hand-off.</p>
   <div class="search">
     <input id="stockInput" placeholder="e.g. RELIANCE, INFY, HDFCBANK">
     <button id="stockGo" class="btn primary">Analyse Stock</button>
   </div>
   <div id="stockResult"></div>
 </div>`;

 const go=async()=>{
   const s=$("#stockInput").value.trim().toUpperCase();
   if(!s)return;
   const d=await (await fetch("/api/stock/"+encodeURIComponent(s))).json();
   let latestTechnical=null;
   if(d.status==="error"||d.status==="not_found"){
     $("#stockResult").innerHTML=`<div class="research-card"><div class="signal bear">⚠ ${d.message||"Stock not found"}</div></div>`;
     return;
   }
   const h=d.stock;

   $("#stockResult").innerHTML=`
   <div class="research-card">
     <div class="stock-head">
       <div>
         <div class="stock-symbol">${s}</div>
         <div class="research-sub">${d.found_in_portfolio?"Currently held in your portfolio":"Not currently held"}</div>
       </div>
       <span class="status RESEARCH">${d.found_in_portfolio?"HELD":"NOT HELD"}</span>
     </div>
     ${!d.found_in_portfolio && d.instrument?`<div class="note"><b>Instrument resolved:</b> ${d.instrument.exchange}:${d.instrument.tradingsymbol}${d.instrument.name&&d.instrument.name!==d.instrument.tradingsymbol?` · ${d.instrument.name}`:""}. This can be technically analysed even though it is not in the portfolio.</div>`:""}

     ${h?`<div class="kpi-grid">
       <div class="kpi"><div class="label">Market Price</div><div class="value" id="marketPriceKpi">${Number(h.ltp||0).toFixed(2)}</div></div>
       <div class="kpi"><div class="label">Current Value</div><div class="value">${money(h.value)}</div></div>
       <div class="kpi"><div class="label">Portfolio Weight</div><div class="value">${(h.value/portfolio.value*100).toFixed(2)}%</div></div>
       <div class="kpi"><div class="label">Unrealised P&L</div><div class="value ${h.pnl>=0?"positive":"negative"}">${money(h.pnl)}</div></div>
     </div>`:`<div class="kpi-grid">
       <div class="kpi"><div class="label">Instrument</div><div class="value">${d.instrument?.tradingsymbol||s}</div></div>
       <div class="kpi"><div class="label">Exchange</div><div class="value">${d.instrument?.exchange||"NSE"}</div></div>
       <div class="kpi"><div class="label">Market Price</div><div class="value" id="marketPriceKpi">${d.quote?.price??d.quote?.last_price??"Live quote unavailable"}</div></div>
       <div class="kpi"><div class="label">Portfolio Position</div><div class="value">Not held</div></div>
     </div>`}

     <div class="research-toolbar">
       <button id="techBtn" class="btn primary">📈 Technical Analysis</button>
       <button id="packBtn" class="btn secondary">🧠 Prepare ChatGPT Research</button>
     </div>

     <div id="techResult"></div>
     <div id="packResult"></div>

     <div id="responseGate" class="response-gate" style="display:none">
       <div class="research-card response-submit-card">
         <div class="section-head">
           <div>
             <h3>Submit ChatGPT Research Response</h3>
             <div class="research-sub">Paste ChatGPT's full response. The local CIO engine extracts the recommendation and portfolio implications.</div>
           </div>
         </div>
         <textarea id="cioResponseText" class="pack-preview" placeholder="Paste the complete ChatGPT response here…"></textarea>
         <div class="pack-actions">
           <button id="submitCioResponse" class="btn primary">✅ Submit Response</button>
           <span class="research-sub">Processed locally — no paid AI API required.</span>
         </div>
       </div>
     </div>

     <div id="decisionResult"></div>
   </div>`;

   $("#techBtn").onclick=async()=>{
     const b=$("#techBtn"); b.disabled=true; b.textContent="Loading technical data…";
     $("#techResult").innerHTML=`<div class="research-card"><div class="research-sub">Fetching historical candles from Kite MCP and calculating indicators locally…</div></div>`;
     try{
       const r=await (await fetch("/api/technical",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({symbol:s,instrument_token:d.instrument?.instrument_token||h?.instrument_token,exchange:d.instrument?.exchange||h?.exchange})})).json();
       if(r.status!=="ok"){
         $("#techResult").innerHTML=`<div class="research-card"><div class="signal bear">⚠ ${r.message||"Technical scan failed"}</div></div>`;
         return;
       }
       const q=r.technical;
       latestTechnical=q;
       const marketPriceEl=$("#marketPriceKpi");
       if(marketPriceEl && Number.isFinite(Number(q.last_close))) marketPriceEl.textContent=Number(q.last_close).toFixed(2);
       const trendClass=(q.trend||"").toLowerCase().includes("bull")?"bull":(q.trend||"").toLowerCase().includes("bear")?"bear":"neutral";
       const macdHist=q.macd?.hist;
       const macdSignal=macdHist==null?"N/A":(macdHist>0?"Positive":"Negative");
       const rsiSignal=q.rsi14==null?"N/A":(q.rsi14>=70?"Overbought":q.rsi14<=30?"Oversold":"Neutral");
       $("#techResult").innerHTML=`
       <div class="research-card">
         <div class="section-head"><h3>Technical Analysis</h3><span class="signal ${trendClass}">${q.trend||"Mixed"} trend</span></div>
         <div class="kpi-grid">
           <div class="kpi"><div class="label">Last Close</div><div class="value">${q.last_close?.toFixed(2)??"N/A"}</div></div>
           <div class="kpi"><div class="label">RSI (14)</div><div class="value">${q.rsi14?.toFixed(1)??"N/A"} <small class="muted">${rsiSignal}</small></div></div>
           <div class="kpi"><div class="label">ATR (14)</div><div class="value">${q.atr14?.toFixed(2)??"N/A"}</div></div>
           <div class="kpi"><div class="label">Volume vs 20D</div><div class="value">${q.volume_ratio?.toFixed(2)??"N/A"}×</div></div>
         </div>
         <div class="tech-section"><div class="section-head"><h3>Moving Averages</h3></div><div class="tech-grid">
           <div class="kpi"><div class="label">20 DMA</div><div class="value">${q.sma20?.toFixed(2)??"N/A"}</div></div>
           <div class="kpi"><div class="label">50 DMA</div><div class="value">${q.sma50?.toFixed(2)??"N/A"}</div></div>
           <div class="kpi"><div class="label">100 DMA</div><div class="value">${q.sma100?.toFixed(2)??"N/A"}</div></div>
           <div class="kpi"><div class="label">200 DMA</div><div class="value">${q.sma200?.toFixed(2)??"N/A"}</div></div>
         </div></div>
         <div class="tech-section"><div class="section-head"><h3>Price Levels</h3></div><div class="tech-grid">
           <div class="kpi"><div class="label">Support Zone</div><div class="value">${q.support?.toFixed(2)??"N/A"}</div></div>
           <div class="kpi"><div class="label">Resistance Zone</div><div class="value">${q.resistance?.toFixed(2)??"N/A"}</div></div>
           <div class="kpi"><div class="label">MACD</div><div class="value">${q.macd?.macd?.toFixed(3)??"N/A"}</div></div>
           <div class="kpi"><div class="label">MACD Signal</div><div class="value">${q.macd?.signal?.toFixed(3)??"N/A"} · ${macdSignal}</div></div>
         </div></div>
         <div class="tech-section"><div class="note"><b>Interpretation:</b> These are indicator outputs, not an automatic buy/sell call. The CIO decision will combine technicals with fundamentals, valuation and portfolio fit.</div>
         <div class="research-sub" style="margin-top:8px">Source: Kite historical candles. Support/resistance is a heuristic zone derived from the recent 60-session range.</div></div>
       </div>`;
     }catch(e){
       $("#techResult").innerHTML=`<div class="research-card"><div class="signal bear">⚠ ${e.message}</div></div>`;
     }finally{b.disabled=false;b.textContent="📈 Technical Analysis";}
   };

   $("#packBtn").onclick=async()=>{
     const b=$("#packBtn"); b.disabled=true; b.textContent="Preparing…";
     try{
       const r=await (await fetch("/api/research-pack",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({symbol:s})})).json();
       const p=r.pack;
       const txt=`PORTFOLIO CIO — CHATGPT RESEARCH REQUEST

ROLE
Act as a professional Indian-equity Portfolio CIO + professional discretionary trader.

STOCK
${p.symbol}
CURRENTLY HELD
${p.held}

HOLDING DATA
${JSON.stringify(p.holding,null,2)}

PORTFOLIO CONTEXT
${JSON.stringify(p.portfolio,null,2)}

RESEARCH REQUIREMENTS
1. Fundamental deep review: latest results, revenue/PAT/EPS trajectory, margins, ROE/ROCE when verifiable, debt, cash flow, promoter/pledge, valuation, management commentary and material risks.
2. Technical + price-action deep review: current/recent price, candle structure, 20/50/100/200 DMA, RSI, MACD, volume, ATR/volatility, trend, support, resistance, breakout/breakdown, entry/exit zones, targets, stop-loss and invalidation.
3. Portfolio fit: sector/theme overlap, concentration, position sizing, diversification, correlation logic when useful and target allocation.
4. Trading action: combine fundamentals + valuation + technicals + candles + portfolio fit. Decide BUY / ACCUMULATE / HOLD / WAIT / REDUCE / SELL.
5. For a held stock, specify exactly what to do with the current position. For a not-held stock, specify starter size if appropriate.
6. Where a sell/reduce action releases capital, explain where the capital should preferably be redeployed, including another stock or a new stock when justified.

SOURCE / DATA RULE
Use current, verified information from reliable public sources. Prefer NSE/BSE filings, Zerodha/Kite market data, exchange disclosures, investor presentations, credible financial reporting and current chart/price-action evidence.
Do NOT use the phrase "DATA UNAVAILABLE" anywhere in your response.
Do NOT leave requested fields blank.
When an exact metric is not directly verifiable, use the best available recent source or clearly label a derived/estimated value such as "ESTIMATED: ..." or "DERIVED: ...".
For price ranges and trade levels, derive practical zones from LTP, recent candles, support/resistance, DMA clusters, ATR/volatility and volume.
Never invent a value and present it as verified.

FINAL CIO RESPONSE BLOCK — RETURN VALID JSON ONLY
No Markdown.
No code fences.
No prose before or after the JSON.

Return exactly one JSON object with this structure:
{
  "ACTION": "BUY | ACCUMULATE | HOLD | WAIT | REDUCE | SELL",
  "CONFIDENCE": "HIGH | MEDIUM-HIGH | MEDIUM | LOW",
  "FUNDAMENTAL": {"headline": "...", "detail": "..."},
  "VALUATION": {"headline": "...", "detail": "..."},
  "TECHNICAL": {"headline": "...", "detail": "..."},
  "RISK": {"headline": "...", "detail": "..."},
  "PORTFOLIO_FIT": {"headline": "...", "detail": "..."},
  "KEY_POSITIVES": ["...", "..."],
  "KEY_NEGATIVES": ["...", "..."],
  "SHARES_TO_SELL": 0,
  "SELL_PRICE_RANGE": "NOT APPLICABLE" ,
  "SHARES_TO_BUY": 0,
  "BUY_PRICE_RANGE": "NOT APPLICABLE",
  "TARGET_WEIGHT": "0%",
  "REBALANCE_ACTION": "...",
  "PRICE_ACTION": {"headline": "...", "detail": "..."},
  "TRADE_PLAN": {
    "type": "BUY | SELL | REDUCE | HOLD | WAIT",
    "headline": "Buy 2 shares @ ₹68–70",
    "shares": 2,
    "entry_range": "₹68–70",
    "stop_loss": "₹64",
    "target_1": "₹78",
    "target_2": "₹84",
    "risk_reward": "1:2.2",
    "invalidation": "...",
    "horizon": "1–3 months",
    "trigger": "...",
    "rationale": "..."
  },
  "PORTFOLIO_ACTION_PLAN": [
    {
      "type": "REDUCE | SELL | BUY | ACCUMULATE | HOLD | WAIT | NEW STOCK",
      "symbol": "${p.symbol}",
      "shares": 0,
      "price_range": "NOT APPLICABLE",
      "target_weight": "0%",
      "reason": "..."
    }
  ],
  "REASONING": "..."
}

OUTPUT RULES
- Every numeric trade field must be a number, not prose.
- Every BUY / ACCUMULATE / SELL / REDUCE transaction must have shares + price_range.
- For HOLD / WAIT, use shares=0 when there is no immediate transaction and make the reason explicit.
- For a not-held stock, label any starter purchase in PORTFOLIO_ACTION_PLAN and use type "NEW STOCK" when appropriate.
- Keep headlines concise and details decision-useful.
- No requested field may contain "DATA UNAVAILABLE".`;

       $("#packResult").innerHTML=`
       <div class="research-card">
         <div class="section-head">
           <div><h3>ChatGPT Research Request</h3><div class="research-sub">Copy this into ChatGPT for deep fundamental, valuation, risk and portfolio-fit research.</div></div>
         </div>
         <textarea id="packText" class="pack-preview" readonly>${txt}</textarea>
         <div class="pack-actions">
           <button id="copyPack" class="btn primary">Copy Research Request</button>
           <button id="haveResponse" class="btn secondary">Already have response?</button>
           <span class="research-sub">No OpenAI API key or paid AI API is used.</span>
         </div>
       </div>`;

       $("#copyPack").onclick=async()=>{
         try{await navigator.clipboard.writeText(txt);}
         catch{const ta=document.createElement("textarea");ta.value=txt;document.body.appendChild(ta);ta.select();document.execCommand("copy");ta.remove();}
         toast("Research request copied to clipboard.");
       };
       $("#haveResponse").onclick=()=>{
         const gate=$("#responseGate");
         if(!gate) return;
         gate.style.display="";
         gate.scrollIntoView({behavior:"smooth",block:"center"});
         $("#cioResponseText")?.focus();
       };
     }catch(e){
       $("#packResult").innerHTML=`<div class="research-card"><div class="signal bear">⚠ ${e.message}</div></div>`;
     }finally{b.disabled=false;b.textContent="🧠 Prepare ChatGPT Research";}
   };

   function factorView(label,value,accent){
     const text=String(value||"DATA UNAVAILABLE");
     const parts=text.split(/\s+[—–-]\s+/);
     const primary=parts[0].trim();
     const detail=parts.slice(1).join(" — ").trim()||text;
     return `<details class="cio-factor ${accent}">
       <summary><span class="factor-label">${label}</span><span class="factor-primary">${primary}</span><span class="factor-chevron">⌄</span></summary>
       <div class="factor-detail">${detail}</div>
     </details>`;
   }

   function renderCioDecision(r){
     const q=r.decision||{}, p=r.parsed||{};
     const action=String(q.action||p.ACTION||p.action||"REVIEW").toUpperCase();
     const badge=action.toLowerCase().replace(/[^a-z]/g,"");

     const textOf=v=>{
       if(v===null||v===undefined||v==="") return "";
       if(typeof v==="string") return v;
       if(typeof v==="object"){
         if(v.detail!==undefined) return v.detail;
         return JSON.stringify(v);
       }
       return String(v);
     };
     const esc=v=>textOf(v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
     const primaryOf=v=>v&&typeof v==="object"&&v.headline?v.headline:textOf(v).split(/\s+[—–-]\s+/)[0].trim();
     const detailOf=v=>v&&typeof v==="object"&&v.detail!==undefined?v.detail:(textOf(v).split(/\s+[—–-]\s+/).slice(1).join(" — ").trim()||textOf(v));

     // Robust case-insensitive field extraction. This also re-parses the raw JSON
     // when the server/client layer has not copied a nested field through.
     const normalizeKeys=(obj)=>{
       const out={};
       if(!obj||typeof obj!=="object") return out;
       Object.entries(obj).forEach(([k,v])=>{out[String(k).toUpperCase()]=v;});
       return out;
     };
     let rawJson={};
     try{
       const raw=String(p.raw||"").trim().replace(/^```json\s*/i,"").replace(/```$/,"").trim();
       const a=raw.indexOf("{"), b=raw.lastIndexOf("}");
       if(a>=0&&b>a) rawJson=JSON.parse(raw.slice(a,b+1));
     }catch(_){}

     const top={...normalizeKeys(rawJson),...normalizeKeys(p),...normalizeKeys(q)};
     const first=(...keys)=>{
       for(const k of keys){
         const uk=String(k).toUpperCase();
         if(top[uk]!==undefined && top[uk]!==null) return top[uk];
       }
       return null;
     };
     const nestedObject=(...keys)=>{
       const v=first(...keys);
       return (v&&typeof v==="object"&&!Array.isArray(v))?v:null;
     };
     const nestedArray=(...keys)=>{
       const v=first(...keys);
       return Array.isArray(v)?v:[];
     };

     const priceAction=nestedObject("PRICE_ACTION");
     const tp=nestedObject("TRADE_PLAN");
     const portfolioPlan=nestedArray("PORTFOLIO_ACTION_PLAN");

     const scores=[
       ["Fundamental",q.scores?.fundamental||first("FUNDAMENTAL"),"fundamental"],
       ["Valuation",q.scores?.valuation||first("VALUATION"),"valuation"],
       ["Technical",q.scores?.technical||first("TECHNICAL"),"technical"],
       ["Risk",q.scores?.risk||first("RISK"),"risk"],
       ["Portfolio Fit",q.scores?.portfolio_fit||first("PORTFOLIO_FIT"),"fit"]
     ];
     const factors=scores.map(([label,val,accent])=>`<details class="cio-factor ${accent}">
       <summary><span class="factor-label">${label}</span><span class="factor-primary">${esc(primaryOf(val))}</span><span class="factor-chevron">⌄</span></summary>
       <div class="factor-detail">${esc(detailOf(val))}</div>
     </details>`).join("");

     const positives=(
       Array.isArray(q.key_positives)?q.key_positives:
       (Array.isArray(first("KEY_POSITIVES"))?first("KEY_POSITIVES"):[])
     ).map(x=>`<li>${esc(x)}</li>`).join("");
     const negatives=(
       Array.isArray(q.key_negatives)?q.key_negatives:
       (Array.isArray(first("KEY_NEGATIVES"))?first("KEY_NEGATIVES"):[])
     ).map(x=>`<li>${esc(x)}</li>`).join("");

     const isBuy=action==="BUY"||action==="ACCUMULATE";
     const isSell=action==="SELL"||action==="REDUCE";
     const targetWeight=first("TARGET_WEIGHT")??q.target_weight_text??q.target_weight??"—";
     const rebalance=first("REBALANCE_ACTION")||q.rebalance_action||"No additional portfolio action specified.";

     const sharesBuy=first("SHARES_TO_BUY")??q.shares_to_buy_text??q.shares_to_buy??tp?.shares??0;
     const sharesSell=first("SHARES_TO_SELL")??q.shares_to_sell_text??q.shares_to_sell??0;
     const topBuyRange=first("BUY_PRICE_RANGE")??q.buy_price_range??tp?.entry_range??"";
     const topSellRange=first("SELL_PRICE_RANGE")??q.sell_price_range??tp?.price_range??"";

     // The actual trade plan is authoritative. Top-level share fields are only the
     // transaction summary, not a replacement for TRADE_PLAN.
     const immediateBuy=isBuy?sharesBuy:0;
     const immediateSell=isSell?sharesSell:0;
     const accumulation=tp?.entry_range||topBuyRange||"Not specified";
     const exitRange=isSell?(topSellRange||"Not specified"):"No exit planned";

     const planRows=portfolioPlan.map(x=>{
       const type=String(x.type??x.TYPE??"ACTION").toUpperCase();
       const shares=x.shares??x.SHARES??x.suggested_buy_shares??x.suggested_sell_shares??0;
       const range=x.price_range??x.PRICE_RANGE??x.suggested_price_range??"Not specified";
       const target=x.target_weight??x.TARGET_WEIGHT??x.suggested_target_weight??"—";
       const reason=x.reason??x.REASON??x.note??"";
       return `<article class="portfolio-plan-card">
         <div class="portfolio-plan-main">
           <span class="portfolio-action-tag ${type.toLowerCase().replace(/\s+/g,"-")}">${esc(type)}</span>
           <div class="portfolio-plan-symbol">${esc(x.symbol??x.SYMBOL??q.symbol??"")}</div>
           <div class="portfolio-plan-reason">${esc(reason)}</div>
         </div>
         <div class="portfolio-plan-metrics">
           <div><span>SHARES</span><b>${esc(shares)}</b></div>
           <div><span>PRICE RANGE</span><b>${esc(range)}</b></div>
           <div><span>TARGET WEIGHT</span><b>${esc(target)}</b></div>
         </div>
       </article>`;
     }).join("");

     const actionPlanHtml=`<section class="decision-section portfolio-action-panel ${planRows?"":"portfolio-plan-empty"}">
       <div class="portfolio-action-header">
         <div>
           <div class="eyebrow">PORTFOLIO ACTION</div>
           <h4>Portfolio Action Plan</h4>
           <small>${planRows?`Structured from PORTFOLIO_ACTION_PLAN · ${portfolioPlan.length} action${portfolioPlan.length===1?"":"s"}`:"No separate portfolio action rows were supplied."}</small>
         </div>
         ${planRows?`<span class="portfolio-plan-count">${portfolioPlan.length} action${portfolioPlan.length===1?"":"s"}</span>`:""}
       </div>
       ${planRows?`<div class="portfolio-plan-list">${planRows}</div>`:`<div class="portfolio-plan-empty-text">The submitted response did not contain a readable PORTFOLIO_ACTION_PLAN array.</div>`}
     </section>`;

     const tradeDetails=tp?`
       <div class="execution-grid">
         ${[
           ["TRADE",tp.headline??tp.type??"—"],
           ["SHARES",tp.shares??0],
           ["ENTRY / RANGE",tp.entry_range??"—"],
           ["STOP LOSS",tp.stop_loss??"—"],
           ["TARGET 1",tp.target_1??"—"],
           ["TARGET 2",tp.target_2??"—"],
           ["RISK / REWARD",tp.risk_reward??"—"],
           ["HORIZON",tp.horizon??"—"]
         ].map(([k,v])=>`<div class="execution-card"><span>${k}</span><b>${esc(v)}</b></div>`).join("")}
       </div>
       <div class="execution-trigger-grid">
         <div><span>TRIGGER</span><b>${esc(tp.trigger??"—")}</b></div>
         <div><span>INVALIDATION</span><b>${esc(tp.invalidation??"—")}</b></div>
       </div>
       ${tp.rationale?`<div class="execution-rationale"><b>Why this trade?</b><div>${esc(tp.rationale)}</div></div>`:""}
     `:`<div class="execution-empty">No TRADE_PLAN object was found in the submitted JSON.</div>`;

     const whatHeading=tp?.headline||`${action} — review the structured CIO action`;
     const whatDetail=rebalance||tp?.rationale||"Review the detailed trade conditions below.";
     const why=first("REASONING")||q.reasoning||tp?.rationale||rebalance||"Review the submitted CIO recommendation.";

     $("#decisionResult").innerHTML=`
       <div class="research-card cio-decision-card">
         <div class="decision-hero">
           <div><div class="eyebrow">PORTFOLIO CIO</div><h3>${esc(q.symbol||symbol||"")} · Final Decision</h3><div class="research-sub">${q.held?"Currently held":"Not held"} · Structured JSON response parsed successfully</div></div>
           <div class="decision-hero-right"><span class="decision-badge ${badge}">${esc(action)}</span>${q.confidence?`<span class="confidence-pill">${esc(q.confidence)}</span>`:""}<span class="json-format-pill">✓ JSON Parsed</span></div>
         </div>

         <details class="decision-callout cio-what-to-do">
           <summary class="what-to-do-summary">
             <div class="what-to-do-icon">${isSell?"↘":isBuy?"↗":"◎"}</div>
             <div class="what-to-do-content">
               <div class="callout-label">WHAT TO DO NOW</div>
               <div class="callout-action">${esc(action)} · ${esc(whatHeading)}</div>
               <div class="callout-sub">Click to view the detailed CIO action and conditions.</div>
             </div>
             <div class="what-to-do-badge">${esc(action)} <span>⌄</span></div>
           </summary>
           <div class="what-to-do-detail">
             <div class="what-to-do-detail-title">${esc(tp?.headline||action)}</div>
             <div class="what-to-do-detail-text">${esc(whatDetail)}</div>
           </div>
         </details>

         <div class="cio-factor-grid">${factors}</div>

         ${priceAction?`<details class="decision-section cool-price-action">
           <summary class="cool-section-header"><div><span class="cool-icon">⌁</span><div><div class="eyebrow">MARKET STRUCTURE</div><h4>Price Action</h4><small>Recent candles · momentum · support · resistance</small></div></div><span class="section-caret">⌄</span></summary>
           <div class="cool-price-body"><div class="price-action-headline">${esc(primaryOf(priceAction))}</div><div class="price-action-detail">${esc(detailOf(priceAction))}</div></div>
         </details>`:""}

         <div class="trade-plan">
           <div class="section-heading"><span>⇄</span><h4>Trade Plan</h4><small>Action-aware execution summary.</small></div>
           <div class="trade-cards">
             <div class="trade-summary-card trade-buy-card ${isBuy?"active":"context"}">
               <div class="trade-card-top"><span class="trade-type">${isBuy?"BUY":"ACCUMULATION"}</span><span class="trade-icon">↗</span></div>
               <div class="trade-field"><span>${isBuy?"Shares to Buy":"Potential Add"}</span><b>${esc(immediateBuy)}</b></div>
               <div class="trade-field"><span>${isBuy?"Buy Range":"Accumulation Zone"}</span><b>${esc(accumulation)}</b></div>
             </div>
             <div class="trade-summary-card trade-sell-card ${isSell?"active":"context"}">
               <div class="trade-card-top"><span class="trade-type">${isSell?"SELL / REDUCE":"EXIT"}</span><span class="trade-icon">↘</span></div>
               <div class="trade-field"><span>${isSell?"Shares to Sell":"Immediate Exit"}</span><b>${isSell?esc(immediateSell):"None"}</b></div>
               <div class="trade-field"><span>${isSell?"Sell Range":"Exit Status"}</span><b>${esc(exitRange)}</b></div>
             </div>
             <div class="trade-summary-card trade-target-card">
               <div class="trade-card-top"><span class="trade-type">ALLOCATION</span><span class="trade-icon">↔</span></div>
               <div class="trade-field"><span>Target Weight</span><b>${esc(targetWeight)}</b></div>
               <div class="trade-field"><span>Rebalancing Action</span><b class="allocation-copy">${esc(rebalance)}</b></div>
             </div>
           </div>
         </div>

         <details class="decision-section execution-panel animated-panel">
           <summary class="cool-section-header">
             <div><span class="cool-icon">🎯</span><div><div class="eyebrow">EXECUTION</div><h4>Execution Details</h4><small>Every field returned inside TRADE_PLAN</small></div></div>
             <span class="section-caret">⌄</span>
           </summary>
           <div class="execution-body">${tradeDetails}</div>
         </details>

         ${actionPlanHtml}

         <div class="decision-columns">
           ${positives?`<div class="decision-section positive-panel"><div class="section-heading"><span>✓</span><h4>Key Positives</h4></div><ul>${positives}</ul></div>`:""}
           ${negatives?`<div class="decision-section risk-panel"><div class="section-heading"><span>⚠</span><h4>Key Risks</h4></div><ul>${negatives}</ul></div>`:""}
         </div>

         <details class="decision-section why-panel">
           <summary class="cool-section-header">
             <div><span class="cool-icon">◎</span><div><div class="eyebrow">CIO THESIS</div><h4>Why this decision?</h4><small>Portfolio-aware reasoning behind the action</small></div></div>
             <span class="section-caret">⌄</span>
           </summary>
           <div class="why-body"><div class="why-glow"></div><div class="why-text">${esc(why).replace(/\n/g,"<br>")}</div></div>
         </details>

         <div class="research-sub decision-disclaimer">No order is placed. This is decision support only.</div>
       </div>`;
   }
   $("#submitCioResponse").onclick=async()=>{
     const response=$("#cioResponseText").value.trim(),b=$("#submitCioResponse");
     if(!response){toast("Paste the ChatGPT research response first.");return;}
     b.disabled=true;b.textContent="Processing…";
     try{
       const r=await (await fetch("/api/research/submit-response",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({symbol:s,response,technical:latestTechnical})})).json();
       if(r.status!=="ok")throw new Error(r.message||"Could not process response.");
       renderCioDecision(r);
       const responseGate=$("#responseGate");
       if(responseGate){
         responseGate.style.display="none";
         responseGate.innerHTML="";
       }
       const responseField=$("#cioResponseText");
       if(responseField) responseField.value="";
       const promptResult=$("#packResult");
       if(promptResult) promptResult.innerHTML="";
       const decisionResult=$("#decisionResult");
       if(decisionResult){
         const moveToDecision=()=>{
           const y=decisionResult.getBoundingClientRect().top+(window.pageYOffset||document.documentElement.scrollTop||0)-16;
           window.scrollTo({top:Math.max(0,y),left:0,behavior:"auto"});
           document.documentElement.scrollTop=Math.max(0,y);
           document.body.scrollTop=Math.max(0,y);
         };
         requestAnimationFrame(()=>requestAnimationFrame(moveToDecision));
         setTimeout(moveToDecision,80);
         setTimeout(moveToDecision,220);
         setTimeout(moveToDecision,500);
       }
       toast("CIO decision generated.");
     }catch(e){
       $("#decisionResult").innerHTML=`<div class="research-card"><div class="signal bear">⚠ ${e.message}</div></div>`;
     }finally{b.disabled=false;b.textContent="✅ Submit Response";}
   };
 };
 $("#stockGo").onclick=go;
 $("#stockInput").onkeydown=e=>{if(e.key==="Enter")go();};
}

let compareDraftSymbols=Array.isArray(window.__compareDraftSymbols)?window.__compareDraftSymbols:[];
function rememberCompareDraft(value){
  compareDraftSymbols=[...new Set(String(value||"").split(/[\s,;\n]+/).map(x=>x.trim().toUpperCase()).filter(Boolean))];
  window.__compareDraftSymbols=compareDraftSymbols.slice();
}
function restoreCompareDraft(){
  return compareDraftSymbols.join(", ");
}

function renderCompare(){
  const host=$("#compare");
  host.innerHTML=`<div class="compare-shell">
    <div class="compare-hero-content">
      <div>
        <p class="muted">Compare any number of stocks across fundamentals, valuation, technicals, price action and portfolio fit. Run a local snapshot instantly or prepare a deeper ChatGPT research request.</p>
      </div>
      <span class="smart-badge">FREE · READ ONLY</span>
    </div>

    <div class="compare-input-panel">
      <div class="compare-select-heading">
        <div class="compare-select-icon" aria-hidden="true">
          <span class="compare-icon-node node-a"></span>
          <span class="compare-icon-node node-b"></span>
          <span class="compare-icon-link link-a"></span>
          <span class="compare-icon-link link-b"></span>
        </div>
        <div class="compare-select-heading-copy">
          <h3>Select Stocks</h3>
          <small>Held or not held · Add any NSE/BSE stock to compare</small>
        </div>
      </div>
      <div class="compare-input-row">
        <input id="compareInput" class="compare-input" placeholder="BEL, HAL, BDL, DEEPAKNTR" value="${restoreCompareDraft()}">
        <button id="compareGo" class="btn primary">Compare Now</button>
      </div>
      <div id="compareSuggested" class="compare-suggested"></div>
      <div class="compare-hint">Use 2 or more NSE/BSE symbols. Comma, space or newline separated. There is no fixed stock-count limit.</div>
    </div>

    <div id="compareResult"><div class="compare-empty">No comparison run yet.</div></div>
  </div>`;

  const held=portfolio.holdings||[];
  const bySymbol=Object.fromEntries(held.map(h=>[String(h.symbol).toUpperCase(),h]));
  const suggested=held;

  $("#compareSuggested").innerHTML=suggested.map(h=>`<button class="compare-chip" data-symbol="${h.symbol}">${h.symbol}</button>`).join("");
  $("#compareSuggested").querySelectorAll("button").forEach(b=>b.onclick=()=>{
    const parts=$("#compareInput").value.split(/[\s,;\n]+/).filter(Boolean);
    if(!parts.some(x=>x.toUpperCase()===b.dataset.symbol.toUpperCase())) parts.push(b.dataset.symbol);
    $("#compareInput").value=parts.join(", ");
    rememberCompareDraft($("#compareInput").value);
  });
  $("#compareInput").oninput=()=>rememberCompareDraft($("#compareInput").value);

  function parseSymbols(){
    rememberCompareDraft($("#compareInput").value);
    return [...new Set($("#compareInput").value.split(/[\s,;\n]+/).map(x=>x.trim().toUpperCase()).filter(Boolean))];
  }

  function localCompare(symbols){
    const rows=symbols.map(s=>{
      const h=bySymbol[s];
      return h?{
        symbol:s,held:true,qty:h.quantity??h.qty??0,ltp:h.ltp??h.close_price??null,value:h.value??null,
        pnl:h.pnl??null,pnl_pct:h.pnl_pct??null,weight:h.weight??null,theme:h.theme??"—",market_cap:h.market_cap??"—",
        status:h.status??"SYNCED",technical_status:h.research_status??""
      }:{
        symbol:s,held:false,qty:0,ltp:null,value:null,pnl:null,pnl_pct:null,weight:0,theme:"Not held",market_cap:"—",status:"NOT HELD",technical_status:""
      };
    });
    renderLocalCompare(rows);
    return rows;
  }

  function renderLocalCompare(rows){
    const result=$("#compareResult");
    result.innerHTML=`<div class="compare-local" id="compareLocalSnapshot">
      <div class="compare-result-head">
        <div><div class="eyebrow">LIVE PORTFOLIO SNAPSHOT</div><h3>Side-by-Side Comparison</h3><p class="muted">Current synced position data. Deep fundamental/technical conclusions are loaded below after research submission.</p></div>
        <span>${rows.length} stocks</span>
      </div>
      <div class="compare-table-wrap"><table class="compare-table"><thead><tr>
        <th>STOCK</th><th>HELD</th><th>QTY</th><th>LTP</th><th>VALUE</th><th>P&L</th><th>P&L %</th><th>WEIGHT</th><th>THEME</th><th>CAP</th><th>STATUS</th>
      </tr></thead><tbody>${rows.map(r=>`<tr>
        <td class="col-stock"><b>${r.symbol}</b></td><td class="col-center"><span class="compare-held ${r.held?"yes":"no"}">${r.held?"HELD":"NOT HELD"}</span></td>
        <td class="col-num">${r.qty}</td><td class="col-num">${r.ltp!=null?"₹"+r.ltp:"—"}</td><td class="col-num">${r.value!=null?"₹"+r.value:"—"}</td>
        <td class="col-num ${Number(r.pnl)>=0?'pnl-good':'pnl-bad'}">${r.pnl!=null?"₹"+r.pnl:"—"}</td>
        <td class="col-num ${Number(r.pnl_pct)>=0?'pnl-good':'pnl-bad'}">${r.pnl_pct!=null?r.pnl_pct+"%":"—"}</td><td class="col-num">${r.weight||0}%</td>
        <td class="col-text">${r.theme}</td><td class="col-center">${r.market_cap}</td><td class="col-center"><span class="status-chip">${r.status}</span></td>
      </tr>`).join("")}</tbody></table></div>
      <div class="compare-actions">
        <button id="prepareCompareResearch" class="btn primary">✦ Prepare Deep Comparison Research</button>
        <button id="alreadyCompare" class="btn secondary">Already have response?</button>
      </div>
      <div id="comparePromptArea"></div>
      <div id="compareResponseArea"></div>
      <div id="compareDeepResult"></div>
    </div>`;

    $("#prepareCompareResearch").onclick=prepareCompareResearch;
    $("#alreadyCompare").onclick=openCompareResponse;
  }

  function buildComparePrompt(rows){
    return `PORTFOLIO CIO — COMPARATIVE RESEARCH REQUEST

ROLE
Act as a professional Portfolio CIO + professional Indian equity research analyst + discretionary trader.

OBJECTIVE
Compare ALL ${rows.length} selected stocks and decide the strongest risk-adjusted choices for THIS portfolio. Do not drop or merge any selected stock, even if there are many.

STOCKS
${JSON.stringify(rows,null,2)}

REQUIRED FOR EVERY STOCK
- Fundamental: latest results, revenue/PAT/EPS trend, margins, ROE/ROCE, debt, cash flow, promoter/pledge where relevant, valuation, management commentary and key risks.
- Technical: current price, 20/50/100/200 DMA, RSI, MACD, volume, support, resistance, breakout/breakdown.
- Price action / candles: trend, accumulation/distribution, recent candle structure, breakout quality, failed moves and volatility.
- Portfolio fit: current weight, theme overlap, diversification benefit, whether held or NEW STOCK.
- Trade plan: action, shares, entry range, stop-loss, targets, risk/reward, invalidation and horizon.

COMPARATIVE DECISION
Rank every stock from strongest to weakest for this portfolio.
Do not choose only by standalone quality.
Consider whether replacing one held stock with another improves the portfolio.

NO DATA UNAVAILABLE
Do not output "DATA UNAVAILABLE". Use verified values or explicitly label a derived estimate.

RETURN VALID JSON ONLY. NO MARKDOWN. NO CODE FENCES.

{
  "winner":"SYMBOL",
  "ranking":[
    {"rank":1,"symbol":"XYZ","score":90,"verdict":"ACCUMULATE","why":"..."}
  ],
  "comparison":{
    "fundamental":"...",
    "valuation":"...",
    "technical":"...",
    "price_action":"...",
    "portfolio_fit":"..."
  },
  "stocks":[
    {
      "symbol":"XYZ",
      "action":"BUY",
      "conviction":"HIGH",
      "fundamental":"...",
      "valuation":"...",
      "technical":"...",
      "price_action":"...",
      "portfolio_fit":"...",
      "trade_plan":{
        "type":"BUY",
        "headline":"Buy 5 shares @ ₹X–Y",
        "shares":5,
        "entry_range":"₹X–Y",
        "stop_loss":"₹X",
        "target_1":"₹X",
        "target_2":"₹X",
        "risk_reward":"1:2+",
        "invalidation":"...",
        "horizon":"1–6 months",
        "trigger":"..."
      },
      "replace_candidate":"NONE"
    }
  ],
  "final_recommendation":"...",
  "capital_note":"..."
}

Every selected stock MUST appear exactly once in stocks, preserving the selected symbol set.
Do not omit a stock because the comparison list is large.
Return JSON only.`;
  }

  function prepareCompareResearch(){
    const symbols=parseSymbols();
    if(symbols.length<2){toast("Select at least 2 stocks.");return;}
    const rows=localCompare(symbols);
    const prompt=buildComparePrompt(rows);
    $("#comparePromptArea").innerHTML=`<div class="smart-prompt compare-prompt"><div class="section-heading"><span>✦</span><h3>ChatGPT Comparative Research Request</h3><small>Copy into ChatGPT and paste the JSON response back here.</small></div><textarea id="comparePromptText" class="pack-preview" readonly>${prompt}</textarea><div class="smart-prompt-actions"><button id="copyComparePrompt" class="btn primary">Copy Research Request</button><button id="pasteCompare" class="btn secondary">Already have response?</button></div></div>`;
    $("#copyComparePrompt").onclick=async()=>{
      try{await navigator.clipboard.writeText(prompt)}catch{const ta=document.createElement("textarea");ta.value=prompt;document.body.appendChild(ta);ta.select();document.execCommand("copy");ta.remove();}
      toast("Comparison research request copied.");
    };
    $("#pasteCompare").onclick=openCompareResponse;
  }

  function openCompareResponse(){
    $("#compareResponseArea").innerHTML=`<div class="smart-response-card"><div class="section-heading"><span>✓</span><h3>Submit Comparative Research Response</h3><small>Paste the JSON response returned by ChatGPT.</small></div><textarea id="compareResponseText" class="pack-preview" placeholder="Paste JSON here…"></textarea><div class="smart-prompt-actions"><button id="submitCompare" class="btn primary">✅ Submit Response</button></div></div>`;
    $("#submitCompare").onclick=submitCompareResponse;
    $("#compareResponseText").focus();
  }

  function scrollToResultStart(target){
    const el=typeof target==="string"?$(target):target;
    if(!el) return;
    const move=()=>{
      const rect=el.getBoundingClientRect();
      const y=Math.max(0,rect.top+window.pageYOffset-24);
      try{ el.scrollIntoView({behavior:"auto",block:"start",inline:"nearest"}); }catch(_){}
      window.scrollTo({top:y,left:0,behavior:"auto"});
      document.documentElement.scrollTop=y;
      document.body.scrollTop=y;
    };
    requestAnimationFrame(move);
    setTimeout(move,80);
    setTimeout(move,220);
    setTimeout(move,500);
    setTimeout(move,900);
  }

  
  
  
  async function submitCompareResponse(){
    const text=$("#compareResponseText").value.trim();
    if(!text){toast("Paste the comparison JSON first.");return;}
    const b=$("#submitCompare");b.disabled=true;b.textContent="Processing…";
    try{
      const r=await (await fetch("/api/compare/submit-response",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({response:text})})).json();
      if(r.status!=="ok") throw new Error(r.message||"Could not process comparison.");
      $("#compareResponseArea").innerHTML="";
      $("#comparePromptArea").innerHTML="";
      renderDeepCompare(r.result);
      scrollToResultStart(document.querySelector("#compareResult")||document.querySelector(".compare-deep")||document.querySelector("#compareContent"));
      toast("Comparative research loaded.");
    }catch(e){toast(e.message||"Could not process comparison.");}
    finally{b.disabled=false;b.textContent="✅ Submit Response";}
  }

  function renderDeepCompare(d){
    const rows=d.stocks||[], rank=d.ranking||[];

    const rankRows=rank.map((x,i)=>`
      <div class="compare-rank-row">
        <div class="compare-rank-num">${x.rank??i+1}</div>
        <div class="compare-rank-stock"><b>${x.symbol||"—"}</b><small>${x.verdict||"REVIEW"}</small></div>
        <div class="compare-rank-action">${x.verdict||"REVIEW"}</div>
        <div class="compare-rank-details">${x.why||"No comparative detail supplied."}</div>
        <div class="compare-rank-score">${x.score??"—"}</div>
      </div>`).join("");

    const analysisCards=[
      ["fundamental","Fundamental","◆"],
      ["valuation","Valuation","◇"],
      ["technical","Technical","⌁"],
      ["price_action","Price Action","↗"],
      ["portfolio_fit","Portfolio Fit","◎"]
    ];
    const analysisHtml=`<div class="compare-analysis-cards">
      ${analysisCards.map(([k,label,icon])=>`<details class="compare-analysis-card ${k}">
        <summary>
          <span class="compare-analysis-icon">${icon}</span>
          <div><b>${label}</b><small>Portfolio-aware comparative view</small></div>
          <i>⌄</i>
        </summary>
        <div class="compare-analysis-detail">${d.comparison?.[k]||"No comparison detail supplied."}</div>
      </details>`).join("")}
    </div>`;

    const stockCards=rows.map((x,i)=>`<details class="compare-stock">
      <summary>
        <div class="compare-stock-rank">${i+1}</div>
        <div class="compare-stock-name"><b>${x.symbol}</b><small>${x.conviction||"—"} · ${x.action||"REVIEW"}</small></div>
        <span class="compare-stock-trade-head">${x.trade_plan?.headline||"Review trade plan"}</span>
        <span class="compare-stock-replacement">${x.replace_candidate||"NONE"}</span>
        <span class="compare-stock-caret">⌄</span>
      </summary>
      <div class="compare-stock-body">
        <div class="compare-mini-grid compare-stock-analysis-closed">
          <details class="compare-stock-analysis-card fundamental">
            <summary><span>Fundamentals</span><i>⌄</i></summary>
            <div>${x.fundamental||"—"}</div>
          </details>
          <details class="compare-stock-analysis-card valuation">
            <summary><span>Valuation</span><i>⌄</i></summary>
            <div>${x.valuation||"—"}</div>
          </details>
          <details class="compare-stock-analysis-card technical">
            <summary><span>Technicals</span><i>⌄</i></summary>
            <div>${x.technical||"—"}</div>
          </details>
          <details class="compare-stock-analysis-card price-action">
            <summary><span>Price Action</span><i>⌄</i></summary>
            <div>${x.price_action||"—"}</div>
          </details>
          <details class="compare-stock-analysis-card portfolio-fit">
            <summary><span>Portfolio Fit</span><i>⌄</i></summary>
            <div>${x.portfolio_fit||"—"}</div>
          </details>
        </div>
        <div class="compare-trade">
          <div class="trade-plan-label">${x.trade_plan?.type||"TRADE PLAN"}</div>
          <strong>${x.trade_plan?.headline||"Review trade plan"}</strong>
          <div class="opp-trade-grid">
            <span>ENTRY<strong>${x.trade_plan?.entry_range||"—"}</strong></span>
            <span>STOP<strong>${x.trade_plan?.stop_loss||"—"}</strong></span>
            <span>TARGET 1<strong>${x.trade_plan?.target_1||"—"}</strong></span>
            <span>TARGET 2<strong>${x.trade_plan?.target_2||"—"}</strong></span>
            <span>R/R<strong>${x.trade_plan?.risk_reward||"—"}</strong></span>
            <span>INVALIDATION<strong>${x.trade_plan?.invalidation||"—"}</strong></span>
          </div>
        </div>
      </div>
    </details>`).join("");

    const deep=`
      <div class="compare-deep">
        <section class="compare-winner-card">
          <div class="compare-winner-icon"><span>★</span></div>
          <div class="compare-winner-copy">
            <div class="eyebrow">CIO COMPARATIVE DECISION</div>
            <h3>Best Portfolio Choice</h3>
            <div class="compare-winner-stock">${d.winner||"REVIEW"}</div>
            <p>${d.final_recommendation||"Comparative recommendation loaded from the submitted research."}</p>
          </div>
          <div class="compare-winner-badge"><span>WINNER</span><b>${d.winner||"—"}</b></div>
        </section>

        <section class="compare-rank-panel">
          <div class="compare-section-header rank-section-header">
            <div class="compare-section-icon ranking-icon">①</div>
            <div>
              <h3>Ranking</h3>
              <small>Strongest → weakest portfolio fit</small>
            </div>
          </div>
          <div class="compare-ranking-table">
            <div class="compare-ranking-head"><span>RANK</span><span>STOCK NAME</span><span>ACTION</span><span>DETAILS</span><span>SCORE</span></div>
            ${rankRows}
          </div>
        </section>

        <section class="compare-analysis-section">
          <div class="compare-section-header">
            <div class="compare-section-icon analysis-icon">◈</div>
            <div>
              <h3>Comparative Analysis</h3>
              <small>Click a card to expand the detailed portfolio-aware comparison</small>
            </div>
          </div>
          ${analysisHtml}
        </section>

        <section class="compare-stock-section">
          <div class="compare-section-header">
            <div class="compare-section-icon stock-icon">▦</div>
            <div>
              <h3>Stock-by-Stock Detail</h3>
              <small>Each stock keeps its own technical thesis and trade plan</small>
            </div>
          </div>
          <div class="compare-stock-header">
            <span>STOCK NAME</span><span>ACTION / CONVICTION</span><span>TRADE PLAN</span><span>REPLACEMENT / ALTERNATIVE</span>
          </div>
          <div class="compare-stock-cards">${stockCards}</div>
        </section>

        <div class="note compare-capital-note"><b>Capital note</b><span>${d.capital_note||"No separate capital action was specified."}</span></div>
      </div>`;

    const deepHost=$("#compareDeepResult");
    if(deepHost) deepHost.innerHTML=deep;
    else $("#compareResult").insertAdjacentHTML("beforeend",deep);
  }

  $("#compareGo").onclick=()=>{
    const s=parseSymbols();
    if(s.length<2){toast("Enter at least 2 symbols.");return;}
    rememberCompareDraft(s.join(", "));
    localCompare(s);
  };
  $("#compareInput").onkeydown=e=>{if(e.key==="Enter")$("#compareGo").click();};
  $("#compareInput").value=restoreCompareDraft();
}

function renderOpportunities(){
  const host=$("#opportunities");
  host.innerHTML=`<div class="opportunities-shell">
    <div class="opps-hero-content">
      <div>
        <p class="muted">Find new stocks that can improve diversification, portfolio quality and risk-adjusted return. Free mode uses portfolio context plus a ChatGPT research hand-off; no paid AI API is required.</p>
      </div>
      <button id="oppRefresh" class="btn primary">↻ Refresh Gaps</button>
    </div>
    <div id="oppContent"><div class="opps-loading"><div class="loader-mini"></div> Mapping portfolio gaps…</div></div>
  </div>`;

  let oppContext=null;

  async function loadContext(){
    $("#oppContent").innerHTML=`<div class="opps-loading"><div class="loader-mini"></div> Mapping portfolio gaps…</div>`;
    try{
      const r=await (await fetch("/api/opportunities/context")).json();
      if(r.status==="error") throw new Error(r.message||"Could not build opportunity context.");
      oppContext=r;
      renderOpportunityContext(r);
    }catch(e){
      $("#oppContent").innerHTML=`<div class="panel"><div class="signal bear">⚠ ${e.message}</div></div>`;
    }
  }

  function renderOpportunityContext(c){
    const themes=c.underweight_themes||[], caps=c.underweight_caps||[];
    const topTheme=c.top_theme||{name:"—",pct:0};
    const topPosition=c.largest_position||{symbol:"—",weight:0};
    const risk=c.risk||"REVIEW";
    const riskTone=risk==="HIGH"?"negative":risk==="ELEVATED"?"warning":"positive";

    const gapRows=(items,kind)=>items.length?items.map((x,i)=>`
      <article class="opp-gap-card ${kind}">
        <div class="opp-gap-rank">${i+1}</div>
        <div class="opp-gap-main">
          <div class="opp-gap-title"><b>${x.name}</b><span>${Number(x.current_pct||0).toFixed(2)}% current exposure</span></div>
          <p>${kind==="theme"?"Diversification opportunity within an underweight portfolio theme.":"Market-cap allocation gap that may improve balance if risk/reward is attractive."}</p>
        </div>
        <div class="opp-gap-target"><small>TARGET GUIDE</small><b>${x.target_guide||"—"}</b></div>
      </article>`).join(""):`<div class="opp-empty">No clear allocation gap detected from the current portfolio.</div>`;

    $("#oppContent").innerHTML=`
      <div class="opp-overview-grid">
        <article class="opp-overview-card risk"><div class="opp-overview-icon">◈</div><div><span>PORTFOLIO RISK</span><b class="${riskTone}">${risk}</b><small>Construction profile</small></div></article>
        <article class="opp-overview-card theme"><div class="opp-overview-icon">◌</div><div><span>TOP THEME</span><b>${Number(topTheme.pct||0).toFixed(1)}%</b><small>${topTheme.name}</small></div></article>
        <article class="opp-overview-card size"><div class="opp-overview-icon">◉</div><div><span>LARGEST POSITION</span><b>${Number(topPosition.weight||0).toFixed(1)}%</b><small>${topPosition.symbol}</small></div></article>
        <article class="opp-overview-card micro"><div class="opp-overview-icon">◫</div><div><span>MICRO POSITIONS</span><b>${c.micro_positions||0}</b><small>Potential cleanup</small></div></article>
      </div>

      <div class="opp-gap-grid">
        <section class="opp-section gap-theme">
          <header class="opp-section-head"><div class="opp-section-title"><span class="opp-section-icon green">✦</span><div><div class="eyebrow">DIVERSIFICATION</div><h3>Underweight Themes</h3><small>Best areas to research for diversification</small></div></div><span class="opp-count green">${themes.length}</span></header>
          <div class="opp-gap-list">${gapRows(themes,"theme")}</div>
        </section>
        <section class="opp-section gap-cap">
          <header class="opp-section-head"><div class="opp-section-title"><span class="opp-section-icon blue">◎</span><div><div class="eyebrow">ALLOCATION BALANCE</div><h3>Market-Cap Gaps</h3><small>Use candidates only where risk/reward justifies it</small></div></div><span class="opp-count blue">${caps.length}</span></header>
          <div class="opp-gap-list">${gapRows(caps,"cap")}</div>
        </section>
      </div>

      <section class="opp-research-engine">
        <div class="opp-research-glow"></div>
        <div class="opp-research-top">
          <div class="opp-research-icon">✦</div>
          <div class="opp-research-copy"><div class="eyebrow">FREE RESEARCH ENGINE</div><h3>Research New Stock Opportunities</h3><p>Screen the Indian equity universe specifically for this portfolio's gaps. Every candidate must clear fundamentals, valuation, technicals, price action and portfolio-fit review before appearing in the shortlist.</p></div>
          <span class="opp-engine-badge">NO PAID AI API</span>
        </div>
        <div class="opp-research-actions"><button id="prepareOppResearch" class="btn primary">✦ Prepare Opportunity Research</button><button id="alreadyOpp" class="btn secondary">Already have response?</button></div>
        <div id="oppPromptArea"></div>
        <div id="oppResponseArea"></div>
      </section>

      <section class="opp-section opp-rules-section">
        <header class="opp-section-head"><div class="opp-section-title"><span class="opp-section-icon amber">◇</span><div><div class="eyebrow">CIO FILTERS</div><h3>What qualifies as an opportunity?</h3><small>Portfolio-aware filters applied before research</small></div></div></header>
        <div class="opp-rule-grid">
          <div><span>01</span><b>Avoid oversized themes</b><small>Do not deepen structural concentration without exceptional justification.</small></div>
          <div><span>02</span><b>Improve diversification</b><small>Prefer candidates that add a genuinely different earnings engine.</small></div>
          <div><span>03</span><b>Require confirmation</b><small>Fundamentals and technical/price-action evidence should align.</small></div>
          <div><span>04</span><b>Define the trade</b><small>Entry, stop, targets, invalidation and horizon must be practical.</small></div>
          <div><span>05</span><b>Research before action</b><small>Every new candidate follows the same research workflow.</small></div>
        </div>
      </section>`;

    $("#prepareOppResearch").onclick=prepareOppResearch;
    $("#alreadyOpp").onclick=openOppResponse;
    if(Array.isArray(__opportunitySubmittedResult) && __opportunitySubmittedResult.length){
      renderOpportunityCandidates(__opportunitySubmittedResult);
    }
  }

  function buildOppPrompt(){
    const exclude=(oppContext.holdings||[]).map(h=>h.symbol);
    return `PORTFOLIO CIO — OPPORTUNITY RESEARCH REQUEST

ROLE
Act as a professional Portfolio CIO + professional Indian equity research analyst + discretionary trader.

OBJECTIVE
Find NEW stocks that are NOT currently held and that can improve this portfolio's diversification, quality and risk-adjusted return.

CURRENT PORTFOLIO
${JSON.stringify({
  value:portfolio.value,invested:portfolio.invested,pnl:portfolio.pnl,pnl_pct:portfolio.pnl_pct,
  risk:oppContext.risk,top_theme:oppContext.top_theme,largest_position:oppContext.largest_position
},null,2)}

UNDERWEIGHT THEMES TO PRIORITIZE
${JSON.stringify(oppContext.underweight_themes,null,2)}

UNDERWEIGHT MARKET-CAP AREAS
${JSON.stringify(oppContext.underweight_caps,null,2)}

EXCLUDE THESE CURRENT HOLDINGS
${JSON.stringify(exclude)}

FULL ANALYSIS REQUIRED FOR EVERY CANDIDATE
- Fundamental: latest results, revenue/PAT/EPS trend, margins, ROE/ROCE, debt, cash flow, promoter/pledge, valuation, management commentary, risks.
- Technical: current price, 20/50/100/200 DMA, RSI, MACD, volume, trend, support, resistance, breakout/breakdown.
- Price action: recent candle structure, accumulation/distribution, breakout confirmation, failed breakout/breakdown, volatility and risk/reward.
- Portfolio fit: theme, market-cap, overlap, diversification benefit.
- Trade plan: entry range, shares for a sensible starter allocation, stop-loss, targets, invalidation and horizon.

IMPORTANT
- Only recommend genuinely new stocks, not current holdings.
- Do not simply recommend famous large caps because they are popular.
- Rank candidates by portfolio benefit, not just standalone quality.
- Avoid candidates that duplicate an already excessive theme unless they are exceptional.
- Never invent data.
- No order is placed.

RETURN VALID JSON ONLY. NO MARKDOWN. NO CODE FENCES.

{
  "candidate_count": 5,
  "candidates": [
    {
      "rank": 1,
      "symbol": "XYZ",
      "company": "Example",
      "theme": "PSU Banks",
      "market_cap": "Large Cap",
      "current_price": 0,
      "action": "BUY",
      "conviction": "HIGH",
      "why_now": "Short explanation",
      "fundamental": "Detailed summary",
      "valuation": "Detailed summary",
      "technical": "Detailed summary",
      "price_action": "Detailed candle/structure summary",
      "portfolio_fit": "Why this improves this portfolio",
      "trade_plan": {
        "type":"BUY",
        "headline":"Buy 10 shares @ ₹180–186",
        "shares":10,
        "entry_range":"₹180–186",
        "stop_loss":"₹171",
        "target_1":"₹205",
        "target_2":"₹220",
        "risk_reward":"1:2.0+",
        "invalidation":"Daily close below ₹171",
        "horizon":"1–6 months",
        "trigger":"Support hold / volume-confirmed breakout"
      },
      "target_weight":"2–3%"
    }
  ]
}

RULES
- candidate_count must be between 5 and 10; choose the number based on research quality and avoid padding with weak candidates.
- Every candidate must be a NEW STOCK.
- Every candidate must have a complete trade_plan.
- Use price ranges, not vague phrases like 'buy on dips'.
- Return the JSON only.`;
  }

  function prepareOppResearch(){
    const prompt=buildOppPrompt();
    $("#oppPromptArea").innerHTML=`<div class="smart-prompt"><div class="section-heading"><span>✦</span><h3>ChatGPT Opportunity Research Request</h3><small>Copy into ChatGPT, then paste the JSON response back here.</small></div><textarea id="oppPromptText" class="pack-preview" readonly>${prompt}</textarea><div class="smart-prompt-actions"><button id="copyOppPrompt" class="btn primary">Copy Research Request</button><button id="pasteOppResponse" class="btn secondary">Already have response?</button></div></div>`;
    $("#copyOppPrompt").onclick=async()=>{const p=prompt;try{await navigator.clipboard.writeText(p)}catch{const ta=document.createElement("textarea");ta.value=p;document.body.appendChild(ta);ta.select();document.execCommand("copy");ta.remove()}toast("Opportunity research request copied.")};
    $("#pasteOppResponse").onclick=openOppResponse;
  }

  function openOppResponse(){
    $("#oppResponseArea").innerHTML=`<div class="smart-response-card"><div class="section-heading"><span>✓</span><h3>Submit Opportunity Research Response</h3><small>Paste the JSON response returned by ChatGPT.</small></div><textarea id="oppResponseText" class="pack-preview" placeholder="Paste JSON here…"></textarea><div class="smart-prompt-actions"><button id="submitOppResponse" class="btn primary">✅ Submit Response</button></div></div>`;
    $("#submitOppResponse").onclick=submitOppResponse;
    $("#oppResponseText").focus();
  }

  async function submitOppResponse(){
    const text=$("#oppResponseText").value.trim();
    if(!text){toast("Paste the JSON response first.");return;}
    const b=$("#submitOppResponse");b.disabled=true;b.textContent="Processing…";
    try{
      const r=await (await fetch("/api/opportunities/submit-response",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({response:text})})).json();
      if(r.status!=="ok")throw new Error(r.message||"Could not process opportunity response.");
      __opportunitySubmittedResult=r.candidates||[];
      $("#oppResponseArea").innerHTML="";
      $("#oppPromptArea").innerHTML="";
      renderOpportunityCandidates(__opportunitySubmittedResult);
      scrollToResultStart(document.querySelector(".opp-results-shell")||document.querySelector("#oppContent"));
      toast("Opportunity shortlist generated.");
    }catch(e){toast(e.message||"Could not process opportunity response.");}
    finally{b.disabled=false;b.textContent="✅ Submit Response";}
  }

  function renderOpportunityCandidates(items){
    const el=$("#oppContent");
    const wrap=document.createElement("div"); wrap.className="opps-results";
    wrap.innerHTML=`
      <section class="opp-results-shell">
        <header class="opp-results-head">
          <div class="opp-results-title"><div class="opp-results-icon">✦</div><div><div class="eyebrow">RESEARCH-VALIDATED SHORTLIST</div><h3>New Stock Opportunities</h3><p>Research candidates only — not automatic orders.</p></div></div>
          <span class="opp-results-count">${items.length} candidates</span>
        </header>
        <div class="opp-candidate-list">
        ${items.map((x,i)=>`
          <details class="opp-candidate-premium">
            <summary><div class="opp-cand-rank">${x.rank??i+1}</div><div class="opp-cand-main"><b>${x.symbol||"—"}</b><span>${x.company||""}</span></div><div class="opp-cand-meta"><small>THEME</small><b>${x.theme||"—"}</b></div><div class="opp-cand-meta"><small>CONVICTION</small><b>${x.conviction||"—"}</b></div><div class="opp-cand-meta"><small>TARGET</small><b>${x.target_weight||"—"}</b></div><span class="opp-action-chip buy">BUY</span><span class="opp-cand-caret">⌄</span></summary>
            <div class="opp-cand-body">
              <div class="opp-cand-intro"><div class="opp-intro-stat"><span>CURRENT PRICE</span><b>₹${x.current_price??"—"}</b></div><div class="opp-intro-stat"><span>MARKET CAP</span><b>${x.market_cap||"—"}</b></div><div class="opp-why-card"><span>WHY NOW</span><p>${x.why_now||"—"}</p></div></div>
              <div class="opp-analysis-cards">
                <details class="opp-info-card fundamental"><summary><span class="opp-info-icon">◆</span><b>Fundamentals</b><i>⌄</i></summary><div>${x.fundamental||"—"}</div></details>
                <details class="opp-info-card valuation"><summary><span class="opp-info-icon">◇</span><b>Valuation</b><i>⌄</i></summary><div>${x.valuation||"—"}</div></details>
                <details class="opp-info-card technical"><summary><span class="opp-info-icon">⌁</span><b>Technicals</b><i>⌄</i></summary><div>${x.technical||"—"}</div></details>
                <details class="opp-info-card price"><summary><span class="opp-info-icon">↗</span><b>Price Action</b><i>⌄</i></summary><div>${x.price_action||"—"}</div></details>
                <details class="opp-info-card fit"><summary><span class="opp-info-icon">◎</span><b>Portfolio Fit</b><i>⌄</i></summary><div>${x.portfolio_fit||"—"}</div></details>
              </div>
              <div class="opp-trade-card">
                <div class="opp-trade-head"><div><div class="eyebrow">EXECUTION PLAN</div><h4>${x.trade_plan?.headline||"BUY — review entry plan"}</h4></div><span>🟢 BUY</span></div>
                <div class="opp-trade-metrics">
                  <div><span>ENTRY</span><b>${x.trade_plan?.entry_range||"—"}</b></div><div><span>STOP LOSS</span><b>${x.trade_plan?.stop_loss||"—"}</b></div><div><span>TARGET 1</span><b>${x.trade_plan?.target_1||"—"}</b></div><div><span>TARGET 2</span><b>${x.trade_plan?.target_2||"—"}</b></div><div><span>RISK / REWARD</span><b>${x.trade_plan?.risk_reward||"—"}</b></div><div><span>HORIZON</span><b>${x.trade_plan?.horizon||"—"}</b></div>
                </div>
                <div class="opp-trade-foot"><div><span>TRIGGER</span><b>${x.trade_plan?.trigger||"—"}</b></div><div><span>INVALIDATION</span><b>${x.trade_plan?.invalidation||"—"}</b></div></div>
              </div>
            </div>
          </details>`).join("")}
        </div>
      </section>`;
    el.appendChild(wrap);
  }

  loadContext();
}

function renderRebalance(){
  const host=$("#rebalance");
  // Preserve a successfully submitted Smart Rebalancing result when returning to this tab.
  // Re-render only when the tab has not been initialized or there is no cached result.
  if(host && __smartRebalanceSubmittedResult && host.querySelector("#smartDecision .smart-result-shell")){
    return;
  }
  host.innerHTML=`<div class="rebalance-shell">
    <div class="rebalance-toolbar">
      <div></div>
      <button id="rebalanceRefresh" class="btn primary">↻ Recalculate Plan</button>
    </div>
    <div id="rebalanceContent"><div class="rebalance-loading"><div class="loader-mini"></div> Calculating portfolio construction…</div></div>
    <div id="smartRebalance"></div>
  </div>`;

  let currentPlan=null;
  let submitted=false;

  async function loadPlan(){
    $("#rebalanceContent").innerHTML=`<div class="rebalance-loading"><div class="loader-mini"></div> Calculating portfolio construction…</div>`;
    try{
      const p=await (await fetch("/api/rebalance/plan")).json();
      if(p.status==="error") throw new Error(p.message||"Could not calculate rebalance plan.");
      currentPlan=p; renderPlan(p); renderSmartResearch();
    if(__smartRebalanceSubmittedResult){
      renderSmartDecision(__smartRebalanceSubmittedResult);
    }
    }catch(e){
      $("#rebalanceContent").innerHTML=`<div class="panel"><div class="signal bear">⚠ ${e.message}</div></div>`;
    }
  }

  function tone(v,goodAt){return v>=goodAt?"negative":v>=goodAt*.75?"warning":"positive";}

  function renderPlan(p){
    const m=p.metrics||{}, actions=p.actions||[];
    const reduce=actions.filter(x=>x.type==="REDUCE");
    const cleanup=actions.filter(x=>x.type==="CLEANUP");
    const watch=actions.filter(x=>x.type==="WATCH");
    const theme=actions.filter(x=>x.type==="THEME");
    const research=p.research_queue||[];
    const fmt=n=>Number(n||0).toFixed(2);

    const metrics=[
      ["risk","◈","CONSTRUCTION RISK",m.risk||"—",`${m.holdings??"—"} holdings`],
      ["concentration","◎","LARGEST POSITION",`${fmt(m.largest_weight)}%`,`Top 3 = ${fmt(m.top3_weight)}%`],
      ["theme","◌","THEME CONCENTRATION",`${fmt(m.top_theme_pct)}%`,m.top_theme||"—"],
      ["fragmentation","◫","MICRO POSITIONS",m.micro_positions??0,"Below 0.5% / small value"]
    ].map(x=>`
      <article class="rb-metric-card ${x[0]}">
        <div class="rb-metric-icon">${x[1]}</div>
        <div class="rb-metric-copy"><span>${x[2]}</span><b>${x[3]}</b><small>${x[4]}</small></div>
      </article>`).join("");

    const priority=reduce.length?reduce.map(a=>`
      <details class="rb-priority-card">
        <summary>
          <span class="rb-priority-icon">↘</span>
          <span class="rb-priority-main"><b>${a.symbol}</b><small>REDUCE · ${fmt(a.current_weight)}% → ~${fmt(a.target_weight)}% · ${a.shares??"—"} shares</small></span>
          <span class="rb-priority-money"><b>${a.value_release?money(a.value_release):"Size review"}</b><small>${a.value_release?"released":"portfolio impact"}</small></span>
          <span class="rb-caret">⌄</span>
        </summary>
        <div class="rb-priority-detail"><span>WHY THIS ACTION</span><p>${a.reason||"Reduce the position toward the stated portfolio guardrail."}</p></div>
      </details>`).join("")
      :`<div class="rb-empty">No position currently breaches the high-concentration guardrail.</div>`;

    const themes=theme.map(a=>`
      <article class="rb-theme-card">
        <span class="rb-theme-icon">◌</span>
        <div><div class="rb-theme-top"><b>${a.theme}</b><span>${fmt(a.current_pct)}% exposure</span></div><p>${a.reason||"Theme concentration is above the preferred portfolio guardrail."}</p></div>
        <strong><small>TARGET</small>~${a.target_pct}%</strong>
      </article>`).join("");

    const list=(arr,type,label,icon)=>
      arr.length?arr.map(a=>`
        <div class="rb-mini-row ${type}">
          <span class="rb-mini-icon">${icon}</span>
          <div><b>${a.symbol}</b><small>${fmt(a.current_weight)}% portfolio weight${a.value_release?` · ${money(a.value_release)}`:""}</small></div>
          <span class="rb-mini-tag">${label}</span>
        </div>`).join("")
      :`<div class="rb-empty">No positions surfaced.</div>`;

    const researchRows=research.length?research.map(x=>`
      <details class="rb-research-row">
        <summary><span class="rb-research-icon">✦</span><span><b>${x.theme}</b><small>${fmt(x.pct)}% current exposure</small></span><i>⌄</i></summary>
        <div>${x.reason||"Research before moving released capital into this area."}</div>
      </details>`).join("")
      :`<div class="rb-empty">No underrepresented non-ETF themes surfaced from current holdings.</div>`;

    $("#rebalanceContent").innerHTML=`
      <div class="rb-metric-grid">${metrics}</div>

      <div class="rb-top-grid">
        <section class="rb-info-card health">
          <div class="rb-info-head">
            <span class="rb-info-icon blue">◉</span>
            <div><div class="eyebrow">PORTFOLIO CONSTRUCTION</div><h3>Construction Health</h3><small>Higher is healthier</small></div>
            <span class="rb-info-pill blue">CORE SCORE</span>
          </div>
          <div class="rb-health">
            <div class="rb-health-row"><span>Concentration</span><b>${m.concentration_score}/100</b></div>
            <div class="rb-track"><i style="width:${m.concentration_score}%"></i></div>
            <div class="rb-health-row"><span>Fragmentation</span><b>${m.fragmentation_score}/100</b></div>
            <div class="rb-track second"><i style="width:${m.fragmentation_score}%"></i></div>
          </div>
          <div class="rb-note">Construction guardrails only — this measures portfolio structure, not company quality.</div>
        </section>

        <section class="rb-info-card impact">
          <div class="rb-info-head">
            <span class="rb-info-icon amber">↗</span>
            <div><div class="eyebrow">CAPITAL IMPACT</div><h3>Before → Illustrative After</h3><small>Deterministic reductions only</small></div>
            <span class="rb-info-pill amber">READ ONLY</span>
          </div>
          <div class="rb-impact-row"><span>Largest position</span><b>${fmt(m.largest_weight)}% <i>→</i> ${fmt(p.projected?.largest_weight_after||m.largest_weight)}%</b></div>
          <div class="rb-impact-row"><span>Capital potentially released</span><b>${money(p.projected?.reduction_value||0)}</b></div>
          <div class="rb-note">No hypothetical buys are assumed in these figures.</div>
        </section>
      </div>

      <section class="rb-section priority">
        <header class="rb-section-head">
          <div class="rb-section-title"><span class="rb-section-icon red">⚡</span><div><div class="eyebrow">ACTION QUEUE</div><h3>Priority Actions</h3><small>${actions.length} construction signals surfaced</small></div></div>
          <span class="rb-section-count red">${actions.length}</span>
        </header>
        <div class="rb-priority-list">${priority}</div>
      </section>

      ${theme.length?`
      <section class="rb-section">
        <header class="rb-section-head">
          <div class="rb-section-title"><span class="rb-section-icon amber">◌</span><div><div class="eyebrow">THEME RISK</div><h3>Theme Concentration</h3><small>Keep concentration within portfolio guardrails</small></div></div>
          <span class="rb-section-count amber">${theme.length}</span>
        </header>
        <div class="rb-theme-list">${themes}</div>
      </section>`:""}

      <div class="rb-two-col">
        <section class="rb-section">
          <header class="rb-section-head">
            <div class="rb-section-title"><span class="rb-section-icon violet">◫</span><div><div class="eyebrow">FRAGMENTATION</div><h3>Micro Positions</h3><small>Review before cleanup</small></div></div>
          </header>
          <div class="rb-mini-list">${list(cleanup,"micro","REVIEW","◫")}</div>
        </section>
        <section class="rb-section">
          <header class="rb-section-head">
            <div class="rb-section-title"><span class="rb-section-icon blue">◷</span><div><div class="eyebrow">MONITORING</div><h3>Watch Positions</h3><small>Need stock-level research</small></div></div>
          </header>
          <div class="rb-mini-list">${list(watch,"watch","WATCH","◷")}</div>
        </section>
      </div>

      <section class="rb-section">
        <header class="rb-section-head">
          <div class="rb-section-title"><span class="rb-section-icon green">✦</span><div><div class="eyebrow">DIVERSIFICATION</div><h3>Diversification Research Queue</h3><small>Research before moving released capital</small></div></div>
          <span class="rb-section-count green">${research.length}</span>
        </header>
        <div class="rb-research-list">${researchRows}</div>
      </section>

      <div class="rb-disclaimer"><span>i</span><p><b>Read-only construction analysis.</b> The engine does not place, modify or cancel orders. Individual stock BUY/SELL decisions require stock-level research.</p></div>`;
  }


  function buildSmartPack(){
    const hs=(portfolio.holdings||[]).map((h,i)=>({
      n:i+1,symbol:h.symbol,exchange:h.exchange||"NSE",quantity:h.quantity??h.qty,avg_price:h.avg_price,ltp:h.ltp,
      value:h.value,pnl:h.pnl,pnl_pct:h.pnl_pct,weight:h.weight,theme:h.theme,market_cap:h.market_cap,status:h.status
    }));
    const compactPortfolio={value:portfolio.value,invested:portfolio.invested,pnl:portfolio.pnl,pnl_pct:portfolio.pnl_pct,holding_count:hs.length};
    const compactConstruction={
      risk:currentPlan?.metrics?.risk,largest_position_pct:currentPlan?.metrics?.largest_weight,
      top3_pct:currentPlan?.metrics?.top3_weight,top_theme:currentPlan?.metrics?.top_theme,
      top_theme_pct:currentPlan?.metrics?.top_theme_pct,micro_positions:currentPlan?.metrics?.micro_positions,
      actions:(currentPlan?.actions||[]).map(x=>({type:x.type,symbol:x.symbol,current_weight:x.current_weight,target_weight:x.target_weight,reason:x.reason}))
    };

    const exampleHolding=hs[0]||{
      n:1,symbol:"EXAMPLE_SYMBOL",exchange:"NSE",quantity:0,avg_price:0,ltp:0,value:0,pnl:0,pnl_pct:0,
      weight:0,theme:"Example Theme",market_cap:"Large Cap",status:"SYNCED"
    };
    const requiredHoldingFields={
      n:exampleHolding.n,symbol:exampleHolding.symbol,exchange:exampleHolding.exchange,quantity:exampleHolding.quantity,
      avg_price:exampleHolding.avg_price,ltp:exampleHolding.ltp,value:exampleHolding.value,pnl:exampleHolding.pnl,pnl_pct:exampleHolding.pnl_pct,
      weight:exampleHolding.weight,theme:exampleHolding.theme,market_cap:exampleHolding.market_cap,action:"HOLD",confidence:"MEDIUM",
      fundamental:"Latest verified earnings, growth, margins, balance sheet, cash flow and management commentary...",
      valuation:"Latest credible valuation or clearly labelled derived proxy...",
      technical:"Current/recent candles, trend, 20/50/100/200 DMA, RSI, MACD, volume, support/resistance and volatility...",
      risk:"Company, sector, valuation and portfolio-concentration risks...",
      portfolio_fit:"Current sizing versus the portfolio and diversification role...",
      current_weight:exampleHolding.weight,target_weight:exampleHolding.weight,
      shares_to_sell:0,sell_price_range:"N/A",shares_to_buy:0,buy_price_range:"N/A",
      decision_reason:"Illustrative schema example only.",
      trade_plan:{
        type:"HOLD",headline:`Hold ${exampleHolding.quantity} shares · no fresh buying`,shares:0,
        entry_range:"N/A",stop_loss:"N/A",target_1:"N/A",target_2:"N/A",risk_reward:"N/A",
        invalidation:"Reassess if the thesis materially changes",horizon:"3–12 months",
        trigger:"Defined fundamental/technical trigger",rationale:"Illustrative schema example only."
      }
    };
    const requiredResponse={
      action:"REBALANCE",confidence:"MEDIUM-HIGH",smart_summary:"...",
      fundamental:"...",valuation:"...",technical:"...",risk:"...",portfolio_fit:"...",
      sell_plan:[{symbol:exampleHolding.symbol,shares:0,price_range:"N/A",reason:"Illustrative schema example"}],
      buy_plan:[{symbol:"EXAMPLE_NEW_OR_EXISTING_SYMBOL",shares:0,price_range:"N/A",reason:"Illustrative schema example",new_stock:true}],
      capital_to_add:{required:false,amount:0,reason:"..."},
      target_allocation:{largest_position:"Portfolio-derived target",priority_theme:"Portfolio-derived target"},
      rebalancing_action:"...",
      expected_portfolio_impact:"...",
      key_positives:["..."],key_negatives:["..."],reasoning:"...",
      holdings_review:[requiredHoldingFields]
    };


    return `PORTFOLIO CIO — SMART REBALANCING RESEARCH REQUEST

ROLE
Act as a professional Portfolio CIO + professional discretionary trader.

NON-NEGOTIABLE SCOPE
Analyze ALL ${hs.length} holdings. Every holding must receive BOTH:
1) FULL FUNDAMENTAL REVIEW
2) FULL TECHNICAL + PRICE-ACTION REVIEW

For EVERY stock review:
- Fundamentals: latest results, revenue/PAT/EPS trend, margins, ROE/ROCE, debt, cash flow, promoter/pledge where relevant, valuation, management commentary and risks.
- Technicals: current/recent price, candle structure, trend, 20/50/100/200 DMA, RSI, MACD, volume, support, resistance, breakout/breakdown, volatility and risk/reward.
- Use current verified market information. For price/action analysis, you may use current chart/price-action evidence from reliable sources such as NSE, BSE, Zerodha/Kite, TradingView, Moneycontrol, Screener, exchange filings and credible financial reporting.
- Read recent candles and price action, not just indicator values.
- Do not skip small holdings.

NO-DATA-UNAVAILABLE RULE
Do NOT output the phrase "DATA UNAVAILABLE" anywhere in your response.
Do NOT leave a requested field blank.
When an exact metric is not directly available:
- use the latest verifiable value from another credible source, OR
- derive a reasonable value/proxy from the available market/portfolio data and label it "ESTIMATED" or "DERIVED".
For technical price ranges, derive practical zones from current LTP, support/resistance, recent candles, DMA clusters, ATR/volatility and volume.
For share counts, calculate from the recommended rupee allocation and the chosen entry/exit range.
Never invent a number and present it as verified fact.

PORTFOLIO-LEVEL REBALANCING
After reviewing ALL ${hs.length} stocks:
- evaluate concentration, theme overlap, market-cap mix, fragmentation, micro positions, winners that became oversized, deteriorating holdings, diversification gaps and risk/reward;
- decide which holdings should BUY / ACCUMULATE / HOLD / WAIT / REDUCE / SELL;
- find NEW STOCK opportunities when they improve diversification or risk-adjusted return;
- determine exactly how capital released from SELL/REDUCE actions should be redeployed.

CAPITAL REDEPLOYMENT RULE
A SELL/REDUCE decision releases capital.
Therefore, unless there is genuinely no suitable opportunity after the full ${hs.length}-stock + broader market research review, you MUST also provide BUY/ACCUMULATE recommendations to redeploy that capital.
Do NOT return a sell-only plan while leaving released capital with no destination.
BUY recommendations may be existing holdings or NEW STOCKS.
If the best outcome is to keep some cash, state the exact rupee amount and why, but still identify the highest-conviction BUY opportunities considered.

TRADING RULES
- Never sell only because a stock is down.
- Never sell only because a stock is a large winner.
- Combine fundamentals + valuation + technicals + candle/price action + portfolio fit.
- Every SELL/REDUCE and BUY/ACCUMULATE must contain shares and a realistic price range.
- NEW STOCK buys must set new_stock=true.
- No order is placed by this application.

PORTFOLIO SIZE IS DYNAMIC
The live portfolio.holdings array is the sole source of truth for the holding count.
Current holding count for this request: ${hs.length}.
Analyze exactly ${hs.length} holdings — no fixed count is assumed.
If holdings are added or removed, this prompt and the required JSON count must change automatically.

PORTFOLIO SNAPSHOT
${JSON.stringify(compactPortfolio)}

CONSTRUCTION SNAPSHOT
${JSON.stringify(compactConstruction)}

ALL ${hs.length} HOLDINGS
${JSON.stringify(hs)}

CRITICAL OUTPUT CONTRACT
Return VALID JSON ONLY.
No Markdown.
No code fences.
No prose before or after the JSON.

holdings_review MUST contain exactly ${hs.length} objects, one per input holding, in the same order.
EVERY holdings_review object MUST include ALL of:
n, symbol, exchange, quantity, avg_price, ltp, value, pnl, pnl_pct, weight, theme, market_cap,
action, confidence, fundamental, valuation, technical, risk, portfolio_fit,
current_weight, target_weight, shares_to_sell, sell_price_range,
shares_to_buy, buy_price_range, decision_reason, price_action, trade_plan

trade_plan MUST contain:
type, headline, shares, entry_range, stop_loss, target_1, target_2, risk_reward, invalidation, horizon, trigger, rationale

Trade plan examples:
- BUY: "Buy 2 shares @ ₹68–70"
- SELL: "Sell 5 shares @ ₹720–735"
- REDUCE: "Sell 8 shares @ ₹3,250–3,320"
- HOLD: "Hold 27 shares · no fresh buying"
- WAIT: "Wait for ₹395–405 before buying 3 shares"

No field may contain "DATA UNAVAILABLE". Use a verified value or "ESTIMATED: ..." / "DERIVED: ...".

sell_plan MUST include EVERY recommended SELL/REDUCE/EXIT transaction as a separate object.
buy_plan MUST include EVERY recommended BUY/ACCUMULATE transaction as a separate object.
If sell_plan is non-empty, buy_plan MUST normally be non-empty because released capital must be redeployed.
Each buy_plan object must contain new_stock:true/false.

Every SELL and BUY transaction MUST include shares and price_range.
Use an explicit calculated range rather than a vague instruction like "buy on dips".

Return JSON matching this exact shape:
${JSON.stringify(requiredResponse,null,2)}

FINAL VALIDATION
1. holdings_review count = ${hs.length}
2. every input symbol appears exactly once
3. no field contains the words DATA UNAVAILABLE
4. every sell row has shares + price_range
5. every buy row has shares + price_range
6. if sell_plan has entries, buy_plan contains redeployment opportunities unless cash retention is explicitly justified
7. output is valid JSON only`;
  }

  function renderSmartResearch(){
    $("#smartRebalance").innerHTML=`
      <div class="smart-rebalance-card">
        <div class="smart-header">
          <div><div class="eyebrow">PORTFOLIO CIO</div><h2>🧠 Smart Rebalancing</h2><p class="muted">Portfolio-wide research handoff: holdings, concentration, technicals, price action, diversification and new-stock opportunities.</p></div>
          <span class="smart-badge">READ ONLY</span>
        </div>
        <div class="smart-actions">
          <button id="smartPrepare" class="btn primary">🧠 Prepare ChatGPT Research</button>
          <span class="muted">No paid AI API is used.</span>
        </div>
        <div id="smartPromptArea"></div>
        <div id="smartResponseGate" class="response-gate" style="display:none"></div>
        <div id="smartDecision"></div>
      </div>`;
    $("#smartPrepare").onclick=prepareSmartResearch;
  }

  function prepareSmartResearch(){
    const prompt=buildSmartPack();
    $("#smartPromptArea").innerHTML=`<div class="smart-prompt"><div class="section-heading"><span>✦</span><h3>ChatGPT Research Request</h3><small>Copy into ChatGPT and return the structured response below.</small></div><textarea id="smartPromptText" class="pack-preview" readonly>${prompt}</textarea><div class="smart-prompt-actions"><button id="copySmartPrompt" class="btn primary">Copy Research Request</button><button id="alreadySmart" class="btn secondary">Already have response?</button></div></div>`;
    $("#copySmartPrompt").onclick=async()=>{
      try{await navigator.clipboard.writeText(prompt);}catch{const ta=document.createElement("textarea");ta.value=prompt;document.body.appendChild(ta);ta.select();document.execCommand("copy");ta.remove();}
      toast("Smart Rebalancing research request copied.");
    };
    $("#alreadySmart").onclick=()=>openSmartResponseGate();
  }

  function openSmartResponseGate(){
    $("#smartResponseGate").style.display="";
    $("#smartResponseGate").innerHTML=`<div class="smart-response-card"><div class="section-heading"><span>✓</span><h3>Submit ChatGPT Research Response</h3><small>Paste the complete portfolio-level response here.</small></div><textarea id="smartResponseText" class="pack-preview" placeholder="Paste the complete ChatGPT response here…"></textarea><div class="smart-prompt-actions"><button id="submitSmart" class="btn primary">✅ Submit Response</button></div></div>`;
    $("#submitSmart").onclick=submitSmartResponse;
    $("#smartResponseText").focus();
  }

  async function submitSmartResponse(){
    const text=$("#smartResponseText").value.trim();
    if(!text){toast("Paste the ChatGPT response first.");return;}
    const b=$("#submitSmart"); b.disabled=true; b.textContent="Processing…";
    try{
      const r=await (await fetch("/api/rebalance/submit-response",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({response:text})})).json();
      if(r.status!=="ok") throw new Error(r.message||"Could not process Smart Rebalancing response.");
      submitted=true;
      __smartRebalanceSubmittedResult=r.decision;
      if(document.activeElement && typeof document.activeElement.blur==="function"){
        document.activeElement.blur();
      }
      $("#smartResponseGate").style.display="none";
      $("#smartResponseGate").innerHTML="";
      $("#smartPromptArea").innerHTML="";
      renderSmartDecision(r.decision);
      const forceRebalanceTop=()=>{
        try{
          window.scrollTo({top:0,left:0,behavior:"auto"});
          document.documentElement.scrollTop=0;
          document.body.scrollTop=0;
        }catch(_){}
      };
      requestAnimationFrame(forceRebalanceTop);
      setTimeout(forceRebalanceTop,50);
      setTimeout(forceRebalanceTop,150);
      setTimeout(forceRebalanceTop,350);
      setTimeout(forceRebalanceTop,750);
      setTimeout(forceRebalanceTop,1500);
      toast("Smart Rebalancing decision generated.");
    }catch(e){
      toast(e.message||"Could not process response.");
    }finally{b.disabled=false;b.textContent="✅ Submit Response";}
  }


  function renderHoldingsReviewTable(rows){
    const all=Array.isArray(rows)?rows:[];
    const counts={
      all:all.length,
      buy:all.filter(x=>/BUY|ACCUMULATE/.test(String(x.action||""))).length,
      sell:all.filter(x=>/SELL|REDUCE/.test(String(x.action||""))).length,
      hold:all.filter(x=>/HOLD/.test(String(x.action||""))).length,
      wait:all.filter(x=>/WAIT|REBALANCE/.test(String(x.action||""))).length
    };
    const actionClass=a=>/SELL|REDUCE/.test(a)?"sell":/BUY|ACCUMULATE/.test(a)?"buy":/WAIT|REBALANCE/.test(a)?"wait":"hold";
    const icon=a=>/SELL/.test(a)?"🔴":/REDUCE/.test(a)?"🟡":/BUY|ACCUMULATE/.test(a)?"🟢":/WAIT/.test(a)?"🟠":"🔵";

    return `<div class="all61-card expandable61-card" id="all61Card">
      <div class="all61-head">
        <div>
          <div class="eyebrow">PORTFOLIO COVERAGE</div>
          <h3>ALL ${all.length} HOLDINGS REVIEWED</h3>
          <p class="muted">Every stock reviewed across fundamentals, valuation, technicals, price action, risk and portfolio fit.</p>
        </div>
        <div class="all61-head-right"><span class="all61-badge">${all.length}/61 COMPLETE</span><span class="all61-valid">✓ JSON VERIFIED</span></div>
      </div>

      <div class="all61-toolbar">
        <input id="all61Search" class="all61-search" placeholder="Search stock / theme…">
        <div class="all61-filters">
          <button data-filter="all" class="active">All (${counts.all})</button>
          <button data-filter="buy">Buy / Accumulate (${counts.buy})</button>
          <button data-filter="sell">Sell / Reduce (${counts.sell})</button>
          <button data-filter="hold">Hold (${counts.hold})</button>
          <button data-filter="wait">Wait / Review (${counts.wait})</button>
        </div>
      </div>

      <div id="all61Rows" class="stock-review-list">
        ${all.map((x,i)=>{
          const tp=x.trade_plan||{};
          const sell=Number(x.shares_to_sell||0), buy=Number(x.shares_to_buy||0);
          const tradeHeadline=tp.headline || (sell>0?`Sell ${sell} shares @ ${x.sell_price_range||"N/A"}`:buy>0?`Buy ${buy} shares @ ${x.buy_price_range||"N/A"}`:`${x.action||"HOLD"} — review plan`);
          const detailTrade=tp;
          return `<details class="stock-review-row" data-action="${actionClass(x.action||"HOLD")}" data-search="${String((x.symbol||"")+" "+(x.theme||"")).toLowerCase()}">
            <summary>
              <div class="stock-toggle">›</div>
              <div class="stock-main">
                <div class="stock-title-line"><b>${x.symbol}</b><span class="action-chip ${actionClass(x.action||"HOLD")}">${icon(x.action||"HOLD")} ${x.action||"HOLD"}</span></div>
                <small>${x.theme||"—"} · ${x.market_cap||"—"}</small>
              </div>
              <div class="stock-metric"><span>QTY</span><b>${x.quantity??"—"}</b></div>
              <div class="stock-metric"><span>LTP</span><b>₹${x.ltp??"—"}</b></div>
              <div class="stock-metric"><span>VALUE</span><b>₹${x.value??"—"}</b></div>
              <div class="stock-metric pnl ${Number(x.pnl)<0?"loss":"gain"}"><span>P&L</span><b>${x.pnl!=null?"₹"+x.pnl:"—"}</b></div>
              <div class="stock-metric pnl ${Number(x.pnl_pct)<0?"loss":"gain"}"><span>P&L %</span><b>${x.pnl_pct!=null?x.pnl_pct+"%":"—"}</b></div>
              <div class="stock-metric"><span>WEIGHT</span><b>${x.current_weight??"—"}%</b></div>
              <div class="stock-target"><span>TARGET</span><b>${x.target_weight??"—"}%</b></div>
            </summary>

            <div class="stock-expanded">
              <div class="stock-expanded-top">
                <div>
                  <div class="trade-plan-label">${icon(tp.type||x.action||"HOLD")} TRADE PLAN</div>
                  <strong class="trade-plan-headline">${tradeHeadline}</strong>
                  <p class="trade-plan-rationale">${tp.rationale||x.note||""}</p>
                </div>
                <div class="trade-plan-tags">
                  <span>${tp.horizon||"Portfolio horizon"}</span>
                  <span>${tp.trigger||"Technical / fundamental trigger"}</span>
                </div>
              </div>

              <div class="trade-plan-grid">
                <div><span>ENTRY / EXIT RANGE</span><b>${tp.entry_range||"N/A"}</b></div>
                <div><span>SHARES</span><b>${tp.shares??(sell>0?sell:buy)}</b></div>
                <div><span>STOP-LOSS</span><b>${tp.stop_loss||"N/A"}</b></div>
                <div><span>TARGET 1</span><b>${tp.target_1||"N/A"}</b></div>
                <div><span>TARGET 2</span><b>${tp.target_2||"N/A"}</b></div>
                <div><span>RISK / REWARD</span><b>${tp.risk_reward||"N/A"}</b></div>
                <div><span>INVALIDATION</span><b>${tp.invalidation||"N/A"}</b></div>
                <div><span>HORIZON</span><b>${tp.horizon||"N/A"}</b></div>
              </div>

              <div class="stock-analysis-accordions">
                <details><summary>Move <i>⌄</i></summary><div>${detailTrade.rationale||x.decision_reason||x.note||"No additional move rationale."}</div></details>
                <details><summary>Fundamentals <i>⌄</i></summary><div>${x.fundamental||"N/A"}</div></details>
                <details><summary>Valuation <i>⌄</i></summary><div>${x.valuation||"N/A"}</div></details>
                <details><summary>Technicals <i>⌄</i></summary><div>${x.technical||"N/A"}</div></details>
                <details><summary>Price Action / Candles <i>⌄</i></summary><div>${x.price_action||x.technical||"N/A"}</div></details>
                <details><summary>Portfolio Fit <i>⌄</i></summary><div>${x.portfolio_fit||"N/A"}</div></details>
                <details><summary>Risk <i>⌄</i></summary><div>${x.risk||"N/A"}</div></details>
              </div>
            </div>
          </details>`;
        }).join("")}
      </div>
    </div>`;
  }


  function shortLabel(t){
    const s=String(t||"DATA UNAVAILABLE").replace(/\s+/g," ").trim();
    const m=s.match(/^(.{1,54}?)(?:[.!?](?:\s|$)|$)/);
    return (m?m[1]:s).slice(0,55)+(s.length>55?"…":"");
  }

  function renderSmartDecision(d){
    const badge=String(d.action||"REVIEW").toLowerCase().replace(/[^a-z]/g,"");
    const shortFactor=(text)=>shortLabel(text);
    const factor=(label,text,accent)=>`<details class="smart-factor ${accent}">
      <summary><span>${label}</span><b>${shortFactor(text)}</b><i>⌄</i></summary>
      <div>${String(text||"DATA UNAVAILABLE").replace(/\n/g,"<br>")}</div>
    </details>`;

    const sells=d.smart_sells||[], buys=d.smart_buys||[], reviewed=d.holdings_review||[];
    const reviewedCount=reviewed.length||0;
    const portfolioValue=Number(portfolio.value||0);
    const returnPct=Number(portfolio.pnl_pct||0);
    const risk=String(d.risk||"").toLowerCase().includes("high")?"HIGH":String(currentPlan?.metrics?.risk||"REVIEW");
    const generated=new Date().toLocaleString([], {day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"});

    const money0=(n)=>money(Number(n)||0);
    const objRows=(v)=>{
      if(v===null||v===undefined||v==="") return `<div class="allocation-item"><span>Value</span><b>N/A</b></div>`;
      if(typeof v!=="object") return `<div class="allocation-item"><span>Value</span><b>${String(v)}</b></div>`;
      return Object.entries(v).map(([k,val])=>`<div class="allocation-item"><span>${k.replace(/_/g," ")}</span><b>${typeof val==="object"?JSON.stringify(val):val}</b></div>`).join("");
    };
    const row=(x,idx,isBuy)=>`<div class="smart-trade-row">
      <div class="trade-num">${idx+1}</div>
      <div class="trade-stock"><b>${x.symbol}</b>${isBuy&&x.is_new?'<em>NEW STOCK</em>':""}<small>${x.reason||""}</small></div>
      <strong>${x.shares??"N/A"}</strong>
      <span>${x.price_range||"N/A"}</span>
    </div>`;

    const healthClass=risk==="HIGH"?"high":risk==="ELEVATED"?"elevated":"good";

    $("#smartDecision").innerHTML=`<div class="smart-result-shell">
      <div class="smart-result-topbar">
        <div>
          <div class="eyebrow">SMART REBALANCING RESULT</div>
          <h2>Portfolio CIO Plan</h2>
        </div>
        <div class="smart-result-meta">
          <span>Generated: ${generated}</span>
          <span class="kite-inline">Kite MCP: Connected</span>
          <button class="smart-top-btn" type="button" onclick="window.scrollTo({top:document.body.scrollHeight,behavior:'smooth'})">↓ Review ${reviewedCount||portfolio.holdings?.length||0} Holdings</button>
        </div>
      </div>

      <div class="smart-result-badges">
        <span class="decision-badge ${badge}">ACTION: ${d.action||"REVIEW"}</span>
        <span class="confidence-pill">CONFIDENCE: ${d.confidence||"N/A"}</span>
      </div>

      <div class="smart-hero-summary">
        <div class="summary-icon">◎</div>
        <div class="summary-copy">
          <div class="summary-label">SMART SUMMARY</div>
          <p>${d.summary||"Portfolio-level Smart Rebalancing result."}</p>
        </div>
        <div class="summary-stats">
          <div><b>${money0(portfolioValue)}</b><span>Portfolio Value</span></div>
          <div><b class="positive">${returnPct>0?"+":""}${returnPct.toFixed(1)}%</b><span>Overall Return</span></div>
          <div><b>${portfolio.holdings?.length||reviewedCount||61}</b><span>Holdings</span></div>
          <div><b class="${healthClass}">${risk}</b><span>Construction Risk</span></div>
        </div>
      </div>

      <div class="smart-factor-grid">
        ${factor("Fundamental",d.fundamental,"fundamental")}
        ${factor("Valuation",d.valuation,"valuation")}
        ${factor("Technical",d.technical,"technical")}
        ${factor("Risk",d.risk,"risk")}
        ${factor("Portfolio Fit",d.portfolio_fit,"fit")}
      </div>

      <div class="smart-trade-grid">
        <div class="smart-trade-card sell">
          <div class="trade-title">🔴 SELL / REDUCE / EXIT <span>Total: ${sells.length}</span></div>
          <div class="smart-trade-header"><span>#</span><span>SYMBOL</span><span>SHARES</span><span>PRICE RANGE</span></div>
          <div class="trade-scroll">${sells.length?sells.map((x,i)=>row(x,i,false)).join(""):`<div class="empty-state">No sell/reduce recommendation.</div>`}</div>
          ${sells.length>5?`<div class="trade-more">＋ ${sells.length-5} more recommendations</div>`:""}
        </div>

        <div class="smart-trade-card buy">
          <div class="trade-title">🟢 BUY / ACCUMULATE / NEW <span>Total: ${buys.length}</span></div>
          <div class="smart-trade-header"><span>#</span><span>SYMBOL</span><span>SHARES</span><span>PRICE RANGE</span></div>
          <div class="trade-scroll">${buys.length?buys.map((x,i)=>row(x,i,true)).join(""):`<div class="empty-state">No buy recommendation.</div>`}</div>
          ${buys.length>5?`<div class="trade-more">＋ ${buys.length-5} more recommendations</div>`:""}
        </div>

        <div class="smart-trade-card allocate">
          <div class="trade-title">🟡 CAPITAL & ALLOCATION</div>
          ${objRows(d.capital_to_add)}
          ${objRows(d.target_allocation)}
          <div class="allocation-item"><span>Rebalancing Action</span><b>${d.rebalancing_action||"N/A"}</b></div>
          <div class="allocation-item"><span>Expected Impact</span><b>${d.expected_impact||"N/A"}</b></div>
        </div>
      </div>

      <div class="smart-columns compact-columns">
        <div class="positive-panel"><div class="section-heading"><span>✓</span><h4>Key Positives</h4></div><ul>${(d.positives||[]).map(x=>`<li>${x}</li>`).join("")||"<li>N/A</li>"}</ul></div>
        <div class="risk-panel"><div class="section-heading"><span>⚠</span><h4>Key Risks</h4></div><ul>${(d.negatives||[]).map(x=>`<li>${x}</li>`).join("")||"<li>N/A</li>"}</ul></div>
      </div>

      <div class="decision-section smart-why-section">
        <div class="section-heading"><span>◎</span><h4>Why this plan?</h4></div>
        <div class="decision-reasoning">${String(d.reasoning||"N/A").replace(/\n/g,"<br>")}</div>
      </div>

      ${renderHoldingsReviewTable(reviewed)}

      <div class="research-sub smart-footnote">${d.source_note||""}</div>
    </div>`;

    const allCard=$("#all61Card");
    if(allCard){
      const rows=[...allCard.querySelectorAll(".stock-review-row")];
      let active="all", query="";
      const apply=()=>{
        rows.forEach(r=>{
          const actionMatch=active==="all"||r.dataset.action===active;
          const searchMatch=!query||r.dataset.search.includes(query);
          r.style.display=actionMatch&&searchMatch?"":"none";
          if(!(actionMatch&&searchMatch)) r.open=false;
        });
      };
      allCard.querySelectorAll(".all61-filters button").forEach(btn=>{
        btn.onclick=()=>{
          allCard.querySelectorAll(".all61-filters button").forEach(x=>x.classList.remove("active"));
          btn.classList.add("active"); active=btn.dataset.filter; apply();
        };
      });
      const search=allCard.querySelector("#all61Search");
      if(search) search.oninput=()=>{query=search.value.trim().toLowerCase();apply();};
    }


  }

  $("#rebalanceRefresh").onclick=loadPlan;
  loadPlan();
}

$("#logout").onclick=async()=>{
  const b=$("#logout");
  b.disabled=true;
  try{
    const r=await (await fetch("/api/kite/logout",{method:"POST"})).json();
    if(r.status!=="ok") throw new Error(r.message||"Logout failed.");
    kiteAuthenticated=false;
    kiteConnected=false;
    toast("Logged out and cleared the local Kite MCP session.");
    showHome("You are logged out. Click Let's Get Started to connect Zerodha again.");
  }catch(e){
    toast("Logout failed: "+(e.message||"Unknown error"));
  }finally{b.disabled=false;}
};

$("#reanalyze").onclick=async()=>{let r=await (await fetch("/api/analysis/run",{method:"POST"})).json();toast("Analysis run recorded. Live connector is the next phase.");};

let analysisPoller=null;
async function pollAnalysis(){
  if(analysisPoller)return;
  const tick=async()=>{
    try{
      const r=await fetch("/api/analysis/status",{cache:"no-store"});
      const st=await r.json();
      applyAnalysisState(st,true);
      if(st.status==="running" && currentView==="holdings") renderBanner();

      if(st.status==="complete"||st.status==="error"){
        clearInterval(analysisPoller);
        analysisPoller=null;
        if(currentView==="holdings"){
          const banner=document.querySelector("#analysisBanner");
          if(banner){
            banner.classList.remove("analysis-wait-active");
            banner.innerHTML="";
            banner.style.display="none";
          }
        }
        toast(st.message||"Analysis finished.");
      }
    }catch(e){}
  };
  await tick();
  if(!analysisPoller){
    analysisPoller=setInterval(tick,1000);
  }
}
nav();
$("#getStarted").onclick=async()=>{ await startLoginFlow(); };

$("#relogin").onclick=async()=>{
  const b=$("#relogin");
  b.disabled=true;
  try{
    showHome("Resetting the current Zerodha MCP session…");
    const r=await (await fetch("/api/kite/logout",{method:"POST"})).json();
    if(r.status!=="ok") throw new Error(r.message||"Could not reset the current MCP session.");
    kiteAuthenticated=false;
    kiteConnected=false;
    await startLoginFlow();
  }catch(e){
    setHomeStatus(e.message||"Re-login failed.");
  }finally{b.disabled=false;}
};


$("#reanalyze").onclick=async()=>{
  const b=$("#reanalyze");b.disabled=true;b.textContent="Syncing…";
  try{
    await refreshKiteStatus();
    if(!kiteAuthenticated){showHome("Please re-login to Zerodha.");return;}
    const r=await (await fetch("/api/kite/sync",{method:"POST"})).json();
    if(r.status==="ok"){
      portfolio=r.snapshot;
      window.__priorStatuses=Object.fromEntries(portfolio.holdings.map(h=>[h.symbol,h.status]));
      $("#asOf").textContent="Live sync: "+new Date(portfolio.as_of).toLocaleString();
      renderAll();
      toast(`Live Zerodha sync complete: ${portfolio.holdings.length} holdings.`);
      
      
    }else{toast(r.message||r?.error?.message||"Live sync failed.");}
  }catch(e){toast("Live sync failed: "+e.message)}
  finally{b.disabled=false;b.textContent="↻ Re-analyse";}
};

$("#diagKite").onclick=async()=>{
  const b=$("#diagKite"); b.disabled=true; b.textContent="Testing…";
  try{
    const r=await (await fetch("/api/kite/diagnose")).json();
    console.log("Kite diagnostics:", r);
    if(r.status==="ok"){
      const d=r.diagnostics||{};
      const loginText = d.loginResult?.content?.map(x=>x.text||"").join("\n") || JSON.stringify(d.loginResult||{});
      const holdText = d.holdingsResult?.content?.map(x=>x.text||"").join("\n") || JSON.stringify(d.holdingsResult||{});
      const holdErr = d.holdingsError?.message || "";
      const msg = `Kite diagnostics: ${d.toolCount} tools. Login: ${loginText.slice(0,120)}. Holdings: ${(holdErr||holdText).slice(0,120)}`;
      toast(msg);
    } else toast(r.message||"Diagnostics failed.");
  }catch(e){toast("Diagnostics failed: "+e.message)}
  finally{b.disabled=false;b.textContent="Kite Diagnostics";}
};

load().then(async()=>{
  try{
    const st=await refreshAnalysisStateIntoPortfolio(false);
    if(st?.status==="running" && kiteAuthenticated) pollAnalysis();
    else applyAnalysisState(st,false);
  }catch(e){}
});