import 'dotenv/config';
import cron from 'node-cron';
import { runAgent } from './src/agent.js';

const PAPER_MODE = process.env.PAPER_MODE !== 'false';

console.log(`
╔══════════════════════════════════════════╗
║   🤖  Alpaca Autonomous Trading Agent    ║
║   Mode: ${PAPER_MODE ? '📄 PAPER TRADING           ' : '⚠️  LIVE TRADING            '}║
╚══════════════════════════════════════════╝
`);

if (!process.env.ANTHROPIC_API_KEY) throw new Error('Missing ANTHROPIC_API_KEY');
if (!process.env.ALPACA_API_KEY)    throw new Error('Missing ALPACA_API_KEY');

// ── Run modes ──────────────────────────────────────────────────────────────

// Pass --now to run immediately (for testing)
if (process.argv.includes('--now')) {
  console.log('Running immediately (--now flag)...\n');
  runAgent().catch(console.error);
} else {
  // Schedule: weekdays at 09:45 ET (market open + 15min buffer)
  //           weekdays at 15:30 ET (30min before close)
  //           daily    at 00:05 UTC for crypto (24/7 market)

  // Equity runs — Mon-Fri 09:45 and 15:30 New York time
  cron.schedule('45 9 * * 1-5', () => {
    console.log('⏰ Morning equity run triggered');
    runAgent().catch(console.error);
  }, { timezone: 'America/New_York' });

  cron.schedule('30 15 * * 1-5', () => {
    console.log('⏰ Afternoon equity run triggered');
    runAgent().catch(console.error);
  }, { timezone: 'America/New_York' });

  // Crypto run — every day at 08:00 UTC
  cron.schedule('0 8 * * *', () => {
    console.log('⏰ Daily crypto check triggered');
    runAgent().catch(console.error);
  }, { timezone: 'UTC' });

  console.log('📅 Scheduler active:');
  console.log('   • Equities: Mon-Fri 09:45 & 15:30 ET');
  console.log('   • Crypto:   Daily 08:00 UTC');
  console.log('\nPress Ctrl+C to stop. Use --now flag to run immediately.\n');
}
