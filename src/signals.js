// Signal helpers for the multi-signal composite ranking.
// Each signal is a pure function of (bars, asOfDate) → number | null.
// "Higher is better" — signals that are naturally inverse (volatility, recent
// return for reversion plays) are negated so a higher composite always means
// "more attractive to buy".

// Returns close prices from `bars` strictly on-or-before asOfDate, ascending.
export function closesUpTo(bars, asOfDate) {
  if (!bars || bars.length === 0) return [];
  const out = [];
  for (const b of bars) {
    const d = (b.t || '').slice(0, 10);
    if (d > asOfDate) break;
    out.push(b.c);
  }
  return out;
}

// Stdev of daily log returns over the last `lookback` bars on-or-before asOfDate.
// Returns null if there aren't enough bars.
export function logReturnStd(bars, asOfDate, lookback = 20) {
  const closes = closesUpTo(bars, asOfDate);
  if (closes.length < lookback + 1) return null;
  const recent = closes.slice(-lookback - 1);
  const rets = [];
  for (let i = 1; i < recent.length; i++) {
    rets.push(Math.log(recent[i] / recent[i - 1]));
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance);
}

// Simple lookback return: (close[t] - close[t-window]) / close[t-window].
function lookbackReturn(bars, asOfDate, window) {
  const closes = closesUpTo(bars, asOfDate);
  if (closes.length < window + 1) return null;
  const latest = closes[closes.length - 1];
  const prior = closes[closes.length - 1 - window];
  if (!prior) return null;
  return (latest - prior) / prior;
}

// ── Individual signals ───────────────────────────────────────────────────────

// 3-month momentum (matches the existing ret63 ranking signal).
export function momentum(bars, asOfDate, window = 63) {
  return lookbackReturn(bars, asOfDate, window);
}

// Risk-adjusted momentum: ret / stdev over the same window. Higher = smoother
// uptrend. Dimensionally a (daily) Sharpe-like number, not annualized — but
// since it's z-scored cross-sectionally, the scale doesn't matter.
export function sharpe(bars, asOfDate, window = 63) {
  const ret = lookbackReturn(bars, asOfDate, window);
  const std = logReturnStd(bars, asOfDate, window);
  if (ret == null || std == null || std <= 0) return null;
  return ret / std;
}

// Low volatility: negated stdev so higher rank = lower vol = better.
export function lowVol(bars, asOfDate, window = 60) {
  const std = logReturnStd(bars, asOfDate, window);
  return std == null ? null : -std;
}

// Short-term mean reversion: negated 5-day return. Higher rank = more oversold
// recently = better entry timing for a momentum buy.
export function reversal(bars, asOfDate, window = 5) {
  const ret = lookbackReturn(bars, asOfDate, window);
  return ret == null ? null : -ret;
}

// Map of signal name → function, used by the strategy to look up CLI-selected
// signals. Add new signals here.
export const SIGNAL_FNS = {
  momentum,
  sharpe,
  lowvol: lowVol,
  reversal,
};
