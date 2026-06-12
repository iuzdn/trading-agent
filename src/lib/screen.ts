import type { Bar } from '../tools/alpaca.js';
import { rsi, sma, momentumScore } from '../tools/indicators.js';
import type { MacroRegime } from '../types/contracts.js';

/**
 * Pure, deterministic screening logic for the Scout (no I/O, no LLM).
 * Stage 1 of the funnel: turn raw bars for a universe of symbols into
 * regime-filtered, ranked candidates. The LLM only triages the output.
 */

export interface CandidateStats {
  ticker: string;
  lastClose: number;
  momentum: number; // [-100, 100], from indicators.momentumScore
  rsi14: number;
  vs200dma: 'above' | 'below';
  /** Stdev of last-20 daily log returns. Smoothness input for RISK_OFF ranking. */
  realizedVol: number;
  pctChange: number | null; // intraday % change from the screener, if known
}

export interface ScreenExclusions {
  /** Tickers in stop-out cooldown. */
  cooldowns: string[];
  /** Tickers already held at/above the per-position concentration cap. */
  heldOverCap: string[];
}

export interface RankedCandidate extends CandidateStats {
  score: number; // 0–100, normalized within the surviving set
}

const MIN_PRICE = 5; // avoid penny-stock movers
const MIN_BARS = 200; // need a 200-DMA — deliberately excludes recent IPOs

/** Stdev of daily log returns over the trailing `lookback` bars. */
export function logReturnStd(closes: number[], lookback = 20): number | null {
  if (closes.length < lookback + 1) return null;
  const recent = closes.slice(-lookback - 1);
  const rets: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    rets.push(Math.log(recent[i]! / recent[i - 1]!));
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance);
}

/** Returns null when the symbol lacks the history to be screened (by design). */
export function buildCandidateStats(
  ticker: string,
  bars: Bar[],
  pctChange: number | null = null,
): CandidateStats | null {
  if (bars.length < MIN_BARS) return null;
  const closes = bars.map((b) => b.c);
  const lastClose = closes[closes.length - 1]!;
  const sma200 = sma(closes, 200);
  const ma = sma200[sma200.length - 1];
  const rsiSeries = rsi(closes, 14);
  const vol = logReturnStd(closes);
  if (ma === undefined || vol === null) return null;
  return {
    ticker: ticker.toUpperCase(),
    lastClose,
    momentum: momentumScore(closes),
    rsi14: rsiSeries[rsiSeries.length - 1] ?? 50,
    vs200dma: lastClose >= ma ? 'above' : 'below',
    realizedVol: vol,
    pctChange,
  };
}

function passesRegimeFilter(s: CandidateStats, regime: MacroRegime['label']): boolean {
  switch (regime) {
    case 'CRISIS':
      return false; // no new longs, period
    case 'RISK_OFF':
      // Long-only quality bar: established uptrend, not overheated, not washed out.
      return s.vs200dma === 'above' && s.rsi14 >= 40 && s.rsi14 <= 65 && s.momentum > 0;
    case 'RISK_ON':
    case 'NEUTRAL':
      return s.vs200dma === 'above' && s.rsi14 < 75;
  }
}

function rawScore(s: CandidateStats, regime: MacroRegime['label']): number {
  if (regime === 'RISK_OFF') {
    // Sharpe-like: smooth momentum beats hot momentum in a defensive tape.
    return s.momentum / Math.max(s.realizedVol, 1e-4);
  }
  // NEUTRAL gets a haircut so marginal setups fall off the shortlist.
  return regime === 'NEUTRAL' ? s.momentum * 0.8 : s.momentum;
}

/**
 * Apply exclusions + the regime filter, rank by the regime's score, and return
 * the top `limit` with scores min-max normalized to [1, 100].
 */
export function filterAndRank(
  stats: CandidateStats[],
  regime: MacroRegime['label'],
  exclusions: ScreenExclusions,
  limit = 20,
): RankedCandidate[] {
  if (regime === 'CRISIS') return [];
  const excluded = new Set(
    [...exclusions.cooldowns, ...exclusions.heldOverCap].map((t) => t.toUpperCase()),
  );
  const survivors = stats.filter(
    (s) =>
      s.lastClose >= MIN_PRICE && !excluded.has(s.ticker) && passesRegimeFilter(s, regime),
  );
  if (survivors.length === 0) return [];

  const scored = survivors
    .map((s) => ({ s, raw: rawScore(s, regime) }))
    .sort((a, b) => b.raw - a.raw)
    .slice(0, limit);

  const max = scored[0]!.raw;
  const min = scored[scored.length - 1]!.raw;
  const span = max - min;
  return scored.map(({ s, raw }) => ({
    ...s,
    score: span === 0 ? 100 : Math.round(1 + (99 * (raw - min)) / span),
  }));
}
