import { describe, it, expect } from 'vitest';
import { sma, ema, rsi, macd, keyLevels, momentumScore } from '../../src/tools/indicators.js';

describe('sma', () => {
  it('returns rolling means of correct length', () => {
    const out = sma([1, 2, 3, 4, 5], 3);
    expect(out).toEqual([2, 3, 4]);
  });
  it('returns empty when input shorter than period', () => {
    expect(sma([1, 2], 5)).toEqual([]);
  });
});

describe('ema', () => {
  it('first value equals SMA of seed window', () => {
    const out = ema([1, 2, 3, 4, 5], 3);
    expect(out[0]).toBeCloseTo(2, 6);
    expect(out.length).toBe(3);
  });
  it('grows monotonically on increasing input', () => {
    const out = ema([10, 11, 12, 13, 14, 15, 16, 17, 18, 19], 4);
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!).toBeGreaterThan(out[i - 1]!);
    }
  });
});

describe('rsi', () => {
  it('returns 100 when all moves are gains', () => {
    const series = Array.from({ length: 30 }, (_, i) => 100 + i);
    const out = rsi(series, 14);
    expect(out[out.length - 1]).toBe(100);
  });
  it('returns 0 when all moves are losses', () => {
    const series = Array.from({ length: 30 }, (_, i) => 100 - i);
    const out = rsi(series, 14);
    expect(out[out.length - 1]).toBeCloseTo(0, 5);
  });
  it('returns empty when series shorter than period', () => {
    expect(rsi([1, 2, 3], 14)).toEqual([]);
  });
});

describe('macd', () => {
  it('produces aligned macd/signal/histogram arrays', () => {
    const series = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 5) * 5);
    const r = macd(series);
    expect(r.macd.length).toBe(r.signal.length);
    expect(r.histogram.length).toBe(r.signal.length);
    // last histogram = last macd - last signal
    const last = r.macd.length - 1;
    expect(r.histogram[last]).toBeCloseTo(r.macd[last]! - r.signal[last]!, 8);
  });
});

describe('keyLevels', () => {
  it('finds support below and resistance above last close', () => {
    const bars = [
      { h: 105, l: 95, c: 100 },
      { h: 110, l: 100, c: 108 },
      { h: 115, l: 105, c: 110 }, // pivot high
      { h: 112, l: 102, c: 105 },
      { h: 108, l: 95, c: 102 },
      { h: 104, l: 92, c: 96 }, // pivot low
      { h: 110, l: 95, c: 108 },
      { h: 115, l: 100, c: 113 },
      { h: 118, l: 108, c: 115 }, // pivot high
      { h: 116, l: 110, c: 112 },
      { h: 114, l: 105, c: 107 },
    ];
    const r = keyLevels(bars, 20, 2, 3);
    for (const s of r.support) expect(s).toBeLessThan(107);
    for (const x of r.resistance) expect(x).toBeGreaterThan(107);
  });
});

describe('momentumScore', () => {
  it('positive on uptrend, negative on downtrend', () => {
    const up = Array.from({ length: 80 }, (_, i) => 100 + i);
    const down = Array.from({ length: 80 }, (_, i) => 200 - i);
    expect(momentumScore(up)).toBeGreaterThan(0);
    expect(momentumScore(down)).toBeLessThan(0);
  });
  it('zero on too-short input', () => {
    expect(momentumScore([1, 2, 3])).toBe(0);
  });
  it('bounded in [-100, 100]', () => {
    const s = Array.from({ length: 80 }, (_, i) => 100 * Math.pow(1.1, i));
    expect(momentumScore(s)).toBeLessThanOrEqual(100);
    expect(momentumScore(s)).toBeGreaterThanOrEqual(-100);
  });
});
