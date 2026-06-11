// Pure deterministic reimplementation of the rules in agent.js buildSystemPrompt().
// Used by the backtest harness in place of Claude's reasoning loop.

import { computeMomentum } from './alpaca.js';
import { SIGNAL_FNS, logReturnStd } from './signals.js';

// Re-export for any external callers that still import dailyReturnStd from here.
export { logReturnStd as dailyReturnStd } from './signals.js';

// Compute momentum using only bars strictly on-or-before `asOfDate` (YYYY-MM-DD).
// Returns the same shape as computeMomentum() in alpaca.js, or null if not enough
// history. Inclusive of asOfDate so a "decision at close on D" sees D's bar.
export function computeMomentumAt(bars, asOfDate) {
  if (!bars || bars.length === 0) return null;
  const cutoff = asOfDate;
  const slice = [];
  for (const b of bars) {
    const d = (b.t || '').slice(0, 10);
    if (d > cutoff) break;
    slice.push(b);
  }
  return computeMomentum(slice);
}

// Returns the close price for `symbol` on `date` (or null if no bar that day).
export function priceOn(bars, date) {
  for (let i = bars.length - 1; i >= 0; i--) {
    const d = (bars[i].t || '').slice(0, 10);
    if (d === date) return bars[i].c;
    if (d < date) return null;
  }
  return null;
}

// Decide target portfolio for one decision tick.
//
// Inputs:
//   date              — YYYY-MM-DD of the decision
//   assetClass        — 'equity' | 'crypto'
//   watchlist         — array of symbols to rank
//   barsBySymbol      — { symbol -> array of {t,o,h,l,c,v}, ascending time }
//   regimeBars        — bars for SPY (equities) or BTC/USD (crypto)
//   currentSymbols    — Set of symbols currently held in this asset class
//   config            — { maxPositionPct, cryptoCapPct }
//
// Returns:
//   { regimeOff: bool, ranked: [{symbol, ret63, ret20, qualifies}], targets: [symbol] }
//   targets is the desired *holdings* in this asset class after rebalancing.
export function decideTargets({
  date,
  assetClass,
  watchlist,
  barsBySymbol,
  regimeBars,
  config,
}) {
  const regime = computeMomentumAt(regimeBars, date);
  if (!regime || !regime.aboveMa50) {
    return { regimeOff: true, ranked: [], targets: [] };
  }

  const weights = config.signalWeights || { momentum: 1 };
  const signalNames = Object.keys(weights);

  // First pass: gather per-symbol momentum (for qualifies/MA checks) and raw
  // signal values. Drop symbols missing any required signal.
  const rows = [];
  for (const symbol of watchlist) {
    const m = computeMomentumAt(barsBySymbol[symbol], date);
    if (!m) continue;
    const sigVals = {};
    let missing = false;
    for (const name of signalNames) {
      const fn = SIGNAL_FNS[name];
      if (!fn) { missing = true; break; }
      const v = fn(barsBySymbol[symbol], date);
      if (v == null || !Number.isFinite(v)) { missing = true; break; }
      sigVals[name] = v;
    }
    if (missing) continue;
    rows.push({
      symbol,
      ret63: m.ret63,
      ret20: m.ret20,
      ma20: m.ma20,
      ma50: m.ma50,
      latest: m.latest,
      qualifies: m.aboveMa20 && m.aboveMa50,
      signals: sigVals,
    });
  }

  // Second pass: cross-sectional z-score per signal, then weighted composite.
  // Re-normalize weights to sum to 1 so the composite is in z-space too.
  const wSum = signalNames.reduce((s, n) => s + (weights[n] || 0), 0) || 1;
  for (const name of signalNames) {
    const vals = rows.map(r => r.signals[name]);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
    const std = Math.sqrt(variance) || 1; // avoid div-by-zero if all equal
    for (const r of rows) {
      r.zScores = r.zScores || {};
      r.zScores[name] = (r.signals[name] - mean) / std;
    }
  }
  for (const r of rows) {
    r.composite = signalNames.reduce(
      (s, n) => s + (weights[n] / wSum) * r.zScores[n],
      0,
    );
  }

  const ranked = rows.sort((a, b) => b.composite - a.composite);

  const qualifying = ranked.filter(r => r.qualifies);
  const topN = assetClass === 'equity' ? 3 : qualifying.length;
  const targets = qualifying.slice(0, topN).map(r => r.symbol);

  return { regimeOff: false, ranked, targets };
}

function equalWeightAllocate(targets, pool, perCap) {
  const equalShare = pool / targets.length;
  const each = Math.min(equalShare, perCap);
  const alloc = {};
  for (const s of targets) alloc[s] = each;
  return alloc;
}

// Convert a target symbol list into desired notional allocations.
// When config.volSizing is true, weights are inverse-proportional to 20-day
// stdev of log returns (risk parity within asset class). Otherwise equal-weight.
// Each individual allocation is hard-capped at config.maxPositionPct of equity.
// Crypto allocations additionally respect config.cryptoCapPct combined.
export function allocateTargets({
  assetClass, targets, equity, cash, config, barsBySymbol, date,
}) {
  if (targets.length === 0) return {};
  const perCap = equity * config.maxPositionPct;
  const pool = assetClass === 'crypto'
    ? Math.min(cash, equity * config.cryptoCapPct)
    : cash;

  if (config.volSizing && barsBySymbol && date) {
    const vols = {};
    let totalInvVol = 0;
    let missing = false;
    for (const sym of targets) {
      const std = logReturnStd(barsBySymbol[sym], date, 20);
      if (!std || std <= 0) { missing = true; break; }
      vols[sym] = std;
      totalInvVol += 1 / std;
    }
    if (!missing && totalInvVol > 0) {
      // Deploy at most pool, and never more than perCap × N (sanity).
      const maxDeploy = Math.min(pool, perCap * targets.length);
      const alloc = {};
      for (const sym of targets) {
        const w = (1 / vols[sym]) / totalInvVol;
        alloc[sym] = Math.min(w * maxDeploy, perCap);
      }
      return alloc;
    }
    // Fall through to equal-weight if any symbol lacks vol data.
  }

  return equalWeightAllocate(targets, pool, perCap);
}
