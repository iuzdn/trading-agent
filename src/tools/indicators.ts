/**
 * Pure deterministic indicator math. No LLM. No I/O.
 * All inputs assumed in chronological order (oldest → newest).
 */

export function sma(values: number[], period: number): number[] {
  if (period <= 0) throw new Error('period must be > 0');
  const out: number[] = [];
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i]!;
  out.push(sum / period);
  for (let i = period; i < values.length; i++) {
    sum += values[i]! - values[i - period]!;
    out.push(sum / period);
  }
  return out;
}

export function ema(values: number[], period: number): number[] {
  if (period <= 0) throw new Error('period must be > 0');
  const out: number[] = [];
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  // Seed with SMA of first `period` values for stability.
  let prev = 0;
  for (let i = 0; i < period; i++) prev += values[i]!;
  prev /= period;
  out.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/** Wilder's RSI. Returns one value per input bar from index `period` onward. */
export function rsi(values: number[], period = 14): number[] {
  if (period <= 0) throw new Error('period must be > 0');
  if (values.length <= period) return [];

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = values[i]! - values[i - 1]!;
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  const out: number[] = [];
  out.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i]! - values[i - 1]!;
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
  }
  return out;
}

export interface MacdResult {
  macd: number[];
  signal: number[];
  histogram: number[];
}

/**
 * MACD(fast=12, slow=26, signal=9). All series are aligned to the slowest one
 * (so macd[i] / signal[i] / histogram[i] correspond to the same bar).
 */
export function macd(
  values: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): MacdResult {
  const emaFast = ema(values, fast);
  const emaSlow = ema(values, slow);
  // ema(values, fast) starts at index `fast`, ema(values, slow) starts at `slow`.
  // Trim the fast EMA so both align on the slow start.
  const offset = slow - fast;
  const fastAligned = emaFast.slice(offset);
  const macdLine: number[] = [];
  for (let i = 0; i < emaSlow.length; i++) {
    macdLine.push(fastAligned[i]! - emaSlow[i]!);
  }
  const signal = ema(macdLine, signalPeriod);
  const signalOffset = macdLine.length - signal.length;
  const histogram: number[] = signal.map((s, i) => macdLine[i + signalOffset]! - s);
  return {
    macd: macdLine.slice(signalOffset),
    signal,
    histogram,
  };
}

/**
 * Identify support and resistance levels from recent swing highs/lows.
 * Returns the most recent `count` distinct levels in each direction.
 */
export function keyLevels(
  bars: Array<{ h: number; l: number; c: number }>,
  lookback = 60,
  swingWindow = 5,
  count = 3,
): { support: number[]; resistance: number[] } {
  const slice = bars.slice(-lookback);
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = swingWindow; i < slice.length - swingWindow; i++) {
    const h = slice[i]!.h;
    const l = slice[i]!.l;
    let isHigh = true;
    let isLow = true;
    for (let j = i - swingWindow; j <= i + swingWindow; j++) {
      if (j === i) continue;
      if (slice[j]!.h > h) isHigh = false;
      if (slice[j]!.l < l) isLow = false;
    }
    if (isHigh) highs.push(h);
    if (isLow) lows.push(l);
  }
  const lastClose = slice[slice.length - 1]?.c ?? 0;
  const resistance = highs
    .filter((h) => h > lastClose)
    .sort((a, b) => a - b)
    .slice(0, count);
  const support = lows
    .filter((l) => l < lastClose)
    .sort((a, b) => b - a)
    .slice(0, count);
  return { support, resistance };
}

/**
 * Composite momentum score in [-100, +100] derived from short/long return
 * ratio. Mirrors the existing JS computeMomentum approach for consistency.
 */
export function momentumScore(values: number[]): number {
  if (values.length < 63) return 0;
  const last = values[values.length - 1]!;
  const ref20 = values[values.length - 20]!;
  const ref63 = values[values.length - 63]!;
  const ret20 = (last - ref20) / ref20;
  const ret63 = (last - ref63) / ref63;
  // Blend; clip to [-1, 1] then scale.
  const blended = 0.4 * ret20 + 0.6 * ret63;
  const clipped = Math.max(-1, Math.min(1, blended * 2));
  return Math.round(clipped * 100);
}
