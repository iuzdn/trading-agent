/**
 * Kelly-fraction position sizing capped at user max position %.
 *
 * Inputs:
 *  - confidence: PM confidence in [0, 100]
 *  - entryPrice, stopLoss: defines per-share risk
 *  - takeProfit: defines per-share reward
 *  - equity: portfolio equity in USD
 *  - maxPctOfEquity: hard cap in percent (e.g. 15)
 *
 * Output: { sizeUsd, sizePctOfEquity, kellyFraction }
 *
 * Pure function. No I/O.
 */

export interface SizingInput {
  confidence: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  equity: number;
  maxPctOfEquity: number;
  kellyShrinkage?: number; // default 0.5 (half-Kelly) — Kelly alone is too aggressive
}

export interface SizingOutput {
  sizeUsd: number;
  sizePctOfEquity: number;
  kellyFraction: number;
}

export function computePositionSize(input: SizingInput): SizingOutput {
  const {
    confidence,
    entryPrice,
    stopLoss,
    takeProfit,
    equity,
    maxPctOfEquity,
    kellyShrinkage = 0.5,
  } = input;

  if (equity <= 0) return { sizeUsd: 0, sizePctOfEquity: 0, kellyFraction: 0 };
  if (entryPrice <= 0 || stopLoss <= 0 || takeProfit <= 0) {
    return { sizeUsd: 0, sizePctOfEquity: 0, kellyFraction: 0 };
  }

  const risk = Math.abs(entryPrice - stopLoss) / entryPrice;
  const reward = Math.abs(takeProfit - entryPrice) / entryPrice;
  if (risk <= 0 || reward <= 0) {
    return { sizeUsd: 0, sizePctOfEquity: 0, kellyFraction: 0 };
  }

  // Win probability ~ confidence / 100, clipped to [0.45, 0.85] to avoid extremes.
  const p = Math.max(0.45, Math.min(0.85, confidence / 100));
  const q = 1 - p;
  const b = reward / risk;

  const fullKelly = (b * p - q) / b;
  const shrunk = Math.max(0, fullKelly * kellyShrinkage);

  const pctCap = maxPctOfEquity / 100;
  const finalPct = Math.min(shrunk, pctCap);
  const sizeUsd = Math.round(equity * finalPct * 100) / 100;
  return {
    sizeUsd,
    sizePctOfEquity: Math.round(finalPct * 10000) / 100,
    kellyFraction: Math.round(shrunk * 10000) / 100,
  };
}
