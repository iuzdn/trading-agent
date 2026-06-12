import { describe, it, expect } from 'vitest';
import {
  buildCandidateStats,
  filterAndRank,
  logReturnStd,
  type CandidateStats,
} from '../../src/lib/screen.js';
import type { Bar } from '../../src/tools/alpaca.js';

/** Synthetic daily bars from a close series. */
function barsFrom(closes: number[]): Bar[] {
  return closes.map((c, i) => ({ t: `d${i}`, o: c, h: c * 1.01, l: c * 0.99, c, v: 1000 }));
}

/** Steadily rising series — above 200-DMA, positive momentum, mid RSI. */
function risingCloses(n = 250, slope = 0.3): number[] {
  return Array.from({ length: n }, (_, i) => 100 + i * slope);
}

function makeStats(over: Partial<CandidateStats> = {}): CandidateStats {
  return {
    ticker: 'AAA',
    lastClose: 50,
    momentum: 40,
    rsi14: 55,
    vs200dma: 'above',
    realizedVol: 0.02,
    pctChange: 2.5,
    ...over,
  };
}

const noExclusions = { cooldowns: [], heldOverCap: [] };

describe('buildCandidateStats', () => {
  it('computes stats for a long enough series', () => {
    const s = buildCandidateStats('nvda', barsFrom(risingCloses()), 3.2);
    expect(s).not.toBeNull();
    expect(s!.ticker).toBe('NVDA');
    expect(s!.vs200dma).toBe('above');
    expect(s!.momentum).toBeGreaterThan(0);
    expect(s!.pctChange).toBe(3.2);
  });

  it('returns null below 200 bars (recent IPOs excluded by design)', () => {
    expect(buildCandidateStats('IPO', barsFrom(risingCloses(150)))).toBeNull();
  });
});

describe('logReturnStd', () => {
  it('is ~0 for a flat series and positive for a noisy one', () => {
    expect(logReturnStd(Array(30).fill(100))).toBeCloseTo(0, 6);
    const noisy = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 ? 3 : -3));
    expect(logReturnStd(noisy)!).toBeGreaterThan(0);
  });
});

describe('filterAndRank', () => {
  it('returns empty in CRISIS regardless of candidates', () => {
    expect(filterAndRank([makeStats()], 'CRISIS', noExclusions)).toEqual([]);
  });

  it('RISK_ON: keeps above-200DMA names with RSI < 75, ranks by momentum', () => {
    const out = filterAndRank(
      [
        makeStats({ ticker: 'LOW', momentum: 10 }),
        makeStats({ ticker: 'HOT', momentum: 80, rsi14: 80 }), // overbought → out
        makeStats({ ticker: 'TOP', momentum: 60 }),
        makeStats({ ticker: 'DWN', vs200dma: 'below', momentum: 90 }), // downtrend → out
      ],
      'RISK_ON',
      noExclusions,
    );
    expect(out.map((c) => c.ticker)).toEqual(['TOP', 'LOW']);
    expect(out[0]!.score).toBe(100);
    expect(out[1]!.score).toBe(1);
  });

  it('RISK_OFF: applies the quality bar (RSI 40–65, positive momentum, above 200DMA)', () => {
    const out = filterAndRank(
      [
        makeStats({ ticker: 'OK', momentum: 30, rsi14: 55 }),
        makeStats({ ticker: 'HOT', momentum: 70, rsi14: 70 }), // RSI too high
        makeStats({ ticker: 'WEAK', momentum: -5, rsi14: 50 }), // negative momentum
        makeStats({ ticker: 'COLD', momentum: 20, rsi14: 35 }), // washed out
      ],
      'RISK_OFF',
      noExclusions,
    );
    expect(out.map((c) => c.ticker)).toEqual(['OK']);
  });

  it('RISK_OFF: prefers smoother momentum (lower vol) at equal momentum', () => {
    const out = filterAndRank(
      [
        makeStats({ ticker: 'CHOPPY', momentum: 40, realizedVol: 0.06 }),
        makeStats({ ticker: 'SMOOTH', momentum: 40, realizedVol: 0.015 }),
      ],
      'RISK_OFF',
      noExclusions,
    );
    expect(out[0]!.ticker).toBe('SMOOTH');
  });

  it('applies cooldown, concentration, and penny-stock exclusions', () => {
    const out = filterAndRank(
      [
        makeStats({ ticker: 'CD' }),
        makeStats({ ticker: 'HELD' }),
        makeStats({ ticker: 'PENNY', lastClose: 2 }),
        makeStats({ ticker: 'KEEP' }),
      ],
      'RISK_ON',
      { cooldowns: ['CD'], heldOverCap: ['HELD'] },
    );
    expect(out.map((c) => c.ticker)).toEqual(['KEEP']);
  });

  it('caps the output at the limit', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      makeStats({ ticker: `T${i}`, momentum: i + 1 }),
    );
    expect(filterAndRank(many, 'RISK_ON', noExclusions, 20)).toHaveLength(20);
  });
});
