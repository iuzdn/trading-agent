// Tool definitions for Claude + their executor functions

import * as alpaca from './alpaca.js';

// ── Tool Definitions (passed to Claude API) ────────────────────────────────
export const TOOLS = [
  {
    name: 'get_account',
    description: 'Get current account info: equity, cash, buying power, daily P&L, portfolio value.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_positions',
    description: 'List all open positions with symbol, qty, market value, unrealized P&L, and cost basis.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_orders',
    description: 'List open or recent orders.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Order status filter' },
      },
      required: [],
    },
  },
  {
    name: 'get_bars',
    description: 'Get OHLCV price bars for a symbol. Use timeframe 1Day for daily momentum calculations. For crypto use format BTC/USD.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Ticker e.g. AAPL, SPY, BTC/USD, ETH/USD' },
        timeframe: { type: 'string', enum: ['1Min', '5Min', '15Min', '1Hour', '1Day'], default: '1Day' },
        limit: { type: 'number', description: 'Number of bars to fetch (max 200)', default: 60 },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_latest_price',
    description: 'Get the current price for a symbol.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Ticker e.g. AAPL, BTC/USD' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'compute_momentum',
    description: 'Compute momentum indicators for a symbol: 20d/50d moving averages, 20d/50d returns, whether price is above each MA. Use this before making any buy/sell decision.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'place_order',
    description: 'Place a buy or sell market order. Use notional (USD amount) rather than qty when possible. ALWAYS check risk controls before calling this.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        side: { type: 'string', enum: ['buy', 'sell'] },
        notional: { type: 'number', description: 'USD amount to buy/sell (preferred)' },
        qty: { type: 'number', description: 'Number of shares/coins (use only if notional not applicable)' },
      },
      required: ['symbol', 'side'],
    },
  },
  {
    name: 'close_position',
    description: 'Close an entire position for a symbol.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'cancel_all_orders',
    description: 'Cancel all open orders. Use when entering risk-off / kill-switch mode.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

// ── Tool Executors ─────────────────────────────────────────────────────────
export async function executeTool(name, input) {
  const MAX_TRADE = parseFloat(process.env.MAX_TRADE_USD || '500');

  switch (name) {
    case 'get_account': {
      const acc = await alpaca.getAccount();
      return {
        equity: parseFloat(acc.equity),
        cash: parseFloat(acc.cash),
        buying_power: parseFloat(acc.buying_power),
        portfolio_value: parseFloat(acc.portfolio_value),
        daytrade_count: acc.daytrade_count,
        daily_pl: parseFloat(acc.equity) - parseFloat(acc.last_equity),
        daily_pl_pct: ((parseFloat(acc.equity) - parseFloat(acc.last_equity)) / parseFloat(acc.last_equity) * 100).toFixed(2) + '%',
      };
    }

    case 'get_positions': {
      const positions = await alpaca.getPositions();
      return positions.map(p => ({
        symbol: p.symbol,
        qty: parseFloat(p.qty),
        market_value: parseFloat(p.market_value),
        unrealized_pl: parseFloat(p.unrealized_pl),
        unrealized_pl_pct: (parseFloat(p.unrealized_plpc) * 100).toFixed(2) + '%',
        avg_cost: parseFloat(p.avg_entry_price),
        current_price: parseFloat(p.current_price),
      }));
    }

    case 'get_orders': {
      return alpaca.getOrders(input.status || 'open');
    }

    case 'get_bars': {
      const bars = await alpaca.getBars(input.symbol, input.timeframe || '1Day', input.limit || 60);
      // Return condensed version
      return bars?.slice(-10).map(b => ({
        t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v
      }));
    }

    case 'get_latest_price': {
      try {
        const trade = await alpaca.getLatestTrade(input.symbol);
        return { symbol: input.symbol, price: trade.p || trade.price };
      } catch {
        const quote = await alpaca.getLatestQuote(input.symbol);
        return { symbol: input.symbol, price: (quote.ap + quote.bp) / 2 };
      }
    }

    case 'compute_momentum': {
      const bars = await alpaca.getBars(input.symbol, '1Day', 60);
      const momentum = alpaca.computeMomentum(bars);
      if (!momentum) return { error: 'Not enough data' };
      return { symbol: input.symbol, ...momentum };
    }

    case 'place_order': {
      // Hard risk check
      if (input.notional && input.notional > MAX_TRADE) {
        return { error: `Blocked: notional $${input.notional} exceeds MAX_TRADE_USD $${MAX_TRADE}. Split the order or adjust config.` };
      }
      return alpaca.placeOrder(input);
    }

    case 'close_position': {
      return alpaca.closePosition(input.symbol);
    }

    case 'cancel_all_orders': {
      return alpaca.cancelAllOrders();
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
