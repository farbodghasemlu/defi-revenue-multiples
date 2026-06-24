# Replication Package: *Does Revenue Back Valuation?*

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.20600322.svg)](https://doi.org/10.5281/zenodo.20600322)

**Paper:** Does Revenue Back Valuation? Protocol Revenue Multiples and the Cross-Section of Token Returns in Decentralized Finance
**Author:** Farbod Ghasemlu (Independent Researcher) — ORCID [0009-0009-2303-5672](https://orcid.org/0009-0009-2303-5672)
**Version:** 1.0 (June 2026)

This package reproduces every statistic and figure in the paper, end to end, from free public APIs (DefiLlama and CoinGecko). No paid data or API keys are required.

---

## Contents

```
code/
  revenue_multiples_study.js      Data collector v1 (cross-section + 12m endpoint test)
  revenue_multiples_study_v2.js   Data collector v2 (adds asset-class segmentation +
                                  monthly Fama-MacBeth panel; cache-aware)
  make_analysis.py                Regenerates the regression, panel summary, and all 5 figures
data/
  universe_fundamentals.csv       Cross-sectional snapshot of every priced protocol
  factor_test.csv                 Per-token formation multiple + 12m forward return
  panel_fama_macbeth.csv          Per-period cross-sectional statistics (monthly + 90-day)
  results_summary.json            All computed statistics consumed by the paper
README.md
LICENSE
```

## Data provenance

All raw inputs are retrieved at run time from:
- **DefiLlama** (`api.llama.fi`, `coins.llama.fi`) — protocol fees, revenue, market cap, categories, daily revenue history. Free, no key.
- **CoinGecko** (`api.coingecko.com`) — daily token price and market-capitalization history. Free; an optional free "demo" key raises the rate limit.

Snapshot date of the included data: see `generatedAt` in `results_summary.json`. The return sample is formed ~June 2025 with a twelve-month forward window.

## Reproduction

### Option A — use the included data (fast, exact)
```bash
pip install pandas numpy statsmodels matplotlib
cd code
python make_analysis.py
```
Prints the level statistics, the cross-sectional regression (Table 2), and the Fama-MacBeth panel summary (Table 3), and writes `fig_quintiles.pdf`, `fig_scatter.pdf`, `fig_lorenz.pdf`, `fig_hist.pdf`, `fig_panel.pdf`.

### Option B — rebuild the data from the live APIs
```bash
# Node.js 18+
cd code
COINGECKO_API_KEY=optional_free_demo_key node revenue_multiples_study_v2.js
```
Writes fresh `output/` files. The script caches every API response in `./cache/`, so an interrupted run resumes on re-run without re-fetching. Because crypto data is live, figures rebuilt at a later date will differ from the published snapshot; use Option A to reproduce the paper exactly.

## Data dictionary (key fields)

`universe_fundamentals.csv` — `mcap` (USD market cap), `annualRevenue`/`annualFees` (annualized USD), `ps`/`pf` (market cap ÷ annualized revenue/fees), `revYield` (revenue ÷ mcap), `assetClass` (`Application` | `L1/Monetary` | `Other/Monetary`).

`factor_test.csv` — `t0` (formation date), `daysHeld`, `mcap0`/`rev0`/`ps0` (formation-date values, no look-ahead), `price0`/`priceN`, `fwdReturn` (price return over the window).

`panel_fama_macbeth.csv` — `horizon` (`H30d`/`H90d`), `date` (formation date), `n`, `rho` (cross-sectional Spearman of P/S vs forward return), `rhoApp` (application-only), `lsSpread` (cheap-minus-expensive quintile return), `medRet`.

## Method notes

- **Fees vs revenue:** *fees* are the total paid by users; *revenue* is the protocol-retained portion. The headline multiple uses revenue.
- **Look-ahead:** the formation multiple at date *t* uses trailing-12-month revenue ending at *t* and the market cap at *t* only.
- **Winsorization:** forward returns are winsorized at 2.5%/97.5% for means and regression.
- **Panel:** the 1-month horizon uses non-overlapping monthly windows (preferred *t*-stat); the 90-day horizon overlaps and its *t*-stat is overstated.
- **Known limitations** (see paper §7): single ~12-month, predominantly bearish regime; survivorship and revenue-at-formation selection; DefiLlama's per-protocol revenue methodology; price (not total) returns; associational, not causal.

## How to cite

Paper:
Ghasemlu, F. (2026). Does Revenue Back Valuation? Protocol Revenue Multiples
and the Cross-Section of Token Returns in Decentralized Finance. SSRN Working
Paper (June 8, 2026). https://ssrn.com/abstract=6901559

Dataset and code:
Ghasemlu, F. (2026). DeFi Protocol Revenue Multiples and Token Returns:
Dataset and Replication Code [Data set]. Zenodo.
https://doi.org/10.5281/zenodo.20600322

## License

Code: MIT (see `LICENSE`). Derived data files: CC-BY-4.0. Underlying API data are subject to the respective providers' terms.

## AI-use disclosure

A large language model (Anthropic's Claude) assisted with data-collection scripting, routine statistical computation, and manuscript/code drafting and editing. All research-design choices, interpretation, and conclusions are the author's, who takes sole responsibility for the content.
