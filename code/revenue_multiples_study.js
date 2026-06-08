#!/usr/bin/env node
/**
 * =====================================================================================
 *  Does Revenue Back Valuation?
 *  Protocol Revenue Multiples and the Cross-Section of Token Returns in DeFi
 * =====================================================================================
 *
 *  Single-file Node.js (v18+) data collector + analyzer. No paid keys required.
 *
 *  DATA SOURCES (all free):
 *    - DefiLlama  /overview/fees                 -> fees per protocol (whole universe, 1 call)
 *    - DefiLlama  /overview/fees?dataType=...     -> revenue per protocol (1 call)
 *    - DefiLlama  /protocols                      -> mcap + gecko_id + category (1 call)
 *    - DefiLlama  /summary/fees/{slug}?dataType   -> daily revenue history (per token, keyless)
 *    - CoinGecko  /coins/{id}/market_chart        -> price + mcap history (per token, rate-limited)
 *
 *  OUTPUTS (written to ./output/):
 *    - universe_fundamentals.csv   full cross-sectional snapshot (every protocol w/ mcap)
 *    - factor_test.csv             per-token point-in-time multiple + forward return
 *    - results_summary.json        every computed statistic (for the paper)
 *    - run_log.txt                 dropped/failed tokens (survivorship + data-gap audit)
 *
 *  Phase 1 (fundamentals) uses 3 bulk calls and is bulletproof.
 *  Phase 2 (forward returns) is rate-limit-aware, cached, and resumable.
 *
 *  Optional: set COINGECKO_API_KEY (free "demo" key) to raise the rate limit.
 *      COINGECKO_API_KEY=xxxx node revenue_multiples_study.js
 * =====================================================================================
 */

'use strict';
const fs = require('fs');
const path = require('path');

// ------------------------------------------------------------------ CONFIG
const CFG = {
  T0_DAYS_BACK:        365,     // formation date for the forward-return test
  MIN_DAYS_HELD:       300,     // require ~full year of history for the main factor result
  MAX_FACTOR_TOKENS:   1000,    // safety cap on Phase-2 universe (we expect ~350)
  N_QUANTILES:         5,       // quintile sort
  WINSOR:              0.025,   // winsorize forward returns at 2.5% / 97.5%
  MIN_CAT_COUNT:       5,       // min protocols to report a category breakdown
  REV_THRESHOLDS:      [0, 100_000, 1_000_000], // "no fundamental backing" census cutoffs (annualized USD)
  CG_DELAY_MS:         process.env.COINGECKO_API_KEY ? 2200 : 5000, // throttle CoinGecko (keyless is slow)
  DL_DELAY_MS:         120,     // gentle throttle on DefiLlama per-token calls
  MAX_RETRIES:         5,
  CG_API_KEY:          process.env.COINGECKO_API_KEY || null,
  OUT_DIR:             path.join(process.cwd(), 'output'),
  CACHE_DIR:           path.join(process.cwd(), 'cache'),
};

const DL = 'https://api.llama.fi';
const CG = 'https://api.coingecko.com/api/v3';
const DAY = 86400; // seconds

// ------------------------------------------------------------------ UTIL: fs + log
for (const d of [CFG.OUT_DIR, CFG.CACHE_DIR]) fs.mkdirSync(d, { recursive: true });
const logLines = [];
function log(msg) { const s = `[${new Date().toISOString()}] ${msg}`; console.log(s); logLines.push(s); }
function flushLog() { fs.writeFileSync(path.join(CFG.OUT_DIR, 'run_log.txt'), logLines.join('\n')); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------------ UTIL: robust fetch w/ cache
async function getJSON(url, { headers = {}, cacheKey = null, retries = CFG.MAX_RETRIES } = {}) {
  if (cacheKey) {
    const f = path.join(CFG.CACHE_DIR, cacheKey + '.json');
    if (fs.existsSync(f)) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {} }
  }
  let attempt = 0;
  while (true) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'tokenomics-research/1.0', ...headers } });
      if (res.status === 429 || res.status >= 500) {
        const ra = parseInt(res.headers.get('retry-after') || '0', 10);
        const wait = ra ? ra * 1000 : Math.min(60000, 1500 * 2 ** attempt);
        if (++attempt > retries) throw new Error(`HTTP ${res.status} after ${retries} retries`);
        log(`  ! ${res.status} on ${shortUrl(url)} — backing off ${Math.round(wait / 1000)}s (try ${attempt})`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (cacheKey) fs.writeFileSync(path.join(CFG.CACHE_DIR, cacheKey + '.json'), JSON.stringify(data));
      return data;
    } catch (e) {
      if (++attempt > retries) throw e;
      await sleep(Math.min(30000, 1000 * 2 ** attempt));
    }
  }
}
const shortUrl = (u) => u.replace(/^https?:\/\//, '').slice(0, 70);

// ------------------------------------------------------------------ UTIL: statistics
const num = (x) => (typeof x === 'number' && isFinite(x)) ? x : null;
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q, base = Math.floor(pos), rest = pos - base;
  return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base];
}
const median = (a) => quantile([...a].sort((x, y) => x - y), 0.5);
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
function trimmedMean(a, p = 0.1) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), k = Math.floor(s.length * p);
  const t = s.slice(k, s.length - k);
  return t.length ? mean(t) : mean(s);
}
function describe(arr) {
  const a = arr.filter(x => num(x) !== null);
  if (!a.length) return { n: 0 };
  const s = [...a].sort((x, y) => x - y);
  return {
    n: a.length, mean: mean(a), trimmedMean: trimmedMean(a),
    p10: quantile(s, 0.1), p25: quantile(s, 0.25), median: quantile(s, 0.5),
    p75: quantile(s, 0.75), p90: quantile(s, 0.9), min: s[0], max: s[s.length - 1],
  };
}
function winsorize(arr, p) {
  const a = arr.filter(x => num(x) !== null), s = [...a].sort((x, y) => x - y);
  const lo = quantile(s, p), hi = quantile(s, 1 - p);
  return a.map(x => Math.min(hi, Math.max(lo, x)));
}
function gini(values) {
  const a = values.filter(x => num(x) !== null && x >= 0).sort((x, y) => x - y);
  const n = a.length; if (!n) return null;
  const tot = a.reduce((s, x) => s + x, 0); if (tot === 0) return 0;
  let cum = 0; for (let i = 0; i < n; i++) cum += (i + 1) * a[i];
  return (2 * cum) / (n * tot) - (n + 1) / n;
}
function rank(arr) { // average ranks (handles ties)
  const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(arr.length); let i = 0;
  while (i < idx.length) {
    let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
    i = j + 1;
  }
  return r;
}
function spearman(x, y) {
  const n = x.length; if (n < 3) return { rho: null, t: null, n };
  const rx = rank(x), ry = rank(y), mx = mean(rx), my = mean(ry);
  let num_ = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num_ += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
  const rho = num_ / Math.sqrt(dx * dy);
  const t = rho * Math.sqrt((n - 2) / (1 - rho * rho));
  return { rho, t, n }; // |t|>~1.96 ~ p<0.05
}
const fmtPct = (x) => x == null ? 'n/a' : (x * 100).toFixed(1) + '%';
const fmtX = (x) => x == null ? 'n/a' : x.toFixed(1) + 'x';
const fmtUsd = (x) => x == null ? 'n/a' : '$' + Math.round(x).toLocaleString('en-US');

// ------------------------------------------------------------------ CSV writer
function writeCSV(file, rows, cols) {
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const out = [cols.join(',')].concat(rows.map(r => cols.map(c => esc(r[c])).join(',')));
  fs.writeFileSync(path.join(CFG.OUT_DIR, file), out.join('\n'));
}

// ================================================================== PHASE 0: BULK FETCH
async function buildUniverse() {
  log('PHASE 0  Fetching bulk datasets from DefiLlama (3 calls)…');
  const [feesOv, revOv, protocols] = await Promise.all([
    getJSON(`${DL}/overview/fees`, { cacheKey: 'overview_fees' }),
    getJSON(`${DL}/overview/fees?dataType=dailyRevenue`, { cacheKey: 'overview_revenue' }),
    getJSON(`${DL}/protocols`, { cacheKey: 'protocols' }),
  ]);

  const protBySlug = new Map();
  for (const p of protocols) if (p.slug) protBySlug.set(p.slug, p);

  const revBySlug = new Map();
  for (const r of revOv.protocols) if (r.slug) revBySlug.set(r.slug, r);

  // annualize: prefer trailing-year total; else annualize the 30d figure
  const annual = (rec) => {
    if (!rec) return null;
    if (num(rec.total1y) && rec.total1y > 0) return { v: rec.total1y, method: '1y' };
    if (num(rec.total30d) && rec.total30d > 0) return { v: rec.total30d * 365 / 30, method: '30d_annualized' };
    return { v: 0, method: 'zero' };
  };

  const universe = [];
  for (const f of feesOv.protocols) {
    const p = protBySlug.get(f.slug);
    const r = revBySlug.get(f.slug);
    const fA = annual(f), rA = annual(r);
    universe.push({
      name: f.name, slug: f.slug, symbol: p?.symbol || null,
      category: f.category || p?.category || 'Unknown',
      gecko_id: p?.gecko_id || null,
      mcap: num(p?.mcap),
      annualFees: fA ? fA.v : 0, feesMethod: fA ? fA.method : 'none',
      annualRevenue: rA ? rA.v : 0, revMethod: rA ? rA.method : 'none',
      fees30d: num(f.total30d) || 0, rev30d: num(r?.total30d) || 0,
    });
  }
  log(`PHASE 0  ${universe.length} protocols w/ fee data; ${universe.filter(u => u.mcap > 0).length} carry a market cap; ${universe.filter(u => u.gecko_id).length} have a gecko_id.`);
  return universe;
}

// ================================================================== PHASE 1: CROSS-SECTIONAL FUNDAMENTALS
function phase1(universe) {
  log('PHASE 1  Cross-sectional valuation-multiple analysis…');
  const priced = universe.filter(u => u.mcap > 0); // the investable universe

  for (const u of priced) {
    u.pf = u.annualFees > 0 ? u.mcap / u.annualFees : null;       // price / fees
    u.ps = u.annualRevenue > 0 ? u.mcap / u.annualRevenue : null; // price / revenue (the headline multiple)
    u.revYield = u.mcap > 0 ? u.annualRevenue / u.mcap : null;    // revenue / mcap
  }

  // overall multiple distributions (only where a positive multiple exists)
  const psAll = priced.map(u => u.ps).filter(x => num(x));
  const pfAll = priced.map(u => u.pf).filter(x => num(x));

  // "no fundamental backing" census — by count and by aggregate market cap
  const totMcap = priced.reduce((s, u) => s + u.mcap, 0);
  const census = CFG.REV_THRESHOLDS.map(thr => {
    const below = priced.filter(u => u.annualRevenue <= thr);
    return {
      thresholdUsd: thr,
      countBelow: below.length, pctCount: below.length / priced.length,
      mcapBelow: below.reduce((s, u) => s + u.mcap, 0),
      pctMcap: below.reduce((s, u) => s + u.mcap, 0) / totMcap,
    };
  });

  // category breakdown
  const byCat = {};
  for (const u of priced) (byCat[u.category] ||= []).push(u);
  const categories = Object.entries(byCat)
    .filter(([, arr]) => arr.length >= CFG.MIN_CAT_COUNT)
    .map(([cat, arr]) => ({
      category: cat, nPriced: arr.length,
      nWithRevenue: arr.filter(u => u.annualRevenue > 0).length,
      totalMcap: arr.reduce((s, u) => s + u.mcap, 0),
      totalRevenue: arr.reduce((s, u) => s + u.annualRevenue, 0),
      psStats: describe(arr.map(u => u.ps)),
      medianRevYield: median(arr.map(u => u.revYield).filter(x => num(x))),
    }))
    .sort((a, b) => b.totalMcap - a.totalMcap);

  // aggregate ("market-cap weighted") multiples
  const totRev = priced.reduce((s, u) => s + u.annualRevenue, 0);
  const totFees = priced.reduce((s, u) => s + u.annualFees, 0);

  // revenue concentration
  const revs = priced.map(u => u.annualRevenue).filter(x => x > 0).sort((a, b) => b - a);
  const top10share = revs.slice(0, 10).reduce((s, x) => s + x, 0) / revs.reduce((s, x) => s + x, 0);

  const fundamentals = {
    nUniverseWithFees: universe.length,
    nPriced: priced.length,
    nPricedWithRevenue: priced.filter(u => u.annualRevenue > 0).length,
    aggregate: {
      totalMcap: totMcap, totalAnnualRevenue: totRev, totalAnnualFees: totFees,
      marketPF: totFees > 0 ? totMcap / totFees : null,
      marketPS: totRev > 0 ? totMcap / totRev : null,
    },
    psDistribution: describe(psAll),
    pfDistribution: describe(pfAll),
    revYieldDistribution: describe(priced.map(u => u.revYield).filter(x => num(x))),
    noBackingCensus: census,
    revenueConcentration: { top10Share: top10share, giniAcrossPriced: gini(priced.map(u => u.annualRevenue)) },
    categories,
  };

  // dump the full cross-sectional table
  writeCSV('universe_fundamentals.csv', priced.sort((a, b) => (b.mcap) - (a.mcap)), [
    'name', 'symbol', 'slug', 'category', 'gecko_id', 'mcap',
    'annualRevenue', 'annualFees', 'ps', 'pf', 'revYield', 'revMethod', 'feesMethod',
  ]);

  // console summary
  log(`  Investable universe (mcap>0): ${priced.length}; with positive revenue: ${fundamentals.nPricedWithRevenue}`);
  log(`  Median P/S: ${fmtX(fundamentals.psDistribution.median)} | Median P/F: ${fmtX(fundamentals.pfDistribution.median)}`);
  log(`  Market-aggregate P/S: ${fmtX(fundamentals.aggregate.marketPS)} | P/F: ${fmtX(fundamentals.aggregate.marketPF)}`);
  for (const c of census)
    log(`  Revenue <= ${fmtUsd(c.thresholdUsd)}: ${(c.pctCount * 100).toFixed(0)}% of tokens, ${(c.pctMcap * 100).toFixed(0)}% of market cap`);
  log(`  Revenue concentration: top-10 protocols = ${fmtPct(top10share)} of all revenue (Gini ${fundamentals.revenueConcentration.giniAcrossPriced?.toFixed(2)})`);

  return { fundamentals, priced };
}

// ================================================================== PHASE 2: FORWARD-RETURN FACTOR TEST
async function fetchMarketChart(geckoId) {
  const headers = CFG.CG_API_KEY ? { 'x-cg-demo-api-key': CFG.CG_API_KEY } : {};
  const url = `${CG}/coins/${geckoId}/market_chart?vs_currency=usd&days=${CFG.T0_DAYS_BACK}&interval=daily`;
  const d = await getJSON(url, { headers, cacheKey: `cg_${geckoId}` });
  if (!d.prices || d.prices.length < 2) return null;
  return d; // {prices:[[ms,price]], market_caps:[[ms,mcap]], total_volumes:[...]}
}
async function fetchRevenueHistory(slug) {
  const d = await getJSON(`${DL}/summary/fees/${slug}?dataType=dailyRevenue`, { cacheKey: `dlrev_${slug}` });
  return Array.isArray(d.totalDataChart) ? d.totalDataChart : []; // [[sec, value]]
}
function trailingSum(chart, endSec, windowDays) {
  const startSec = endSec - windowDays * DAY;
  let s = 0;
  for (const [ts, v] of chart) if (ts > startSec && ts <= endSec && num(v)) s += v;
  return s;
}

async function phase2(priced) {
  log('PHASE 2  Forward-return value-factor test (point-in-time multiples)…');
  const candidates = priced
    .filter(u => u.gecko_id && u.annualRevenue > 0)   // need a price feed + a sortable fundamental
    .sort((a, b) => b.mcap - a.mcap)
    .slice(0, CFG.MAX_FACTOR_TOKENS);
  log(`  Phase-2 candidate tokens: ${candidates.length} (this is the rate-limited part)`);

  const rows = [];
  let done = 0, dropped = 0;
  for (const u of candidates) {
    done++;
    if (done % 25 === 0) log(`  …${done}/${candidates.length} processed (${dropped} dropped)`);
    try {
      const chart = await fetchMarketChart(u.gecko_id);
      if (!chart) { dropped++; logLines.push(`  drop ${u.name}: no price history`); continue; }
      const p0 = chart.prices[0], pN = chart.prices[chart.prices.length - 1];
      const m0 = chart.market_caps?.[0];
      const t0Sec = Math.round(p0[0] / 1000), tNSec = Math.round(pN[0] / 1000);
      const daysHeld = Math.round((tNSec - t0Sec) / DAY);
      const price0 = num(p0[1]), priceN = num(pN[1]), mcap0 = num(m0?.[1]);
      if (!price0 || !priceN || !mcap0) { dropped++; logLines.push(`  drop ${u.name}: missing p0/pN/mcap0`); continue; }

      await sleep(CFG.DL_DELAY_MS);
      const revChart = await fetchRevenueHistory(u.slug);
      const rev0 = trailingSum(revChart, t0Sec, 365);    // trailing-12m revenue AS OF T0 (no lookahead)
      if (rev0 <= 0) { dropped++; logLines.push(`  drop ${u.name}: no revenue@T0`); continue; }

      const ps0 = mcap0 / rev0;                          // formation-date P/S  (the sort variable)
      const fwdReturn = priceN / price0 - 1;             // forward total price return
      rows.push({
        name: u.name, symbol: u.symbol, slug: u.slug, category: u.category, gecko_id: u.gecko_id,
        t0: new Date(t0Sec * 1000).toISOString().slice(0, 10), daysHeld,
        mcap0, rev0, ps0, price0, priceN, fwdReturn,
      });
    } catch (e) {
      dropped++; logLines.push(`  drop ${u.name}: ${e.message}`);
    }
    await sleep(CFG.CG_DELAY_MS);
  }
  log(`  Phase-2 collected ${rows.length} tokens (${dropped} dropped → see run_log.txt for survivorship audit).`);

  // main sample: require ~full year of history & a positive formation multiple
  const sample = rows.filter(r => r.daysHeld >= CFG.MIN_DAYS_HELD && num(r.ps0) && r.ps0 > 0 && num(r.fwdReturn));
  writeCSV('factor_test.csv', rows.sort((a, b) => a.ps0 - b.ps0), [
    'name', 'symbol', 'slug', 'category', 't0', 'daysHeld', 'mcap0', 'rev0', 'ps0', 'price0', 'priceN', 'fwdReturn',
  ]);

  if (sample.length < CFG.N_QUANTILES * 3) {
    log(`  ! Only ${sample.length} usable tokens — too few for a ${CFG.N_QUANTILES}-quantile sort. Reporting raw correlation only.`);
  }

  // quantile sort on formation P/S (Q1 = cheapest / lowest multiple)
  const sorted = [...sample].sort((a, b) => a.ps0 - b.ps0);
  const q = CFG.N_QUANTILES, buckets = Array.from({ length: q }, () => []);
  sorted.forEach((r, i) => buckets[Math.min(q - 1, Math.floor(i * q / sorted.length))].push(r));

  const winMap = new Map(); // winsorized forward returns over the whole sample
  const wins = winsorize(sample.map(r => r.fwdReturn), CFG.WINSOR);
  sample.forEach((r, i) => winMap.set(r, wins[i]));

  const quantiles = buckets.map((b, i) => ({
    quantile: `Q${i + 1}${i === 0 ? ' (cheapest)' : i === q - 1 ? ' (most expensive)' : ''}`,
    n: b.length,
    ps0_median: median(b.map(r => r.ps0)),
    fwdReturn_mean: mean(b.map(r => r.fwdReturn)),
    fwdReturn_median: median(b.map(r => r.fwdReturn)),
    fwdReturn_mean_winsorized: mean(b.map(r => winMap.get(r))),
  }));

  const q1 = quantiles[0], qN = quantiles[q - 1];
  const longShort = (q1 && qN) ? {
    cheapMinusExpensive_meanWinsorized: q1.fwdReturn_mean_winsorized - qN.fwdReturn_mean_winsorized,
    cheapMinusExpensive_median: q1.fwdReturn_median - qN.fwdReturn_median,
  } : null;

  const sp = spearman(sample.map(r => r.ps0), sample.map(r => r.fwdReturn));

  const factor = {
    formationDateApprox: new Date(Date.now() - CFG.T0_DAYS_BACK * DAY * 1000).toISOString().slice(0, 10),
    nCollected: rows.length, nDropped: dropped, nUsableSample: sample.length,
    winsorLevel: CFG.WINSOR,
    quantiles, longShort,
    spearman: { rho: sp.rho, tStat: sp.t, n: sp.n, significant5pct: sp.t != null && Math.abs(sp.t) > 1.96 },
    sampleForwardReturn: describe(sample.map(r => r.fwdReturn)),
    interpretationHint:
      'Negative Spearman rho => lower formation multiple (cheaper on revenue) preceded higher forward returns ' +
      '=> a value effect / revenue does back valuation. Rho near 0 => multiples did not discriminate returns.',
  };

  // console summary
  log(`  Usable factor sample: ${sample.length} tokens; formation ~${factor.formationDateApprox}`);
  for (const qb of quantiles)
    log(`   ${qb.quantile.padEnd(20)} n=${String(qb.n).padStart(3)}  medP/S=${fmtX(qb.ps0_median).padStart(8)}  fwdRet(mean,wins)=${fmtPct(qb.fwdReturn_mean_winsorized)}  (median ${fmtPct(qb.fwdReturn_median)})`);
  if (longShort) log(`  Cheap−Expensive spread (winsorized mean): ${fmtPct(longShort.cheapMinusExpensive_meanWinsorized)}`);
  log(`  Spearman rho(P/S, fwdReturn) = ${sp.rho?.toFixed(3)}  (t=${sp.t?.toFixed(2)}, n=${sp.n}, ${factor.spearman.significant5pct ? 'sig @5%' : 'not sig @5%'})`);

  return factor;
}

// ================================================================== MAIN
(async () => {
  const started = Date.now();
  try {
    const universe = await buildUniverse();
    const { fundamentals, priced } = phase1(universe);
    const factor = await phase2(priced);

    const summary = {
      study: 'Does Revenue Back Valuation? Protocol Revenue Multiples and the Cross-Section of Token Returns in DeFi',
      generatedAt: new Date().toISOString(),
      config: CFG,
      phase1_fundamentals: fundamentals,
      phase2_factorTest: factor,
    };
    fs.writeFileSync(path.join(CFG.OUT_DIR, 'results_summary.json'), JSON.stringify(summary, null, 2));
    log(`DONE in ${((Date.now() - started) / 1000 / 60).toFixed(1)} min. Outputs in ./output/`);
    log('  -> universe_fundamentals.csv, factor_test.csv, results_summary.json, run_log.txt');
  } catch (e) {
    log(`FATAL: ${e.stack || e.message}`);
  } finally {
    flushLog();
  }
})();
