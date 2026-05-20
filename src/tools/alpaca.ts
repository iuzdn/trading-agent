import type { ClaudeToolSpec } from '../lib/claude.js';
import { withCache, TTL } from '../lib/cache.js';
import { logger } from '../lib/logger.js';

const PAPER_URL = 'https://paper-api.alpaca.markets';
const LIVE_URL = 'https://api.alpaca.markets';
const DATA_URL = 'https://data.alpaca.markets';

function isPaper(): boolean {
  // Default to paper unless ALPACA_PAPER is explicitly 'false' AND TRADING_MODE is 'live'.
  const paperEnv = process.env.ALPACA_PAPER;
  const mode = process.env.TRADING_MODE;
  if (mode !== 'live') return true;
  return paperEnv !== 'false';
}

function baseUrl(): string {
  return isPaper() ? PAPER_URL : LIVE_URL;
}

function headers(): Record<string, string> {
  const key = process.env.ALPACA_API_KEY;
  const secret = process.env.ALPACA_API_SECRET ?? process.env.ALPACA_SECRET_KEY;
  if (!key || !secret) throw new Error('Alpaca credentials missing');
  return {
    'APCA-API-KEY-ID': key,
    'APCA-API-SECRET-KEY': secret,
    'Content-Type': 'application/json',
  };
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, headers: { ...headers(), ...(init.headers ?? {}) } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Alpaca ${res.status} ${res.statusText}: ${body}`);
  }
  return res.json() as Promise<T>;
}

// ─── Tool: get_bars ───────────────────────────────────────────────────────
export interface Bar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export async function getBars(
  ticker: string,
  timeframe: string,
  limit: number,
): Promise<Bar[]> {
  return withCache(
    'get_bars',
    { ticker, timeframe, limit },
    TTL.MINUTE,
    async () => {
      const start = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
        .toISOString()
        .split('T')[0];
      const url = `${DATA_URL}/v2/stocks/${encodeURIComponent(
        ticker,
      )}/bars?timeframe=${timeframe}&limit=${limit}&start=${start}&feed=iex`;
      const data = await request<{ bars?: Bar[] }>(url);
      return data.bars ?? [];
    },
  );
}

export const getBarsTool: ClaudeToolSpec = {
  name: 'get_bars',
  description:
    'Fetch OHLCV bars for a US-listed equity from Alpaca. Returns recent bars in chronological order.',
  input_schema: {
    type: 'object',
    properties: {
      ticker: { type: 'string', description: 'Ticker symbol, e.g. NVDA' },
      timeframe: {
        type: 'string',
        enum: ['1Min', '5Min', '15Min', '1Hour', '1Day'],
        description: 'Bar size',
      },
      limit: { type: 'number', description: 'Number of bars (max 1000)' },
    },
    required: ['ticker', 'timeframe', 'limit'],
  },
  execute: async (input) => {
    const { ticker, timeframe, limit } = input as {
      ticker: string;
      timeframe: string;
      limit: number;
    };
    return getBars(ticker, timeframe, Math.min(limit, 1000));
  },
};

// ─── Tool: get_portfolio_state ────────────────────────────────────────────
export interface PortfolioStateRaw {
  equity: number;
  cash: number;
  buyingPower: number;
  dayTradeCount: number;
  positions: Array<{
    symbol: string;
    qty: number;
    marketValue: number;
    costBasis: number;
    unrealizedPl: number;
    unrealizedPlPct: number;
  }>;
}

export async function getPortfolioState(): Promise<PortfolioStateRaw> {
  // No cache — always fresh per ARCHITECTURE §5.2.
  const [acc, positions] = await Promise.all([
    request<{
      equity: string;
      cash: string;
      buying_power: string;
      daytrade_count: number;
    }>(`${baseUrl()}/v2/account`),
    request<
      Array<{
        symbol: string;
        qty: string;
        market_value: string;
        cost_basis: string;
        unrealized_pl: string;
        unrealized_plpc: string;
      }>
    >(`${baseUrl()}/v2/positions`),
  ]);
  return {
    equity: parseFloat(acc.equity),
    cash: parseFloat(acc.cash),
    buyingPower: parseFloat(acc.buying_power),
    dayTradeCount: acc.daytrade_count,
    positions: positions.map((p) => ({
      symbol: p.symbol,
      qty: parseFloat(p.qty),
      marketValue: parseFloat(p.market_value),
      costBasis: parseFloat(p.cost_basis),
      unrealizedPl: parseFloat(p.unrealized_pl),
      unrealizedPlPct: parseFloat(p.unrealized_plpc),
    })),
  };
}

export const getPortfolioStateTool: ClaudeToolSpec = {
  name: 'get_portfolio_state',
  description:
    'Fetch the current Alpaca account state: equity, cash, buying power, day-trade count, and open positions.',
  input_schema: { type: 'object', properties: {} },
  execute: async () => getPortfolioState(),
};

// ─── place_order with bracket OCO ─────────────────────────────────────────
export interface PlaceBracketOrderArgs {
  ticker: string;
  side: 'buy' | 'sell';
  qty: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  timeInForce?: 'day' | 'gtc';
}

export interface AlpacaOrder {
  id: string;
  status: string;
  filled_qty?: string;
  filled_avg_price?: string | null;
  legs?: AlpacaOrder[];
  submitted_at?: string;
}

export async function placeBracketOrder(args: PlaceBracketOrderArgs): Promise<AlpacaOrder> {
  if (!isPaper() && process.env.TRADING_MODE !== 'live') {
    throw new Error(
      'Refusing to place live order: set TRADING_MODE=live explicitly to enable',
    );
  }
  const body = {
    symbol: args.ticker,
    qty: String(args.qty),
    side: args.side,
    type: 'limit',
    time_in_force: args.timeInForce ?? 'day',
    limit_price: String(args.entryPrice),
    order_class: 'bracket',
    take_profit: { limit_price: String(args.takeProfit) },
    stop_loss: { stop_price: String(args.stopLoss) },
  };
  logger.info({ paper: isPaper(), body }, 'placing bracket order');
  return request<AlpacaOrder>(`${baseUrl()}/v2/orders`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function getOrder(orderId: string): Promise<AlpacaOrder> {
  return request<AlpacaOrder>(`${baseUrl()}/v2/orders/${orderId}`);
}

export const placeOrderTool: ClaudeToolSpec = {
  name: 'place_order',
  description:
    'Place a bracket (entry limit + OCO stop/target) order on Alpaca. Paper by default unless TRADING_MODE=live.',
  input_schema: {
    type: 'object',
    properties: {
      ticker: { type: 'string' },
      side: { type: 'string', enum: ['buy', 'sell'] },
      qty: { type: 'number' },
      entryPrice: { type: 'number' },
      stopLoss: { type: 'number' },
      takeProfit: { type: 'number' },
    },
    required: ['ticker', 'side', 'qty', 'entryPrice', 'stopLoss', 'takeProfit'],
  },
  execute: async (input) => placeBracketOrder(input as unknown as PlaceBracketOrderArgs),
};

// Latest trade — used by Executor to determine slippage from entry hint.
export async function getLatestTrade(ticker: string): Promise<{ p: number; t: string }> {
  return withCache(
    'latest_trade',
    { ticker },
    30_000,
    async () => {
      const data = await request<{ trade: { p: number; t: string } }>(
        `${DATA_URL}/v2/stocks/${encodeURIComponent(ticker)}/trades/latest?feed=iex`,
      );
      return data.trade;
    },
  );
}

export function tradingMode(): 'paper' | 'live' {
  return isPaper() ? 'paper' : 'live';
}
