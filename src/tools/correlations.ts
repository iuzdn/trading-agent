import type { ClaudeToolSpec } from '../lib/claude.js';
import { withCache, TTL } from '../lib/cache.js';
import { getBars } from './alpaca.js';

/** Simple-return series from a chronological close series. */
export function dailyReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1]!;
    if (prev !== 0) out.push((closes[i]! - prev) / prev);
  }
  return out;
}

/** Pearson correlation of two equal-length series. Returns 0 when undefined. */
export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const xa = a.slice(a.length - n);
  const xb = b.slice(b.length - n);
  const ma = xa.reduce((s, v) => s + v, 0) / n;
  const mb = xb.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = xa[i]! - ma;
    const db = xb[i]! - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va === 0 || vb === 0) return 0;
  return cov / Math.sqrt(va * vb);
}

export interface CorrelationResult {
  ticker: string;
  peer: string;
  correlation: number;
}

/**
 * Pairwise daily-return correlation of `ticker` vs each `peers` symbol over the
 * last ~90 sessions. Deterministic — the LLM only reads the numbers. Cached 1h.
 */
export async function getCorrelations(
  ticker: string,
  peers: string[],
  lookback = 90,
): Promise<CorrelationResult[]> {
  const unique = [...new Set(peers.map((p) => p.toUpperCase()))].filter(
    (p) => p !== ticker.toUpperCase(),
  );
  if (unique.length === 0) return [];

  return withCache(
    'get_correlations',
    { ticker: ticker.toUpperCase(), peers: unique.sort(), lookback },
    TTL.HOUR,
    async () => {
      const symbols = [ticker, ...unique];
      const barsBySymbol = await Promise.all(
        symbols.map(async (s) => dailyReturns((await getBars(s, '1Day', lookback)).map((b) => b.c))),
      );
      const base = barsBySymbol[0]!;
      return unique.map((peer, i) => ({
        ticker: ticker.toUpperCase(),
        peer,
        correlation: Math.round(pearson(base, barsBySymbol[i + 1]!) * 1000) / 1000,
      }));
    },
  );
}

export const getCorrelationsTool: ClaudeToolSpec = {
  name: 'get_correlations',
  description:
    'Compute daily-return correlation of a ticker against a list of peer symbols (e.g. current holdings) over ~90 sessions. Used to assess concentration/diversification risk.',
  input_schema: {
    type: 'object',
    properties: {
      ticker: { type: 'string' },
      peers: { type: 'array', items: { type: 'string' } },
    },
    required: ['ticker', 'peers'],
  },
  execute: async (input) => {
    const { ticker, peers } = input as { ticker: string; peers: string[] };
    return getCorrelations(ticker, peers ?? []);
  },
};
