import 'dotenv/config';
import { runResearchPipeline } from '../agents/orchestrator.js';
import { formatDecisionCard } from '../lib/formatDecision.js';
import { logger } from '../lib/logger.js';
import { tradingMode } from '../tools/alpaca.js';

const args = process.argv.slice(2);
const ticker = args.find((a) => !a.startsWith('--'));
const dryRun = args.includes('--dry-run');

if (!ticker) {
  console.error('Usage: npm run research <TICKER> [--dry-run]');
  process.exit(1);
}

if (tradingMode() === 'live') {
  if (!process.argv.includes('--i-know-this-is-live')) {
    console.error(
      'TRADING_MODE=live detected. Refusing to run without --i-know-this-is-live.\n' +
        'For paper, set TRADING_MODE=paper (or omit it) and ALPACA_PAPER=true.',
    );
    process.exit(2);
  }
}

(async () => {
  try {
    const result = await runResearchPipeline(
      { ticker, triggerReason: 'manual' },
      { dryRun },
    );
    // Human-readable summary to stdout.
    console.log('\n' + formatDecisionCard(result) + '\n');
    // Full result available via logger debug for traceability.
    logger.debug({ result }, 'pipeline result');
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, 'pipeline failed');
    console.error(`\n❌ ${msg}\n`);
    process.exit(1);
  }
})();
