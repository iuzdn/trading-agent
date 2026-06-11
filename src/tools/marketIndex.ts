import type { ClaudeToolSpec } from '../lib/claude.js';
import { withCache, TTL } from '../lib/cache.js';
import { getBars, type Bar } from './alpaca.js';
import { sma } from './indicators.js';

const INDEX_SYMBOLS = ['SPY', 'QQQ', 'IWM', 'TLT', 'GLD'] as const;
export type IndexSymbol = (typeof INDEX_SYMBOLS)[number];

/** Daily bars for a market-index ETF, cached 15 min (ARCHITECTURE §5.2). */
export async function getIndexData(symbol: string, limit = 250): Promise<Bar[]> {
  return withCache('get_index_data', { symbol, limit }, TTL.FIFTEEN_MIN, async () =>
    getBars(symbol, '1Day', limit),
  );
}

/**
 * Deterministic trend read: is the latest close above or below its `period`-bar
 * SMA? Throws on insufficient history so a bad fetch can't silently flip the
 * regime. Pure — unit-tested.
 */
export function trendVsSma(closes: number[], period = 200): 'above' | 'below' {
  if (closes.length < period) {
    throw new Error(`trendVsSma needs ≥${period} closes (got ${closes.length})`);
  }
  const series = sma(closes, period);
  const ma = series[series.length - 1];
  const last = closes[closes.length - 1];
  if (ma === undefined || last === undefined) {
    throw new Error('trendVsSma: empty SMA series');
  }
  return last >= ma ? 'above' : 'below';
}

export const getIndexDataTool: ClaudeToolSpec = {
  name: 'get_index_data',
  description:
    'Fetch daily OHLCV bars for a market-index ETF (SPY, QQQ, IWM, TLT, GLD) from Alpaca, for macro regime analysis. Returns recent bars in chronological order.',
  input_schema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        enum: [...INDEX_SYMBOLS],
        description: 'Index ETF symbol',
      },
      limit: { type: 'number', description: 'Number of daily bars (max 1000)' },
    },
    required: ['symbol'],
  },
  execute: async (input) => {
    const { symbol, limit } = input as { symbol: string; limit?: number };
    return getIndexData(symbol, Math.min(limit ?? 250, 1000));
  },
};
