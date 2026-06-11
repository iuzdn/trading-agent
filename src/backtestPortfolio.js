// Simulated portfolio for the backtest. Mirrors the real risk controls in
// src/tools.js (place_order cap) and src/agent.js (trailing stop, kill switch),
// and adds backtest-only improvements: position trim, cooldown after stops,
// min-trade threshold.

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export class BacktestPortfolio {
  constructor({ startingCash, slippageBps, config }) {
    this.cash = startingCash;
    this.startingCash = startingCash;
    this.positions = {}; // symbol -> { qty, avgEntryPrice, highWaterMark }
    this.trades = [];
    this.slippage = slippageBps / 10000;
    this.config = config;
    this.killSwitchActive = false;
    this.cooldownUntil = {}; // symbol -> 'YYYY-MM-DD' inclusive
  }

  markToMarket(prices) {
    let val = this.cash;
    for (const [sym, pos] of Object.entries(this.positions)) {
      const p = prices[sym];
      if (p != null) val += pos.qty * p;
    }
    return val;
  }

  positionValue(symbol, prices) {
    const pos = this.positions[symbol];
    if (!pos) return 0;
    const p = prices[symbol];
    return p != null ? pos.qty * p : 0;
  }

  // Buy at close + slippage. Caps notional at MAX_POSITION_PCT of equity (matches
  // tools.js:205) and at available cash. Returns the actual notional spent.
  // Honors cooldown after stops, and a minimum-trade threshold to suppress
  // sub-1%-of-equity rebalance noise.
  buy({ symbol, notional, closePrice, date, reason, equity }) {
    if (this.killSwitchActive) return 0;
    if (notional <= 0) return 0;
    if (this.cooldownUntil[symbol] && this.cooldownUntil[symbol] >= date) return 0;

    const minTrade = (this.config.minTradePct || 0) * equity;
    if (notional < minTrade) return 0;

    const fillPrice = closePrice * (1 + this.slippage);

    const cap = equity * this.config.maxPositionPct;
    const existingValue = this.positionValue(symbol, { [symbol]: closePrice });
    const allowedByCap = Math.max(0, cap - existingValue);
    const allowedByCash = this.cash;
    const spend = Math.min(notional, allowedByCap, allowedByCash);
    if (spend <= 0) return 0;
    if (spend < minTrade) return 0;

    const qty = spend / fillPrice;
    const existing = this.positions[symbol];
    if (existing) {
      const newQty = existing.qty + qty;
      const newAvg = (existing.qty * existing.avgEntryPrice + qty * fillPrice) / newQty;
      existing.qty = newQty;
      existing.avgEntryPrice = newAvg;
      existing.highWaterMark = Math.max(existing.highWaterMark, fillPrice);
    } else {
      this.positions[symbol] = {
        qty,
        avgEntryPrice: fillPrice,
        highWaterMark: fillPrice,
      };
    }
    this.cash -= spend;
    this.trades.push({
      date, symbol, side: 'buy', qty, fillPrice, notional: spend, reason, pnl: 0,
    });
    return spend;
  }

  // Sell down part of a position (no cooldown set — this is a rebalance trim,
  // not a stop). Used by the Fix 1 trim logic to cap concentration.
  trim({ symbol, sellNotional, closePrice, date }) {
    const pos = this.positions[symbol];
    if (!pos || sellNotional <= 0) return 0;
    const fillPrice = closePrice * (1 - this.slippage);
    const qtyToSell = Math.min(pos.qty, sellNotional / fillPrice);
    if (qtyToSell <= 0) return 0;
    const proceeds = qtyToSell * fillPrice;
    const cost = qtyToSell * pos.avgEntryPrice;
    const pnl = proceeds - cost;
    this.cash += proceeds;
    pos.qty -= qtyToSell;
    this.trades.push({
      date, symbol, side: 'sell', qty: qtyToSell, fillPrice, notional: proceeds, reason: 'trim', pnl,
    });
    if (pos.qty <= 1e-9) delete this.positions[symbol];
    return proceeds;
  }

  // Close entire position at close - slippage. Returns realized P&L.
  closePosition({ symbol, closePrice, date, reason }) {
    const pos = this.positions[symbol];
    if (!pos) return 0;
    const fillPrice = closePrice * (1 - this.slippage);
    const proceeds = pos.qty * fillPrice;
    const cost = pos.qty * pos.avgEntryPrice;
    const pnl = proceeds - cost;
    this.cash += proceeds;
    this.trades.push({
      date, symbol, side: 'sell', qty: pos.qty, fillPrice, notional: proceeds, reason, pnl,
    });
    delete this.positions[symbol];
    return pnl;
  }

  // Update HWM to max(prev, currentClose) for every held position.
  updateHighWaterMarks(prices) {
    for (const [sym, pos] of Object.entries(this.positions)) {
      const p = prices[sym];
      if (p == null) continue;
      if (p > pos.highWaterMark) pos.highWaterMark = p;
    }
  }

  // Mirrors processTrailingStops in agent.js. equityMarketOpen=false skips
  // equity positions for that day (weekends/holidays). Crypto always evaluated.
  // Sets a cooldown on each stopped symbol to prevent same-week re-entry.
  applyTrailingStops({ prices, date, equityMarketOpen }) {
    const closes = [];
    const threshold = this.config.trailingStopPct;
    const cooldown = this.config.cooldownDays || 0;
    for (const sym of Object.keys(this.positions)) {
      const isCrypto = sym.includes('/');
      if (!isCrypto && !equityMarketOpen) continue;
      const p = prices[sym];
      if (p == null) continue;
      const pos = this.positions[sym];
      const drawdown = (pos.highWaterMark - p) / pos.highWaterMark;
      if (drawdown > threshold) {
        this.closePosition({ symbol: sym, closePrice: p, date, reason: 'trailing_stop' });
        if (cooldown > 0) this.cooldownUntil[sym] = addDays(date, cooldown);
        closes.push(sym);
      }
    }
    return closes;
  }

  // Mirrors checkKillSwitch in agent.js. Triggers if today's mark-to-market is
  // below previous-day equity by more than DAILY_LOSS_LIMIT_PCT. When it fires,
  // liquidate everything and lock the rest of the day. Each liquidated symbol
  // gets a cooldown to prevent immediate re-entry the next session.
  applyKillSwitch({ prevEquity, currentEquity, prices, date }) {
    if (!prevEquity) return false;
    const dailyPct = (currentEquity - prevEquity) / prevEquity;
    if (dailyPct >= -this.config.dailyLossLimitPct) return false;
    this.killSwitchActive = true;
    const cooldown = this.config.cooldownDays || 0;
    for (const sym of Object.keys(this.positions)) {
      const p = prices[sym];
      if (p == null) continue;
      this.closePosition({ symbol: sym, closePrice: p, date, reason: 'kill_switch' });
      if (cooldown > 0) this.cooldownUntil[sym] = addDays(date, cooldown);
    }
    return true;
  }

  resetKillSwitchForNewDay() {
    this.killSwitchActive = false;
  }
}
