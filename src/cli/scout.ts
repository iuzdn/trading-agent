import 'dotenv/config';
import { runScoutPipeline } from '../agents/orchestrator.js';
import { logger } from '../lib/logger.js';
import { tradingMode } from '../tools/alpaca.js';

const args = process.argv.slice(2);
const shortlistOnly = args.includes('--shortlist-only');
const dryRun = args.includes('--dry-run');
const nArg = args.find((a) => /^[1-5]$/.test(a));
const fanOut = shortlistOnly ? 0 : nArg ? parseInt(nArg, 10) : 3;

if (args.some((a) => a.startsWith('--') && !['--shortlist-only', '--dry-run'].includes(a))) {
  console.error('Usage: npm run scout [1-5] [--shortlist-only] [--dry-run]');
  process.exit(1);
}

if (tradingMode() === 'live' && !dryRun) {
  console.error(
    'TRADING_MODE=live detected. The scout fan-out places orders — refusing.\n' +
      'Use --dry-run, or set TRADING_MODE=paper.',
  );
  process.exit(2);
}

(async () => {
  try {
    const { results } = await runScoutPipeline({
      fanOut,
      dryRun,
      onUpdate: async (msg) => {
        console.log('\n' + msg + '\n');
      },
    });
    if (results.length > 0) {
      const trades = results.filter((r) => r.decision.kind === 'TRADE').length;
      console.log(`Scout run complete: ${results.length} researched, ${trades} trade(s).`);
    }
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, 'scout pipeline failed');
    console.error(`\n❌ ${msg}\n`);
    process.exit(1);
  }
})();
