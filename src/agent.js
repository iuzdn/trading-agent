import Anthropic from '@anthropic-ai/sdk';
import { TOOLS, executeTool } from './tools.js';
import { sendAlert, formatRunSummary } from './telegram.js';
import * as alpaca from './alpaca.js';
import { loadState, saveState } from './state.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Watchlists ─────────────────────────────────────────────────────────────
// Diversified across broad indices, sector ETFs, and a handful of single-name
// leaders. Earlier all-tech list (NVDA/MSFT/AAPL/AMZN/META/TSM/ASML) had
// pairwise correlations >0.7, so "top 3" gave essentially one bet.
const EQUITY_WATCHLIST = [
  // Broad market / regime
  'SPY', 'QQQ', 'IWM',
  // Sector ETFs — rotation breadth
  'XLE', 'XLF', 'XLV', 'XLP', 'XLU', 'XLI', 'XLY', 'XLK', 'XLB',
  // Select single-name leaders (capped to avoid tech monoculture)
  'NVDA', 'MSFT',
];

const CRYPTO_WATCHLIST = [
  'BTC/USD',
  'ETH/USD',
  'SOL/USD',
];

// ── System Prompt ──────────────────────────────────────────────────────────
function buildSystemPrompt() {
  const maxPct = process.env.MAX_POSITION_PCT || '0.10';
  const lossLimit = process.env.DAILY_LOSS_LIMIT_PCT || '0.03';
  const trailPct = process.env.TRAILING_STOP_PCT || '0.08';
  const isPaper = alpaca.isPaperTrading();

  return `You are an autonomous trading agent running on ${isPaper ? 'PAPER (simulated)' : '⚠️ LIVE'} Alpaca account.

## Strategy: Dual Momentum with Regime Filter

### Regime Check (do this FIRST every run)
1. Get SPY and BTC/USD momentum.
2. If SPY is BELOW its 50-day MA → equity market is in downtrend (RISK OFF for equities).
3. If BTC is BELOW its 50-day MA → crypto market is in downtrend (RISK OFF for crypto).
4. In RISK OFF: close any long positions in that asset class, hold cash. Do NOT open new longs.

### Equity Selection (only when RISK ON)
1. Compute momentum for each symbol in: ${EQUITY_WATCHLIST.join(', ')}
2. Rank by **63-day return (ret63)** — the primary momentum signal. Use 20-day return (ret20) only as a tiebreaker when ret63 values are within ~1% of each other.
3. Only consider symbols where price is ABOVE both MA20 and MA50.
4. Target top 3 qualifying symbols. Allocate equally from available cash.

### Crypto Selection (only when RISK ON)
1. Compute momentum for BTC/USD, ETH/USD, SOL/USD. Rank by ret63 just like equities.
2. Only buy if price is above MA20 AND MA50.
3. Allocate up to 20% of total portfolio to crypto combined.

### Rebalancing Logic
- If a position has FALLEN below its MA50 → sell it.
- If a better-ranked symbol is not in portfolio → replace lowest-ranked held position.
- If position already held and still qualifies → HOLD (avoid churn).
- Note: positions may be auto-closed by the trailing-stop monitor before your turn (drawdown > ${(parseFloat(trailPct) * 100).toFixed(0)}% from post-entry high). Don't second-guess those exits — treat them as already-decided.

## Hard Risk Controls (NEVER violate these)
- Max position size: ${(parseFloat(maxPct) * 100).toFixed(0)}% of portfolio value per symbol.
- One order per symbol per run. Never place multiple orders for the same symbol in the same run.
- Daily loss kill-switch: If daily P&L% is worse than -${(parseFloat(lossLimit) * 100).toFixed(0)}%, cancel all orders, close all positions, send alert, STOP.
- Trailing stop: positions drawn down more than ${(parseFloat(trailPct) * 100).toFixed(0)}% from their post-entry high are auto-closed before each run.
- Never use leverage. Notional buys only within available cash.
- Never short. Long-only strategy.
- Never trade illiquid or unknown symbols outside the defined watchlists.

## Process for Each Run
1. Check kill-switch (get_account, check daily_pl_pct).
2. If you intend to trade equities, call get_clock first — equity orders are rejected when the US market is closed. Crypto trades 24/7.
3. Check regime (SPY + BTC momentum).
4. Review current positions.
5. Evaluate watchlist momentum.
6. Make rebalancing decisions.
7. Execute orders (use notional in USD). The place_order tool enforces the position-size cap and cash limit — if it returns an error, adjust the size and try again rather than retrying the same notional.
8. Summarize what you did and why in plain English.

Be decisive. Think step by step. Always explain your reasoning before executing any trade.
Today's date: ${new Date().toDateString()}`;
}

// ── Stop flag (set by requestStop() from index.js) ────────────────────────
let _stopRequested = false;
export function requestStop() { _stopRequested = true; }

// Returns true if the kill-switch fired (daily P&L below the configured floor),
// in which case all orders/positions have already been liquidated.
async function checkKillSwitch(log) {
  const acc = await alpaca.getAccount();
  const equity = parseFloat(acc.equity);
  const lastEquity = parseFloat(acc.last_equity);
  if (!lastEquity) return false;
  const dailyPlPct = ((equity - lastEquity) / lastEquity) * 100;
  const limit = parseFloat(process.env.DAILY_LOSS_LIMIT_PCT || '0.03') * 100;
  if (dailyPlPct >= -limit) return false;

  console.log(`\n🚨 KILL SWITCH: daily P&L ${dailyPlPct.toFixed(2)}% exceeds -${limit}%`);
  log.push({ type: 'killswitch' });
  await alpaca.cancelAllOrders().catch(() => {});
  const positions = await alpaca.getPositions().catch(() => []);
  for (const p of positions) {
    await alpaca.closePosition(p.symbol).catch(() => {});
  }
  log.push({
    type: 'summary',
    text: `🚨 KILL SWITCH triggered before run: daily P&L ${dailyPlPct.toFixed(2)}% beyond -${limit}%. Cancelled orders and closed ${positions.length} position(s).`,
  });
  await sendAlert('🚨 *KILL SWITCH TRIGGERED*\nDaily loss limit hit at run start. All positions closed.');
  return true;
}

// Updates high-water marks for held positions and closes any that have drawn
// down more than TRAILING_STOP_PCT from their post-entry high. Equity stops are
// only evaluated while the US market is open — current_price for equities is
// stale outside hours and would generate false triggers. Crypto evaluates 24/7.
async function processTrailingStops(log) {
  const threshold = parseFloat(process.env.TRAILING_STOP_PCT || '0.08');
  const positions = await alpaca.getPositions().catch(() => []);
  if (positions.length === 0) return;

  let marketOpen = true;
  try {
    const clock = await alpaca.getClock();
    marketOpen = clock.is_open;
  } catch { /* best-effort */ }

  const state = loadState();
  const hwm = { ...(state.highWaterMarks || {}) };
  const heldSymbols = new Set(positions.map(p => p.symbol));
  const closedThisRun = new Set();

  for (const p of positions) {
    const isCrypto = p.symbol.includes('/');
    const current = parseFloat(p.current_price);
    if (!current) continue;

    const prev = hwm[p.symbol] ?? parseFloat(p.avg_entry_price);
    const high = Math.max(prev, current);
    hwm[p.symbol] = high;

    if (!isCrypto && !marketOpen) continue;

    const drawdown = (high - current) / high;
    if (drawdown <= threshold) continue;

    console.log(`📉 Trailing stop: ${p.symbol} ${(drawdown * 100).toFixed(1)}% off high ($${high.toFixed(2)} → $${current.toFixed(2)})`);
    try {
      await alpaca.closePosition(p.symbol);
      log.push({
        type: 'trailing_stop',
        symbol: p.symbol,
        high: high.toFixed(2),
        current: current.toFixed(2),
        drawdown_pct: (drawdown * 100).toFixed(2),
      });
      closedThisRun.add(p.symbol);
      delete hwm[p.symbol];
    } catch (e) {
      console.error(`Trailing stop close failed for ${p.symbol}:`, e.message);
    }
  }

  // Drop high-water marks for symbols we no longer hold.
  for (const sym of Object.keys(hwm)) {
    if (!heldSymbols.has(sym) || closedThisRun.has(sym)) delete hwm[sym];
  }

  saveState({ ...state, highWaterMarks: hwm });
}

// ── Agentic Loop ───────────────────────────────────────────────────────────
export async function runAgent() {
  const log = [];
  const runState = {};
  _stopRequested = false;
  console.log(`\n🤖 Agent run started at ${new Date().toISOString()}`);

  // Eager kill-switch — runs before the model gets a turn, so a breached account
  // can never accidentally place new trades just because the model forgot to look.
  try {
    if (await checkKillSwitch(log)) {
      await sendAlert(formatRunSummary(log));
      return log;
    }
  } catch (e) {
    console.error('Kill-switch precheck failed:', e.message);
  }

  // Per-position trailing stops — also pre-model, so exits aren't subject to
  // model discretion or whether it remembered to check drawdown.
  try {
    await processTrailingStops(log);
  } catch (e) {
    console.error('Trailing-stop processing failed:', e.message);
  }

  const messages = [
    {
      role: 'user',
      content: 'Run the trading strategy now. Check the regime, review positions, and make any necessary trades. Report what you did.',
    },
  ];

  let iterations = 0;
  const MAX_ITERATIONS = 30; // Safety cap

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    if (_stopRequested) {
      console.log('\n🛑 Stop requested — exiting agent loop');
      log.push({ type: 'summary', text: 'Run stopped by manual /stop command.' });
      break;
    }

    const response = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: buildSystemPrompt(),
      tools: TOOLS,
      messages,
    });

    // Append assistant response to history
    messages.push({ role: 'assistant', content: response.content });

    // Print text blocks
    for (const block of response.content) {
      if (block.type === 'text') {
        console.log('\n💭', block.text);
      }
    }

    // If no tool calls → agent is done
    if (response.stop_reason === 'end_turn') {
      const summary = response.content.find(b => b.type === 'text')?.text || 'Run complete.';
      log.push({ type: 'summary', text: summary });
      break;
    }

    // Process tool calls
    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;

      console.log(`\n🔧 Tool: ${block.name}`, JSON.stringify(block.input));

      let result;
      try {
        result = await executeTool(block.name, block.input, runState);

        // Log trades
        if (block.name === 'place_order') {
          log.push({ type: 'trade', ...block.input });
        }

        // Kill-switch detection
        if (block.name === 'get_account' && result.daily_pl_pct) {
          const pct = parseFloat(result.daily_pl_pct);
          const limit = parseFloat(process.env.DAILY_LOSS_LIMIT_PCT || '0.03') * 100;
          if (pct < -limit) {
            console.log(`\n🚨 KILL SWITCH: daily loss ${result.daily_pl_pct} exceeds -${limit}%`);
            log.push({ type: 'killswitch' });
            await alpaca.cancelAllOrders().catch(() => {});
            // Close all positions
            const positions = await alpaca.getPositions().catch(() => []);
            for (const p of positions) {
              await alpaca.closePosition(p.symbol).catch(() => {});
            }
            await sendAlert('🚨 *KILL SWITCH TRIGGERED*\nDaily loss limit hit. All positions closed.');
            return log;
          }
        }

      } catch (err) {
        result = { error: err.message };
        console.error(`Tool error (${block.name}):`, err.message);
      }

      console.log(`   → Result:`, JSON.stringify(result).slice(0, 300));

      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }

    // Feed results back to Claude
    messages.push({ role: 'user', content: toolResults });
  }

  // Send Telegram summary
  await sendAlert(formatRunSummary(log));
  console.log('\n✅ Agent run complete\n');
  return log;
}
