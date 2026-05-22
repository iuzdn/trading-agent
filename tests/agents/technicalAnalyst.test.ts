import { describe, it, expect } from 'vitest';
import { computeIndicators } from '../../src/agents/technicalAnalyst.js';

describe('computeIndicators (deterministic part of TechnicalAnalyst)', () => {
  const baseDate = new Date('2026-01-01');
  const bars = Array.from({ length: 220 }, (_, i) => {
    const close = 100 + i * 0.5 + Math.sin(i / 7) * 3;
    return {
      t: new Date(baseDate.getTime() + i * 86_400_000).toISOString(),
      o: close - 0.5,
      h: close + 1,
      l: close - 1,
      c: close,
      v: 1_000_000,
    };
  });

  it('throws when fewer than 50 bars provided', () => {
    expect(() => computeIndicators('TEST', bars.slice(0, 30))).toThrow(/Not enough bars/);
  });

  it('produces all expected numeric fields on full history', () => {
    const ind = computeIndicators('TEST', bars);
    expect(ind.ticker).toBe('TEST');
    expect(ind.lastClose).toBeGreaterThan(0);
    expect(ind.rsi14).toBeGreaterThanOrEqual(0);
    expect(ind.rsi14).toBeLessThanOrEqual(100);
    expect(typeof ind.macd.macd).toBe('number');
    expect(typeof ind.macd.signal).toBe('number');
    expect(ind.sma50).not.toBeNull();
    expect(ind.sma200).not.toBeNull();
    expect(ind.momentum).toBeGreaterThanOrEqual(-100);
    expect(ind.momentum).toBeLessThanOrEqual(100);
    expect(ind.keyLevels.support.every((s) => s < ind.lastClose)).toBe(true);
    expect(ind.keyLevels.resistance.every((r) => r > ind.lastClose)).toBe(true);
  });

  it('positive momentum on a strictly rising series', () => {
    const ind = computeIndicators('TEST', bars);
    expect(ind.momentum).toBeGreaterThan(0);
  });
});
