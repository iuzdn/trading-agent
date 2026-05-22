import { describe, it, expect } from 'vitest';
import { computePositionSize } from '../../src/lib/positionSizing.js';

describe('computePositionSize', () => {
  it('returns 0 size on zero equity', () => {
    const r = computePositionSize({
      confidence: 70,
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 115,
      equity: 0,
      maxPctOfEquity: 15,
    });
    expect(r.sizeUsd).toBe(0);
  });

  it('caps at maxPctOfEquity even when Kelly would be larger', () => {
    const r = computePositionSize({
      confidence: 85,
      entryPrice: 100,
      stopLoss: 99,
      takeProfit: 130, // huge reward, tight stop → Kelly very high
      equity: 100_000,
      maxPctOfEquity: 15,
    });
    expect(r.sizePctOfEquity).toBeLessThanOrEqual(15.01);
  });

  it('returns 0 on inverted reward/risk (entry == stop)', () => {
    const r = computePositionSize({
      confidence: 70,
      entryPrice: 100,
      stopLoss: 100,
      takeProfit: 110,
      equity: 50_000,
      maxPctOfEquity: 15,
    });
    expect(r.sizeUsd).toBe(0);
  });

  it('returns 0 when Kelly is non-positive (low edge)', () => {
    // p clipped to 0.45 → at b=1, kelly = (1*.45 - .55)/1 = -0.1 → clip to 0
    const r = computePositionSize({
      confidence: 30,
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 105,
      equity: 100_000,
      maxPctOfEquity: 15,
    });
    expect(r.kellyFraction).toBe(0);
    expect(r.sizeUsd).toBe(0);
  });

  it('half-Kelly shrinkage halves the raw Kelly value', () => {
    const full = computePositionSize({
      confidence: 70,
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 120,
      equity: 100_000,
      maxPctOfEquity: 100,
      kellyShrinkage: 1.0,
    });
    const half = computePositionSize({
      confidence: 70,
      entryPrice: 100,
      stopLoss: 95,
      takeProfit: 120,
      equity: 100_000,
      maxPctOfEquity: 100,
      kellyShrinkage: 0.5,
    });
    expect(half.kellyFraction).toBeCloseTo(full.kellyFraction / 2, 1);
  });
});
