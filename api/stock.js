// api/stock.js
// Serverless function that runs on Vercel. It talks to Finnhub using your
// secret API key (stored safely in Vercel settings, never in the browser),
// gathers live data, and returns it to the page as clean JSON.

const FINNHUB = "https://finnhub.io/api/v1";

async function fh(path, key) {
  const res = await fetch(`${FINNHUB}${path}${path.includes("?") ? "&" : "?"}token=${key}`);
  if (!res.ok) throw new Error(`Finnhub ${res.status} on ${path.split("?")[0]}`);
  return res.json();
}

export default async function handler(req, res) {
  const key = process.env.FINNHUB_KEY;
  if (!key) {
    return res.status(500).json({ error: "Server is missing FINNHUB_KEY. Add it in Vercel → Settings → Environment Variables." });
  }

  const mode = req.query.mode || "search";
  const q = (req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "Missing query" });

  try {
    // ---- SEARCH: company name or ticker -> list of matches for the dropdown
    if (mode === "search") {
      const data = await fh(`/search?q=${encodeURIComponent(q)}`, key);
      const results = (data.result || [])
        .filter((r) => r.type === "Common Stock" || r.type === "" || !r.type)
        .slice(0, 8)
        .map((r) => ({
          name: r.description,
          ticker: r.symbol,
          exchange: r.displaySymbol && r.displaySymbol.includes(".") ? r.displaySymbol.split(".")[1] : "US",
        }));
      return res.status(200).json({ results });
    }

    // ---- ANALYZE: pull everything we can for one ticker
    if (mode === "analyze") {
      const sym = q.toUpperCase();

      // Fire requests in parallel. Some may fail on the free tier; we handle gaps.
      const safe = (p) => p.catch(() => null);
      const [profile, quote, metricsResp, recResp, ptResp, earningsResp, candleResp] = await Promise.all([
        safe(fh(`/stock/profile2?symbol=${sym}`, key)),
        safe(fh(`/quote?symbol=${sym}`, key)),
        safe(fh(`/stock/metric?symbol=${sym}&metric=all`, key)),
        safe(fh(`/stock/recommendation?symbol=${sym}`, key)),
        safe(fh(`/stock/price-target?symbol=${sym}`, key)),
        safe(fh(`/stock/earnings?symbol=${sym}`, key)),
        safe(fh(`/stock/candle?symbol=${sym}&resolution=D&count=250`, key)),
      ]);

      const metric = (metricsResp && metricsResp.metric) || {};
      const rec = (recResp && recResp[0]) || {};
      const pt = ptResp || {};
      const price = quote && quote.c ? quote.c : null;

      // Simple technical signals from daily candles (free-tier friendly math)
      let technical = null;
      if (candleResp && candleResp.s === "ok" && Array.isArray(candleResp.c) && candleResp.c.length > 50) {
        const closes = candleResp.c;
        const sma = (arr, n) => {
          if (arr.length < n) return null;
          const slice = arr.slice(-n);
          return slice.reduce((a, b) => a + b, 0) / n;
        };
        const sma50 = sma(closes, 50);
        const sma200 = sma(closes, 200);
        // RSI (14)
        let gains = 0, losses = 0;
        for (let i = closes.length - 14; i < closes.length; i++) {
          const diff = closes[i] - closes[i - 1];
          if (diff >= 0) gains += diff; else losses -= diff;
        }
        const rs = losses === 0 ? 100 : gains / losses;
        const rsi = 100 - 100 / (1 + rs);
        const last = closes[closes.length - 1];
        const recentLow = Math.min(...closes.slice(-60));
        const recentHigh = Math.max(...closes.slice(-60));

        const aboveBoth = sma50 && sma200 && last > sma50 && last > sma200;
        const belowBoth = sma50 && sma200 && last < sma50 && last < sma200;
        technical = {
          signal: aboveBoth ? "Bullish" : belowBoth ? "Bearish" : "Neutral",
          trend: sma50 && sma200 ? (sma50 > sma200 ? "Uptrend (50D > 200D)" : "Downtrend (50D < 200D)") : "—",
          rsi: rsi ? rsi.toFixed(1) : null,
          sma50: sma50 ? `$${sma50.toFixed(2)}` : null,
          sma200: sma200 ? `$${sma200.toFixed(2)}` : null,
          support: `$${recentLow.toFixed(2)}`,
          resistance: `$${recentHigh.toFixed(2)}`,
        };
      }

      const out = {
        ticker: sym,
        companyName: profile?.name || sym,
        exchange: profile?.exchange || "—",
        sector: profile?.finnhubIndustry || "—",
        currency: profile?.currency || "USD",
        logo: profile?.logo || null,
        currentPrice: price ? `$${price.toFixed(2)}` : "—",
        change: quote?.dp != null ? `${quote.dp > 0 ? "+" : ""}${quote.dp.toFixed(2)}%` : "—",
        marketCap: profile?.marketCapitalization ? `$${(profile.marketCapitalization / 1000).toFixed(1)}B` : "—",
        week52High: metric["52WeekHigh"] ? `$${metric["52WeekHigh"].toFixed(2)}` : "—",
        week52Low: metric["52WeekLow"] ? `$${metric["52WeekLow"].toFixed(2)}` : "—",
        ipo: profile?.ipo || "—",
        metrics: {
          pe: metric.peTTM ? metric.peTTM.toFixed(1) : metric.peBasicExclExtraTTM ? metric.peBasicExclExtraTTM.toFixed(1) : "—",
          ps: metric.psTTM ? metric.psTTM.toFixed(1) : "—",
          pb: metric.pbQuarterly ? metric.pbQuarterly.toFixed(1) : metric.pbAnnual ? metric.pbAnnual.toFixed(1) : "—",
          roe: metric.roeTTM ? `${metric.roeTTM.toFixed(1)}%` : "—",
          netMargin: metric.netProfitMarginTTM ? `${metric.netProfitMarginTTM.toFixed(1)}%` : "—",
          debtToEquity: metric["totalDebt/totalEquityQuarterly"] != null ? metric["totalDebt/totalEquityQuarterly"].toFixed(2) : "—",
          dividendYield: metric.dividendYieldIndicatedAnnual != null ? `${metric.dividendYieldIndicatedAnnual.toFixed(2)}%` : "—",
          revenueGrowth: metric.revenueGrowthTTMYoy != null ? `${metric.revenueGrowthTTMYoy.toFixed(1)}%` : "—",
          beta: metric.beta != null ? metric.beta.toFixed(2) : "—",
        },
        earnings: (earningsResp || []).slice(0, 4).reverse().map((e) => ({
          period: e.period,
          actual: e.actual != null ? `$${e.actual.toFixed(2)}` : "—",
          estimate: e.estimate != null ? `$${e.estimate.toFixed(2)}` : "—",
          beat: e.actual != null && e.estimate != null ? e.actual >= e.estimate : null,
        })),
        analysts: rec.buy != null ? {
          strongBuy: rec.strongBuy || 0,
          buy: rec.buy || 0,
          hold: rec.hold || 0,
          sell: rec.sell || 0,
          strongSell: rec.strongSell || 0,
          period: rec.period || "",
        } : null,
        priceTarget: pt.targetMean ? {
          mean: `$${pt.targetMean.toFixed(2)}`,
          high: pt.targetHigh ? `$${pt.targetHigh.toFixed(2)}` : "—",
          low: pt.targetLow ? `$${pt.targetLow.toFixed(2)}` : "—",
          upside: price && pt.targetMean ? `${(((pt.targetMean - price) / price) * 100).toFixed(1)}%` : "—",
        } : null,
        technical,
      };

      return res.status(200).json(out);
    }

    return res.status(400).json({ error: "Unknown mode" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
