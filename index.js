import 'dotenv/config';
import cron from 'node-cron';
import { runAgent, requestStop } from './src/agent.js';
import { sendAlert, startCommandListener, formatRunSummary } from './src/telegram.js';
import * as alpaca from './src/alpaca.js';

const PAPER_MODE = alpaca.isPaperTrading();

console.log(`
╔══════════════════════════════════════════╗
║   🤖  Alpaca Autonomous Trading Agent    ║
║   Mode: ${PAPER_MODE ? '📄 PAPER TRADING           ' : '⚠️  LIVE TRADING            '}║
╚══════════════════════════════════════════╝
`);

if (!process.env.ANTHROPIC_API_KEY) throw new Error('Missing ANTHROPIC_API_KEY');
if (!process.env.ALPACA_API_KEY)    throw new Error('Missing ALPACA_API_KEY');

// ── State ──────────────────────────────────────────────────────────────────
let agentRunning = false;
let paused = false;

async function safeRunAgent({ manual = false } = {}) {
  if (paused && !manual) {
    console.log('⏸️  Scheduled run skipped — agent is paused');
    return;
  }
  if (agentRunning) {
    await sendAlert('⚠️ Agent already running — skipping this trigger.');
    return;
  }
  agentRunning = true;
  try {
    await runAgent();
  } finally {
    agentRunning = false;
  }
}

// ── Telegram command handlers ──────────────────────────────────────────────
const commands = {
  '/status': async () => {
    const [acc, positions] = await Promise.all([
      alpaca.getAccount(),
      alpaca.getPositions(),
    ]);
    const equity = parseFloat(acc.equity);
    const dailyPl = parseFloat(acc.equity) - parseFloat(acc.last_equity);
    const dailyPlPct = (dailyPl / parseFloat(acc.last_equity) * 100).toFixed(2);
    const plSign = dailyPl >= 0 ? '+' : '';
    const lines = [
      `📊 *Account Status*`,
      `Portfolio: $${equity.toFixed(2)}`,
      `Cash: $${parseFloat(acc.cash).toFixed(2)}`,
      `Daily P&L: ${plSign}$${dailyPl.toFixed(2)} (${plSign}${dailyPlPct}%)`,
      paused ? '⏸️ _Scheduler is paused_' : '✅ _Scheduler is active_',
      agentRunning ? '⚙️ _Agent is currently running..._' : '',
      '',
      `*Open Positions (${positions.length}):*`,
      ...positions.map(p => {
        const plPct = (parseFloat(p.unrealized_plpc) * 100).toFixed(2);
        return `• *${p.symbol}*: $${parseFloat(p.market_value).toFixed(2)} (${plPct}%)`;
      }),
      positions.length === 0 ? '_No open positions_' : '',
    ].filter(l => l !== '');
    await sendAlert(lines.join('\n'));
  },

  // Stop the agent's current reasoning loop — positions are untouched
  '/stop': async () => {
    requestStop();
    await sendAlert('🛑 *Agent stopped.* Positions are untouched. Use /close\\-positions to liquidate.');
  },

  // Cancel all open orders and market-sell every position
  '/close-positions': async () => {
    requestStop();
    await sendAlert('🔴 *Closing all positions...* Cancelling orders first.');
    await alpaca.cancelAllOrders().catch(() => {});
    const positions = await alpaca.getPositions().catch(() => []);
    for (const p of positions) {
      await alpaca.closePosition(p.symbol).catch(() => {});
    }
    await sendAlert(`✅ Done. Closed ${positions.length} position(s) and cancelled all open orders.`);
  },

  // Prevent scheduled cron runs from firing (manual /run still works)
  '/pause': async () => {
    paused = true;
    await sendAlert('⏸️ *Scheduler paused.* Cron runs are suspended. Send /resume to re\\-enable, or /run to trigger a manual run.');
  },

  '/resume': async () => {
    paused = false;
    await sendAlert('▶️ *Scheduler resumed.* Cron runs are active again.');
  },

  // Trigger an immediate run regardless of pause state
  '/run': async () => {
    if (agentRunning) {
      await sendAlert('⚠️ Agent is already running — wait for it to finish.');
      return;
    }
    await sendAlert('▶️ *Manual run triggered...*');
    safeRunAgent({ manual: true }).catch(async e => {
      await sendAlert(`❌ Agent run failed: ${e.message}`);
    });
  },
};

// ── Run modes ──────────────────────────────────────────────────────────────

if (process.argv.includes('--now')) {
  console.log('Running immediately (--now flag)...\n');
  safeRunAgent().catch(console.error);
} else {
  // Skips equity runs when the US market is closed (holidays, unscheduled closures).
  async function runEquitySession(label) {
    try {
      const clock = await alpaca.getClock();
      if (!clock.is_open) {
        console.log(`⏭️  ${label} skipped — market closed (next open: ${clock.next_open})`);
        return;
      }
    } catch (e) {
      console.error(`Market clock check failed for ${label} — proceeding anyway:`, e.message);
    }
    console.log(`⏰ ${label} triggered`);
    safeRunAgent().catch(console.error);
  }

  // Equity runs — Mon-Fri 09:45 and 15:30 New York time
  cron.schedule('45 9 * * 1-5', () => runEquitySession('Morning equity run'),
    { timezone: 'America/New_York' });

  cron.schedule('30 15 * * 1-5', () => runEquitySession('Afternoon equity run'),
    { timezone: 'America/New_York' });

  cron.schedule('0 8 * * *', () => {
    console.log('⏰ Daily crypto check triggered');
    safeRunAgent().catch(console.error);
  }, { timezone: 'UTC' });

  console.log('📅 Scheduler active:');
  console.log('   • Equities: Mon-Fri 09:45 & 15:30 ET');
  console.log('   • Crypto:   Daily 08:00 UTC');
  console.log('\nPress Ctrl+C to stop. Use --now flag to run immediately.\n');

  // Start Telegram command listener (non-blocking)
  startCommandListener(commands).catch(console.error);
}
