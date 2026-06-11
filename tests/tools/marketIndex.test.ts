import { describe, it, expect } from 'vitest';
import { trendVsSma } from '../../src/tools/marketIndex.js';

describe('trendVsSma', () => {
  it('returns "above" when the latest close is above its SMA', () => {
    // Steadily rising series → last close well above the 200-bar mean.
    const closes = Array.from({ length: 250 }, (_, i) => 100 + i);
    expect(trendVsSma(closes, 200)).toBe('above');
  });

  it('returns "below" when the latest close is below its SMA', () => {
    // Steadily falling series → last close below the 200-bar mean.
    const closes = Array.from({ length: 250 }, (_, i) => 100 - i * 0.2);
    expect(trendVsSma(closes, 200)).toBe('below');
  });

  it('treats a close equal to the SMA as "above" (>=)', () => {
    const closes = Array.from({ length: 200 }, () => 50);
    expect(trendVsSma(closes, 200)).toBe('above');
  });

  it('throws on insufficient history', () => {
    expect(() => trendVsSma([1, 2, 3], 200)).toThrow(/needs/);
  });
});
