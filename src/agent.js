import Anthropic from '@anthropic-ai/sdk';
import { TOOLS, executeTool } from './tools.js';
import { sendAlert, formatRunSummary } from './telegram.js';
import * as alpaca from './alpaca.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Watchlists ─────────────────────────────────────────────────────────────
const EQUITY_WATCHLIST = [
  'SPY',   // S&P 500 — regime filter
  'QQQ',   // Nasdaq
  'NVDA',  // AI/semis
  'MSFT',  // Big tech
  'AAPL',  // Big tech
  'AMZN',  // E-commerce/cloud
  'META',  // Social/AI
  'TSM',   // Semiconductors
  'ASML',  // Semis equipment
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
  const maxTrade = process.env.MAX_TRADE_USD || '500';
  const isPaper = process.env.PAPER_MODE !== 'false';

  return `You are an autonomous trading agent running on ${isPaper ? 'PAPER (simulated)' : '⚠️ LIVE'} Alpaca account.

## Strategy: Dual Momentum with Regime Filter

### Regime Check (do this FIRST every run)
1. Get SPY and BTC/USD momentum.
2. If SPY is BELOW its 50-day MA → equity market is in downtrend (RISK OFF for equities).
3. If BTC is BELOW its 50-day MA → crypto market is in downtrend (RISK OFF for crypto).
4. In RISK OFF: close any long positions in that asset class, hold cash. Do NOT open new longs.

### Equity Selection (only when RISK ON)
1. Compute momentum for each symbol in: ${EQUITY_WATCHLIST.join(', ')}
2. Rank by 20-day return (highest first).
3. Only consider symbols where price is ABOVE both MA20 and MA50.
4. Target top 3 qualifying symbols. Allocate equally from available cash.

### Crypto Selection (only when RISK ON)
1. Compute momentum for BTC/USD, ETH/USD, SOL/USD.
2. Only buy if price is above MA20 AND MA50.
3. Allocate up to 20% of total portfolio to crypto combined.

### Rebalancing Logic
- If a position has FALLEN below its MA50 → sell it.
- If a better-ranked symbol is not in portfolio → replace lowest-ranked held position.
- If position already held and still qualifies → HOLD (avoid churn).

## Hard Risk Controls (NEVER violate these)
- Max position size: ${(parseFloat(maxPct) * 100).toFixed(0)}% of portfolio value per symbol.
- Single order cap: $${maxTrade} notional. Split larger allocations if needed.
- Daily loss kill-switch: If daily P&L% is worse than -${(parseFloat(lossLimit) * 100).toFixed(0)}%, cancel all orders, close all positions, send alert, STOP.
- Never use leverage. Notional buys only within available cash.
- Never short. Long-only strategy.
- Never trade illiquid or unknown symbols outside the defined watchlists.

## Process for Each Run
1. Check kill-switch (get_account, check daily_pl_pct).
2. Check regime (SPY + BTC momentum).
3. Review current positions.
4. Evaluate watchlist momentum.
5. Make rebalancing decisions.
6. Execute orders (use notional in USD).
7. Summarize what you did and why in plain English.

Be decisive. Think step by step. Always explain your reasoning before executing any trade.
Today's date: ${new Date().toDateString()}`;
}

// ── Agentic Loop ───────────────────────────────────────────────────────────
export async function runAgent() {
  const log = [];
  console.log(`\n🤖 Agent run started at ${new Date().toISOString()}`);

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

    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
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
        result = await executeTool(block.name, block.input);

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
