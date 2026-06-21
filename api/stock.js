// api/stock.js — Meridian live data backend (Vercel serverless function)
//   FINNHUB_KEY -> quotes, profile, ratings, price targets, peers, candles
//   FMP_KEY     -> cash flow, balance sheet, ratios (confirmed working on free "stable" tier)
// All field names verified against live free-tier responses.

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
const arr0 = (x) => Array.isArray(x) ? x[0] : (x || null);

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

    // Lightweight per-peer snapshot (used to fill the comparables table)
    if (mode === "peer") {
      const sym = q.toUpperCase();
      const [profile, quote, metricsResp, ptResp] = await Promise.all([
        safe(fh(`/stock/profile2?symbol=${sym}`, fhKey)),
        safe(fh(`/quote?symbol=${sym}`, fhKey)),
        safe(fh(`/stock/metric?symbol=${sym}&metric=all`, fhKey)),
        safe(fh(`/stock/price-target?symbol=${sym}`, fhKey)),
      ]);
      const m = (metricsResp && metricsResp.metric) || {};
      const price = quote?.c || null;
      let ratios = null;
      if (fmpKey) ratios = arr0(await safe(fmp(`/ratios-ttm?symbol=${sym}`, fmpKey)));
      const eps = ratios?.netIncomePerShareTTM ?? m.epsTTM ?? null;
      const salesPS = ratios?.revenuePerShareTTM ?? null;
      const sharesOut = profile?.shareOutstanding ? profile.shareOutstanding*1e6 : null;
      const sales = salesPS && sharesOut ? salesPS*sharesOut : null;
      return res.status(200).json({
        ticker: sym,
        name: profile?.name || sym,
        sic: profile?.naics || profile?.sic || profile?.finnhubIndustry || "—",
        price: price ? `$${price.toFixed(2)}` : "—",
        sales: sales ? `$${(sales/1e9).toFixed(1)}B` : "—",
        marketCap: profile?.marketCapitalization ? `$${(profile.marketCapitalization/1000).toFixed(1)}B` : "—",
        eps: eps != null ? `$${eps.toFixed(2)}` : "—",
        target: ptResp?.targetMean ? `$${ptResp.targetMean.toFixed(2)}` : "—",
      });
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

      // FMP fundamentals — only the three confirmed-working endpoints
      let cashflow = null, balance = null, ratios = null;
      if (fmpKey) {
        [cashflow, balance, ratios] = await Promise.all([
          safe(fmp(`/cash-flow-statement?symbol=${sym}&limit=5`, fmpKey)),
          safe(fmp(`/balance-sheet-statement?symbol=${sym}&limit=1`, fmpKey)),
          safe(fmp(`/ratios-ttm?symbol=${sym}`, fmpKey)),
        ]);
      }

      const metric = (metricsResp && metricsResp.metric) || {};
      const rec = (recResp && recResp[0]) || {};
      const pt = ptResp || {};
      const price = quote?.c || null;
      const shares = profile?.shareOutstanding ? profile.shareOutstanding*1e6 : null;
      const rat = arr0(ratios);

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
      const riskFree = 0.0425, equityRiskPremium = 0.055, taxRate = 0.21, inflation = 0.025;
      const beta = metric.beta != null ? metric.beta : 1.1;
      const costOfEquity = riskFree + beta*equityRiskPremium;
      const ratePath = [riskFree, riskFree-0.0025, riskFree-0.0050, riskFree-0.0050, riskFree-0.0050];

      let dcf = null, dcfError = null;
      const cfList = Array.isArray(cashflow) ? cashflow : (cashflow ? [cashflow] : []);
      const cf0 = cfList[0] || null;
      const bs0 = arr0(balance);

      let fcfBase = cf0?.freeCashFlow ?? null;
      if (fcfBase == null && cf0?.operatingCashFlow != null) fcfBase = cf0.operatingCashFlow + (cf0.capitalExpenditure || 0);
      const totalDebt = bs0?.totalDebt ?? null;
      const cashEq = bs0?.cashAndShortTermInvestments ?? bs0?.cashAndCashEquivalents ?? null;

      // historical FCF growth (from the 5 years of cash-flow data), blended with analyst rev growth
      let histGrowth = null;
      if (cfList.length >= 2) {
        const fcfs = cfList.map(c => c.freeCashFlow).filter(v => v != null);
        if (fcfs.length >= 2) {
          const newest = fcfs[0], oldest = fcfs[fcfs.length-1], yrs = fcfs.length-1;
          if (oldest > 0 && newest > 0) histGrowth = Math.pow(newest/oldest, 1/yrs)-1;
        }
      }
      const analystRevG = metric.revenueGrowthTTMYoy != null ? metric.revenueGrowthTTMYoy/100 : null;
      // Blend: lean on forward analyst signal where available, floor at 4% so mature names aren't punished to absurdity
      let blended = [histGrowth, analystRevG].filter(v => v != null);
      let growthEst = blended.length ? blended.reduce((a,b)=>a+b,0)/blended.length : 0.08;
      growthEst = Math.max(0.04, Math.min(0.16, growthEst));

      if (!fmpKey) dcfError = "no_key";
      else if (!fcfBase || !shares || !price) dcfError = "no_data";
      else {
        const debtWeight = totalDebt && (totalDebt + price*shares) ? totalDebt/(totalDebt + price*shares) : 0.12;
        const equityWeight = 1 - debtWeight;
        const costOfDebt = (riskFree + 0.012) * (1 - taxRate);
        const wacc = equityWeight*costOfEquity + debtWeight*costOfDebt;
        const gGrowth = growthEst, terminalGrowth = 0.03;

        const project = (waccX, tgX) => {
          let pv=0, fcf=fcfBase;
          for (let yr=1; yr<=5; yr++){ fcf = fcf*(1+gGrowth*(1-(yr-1)*0.12)); pv += fcf/Math.pow(1+waccX,yr); }
          const terminal = (fcf*(1+tgX))/(waccX-tgX);
          pv += terminal/Math.pow(1+waccX,5);
          return (pv - (totalDebt||0) + (cashEq||0))/shares;
        };
        const fair = project(wacc, terminalGrowth);
        const waccRange = [wacc-0.01, wacc-0.005, wacc, wacc+0.005, wacc+0.01];
        const tgRange = [terminalGrowth-0.005, terminalGrowth, terminalGrowth+0.005];

        dcf = {
          fairValue:`$${fair.toFixed(2)}`,
          upside: price ? `${(((fair-price)/price)*100).toFixed(1)}%` : "—",
          assumptions:{
            riskFree:(riskFree*100).toFixed(2)+"%", erp:(equityRiskPremium*100).toFixed(2)+"%", beta:beta.toFixed(2),
            costOfEquity:(costOfEquity*100).toFixed(2)+"%", costOfDebt:(costOfDebt*100).toFixed(2)+"%", wacc:(wacc*100).toFixed(2)+"%",
            terminalGrowth:(terminalGrowth*100).toFixed(2)+"%", fcfGrowth:(gGrowth*100).toFixed(1)+"%",
            inflation:(inflation*100).toFixed(2)+"%", taxRate:(taxRate*100).toFixed(0)+"%",
            ratePath: ratePath.map(r=>(r*100).toFixed(2)+"%"),
          },
          sensitivity:{ tgCols:tgRange.map(g=>(g*100).toFixed(2)+"%"),
            rows: waccRange.map(w=>({ wacc:(w*100).toFixed(2)+"%", vals: tgRange.map(g=>`$${project(w,g).toFixed(0)}`) })) },
          fcfBase:`$${(fcfBase/1e9).toFixed(2)}B`,
        };
      }

      // ---------- EV valuation (compute EV/Sales ourselves) ----------
      let ev = null;
      const evVal = rat?.enterpriseValueTTM ?? null;
      const evMultiple = rat?.enterpriseValueMultipleTTM ?? null;
      const revPS = rat?.revenuePerShareTTM ?? null;
      const revenue = revPS && shares ? revPS*shares : null;
      const evFallback = price && shares ? price*shares + (totalDebt||0) - (cashEq||0) : null;
      const evFinal = evVal || evFallback;
      if (evFinal) {
        ev = {
          enterpriseValue:`$${(evFinal/1e9).toFixed(1)}B`,
          evEbitda: evMultiple != null ? evMultiple.toFixed(1)+"x" : "—",
          evSales: (evVal && revenue) ? (evVal/revenue).toFixed(1)+"x" : "—",
        };
      }

      // ---------- consensus / price target (with source + date) ----------
      const consensus = pt.targetMean ? {
        mean:`$${pt.targetMean.toFixed(2)}`, high:pt.targetHigh?`$${pt.targetHigh.toFixed(2)}`:"—",
        low:pt.targetLow?`$${pt.targetLow.toFixed(2)}`:"—",
        median:pt.targetMedian?`$${pt.targetMedian.toFixed(2)}`:"—",
        upside: price&&pt.targetMean?`${(((pt.targetMean-price)/price)*100).toFixed(1)}%`:"—",
        analystCount: pt.numberOfAnalysts || pt.numberAnalysts || null,
        asOf: pt.lastUpdated ? pt.lastUpdated.split("T")[0] : null,
        source: "Finnhub aggregated consensus",
      } : null;

      // ---------- peers (tickers only; table filled client-side) ----------
      let peers = [];
      if (Array.isArray(peersResp)) peers = peersResp.filter(p=>p && p!==sym).slice(0,7).map(t=>({ticker:t}));

      return res.status(200).json({
        ticker:sym, companyName:profile?.name||sym, exchange:profile?.exchange||"—",
        sector:profile?.finnhubIndustry||"—", naics: profile?.naics||null, sic: profile?.sic||null,
        currency:profile?.currency||"USD", logo:profile?.logo||null,
        currentPrice: price?`$${price.toFixed(2)}`:"—",
        change: quote?.dp!=null?`${quote.dp>0?"+":""}${quote.dp.toFixed(2)}%`:"—", changeRaw: quote?.dp ?? null,
        marketCap: profile?.marketCapitalization?`$${(profile.marketCapitalization/1000).toFixed(1)}B`:"—",
        week52High: metric["52WeekHigh"]?`$${metric["52WeekHigh"].toFixed(2)}`:"—",
        week52Low: metric["52WeekLow"]?`$${metric["52WeekLow"].toFixed(2)}`:"—",
        ipo: profile?.ipo||"—",
        metrics:{
          pe: rat?.priceToEarningsRatioTTM?rat.priceToEarningsRatioTTM.toFixed(1):(metric.peTTM?metric.peTTM.toFixed(1):"—"),
          ps: rat?.priceToSalesRatioTTM?rat.priceToSalesRatioTTM.toFixed(1):(metric.psTTM?metric.psTTM.toFixed(1):"—"),
          pb: rat?.priceToBookRatioTTM?rat.priceToBookRatioTTM.toFixed(1):"—",
          roe: rat?.returnOnEquityTTM?`${(rat.returnOnEquityTTM*100).toFixed(1)}%`:(metric.roeTTM?`${metric.roeTTM.toFixed(1)}%`:"—"),
          netMargin: rat?.netProfitMarginTTM?`${(rat.netProfitMarginTTM*100).toFixed(1)}%`:"—",
          debtToEquity: rat?.debtToEquityRatioTTM!=null?rat.debtToEquityRatioTTM.toFixed(2):"—",
          dividendYield: rat?.dividendYieldTTM!=null?`${(rat.dividendYieldTTM*100).toFixed(2)}%`:"—",
          revenueGrowth: metric.revenueGrowthTTMYoy!=null?`${metric.revenueGrowthTTMYoy.toFixed(1)}%`:"—",
          beta: metric.beta!=null?metric.beta.toFixed(2):"—",
          eps: rat?.netIncomePerShareTTM!=null?`$${rat.netIncomePerShareTTM.toFixed(2)}`:"—",
        },
        earnings:(earningsResp||[]).slice(0,4).reverse().map(e=>({ period:e.period,
          actual:e.actual!=null?`$${e.actual.toFixed(2)}`:"—", estimate:e.estimate!=null?`$${e.estimate.toFixed(2)}`:"—",
          beat: e.actual!=null&&e.estimate!=null?e.actual>=e.estimate:null })),
        analysts: rec.buy!=null?{ strongBuy:rec.strongBuy||0,buy:rec.buy||0,hold:rec.hold||0,sell:rec.sell||0,strongSell:rec.strongSell||0,period:rec.period||"" }:null,
        consensus, dcf, dcfError, ev, peers, hasFMP: !!fmpKey,
      });
    }
    return res.status(400).json({ error:"Unknown mode" });
  } catch (e) {
    return res.status(500).json({ error:e.message });
  }
}
