import type { ClaudeToolSpec } from '../lib/claude.js';
import { withCache, TTL } from '../lib/cache.js';
import { request, DATA_URL } from './alpaca.js';
import { logger } from '../lib/logger.js';

/**
 * Alpaca screener API (v1beta1). Universe source for the Scout: top market
 * movers (gainers) and most-active stocks by volume. Responses are parsed
 * defensively — the entry schema isn't pinned in the docs.
 */

export interface ScreenedSymbol {
  symbol: string;
  price?: number;
  percentChange?: number;
  volume?: number;
}

interface MoverEntry {
  symbol?: string;
  price?: number;
  change?: number;
  percent_change?: number;
}

interface MostActiveEntry {
  symbol?: string;
  volume?: number;
  trade_count?: number;
}

function normalizeMover(e: MoverEntry): ScreenedSymbol | null {
  if (!e.symbol) return null;
  return {
    symbol: e.symbol.toUpperCase(),
    ...(typeof e.price === 'number' ? { price: e.price } : {}),
    ...(typeof e.percent_change === 'number' ? { percentChange: e.percent_change } : {}),
  };
}

/** Top gainers from the movers screener (losers ignored — system is long-only). */
export async function getMovers(top = 25): Promise<ScreenedSymbol[]> {
  return withCache('get_movers', { top }, TTL.FIFTEEN_MIN, async () => {
    const data = await request<{ gainers?: MoverEntry[]; losers?: MoverEntry[] }>(
      `${DATA_URL}/v1beta1/screener/stocks/movers?top=${Math.min(top, 50)}`,
    );
    logger.debug({ gainers: data.gainers?.length, losers: data.losers?.length }, 'movers fetched');
    return (data.gainers ?? [])
      .map(normalizeMover)
      .filter((s): s is ScreenedSymbol => s !== null);
  });
}

export async function getMostActives(top = 25): Promise<ScreenedSymbol[]> {
  return withCache('get_most_actives', { top }, TTL.FIFTEEN_MIN, async () => {
    const data = await request<{ most_actives?: MostActiveEntry[] }>(
      `${DATA_URL}/v1beta1/screener/stocks/most-actives?by=volume&top=${Math.min(top, 100)}`,
    );
    logger.debug({ count: data.most_actives?.length }, 'most-actives fetched');
    return (data.most_actives ?? [])
      .filter((e): e is MostActiveEntry & { symbol: string } => Boolean(e.symbol))
      .map((e) => ({
        symbol: e.symbol.toUpperCase(),
        ...(typeof e.volume === 'number' ? { volume: e.volume } : {}),
      }));
  });
}

export const getMarketMoversTool: ClaudeToolSpec = {
  name: 'get_market_movers',
  description:
    'Fetch the top US-equity market gainers and most-active stocks by volume from the Alpaca screener. Returns symbols with price/percent-change/volume where available.',
  input_schema: {
    type: 'object',
    properties: {
      top: { type: 'number', description: 'How many of each list to fetch (max 50)' },
    },
  },
  execute: async (input) => {
    const { top } = input as { top?: number };
    const [movers, actives] = await Promise.all([
      getMovers(top ?? 25),
      getMostActives(top ?? 25),
    ]);
    return { gainers: movers, mostActives: actives };
  },
};
