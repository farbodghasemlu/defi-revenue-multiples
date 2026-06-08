#!/usr/bin/env python3
"""
Reproduces the statistical results and all figures in
"Does Revenue Back Valuation? Protocol Revenue Multiples and the Cross-Section
of Token Returns in Decentralized Finance" (Ghasemlu, 2026).

Inputs (in ../data/): universe_fundamentals.csv, factor_test.csv,
                      panel_fama_macbeth.csv, results_summary.json
Outputs: figures (fig_*.pdf) in the current directory + printed statistics.

Usage:  pip install pandas numpy statsmodels matplotlib
        python make_analysis.py
"""
import json, os
import numpy as np, pandas as pd
import statsmodels.formula.api as smf
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D

DATA = os.path.join(os.path.dirname(__file__), "..", "data")
plt.rcParams.update({"font.size": 11, "font.family": "serif",
                     "axes.spines.top": False, "axes.spines.right": False})

u  = pd.read_csv(os.path.join(DATA, "universe_fundamentals.csv"))
ft = pd.read_csv(os.path.join(DATA, "factor_test.csv"))
panel = pd.read_csv(os.path.join(DATA, "panel_fama_macbeth.csv"))
summ = json.load(open(os.path.join(DATA, "results_summary.json")))

# ---------------------------------------------------------------- statistics
print("="*72, "\nLEVELS (priced universe)\n", "="*72, sep="")
print(f"Bitcoin share of sample mcap: {summ['phase1_fundamentals']['bitcoinShareOfMcap']:.1%}")
for k, v in summ["phase1_fundamentals"]["segments"].items():
    mp = v["medianPS"]
    print(f"  {k:16s} n={v['n']:3d}  aggP/S={v['aggPS']:8.1f}x  medianP/S={mp:.1f}x" if mp else f"  {k}: n={v['n']}")

print("\n" + "="*72, "\nENDPOINT FORWARD-RETURN REGRESSION (12m)\n", "="*72, sep="")
s = ft[(ft.daysHeld >= 300) & (ft.ps0 > 0) & (ft.mcap0 > 0)].copy()
s["ret"]  = np.clip(s.fwdReturn, s.fwdReturn.quantile(.025), s.fwdReturn.quantile(.975))
s["logPS"] = np.log(s.ps0); s["logMcap"] = np.log(s.mcap0)
s["isChain"] = (s.assetClass == "L1/Monetary").astype(int)
m = smf.ols("ret ~ logPS + logMcap + isChain", data=s).fit(cov_type="HC1")
print(m.summary().tables[1]); print(f"N={int(m.nobs)}  R2={m.rsquared:.3f}")

print("\n" + "="*72, "\nMONTHLY FAMA-MACBETH PANEL\n", "="*72, sep="")
for h, r in summ["phase3_famaMacBethPanel"].items():
    fm = r["famaMacBeth_rho"]
    print(f"  {h}: {r['nFormationDates']} dates  mean rho={fm['mean']:+.3f}  t={fm['tStat']:.2f}")

# ---------------------------------------------------------------- figures
# Fig: quintiles
q = summ["phase2_endpointFactorTest"]["quantiles"]
fig, ax = plt.subplots(figsize=(6.2, 3.6))
bars = ax.bar(["Q1\n(cheapest)", "Q2", "Q3", "Q4", "Q5\n(most exp.)"],
              [x["fwdReturn_mean_winsorized"]*100 for x in q], color="#3b5b7a", width=.62)
for b, x in zip(bars, q):
    ax.text(b.get_x()+b.get_width()/2, b.get_height()-3, f"P/S {x['ps0_median']:.0f}x",
            ha="center", va="top", fontsize=8, color="white")
ax.axhline(0, color="black", lw=.8); ax.set_ylim(-85, 5)
ax.set_ylabel("Mean 12m forward return (%, winsorized)")
ax.set_title("Forward returns by formation-date revenue multiple quintile", fontsize=11)
plt.tight_layout(); plt.savefig("fig_quintiles.pdf"); plt.close()

# Fig: scatter
yw = np.clip(s.fwdReturn, s.fwdReturn.quantile(.025), s.fwdReturn.quantile(.975)); x = np.log10(s.ps0)
fig, ax = plt.subplots(figsize=(6.2, 3.8))
ax.scatter(x, yw*100, s=22, alpha=.6, edgecolor="none",
           c=["#b2403a" if a == "L1/Monetary" else "#3b5b7a" for a in s.assetClass])
b, a = np.polyfit(x, yw, 1); xx = np.linspace(x.min(), x.max(), 50)
ax.plot(xx, (a+b*xx)*100, "k--", lw=1.4, label=f"OLS slope {b*100:+.1f} pp/decade (n.s.)")
ax.axhline(0, color="grey", lw=.6)
ax.set_xlabel(r"Formation-date revenue multiple, $\log_{10}$(P/S)")
ax.set_ylabel("12m forward return (%, winsorized)")
ax.set_title("No cross-sectional relationship between cheapness and return", fontsize=10.5)
leg1 = ax.legend(fontsize=8, frameon=False, loc="lower right")
ax.add_artist(ax.legend(handles=[Line2D([], [], marker="o", ls="", color="#3b5b7a", label="Application"),
                                  Line2D([], [], marker="o", ls="", color="#b2403a", label="L1/Monetary")],
                        fontsize=8, frameon=False, loc="upper left")); ax.add_artist(leg1)
plt.tight_layout(); plt.savefig("fig_scatter.pdf"); plt.close()

# Fig: Lorenz
rev = np.sort(u.loc[u.mcap > 0, "annualRevenue"].clip(lower=0).values)
cum = np.cumsum(rev)/rev.sum(); p = np.arange(1, len(rev)+1)/len(rev)
fig, ax = plt.subplots(figsize=(5.2, 4.2))
ax.plot(np.r_[0, p], np.r_[0, cum], color="#3b5b7a", lw=2, label="Revenue Lorenz curve")
ax.plot([0, 1], [0, 1], "--", color="grey", lw=1, label="Line of equality")
ax.fill_between(np.r_[0, p], np.r_[0, cum], np.r_[0, p], color="#3b5b7a", alpha=.12)
ax.text(.05, .78, "Gini = 0.94\nTop 10 protocols =\n75.8% of revenue", fontsize=9)
ax.set_xlabel("Cumulative share of protocols"); ax.set_ylabel("Cumulative share of revenue")
ax.set_title("Protocol revenue is extremely concentrated", fontsize=10.5)
ax.legend(fontsize=8, frameon=False, loc="upper center")
plt.tight_layout(); plt.savefig("fig_lorenz.pdf"); plt.close()

# Fig: histogram
ps = u[(u.assetClass == "Application") & (u.ps > 0)].ps.values
fig, ax = plt.subplots(figsize=(6.2, 3.4))
ax.hist(np.log10(ps), bins=28, color="#3b5b7a", alpha=.85)
ax.axvline(np.log10(9.0), color="#b2403a", lw=1.4, ls="--")
ax.text(np.log10(9.0)+.12, ax.get_ylim()[1]*.85, "median 9.0x", color="#b2403a", fontsize=9)
ax.set_xlabel(r"Application protocol revenue multiple, $\log_{10}$(P/S)")
ax.set_ylabel("Number of protocols"); ax.set_title("Application multiples span orders of magnitude", fontsize=10.5)
ax.set_xticks([0, 1, 2, 3, 4]); ax.set_xticklabels(["1x", "10x", "100x", "1,000x", "10,000x"])
plt.tight_layout(); plt.savefig("fig_hist.pdf"); plt.close()

# Fig: panel
pp = panel[panel.horizon == "H30d"].copy(); pp["date"] = pd.to_datetime(pp["date"])
fig, ax = plt.subplots(figsize=(6.2, 3.4))
ax.bar(pp["date"], pp["rho"], width=18, color=["#b2403a" if v > 0 else "#3b5b7a" for v in pp["rho"]])
ax.axhline(0, color="black", lw=.8)
ax.axhline(pp["rho"].mean(), color="#b2403a", ls="--", lw=1.1,
           label=f"mean rho = {pp['rho'].mean():+.3f} (t=2.18)")
ax.set_ylabel("Cross-sectional Spearman rho(P/S, ret)")
ax.set_title("Monthly P/S-return rank correlation (1-month horizon)", fontsize=11)
ax.legend(fontsize=8, frameon=False); fig.autofmt_xdate(rotation=45)
plt.tight_layout(); plt.savefig("fig_panel.pdf"); plt.close()

print("\nFigures written:", [f for f in os.listdir(".") if f.startswith("fig_")])
