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
    description: 'Compute momentum indicators for a symbol: 20d/50d moving averages, 20d/50d/63d returns, whether price is above each MA. Primary ranking signal is ret63 (3-month return); use ret20 only as a tiebreaker. Call this before any buy/sell decision.',
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
    description: 'Place a buy or sell market order. Use notional (USD amount) rather than qty when possible. One order per symbol per run. ALWAYS check risk controls before calling this.',
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
  {
    name: 'get_clock',
    description: 'Check whether the US equity market is currently open. Crypto trades 24/7, but equity orders will be rejected when the market is closed. Call this before placing equity orders if uncertain.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

// ── Tool Executors ─────────────────────────────────────────────────────────
export async function executeTool(name, input, runState = {}) {

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
      // 80 bars covers 63-day return + buffer for missing days.
      const bars = await alpaca.getBars(input.symbol, '1Day', 80);
      const momentum = alpaca.computeMomentum(bars);
      if (!momentum) return { error: 'Not enough data' };
      return { symbol: input.symbol, ...momentum };
    }

    case 'place_order': {
      if (!runState.orderedSymbols) runState.orderedSymbols = new Set();
      if (runState.orderedSymbols.has(input.symbol)) {
        return { error: `Already placed an order for ${input.symbol} this run. One order per symbol per run.` };
      }

      if (input.side === 'buy') {
        const isCrypto = input.symbol.includes('/');

        // Block equity buys when the US market is closed (crypto trades 24/7).
        if (!isCrypto) {
          try {
            const clock = await alpaca.getClock();
            if (!clock.is_open) {
              return { error: `Order rejected: US equity market is closed. Next open: ${clock.next_open}.` };
            }
          } catch (e) {
            // Clock check is best-effort — don't block trading on Alpaca infra hiccups.
          }
        }

        // Resolve notional from qty if needed, so cap math works either way.
        let notional = input.notional ? parseFloat(input.notional) : null;
        if (!notional && input.qty) {
          try {
            const trade = await alpaca.getLatestTrade(input.symbol);
            const price = trade?.p ?? trade?.price;
            if (price) notional = parseFloat(input.qty) * parseFloat(price);
          } catch {}
        }

        if (notional) {
          const acc = await alpaca.getAccount();
          const equity = parseFloat(acc.equity);
          const cash = parseFloat(acc.cash);
          const maxPct = parseFloat(process.env.MAX_POSITION_PCT || '0.10');
          const cap = equity * maxPct;

          let existingValue = 0;
          try {
            const positions = await alpaca.getPositions();
            const existing = positions.find(p => p.symbol === input.symbol);
            if (existing) existingValue = parseFloat(existing.market_value);
          } catch {}

          const projected = existingValue + notional;
          if (projected > cap) {
            return {
              error: `Order rejected: position would reach $${projected.toFixed(2)}, exceeds ${(maxPct * 100).toFixed(0)}% cap of $${cap.toFixed(2)} (equity $${equity.toFixed(2)}). Existing position: $${existingValue.toFixed(2)}; requested buy: $${notional.toFixed(2)}.`,
            };
          }
          if (notional > cash) {
            return {
              error: `Order rejected: notional $${notional.toFixed(2)} exceeds available cash $${cash.toFixed(2)}.`,
            };
          }
        }
      }

      const result = await alpaca.placeOrder(input);
      runState.orderedSymbols.add(input.symbol);
      return result;
    }

    case 'close_position': {
      return alpaca.closePosition(input.symbol);
    }

    case 'cancel_all_orders': {
      return alpaca.cancelAllOrders();
    }

    case 'get_clock': {
      const clock = await alpaca.getClock();
      return {
        is_open: clock.is_open,
        next_open: clock.next_open,
        next_close: clock.next_close,
        timestamp: clock.timestamp,
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
