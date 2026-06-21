// api/stock.js — Meridian live data backend (Vercel serverless function)
// Uses two free providers:
//   FINNHUB_KEY  -> quotes, profile, ratings, price targets, peers, candles
//   FMP_KEY      -> cash flow, balance sheet, financial ratios for DCF/EV
// Both have free tiers. FMP is optional; if absent, DCF falls back to Finnhub-only fields.

const FINNHUB = "https://finnhub.io/api/v1";
const FMP = "https://financialmodelingprep.com/stable";

async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}
const fh = (path, key) => getJSON(`${FINNHUB}${path}${path.includes("?") ? "&" : "?"}token=${key}`);
const fmp = (path, key) => getJSON(`${FMP}${path}${path.includes("?") ? "&" : "?"}apikey=${key}`);
const safe = (p) => p.catch(() => null);

export default async function handler(req, res) {
  const fhKey = process.env.FINNHUB_KEY;
  const fmpKey = process.env.FMP_KEY || null;
  if (!fhKey) return res.status(500).json({ error: "Server is missing FINNHUB_KEY. Add it in Vercel → Settings → Environment Variables." });

  const mode = req.query.mode || "search";
  const q = (req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "Missing query" });

  try {
    if (mode === "search") {
      const data = await fh(`/search?q=${encodeURIComponent(q)}`, fhKey);
      const results = (data.result || [])
        .filter((r) => r.type === "Common Stock" || !r.type)
        .slice(0, 8)
        .map((r) => ({ name: r.description, ticker: r.symbol, exchange: (r.displaySymbol||"").includes(".") ? r.displaySymbol.split(".")[1] : "US" }));
      return res.status(200).json({ results });
    }

    if (mode === "analyze") {
      const sym = q.toUpperCase();
      const [profile, quote, metricsResp, recResp, ptResp, earningsResp, candleResp, peersResp] = await Promise.all([
        safe(fh(`/stock/profile2?symbol=${sym}`, fhKey)),
        safe(fh(`/quote?symbol=${sym}`, fhKey)),
        safe(fh(`/stock/metric?symbol=${sym}&metric=all`, fhKey)),
        safe(fh(`/stock/recommendation?symbol=${sym}`, fhKey)),
        safe(fh(`/stock/price-target?symbol=${sym}`, fhKey)),
        safe(fh(`/stock/earnings?symbol=${sym}`, fhKey)),
        safe(fh(`/stock/candle?symbol=${sym}&resolution=D&count=250`, fhKey)),
        safe(fh(`/stock/peers?symbol=${sym}`, fhKey)),
      ]);

      // FMP fundamentals for DCF / EV (optional)
      let cashflow = null, balance = null, ratios = null, incomeGrowth = null, enterprise = null;
      if (fmpKey) {
        [cashflow, balance, ratios, incomeGrowth, enterprise] = await Promise.all([
          safe(fmp(`/cash-flow-statement?symbol=${sym}&limit=1`, fmpKey)),
          safe(fmp(`/balance-sheet-statement?symbol=${sym}&limit=1`, fmpKey)),
          safe(fmp(`/ratios-ttm?symbol=${sym}`, fmpKey)),
          safe(fmp(`/financial-growth?symbol=${sym}&limit=1`, fmpKey)),
          safe(fmp(`/enterprise-values?symbol=${sym}&limit=1`, fmpKey)),
        ]);
      }

      const metric = (metricsResp && metricsResp.metric) || {};
      const rec = (recResp && recResp[0]) || {};
      const pt = ptResp || {};
      const price = quote && quote.c ? quote.c : null;
      const shares = profile?.shareOutstanding ? profile.shareOutstanding * 1e6 : null; // profile gives millions

      // ---------- technicals ----------
      let technical = null;
      if (candleResp && candleResp.s === "ok" && candleResp.c?.length > 50) {
        const c = candleResp.c;
        const sma = (n) => c.length >= n ? c.slice(-n).reduce((a,b)=>a+b,0)/n : null;
        const sma50 = sma(50), sma200 = sma(200);
        let g=0,l=0; for (let i=c.length-14;i<c.length;i++){const d=c[i]-c[i-1]; if(d>=0)g+=d; else l-=d;}
        const rsi = l===0?100:100-100/(1+g/l);
        const last=c[c.length-1], lo=Math.min(...c.slice(-60)), hi=Math.max(...c.slice(-60));
        const aboveBoth=sma50&&sma200&&last>sma50&&last>sma200, belowBoth=sma50&&sma200&&last<sma50&&last<sma200;
        technical={ signal:aboveBoth?"Bullish":belowBoth?"Bearish":"Neutral",
          trend:sma50&&sma200?(sma50>sma200?"Uptrend (50D > 200D)":"Downtrend (50D < 200D)"):"—",
          rsi:rsi?rsi.toFixed(1):null, sma50:sma50?`$${sma50.toFixed(2)}`:null, sma200:sma200?`$${sma200.toFixed(2)}`:null,
          support:`$${lo.toFixed(2)}`, resistance:`$${hi.toFixed(2)}` };
      }

      // ---------- DCF ----------
      // Macro consensus-style defaults (visible to the user, editable in code).
      const riskFree = 0.0425;            // 10Y treasury approx
      const equityRiskPremium = 0.055;    // long-run US ERP
      const beta = metric.beta != null ? metric.beta : 1.1;
      const costOfEquity = riskFree + beta * equityRiskPremium;
      const taxRate = 0.21;
      const inflation = 0.025;
      // forward rate path (rates expected to drift, not static)
      const ratePath = [riskFree, riskFree-0.0025, riskFree-0.0050, riskFree-0.0050, riskFree-0.0050];

      let dcf = null, ev = null;
      const cf0 = (Array.isArray(cashflow) ? cashflow[0] : cashflow) || null;
      const bs0 = (Array.isArray(balance) ? balance[0] : balance) || null;
      // FCF: prefer explicit field, else operating cash flow minus capex
      let fcfBase = cf0?.freeCashFlow ?? null;
      if (fcfBase == null && cf0) {
        const ocf = cf0.operatingCashFlow ?? cf0.netCashProvidedByOperatingActivities ?? null;
        const capex = cf0.capitalExpenditure ?? 0;
        if (ocf != null) fcfBase = ocf + capex; // capex is negative in FMP, so add
      }
      const totalDebt = bs0 ? (bs0.totalDebt ?? ((bs0.shortTermDebt||0)+(bs0.longTermDebt||0))) : null;
      const cashEq = bs0?.cashAndShortTermInvestments ?? bs0?.cashAndCashEquivalents ?? null;

      if (fcfBase && shares && price) {
        const debtWeight = totalDebt && (totalDebt + price*shares) ? totalDebt/(totalDebt + price*shares) : 0.15;
        const equityWeight = 1 - debtWeight;
        const costOfDebt = (riskFree + 0.015) * (1 - taxRate);
        const wacc = equityWeight*costOfEquity + debtWeight*costOfDebt;
        const ig0 = (Array.isArray(incomeGrowth) ? incomeGrowth[0] : incomeGrowth) || null;
        const rawGrowth = ig0?.freeCashFlowGrowth ?? ig0?.growthFreeCashFlow ?? null;
        const gGrowth = rawGrowth != null
          ? Math.max(0.02, Math.min(0.18, rawGrowth)) : 0.08;
        const terminalGrowth = 0.025;

        const project = (waccX, tgX) => {
          let pv=0, fcf=fcfBase;
          for (let yr=1; yr<=5; yr++){ fcf = fcf*(1+gGrowth*(1-(yr-1)*0.1)); pv += fcf/Math.pow(1+waccX,yr); }
          const fcf5 = fcf;
          const terminal = (fcf5*(1+tgX))/(waccX-tgX);
          pv += terminal/Math.pow(1+waccX,5);
          const equityVal = pv - (totalDebt||0) + (cashEq||0);
          return equityVal/shares;
        };

        const fair = project(wacc, terminalGrowth);
        // sensitivity table: WACC rows x terminal growth cols
        const waccRange = [wacc-0.01, wacc-0.005, wacc, wacc+0.005, wacc+0.01];
        const tgRange = [terminalGrowth-0.005, terminalGrowth, terminalGrowth+0.005];
        const sens = waccRange.map(w => ({
          wacc:(w*100).toFixed(2)+"%",
          vals: tgRange.map(g => `$${project(w,g).toFixed(0)}`)
        }));

        dcf = {
          fairValue:`$${fair.toFixed(2)}`,
          upside: price ? `${(((fair-price)/price)*100).toFixed(1)}%` : "—",
          assumptions: {
            riskFree:(riskFree*100).toFixed(2)+"%",
            erp:(equityRiskPremium*100).toFixed(2)+"%",
            beta:beta.toFixed(2),
            costOfEquity:(costOfEquity*100).toFixed(2)+"%",
            costOfDebt:(costOfDebt*100).toFixed(2)+"%",
            wacc:(wacc*100).toFixed(2)+"%",
            terminalGrowth:(terminalGrowth*100).toFixed(2)+"%",
            fcfGrowth:(gGrowth*100).toFixed(1)+"%",
            inflation:(inflation*100).toFixed(2)+"%",
            taxRate:(taxRate*100).toFixed(0)+"%",
            ratePath: ratePath.map(r=>(r*100).toFixed(2)+"%"),
          },
          sensitivity:{ tgCols:tgRange.map(g=>(g*100).toFixed(2)+"%"), rows:sens },
          fcfBase:`$${(fcfBase/1e9).toFixed(2)}B`,
        };
      }

      // ---------- EV valuation ----------
      const entObj = (Array.isArray(enterprise) ? enterprise[0] : enterprise) || null;
      const ratObj = (Array.isArray(ratios) ? ratios[0] : ratios) || null;
      const evNow = entObj?.enterpriseValue || (price&&shares ? price*shares + (totalDebt||0) - (cashEq||0) : null);
      const evEbitdaVal = ratObj?.enterpriseValueMultipleTTM ?? ratObj?.evToEBITDATTM ?? ratObj?.enterpriseValueOverEBITDATTM ?? null;
      if (evNow) {
        ev = {
          enterpriseValue:`$${(evNow/1e9).toFixed(1)}B`,
          evEbitda: evEbitdaVal != null ? evEbitdaVal.toFixed(1)+"x" : (metric["currentEv/ebitdaAnnual"]? metric["currentEv/ebitdaAnnual"].toFixed(1)+"x":"—"),
          evSales: metric["currentEv/salesAnnual"]? metric["currentEv/salesAnnual"].toFixed(1)+"x":"—",
        };
      }

      // ---------- consensus / price target ----------
      const consensus = pt.targetMean ? {
        mean:`$${pt.targetMean.toFixed(2)}`, high:pt.targetHigh?`$${pt.targetHigh.toFixed(2)}`:"—",
        low:pt.targetLow?`$${pt.targetLow.toFixed(2)}`:"—",
        upside: price&&pt.targetMean?`${(((pt.targetMean-price)/price)*100).toFixed(1)}%`:"—",
      } : null;

      // ---------- peers (clickable) ----------
      let peers = [];
      if (peersResp && Array.isArray(peersResp)) {
        peers = peersResp.filter(p=>p && p!==sym).slice(0,7).map(t=>({ ticker:t }));
      }

      return res.status(200).json({
        ticker:sym, companyName:profile?.name||sym, exchange:profile?.exchange||"—",
        sector:profile?.finnhubIndustry||"—", currency:profile?.currency||"USD", logo:profile?.logo||null,
        currentPrice: price?`$${price.toFixed(2)}`:"—",
        change: quote?.dp!=null?`${quote.dp>0?"+":""}${quote.dp.toFixed(2)}%`:"—",
        changeRaw: quote?.dp ?? null,
        marketCap: profile?.marketCapitalization?`$${(profile.marketCapitalization/1000).toFixed(1)}B`:"—",
        week52High: metric["52WeekHigh"]?`$${metric["52WeekHigh"].toFixed(2)}`:"—",
        week52Low: metric["52WeekLow"]?`$${metric["52WeekLow"].toFixed(2)}`:"—",
        ipo: profile?.ipo||"—",
        metrics:{
          pe: metric.peTTM?metric.peTTM.toFixed(1):metric.peBasicExclExtraTTM?metric.peBasicExclExtraTTM.toFixed(1):"—",
          ps: metric.psTTM?metric.psTTM.toFixed(1):"—",
          pb: metric.pbQuarterly?metric.pbQuarterly.toFixed(1):metric.pbAnnual?metric.pbAnnual.toFixed(1):"—",
          roe: metric.roeTTM?`${metric.roeTTM.toFixed(1)}%`:"—",
          netMargin: metric.netProfitMarginTTM?`${metric.netProfitMarginTTM.toFixed(1)}%`:"—",
          debtToEquity: metric["totalDebt/totalEquityQuarterly"]!=null?metric["totalDebt/totalEquityQuarterly"].toFixed(2):"—",
          dividendYield: metric.dividendYieldIndicatedAnnual!=null?`${metric.dividendYieldIndicatedAnnual.toFixed(2)}%`:"—",
          revenueGrowth: metric.revenueGrowthTTMYoy!=null?`${metric.revenueGrowthTTMYoy.toFixed(1)}%`:"—",
          beta: metric.beta!=null?metric.beta.toFixed(2):"—",
        },
        earnings:(earningsResp||[]).slice(0,4).reverse().map(e=>({ period:e.period,
          actual:e.actual!=null?`$${e.actual.toFixed(2)}`:"—", estimate:e.estimate!=null?`$${e.estimate.toFixed(2)}`:"—",
          beat: e.actual!=null&&e.estimate!=null?e.actual>=e.estimate:null })),
        analysts: rec.buy!=null?{ strongBuy:rec.strongBuy||0,buy:rec.buy||0,hold:rec.hold||0,sell:rec.sell||0,strongSell:rec.strongSell||0,period:rec.period||"" }:null,
        consensus, dcf, ev, peers,
        hasFMP: !!fmpKey,
      });
    }
    return res.status(400).json({ error:"Unknown mode" });
  } catch (e) {
    return res.status(500).json({ error:e.message });
  }
}
