#!/usr/bin/env node
/**
 * =====================================================================================
 *  Does Revenue Back Valuation?  (v2 — adds robustness layer)
 *  Protocol Revenue Multiples and the Cross-Section of Token Returns in DeFi
 * =====================================================================================
 *  v2 changes vs v1:
 *    (1) Asset-class segmentation (Application protocols vs L1/Monetary) in Phase 1,
 *        so the misleading market-cap-weighted aggregate (dominated by BTC/L1s) is split out.
 *    (2) Cache-aware Phase 2: if a token is already cached, skip the rate-limit sleeps.
 *        => a re-run that reuses ./cache/ is essentially instant and hits no API limits.
 *    (3) NEW Phase 3 — monthly Fama–MacBeth panel: re-estimates the cross-sectional
 *        P/S -> forward-return relationship at ~monthly formation dates INSIDE the cached
 *        window, then averages (with a t-stat). This shows whether the signal fails
 *        throughout the period or only at the endpoints — the key defense of a null result.
 *
 *  Run the SAME way as before (cache makes it fast):
 *      COINGECKO_API_KEY=yourkey node revenue_multiples_study_v2.js
 *  Keep the ./cache/ folder from your previous run in the working directory.
 * =====================================================================================
 */
'use strict';
const fs = require('fs');
const path = require('path');

const CFG = {
  T0_DAYS_BACK: 365, MIN_DAYS_HELD: 300, MAX_FACTOR_TOKENS: 1000,
  N_QUANTILES: 5, WINSOR: 0.025, MIN_CAT_COUNT: 5,
  REV_THRESHOLDS: [0, 100_000, 1_000_000],
  CG_DELAY_MS: process.env.COINGECKO_API_KEY ? 2200 : 5000, DL_DELAY_MS: 120, MAX_RETRIES: 5,
  // ---- Phase 3 panel ----
  PANEL_HORIZONS_DAYS: [30, 90],  // forward-return horizons per formation date
  PANEL_STEP_DAYS: 30,            // spacing between formation dates (30 => ~monthly, non-overlapping for H=30)
  PANEL_MIN_XSECTION: 20,         // skip a formation date with fewer than this many valid tokens
  CG_API_KEY: process.env.COINGECKO_API_KEY || null,
  OUT_DIR: path.join(process.cwd(), 'output'),
  CACHE_DIR: path.join(process.cwd(), 'cache'),
};
const DL = 'https://api.llama.fi';
const CG = 'https://api.coingecko.com/api/v3';
const DAY = 86400;

for (const d of [CFG.OUT_DIR, CFG.CACHE_DIR]) fs.mkdirSync(d, { recursive: true });
const logLines = [];
const log = (m) => { const s = `[${new Date().toISOString()}] ${m}`; console.log(s); logLines.push(s); };
const flushLog = () => fs.writeFileSync(path.join(CFG.OUT_DIR, 'run_log.txt'), logLines.join('\n'));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const cacheFile = (k) => path.join(CFG.CACHE_DIR, k + '.json');
const cacheHas = (k) => fs.existsSync(cacheFile(k));
const cacheRead = (k) => { try { return JSON.parse(fs.readFileSync(cacheFile(k), 'utf8')); } catch { return null; } };

async function getJSON(url, { headers = {}, cacheKey = null, retries = CFG.MAX_RETRIES } = {}) {
  if (cacheKey && cacheHas(cacheKey)) { const c = cacheRead(cacheKey); if (c) return c; }
  let attempt = 0;
  while (true) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'tokenomics-research/2.0', ...headers } });
      if (res.status === 429 || res.status >= 500) {
        const ra = parseInt(res.headers.get('retry-after') || '0', 10);
        const wait = ra ? ra * 1000 : Math.min(60000, 1500 * 2 ** attempt);
        if (++attempt > retries) throw new Error(`HTTP ${res.status} after ${retries} retries`);
        log(`  ! ${res.status} on ${url.replace(/^https?:\/\//, '').slice(0, 60)} — backoff ${Math.round(wait / 1000)}s`);
        await sleep(wait); continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (cacheKey) fs.writeFileSync(cacheFile(cacheKey), JSON.stringify(data));
      return data;
    } catch (e) { if (++attempt > retries) throw e; await sleep(Math.min(30000, 1000 * 2 ** attempt)); }
  }
}

// ---------------- stats ----------------
const num = (x) => (typeof x === 'number' && isFinite(x)) ? x : null;
function quantile(s, q) { if (!s.length) return null; const p = (s.length - 1) * q, b = Math.floor(p), r = p - b; return s[b + 1] !== undefined ? s[b] + r * (s[b + 1] - s[b]) : s[b]; }
const median = (a) => quantile([...a].sort((x, y) => x - y), 0.5);
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const sd = (a) => { if (a.length < 2) return null; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
function trimmedMean(a, p = 0.1) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), k = Math.floor(s.length * p), t = s.slice(k, s.length - k); return t.length ? mean(t) : mean(s); }
function describe(arr) { const a = arr.filter(x => num(x) !== null); if (!a.length) return { n: 0 }; const s = [...a].sort((x, y) => x - y); return { n: a.length, mean: mean(a), trimmedMean: trimmedMean(a), p10: quantile(s, .1), p25: quantile(s, .25), median: quantile(s, .5), p75: quantile(s, .75), p90: quantile(s, .9), min: s[0], max: s[s.length - 1] }; }
function winsorize(a, p) { const s = [...a].sort((x, y) => x - y), lo = quantile(s, p), hi = quantile(s, 1 - p); return a.map(x => Math.min(hi, Math.max(lo, x))); }
function gini(v) { const a = v.filter(x => num(x) !== null && x >= 0).sort((x, y) => x - y), n = a.length; if (!n) return null; const t = a.reduce((s, x) => s + x, 0); if (!t) return 0; let c = 0; for (let i = 0; i < n; i++) c += (i + 1) * a[i]; return (2 * c) / (n * t) - (n + 1) / n; }
function rankArr(arr) { const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]); const r = new Array(arr.length); let i = 0; while (i < idx.length) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; const a = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k][1]] = a; i = j + 1; } return r; }
function spearman(x, y) { const n = x.length; if (n < 3) return { rho: null, t: null, n }; const rx = rankArr(x), ry = rankArr(y), mx = mean(rx), my = mean(ry); let nu = 0, dx = 0, dy = 0; for (let i = 0; i < n; i++) { nu += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; } const rho = nu / Math.sqrt(dx * dy); return { rho, t: rho * Math.sqrt((n - 2) / (1 - rho * rho)), n }; }
const fmtPct = (x) => x == null ? 'n/a' : (x * 100).toFixed(1) + '%';
const fmtX = (x) => x == null ? 'n/a' : x.toFixed(1) + 'x';
function writeCSV(file, rows, cols) { const esc = (v) => v == null ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v); fs.writeFileSync(path.join(CFG.OUT_DIR, file), [cols.join(',')].concat(rows.map(r => cols.map(c => esc(r[c])).join(','))).join('\n')); }

// ---------------- asset class ----------------
function assetClass(category) {
  if (category === 'Chain') return 'L1/Monetary';
  if (['Bridge', 'Wrapped Tokens', 'Reserve Currency'].includes(category)) return 'Other/Monetary';
  return 'Application'; // DEX, Lending, Yield, Liquid Staking, Perps, Aggregators, etc.
}

// ================= PHASE 0 =================
async function buildUniverse() {
  log('PHASE 0  Fetching bulk datasets from DefiLlama…');
  const [feesOv, revOv, protocols] = await Promise.all([
    getJSON(`${DL}/overview/fees`, { cacheKey: 'overview_fees' }),
    getJSON(`${DL}/overview/fees?dataType=dailyRevenue`, { cacheKey: 'overview_revenue' }),
    getJSON(`${DL}/protocols`, { cacheKey: 'protocols' }),
  ]);
  const protBySlug = new Map(); for (const p of protocols) if (p.slug) protBySlug.set(p.slug, p);
  const revBySlug = new Map(); for (const r of revOv.protocols) if (r.slug) revBySlug.set(r.slug, r);
  const annual = (rec) => !rec ? null : (num(rec.total1y) > 0 ? { v: rec.total1y } : (num(rec.total30d) > 0 ? { v: rec.total30d * 365 / 30 } : { v: 0 }));
  const universe = feesOv.protocols.map(f => {
    const p = protBySlug.get(f.slug), r = revBySlug.get(f.slug);
    const cat = f.category || p?.category || 'Unknown';
    return {
      name: f.name, slug: f.slug, symbol: p?.symbol || null, category: cat, assetClass: assetClass(cat),
      gecko_id: p?.gecko_id || null, mcap: num(p?.mcap),
      annualFees: annual(f)?.v || 0, annualRevenue: annual(r)?.v || 0,
    };
  });
  log(`PHASE 0  ${universe.length} protocols; ${universe.filter(u => u.mcap > 0).length} priced; ${universe.filter(u => u.gecko_id).length} w/ gecko_id.`);
  return universe;
}

// ================= PHASE 1 =================
function phase1(universe) {
  log('PHASE 1  Cross-sectional levels + asset-class segmentation…');
  const priced = universe.filter(u => u.mcap > 0);
  for (const u of priced) {
    u.ps = u.annualRevenue > 0 ? u.mcap / u.annualRevenue : null;
    u.pf = u.annualFees > 0 ? u.mcap / u.annualFees : null;
    u.revYield = u.annualRevenue / u.mcap;
  }
  const segAgg = (arr) => { const mc = arr.reduce((s, u) => s + u.mcap, 0), rv = arr.reduce((s, u) => s + u.annualRevenue, 0); return { n: arr.length, totalMcap: mc, totalRevenue: rv, aggPS: rv > 0 ? mc / rv : null, medianPS: median(arr.map(u => u.ps).filter(num)) }; };
  const classes = {};
  for (const u of priced) (classes[u.assetClass] ||= []).push(u);
  const segments = Object.fromEntries(Object.entries(classes).map(([k, v]) => [k, segAgg(v)]));
  const apps = priced.filter(u => u.assetClass === 'Application');

  const totMcap = priced.reduce((s, u) => s + u.mcap, 0);
  const census = CFG.REV_THRESHOLDS.map(thr => { const b = priced.filter(u => u.annualRevenue <= thr); return { thresholdUsd: thr, pctCount: b.length / priced.length, pctMcap: b.reduce((s, u) => s + u.mcap, 0) / totMcap }; });

  const byCat = {}; for (const u of apps) (byCat[u.category] ||= []).push(u);
  const categories = Object.entries(byCat).filter(([, a]) => a.length >= CFG.MIN_CAT_COUNT)
    .map(([c, a]) => ({ category: c, n: a.length, nWithRevenue: a.filter(u => u.annualRevenue > 0).length, totalMcap: a.reduce((s, u) => s + u.mcap, 0), psStats: describe(a.map(u => u.ps)), medianRevYield: median(a.map(u => u.revYield).filter(num)) }))
    .sort((a, b) => b.totalMcap - a.totalMcap);

  const fundamentals = {
    nPriced: priced.length, nPricedWithRevenue: priced.filter(u => u.annualRevenue > 0).length,
    bitcoinShareOfMcap: (priced.find(u => u.name === 'Bitcoin')?.mcap || 0) / totMcap,
    segments,                                   // <-- the key fix: BTC/L1 split from apps
    applicationOnly: { aggPS: segments['Application']?.aggPS, medianPS: segments['Application']?.medianPS, psDistribution: describe(apps.map(u => u.ps)), pfDistribution: describe(apps.map(u => u.pf)) },
    fullUniverseAggregate: segAgg(priced),
    revYieldDistribution: describe(priced.map(u => u.revYield).filter(num)),
    noBackingCensus: census,
    revenueConcentration: { top10Share: (() => { const r = priced.map(u => u.annualRevenue).filter(x => x > 0).sort((a, b) => b - a); return r.slice(0, 10).reduce((s, x) => s + x, 0) / r.reduce((s, x) => s + x, 0); })(), gini: gini(priced.map(u => u.annualRevenue)) },
    categories,
  };
  writeCSV('universe_fundamentals.csv', priced.sort((a, b) => b.mcap - a.mcap), ['name', 'symbol', 'slug', 'category', 'assetClass', 'gecko_id', 'mcap', 'annualRevenue', 'annualFees', 'ps', 'pf', 'revYield']);

  log(`  Application aggregate P/S: ${fmtX(fundamentals.applicationOnly.aggPS)} | median ${fmtX(fundamentals.applicationOnly.medianPS)}`);
  log(`  L1/Monetary aggregate P/S: ${fmtX(segments['L1/Monetary']?.aggPS)} | Bitcoin = ${fmtPct(fundamentals.bitcoinShareOfMcap)} of sample mcap`);
  log(`  Revenue concentration: top-10 = ${fmtPct(fundamentals.revenueConcentration.top10Share)} (Gini ${fundamentals.revenueConcentration.gini?.toFixed(2)})`);
  return { fundamentals, priced };
}

// ================= PHASE 2 (cache-aware) =================
async function fetchMarketChart(geckoId) {
  const d = await getJSON(`${CG}/coins/${geckoId}/market_chart?vs_currency=usd&days=${CFG.T0_DAYS_BACK}&interval=daily`,
    { headers: CFG.CG_API_KEY ? { 'x-cg-demo-api-key': CFG.CG_API_KEY } : {}, cacheKey: `cg_${geckoId}` });
  return (d && d.prices && d.prices.length >= 2) ? d : null;
}
const fetchRevHistory = async (slug) => { const d = await getJSON(`${DL}/summary/fees/${slug}?dataType=dailyRevenue`, { cacheKey: `dlrev_${slug}` }); return Array.isArray(d?.totalDataChart) ? d.totalDataChart : []; };
const trailingSum = (chart, endSec, days) => { const st = endSec - days * DAY; let s = 0; for (const [t, v] of chart) if (t > st && t <= endSec && num(v)) s += v; return s; };

async function phase2(priced) {
  log('PHASE 2  Endpoint forward-return test (12m buy-and-hold)…');
  const cands = priced.filter(u => u.gecko_id && u.annualRevenue > 0).sort((a, b) => b.mcap - a.mcap).slice(0, CFG.MAX_FACTOR_TOKENS);
  log(`  ${cands.length} candidate tokens (cached tokens won't be re-fetched or throttled)`);
  const rows = []; let done = 0, dropped = 0;
  for (const u of cands) {
    done++; if (done % 50 === 0) log(`  …${done}/${cands.length} (${dropped} dropped)`);
    const cached = cacheHas(`cg_${u.gecko_id}`) && cacheHas(`dlrev_${u.slug}`);
    try {
      const chart = await fetchMarketChart(u.gecko_id);
      if (!chart) { dropped++; logLines.push(`drop ${u.name}: no price history`); if (!cached) await sleep(CFG.CG_DELAY_MS); continue; }
      const p0 = chart.prices[0], pN = chart.prices.at(-1), m0 = chart.market_caps?.[0];
      const t0 = Math.round(p0[0] / 1000), tN = Math.round(pN[0] / 1000);
      const price0 = num(p0[1]), priceN = num(pN[1]), mcap0 = num(m0?.[1]);
      if (!price0 || !priceN || !mcap0) { dropped++; logLines.push(`drop ${u.name}: missing p0/pN/mcap0`); if (!cached) await sleep(CFG.CG_DELAY_MS); continue; }
      if (!cached) await sleep(CFG.DL_DELAY_MS);
      const rev0 = trailingSum(await fetchRevHistory(u.slug), t0, 365);
      if (rev0 <= 0) { dropped++; logLines.push(`drop ${u.name}: no revenue@T0`); if (!cached) await sleep(CFG.CG_DELAY_MS); continue; }
      rows.push({ name: u.name, symbol: u.symbol, slug: u.slug, category: u.category, assetClass: u.assetClass, gecko_id: u.gecko_id, t0: new Date(t0 * 1000).toISOString().slice(0, 10), daysHeld: Math.round((tN - t0) / DAY), mcap0, rev0, ps0: mcap0 / rev0, price0, priceN, fwdReturn: priceN / price0 - 1 });
    } catch (e) { dropped++; logLines.push(`drop ${u.name}: ${e.message}`); }
    if (!cached) await sleep(CFG.CG_DELAY_MS);
  }
  log(`  collected ${rows.length} (${dropped} dropped)`);
  const sample = rows.filter(r => r.daysHeld >= CFG.MIN_DAYS_HELD && r.ps0 > 0 && num(r.fwdReturn));
  writeCSV('factor_test.csv', rows.sort((a, b) => a.ps0 - b.ps0), ['name', 'symbol', 'slug', 'category', 'assetClass', 't0', 'daysHeld', 'mcap0', 'rev0', 'ps0', 'price0', 'priceN', 'fwdReturn']);

  const sorted = [...sample].sort((a, b) => a.ps0 - b.ps0), q = CFG.N_QUANTILES, buckets = Array.from({ length: q }, () => []);
  sorted.forEach((r, i) => buckets[Math.min(q - 1, Math.floor(i * q / sorted.length))].push(r));
  const wins = winsorize(sample.map(r => r.fwdReturn), CFG.WINSOR), wmap = new Map(); sample.forEach((r, i) => wmap.set(r, wins[i]));
  const quantiles = buckets.map((b, i) => ({ quantile: `Q${i + 1}`, n: b.length, ps0_median: median(b.map(r => r.ps0)), fwdReturn_mean_winsorized: mean(b.map(r => wmap.get(r))), fwdReturn_median: median(b.map(r => r.fwdReturn)) }));
  const sp = spearman(sample.map(r => r.ps0), sample.map(r => r.fwdReturn));
  const spApp = (() => { const a = sample.filter(r => r.assetClass === 'Application'); return spearman(a.map(r => r.ps0), a.map(r => r.fwdReturn)); })();
  const factor = {
    nCollected: rows.length, nDropped: dropped, nUsableSample: sample.length, formationDateApprox: sample[0]?.t0,
    sampleForwardReturn: describe(sample.map(r => r.fwdReturn)), shareNegative: sample.filter(r => r.fwdReturn < 0).length / sample.length,
    quantiles, longShort_cheapMinusExpensive: quantiles[0] && quantiles[q - 1] ? quantiles[0].fwdReturn_mean_winsorized - quantiles[q - 1].fwdReturn_mean_winsorized : null,
    spearmanAll: { rho: sp.rho, t: sp.t, n: sp.n, sig5pct: sp.t != null && Math.abs(sp.t) > 1.96 },
    spearmanApplicationOnly: { rho: spApp.rho, t: spApp.t, n: spApp.n, sig5pct: spApp.t != null && Math.abs(spApp.t) > 1.96 },
  };
  log(`  usable ${sample.length}; median fwd ret ${fmtPct(factor.sampleForwardReturn.median)}; share negative ${fmtPct(factor.shareNegative)}`);
  log(`  Spearman(P/S,ret) all=${sp.rho?.toFixed(3)} (t=${sp.t?.toFixed(2)}) | app-only=${spApp.rho?.toFixed(3)} (t=${spApp.t?.toFixed(2)})`);
  return { factor, rowsWithGecko: rows };
}

// ================= PHASE 3: monthly Fama–MacBeth panel (from cache) =================
function seriesAt(pairsMs, targetSec) { // pairs are [ms, value]; return last value with ts<=target
  let v = null; for (const [ms, val] of pairsMs) { if (ms / 1000 <= targetSec) v = val; else break; } return num(v);
}
function phase3(rows) {
  log('PHASE 3  Monthly Fama–MacBeth panel (reading cached daily series)…');
  // load per-token cached daily price+mcap and revenue history
  const tokens = [];
  for (const r of rows) {
    const cg = cacheRead(`cg_${r.gecko_id}`), rv = cacheRead(`dlrev_${r.slug}`);
    if (!cg?.prices || !cg?.market_caps || !rv?.totalDataChart) continue;
    tokens.push({ ...r, prices: cg.prices, mcaps: cg.market_caps, rev: rv.totalDataChart, firstSec: Math.round(cg.prices[0][0] / 1000), lastSec: Math.round(cg.prices.at(-1)[0] / 1000) });
  }
  if (!tokens.length) { log('  ! no cached series found — skip Phase 3 (run once online first to populate ./cache/).'); return null; }
  const globalLast = Math.max(...tokens.map(t => t.lastSec)), globalFirst = Math.min(...tokens.map(t => t.firstSec));

  const results = {};
  for (const H of CFG.PANEL_HORIZONS_DAYS) {
    const periods = [];
    for (let t = globalFirst; t <= globalLast - H * DAY; t += CFG.PANEL_STEP_DAYS * DAY) {
      const xs = [], ys = [], appMask = [];
      for (const tk of tokens) {
        const p0 = seriesAt(tk.prices, t), pH = seriesAt(tk.prices, t + H * DAY), mc = seriesAt(tk.mcaps, t);
        const rev = trailingSum(tk.rev, t, 365);
        if (!p0 || !pH || !mc || rev <= 0) continue;
        xs.push(mc / rev); ys.push(pH / p0 - 1); appMask.push(tk.assetClass === 'Application');
      }
      if (xs.length < CFG.PANEL_MIN_XSECTION) continue;
      const sp = spearman(xs, ys);
      // quintile cheap-minus-expensive spread
      const order = xs.map((v, i) => [v, ys[i]]).sort((a, b) => a[0] - b[0]);
      const k = Math.floor(order.length / 5);
      const cheap = mean(order.slice(0, k).map(o => o[1])), exp = mean(order.slice(-k).map(o => o[1]));
      // app-only rho
      const ax = [], ay = []; xs.forEach((v, i) => { if (appMask[i]) { ax.push(v); ay.push(ys[i]); } });
      const spA = ax.length >= CFG.PANEL_MIN_XSECTION ? spearman(ax, ay) : { rho: null };
      periods.push({ date: new Date(t * 1000).toISOString().slice(0, 10), n: xs.length, rho: sp.rho, lsSpread: cheap - exp, rhoApp: spA.rho, medRet: median(ys) });
    }
    const rhos = periods.map(p => p.rho).filter(num), spreads = periods.map(p => p.lsSpread).filter(num), rhosApp = periods.map(p => p.rhoApp).filter(num);
    const fm = (arr) => { const m = mean(arr), s = sd(arr); return { mean: m, sd: s, nPeriods: arr.length, tStat: (s && arr.length) ? m / (s / Math.sqrt(arr.length)) : null }; };
    results[`H${H}d`] = {
      horizonDays: H, nFormationDates: periods.length,
      famaMacBeth_rho: fm(rhos), famaMacBeth_lsSpread: fm(spreads), famaMacBeth_rho_appOnly: fm(rhosApp),
      perPeriod: periods,
    };
    const r = results[`H${H}d`];
    log(`  H=${H}d: ${periods.length} formation dates | mean rho=${r.famaMacBeth_rho.mean?.toFixed(3)} (t=${r.famaMacBeth_rho.tStat?.toFixed(2)}) | mean cheap-exp spread=${fmtPct(r.famaMacBeth_lsSpread.mean)} (t=${r.famaMacBeth_lsSpread.tStat?.toFixed(2)})`);
  }
  // dump panel
  const flat = []; for (const [h, r] of Object.entries(results)) for (const p of r.perPeriod) flat.push({ horizon: h, ...p });
  writeCSV('panel_fama_macbeth.csv', flat, ['horizon', 'date', 'n', 'rho', 'rhoApp', 'lsSpread', 'medRet']);
  return results;
}

// ================= MAIN =================
(async () => {
  const t0 = Date.now();
  try {
    const universe = await buildUniverse();
    const { fundamentals, priced } = phase1(universe);
    const { factor, rowsWithGecko } = await phase2(priced);
    const panel = phase3(rowsWithGecko);
    fs.writeFileSync(path.join(CFG.OUT_DIR, 'results_summary.json'), JSON.stringify({
      study: 'Does Revenue Back Valuation? Protocol Revenue Multiples and the Cross-Section of Token Returns in DeFi',
      generatedAt: new Date().toISOString(), config: CFG,
      phase1_fundamentals: fundamentals, phase2_endpointFactorTest: factor, phase3_famaMacBethPanel: panel,
    }, null, 2));
    log(`DONE in ${((Date.now() - t0) / 1000).toFixed(0)}s. Outputs: results_summary.json, universe_fundamentals.csv, factor_test.csv, panel_fama_macbeth.csv`);
  } catch (e) { log(`FATAL: ${e.stack || e.message}`); } finally { flushLog(); }
})();
