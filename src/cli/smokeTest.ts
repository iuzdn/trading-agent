import 'dotenv/config';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runResearchPipeline } from '../agents/orchestrator.js';
import { formatDecisionCard } from '../lib/formatDecision.js';
import { logger } from '../lib/logger.js';
import { getPortfolioState, tradingMode } from '../tools/alpaca.js';

/**
 * Phase 1 end-to-end smoke test.
 *
 * Runs the full /research NVDA pipeline against the paper Alpaca account
 * and verifies that:
 *   1. Every env var the system needs is present
 *   2. Trading mode is paper (refuses otherwise)
 *   3. The pipeline completes without throwing
 *   4. A journal entry was appended to data/journal/YYYY-MM.jsonl
 *   5. If the decision was TRADE, an Alpaca order ID was returned
 *
 * Run with: npx tsx src/cli/smokeTest.ts [TICKER]
 */

/**
 * Each entry is either a single var name or an array of acceptable aliases
 * (e.g. ALPACA_API_SECRET vs the legacy ALPACA_SECRET_KEY used by the JS code).
 */
const REQUIRED_ENV: Array<string | string[]> = [
  'ANTHROPIC_API_KEY',
  'ALPACA_API_KEY',
  ['ALPACA_API_SECRET', 'ALPACA_SECRET_KEY'],
  'FMP_API_KEY',
  'FINNHUB_API_KEY',
];

function checkEnv(): string[] {
  const missing: string[] = [];
  for (const entry of REQUIRED_ENV) {
    const names = Array.isArray(entry) ? entry : [entry];
    if (!names.some((n) => process.env[n])) {
      missing.push(names.join(' or '));
    }
  }
  return missing;
}

async function findJournalEntry(requestId: string): Promise<string | null> {
  const dir = join(process.cwd(), 'data', 'journal');
  try {
    const files = await readdir(dir);
    for (const f of files.filter((x) => x.endsWith('.jsonl'))) {
      const text = await readFile(join(dir, f), 'utf8');
      if (text.includes(`"requestId":"${requestId}"`)) return join(dir, f);
    }
  } catch {
    // dir may not exist if journal write failed
  }
  return null;
}

const ticker = process.argv[2] ?? 'NVDA';

(async () => {
  console.log(`\n🚦 Phase 1 smoke test — /research ${ticker}\n`);

  // 1. env check
  const missing = checkEnv();
  if (missing.length) {
    console.error(`❌ Missing env vars: ${missing.join(', ')}`);
    process.exit(2);
  }
  console.log('✅ Env vars present');

  // 2. trading mode
  if (tradingMode() !== 'paper') {
    console.error('❌ Trading mode is not paper. Refusing to run smoke test.');
    process.exit(2);
  }
  console.log('✅ Trading mode: paper');

  // 3. account reachable
  let equityBefore: number;
  try {
    const acc = await getPortfolioState();
    equityBefore = acc.equity;
    console.log(`✅ Alpaca paper account reachable. Equity: $${equityBefore.toFixed(2)}`);
  } catch (err) {
    console.error(`❌ Alpaca account check failed: ${err instanceof Error ? err.message : err}`);
    process.exit(3);
  }

  // 4. ensure journal dir exists
  await mkdir(join(process.cwd(), 'data', 'journal'), { recursive: true });

  // 5. run pipeline
  console.log(`\n▶ Running pipeline...\n`);
  let result;
  try {
    result = await runResearchPipeline({ ticker, triggerReason: 'manual' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, 'pipeline threw');
    console.error(`❌ Pipeline threw: ${msg}`);
    process.exit(4);
  }

  console.log(formatDecisionCard(result, { escapeProse: false }));
  console.log();

  // 6. verify journal entry
  const file = await findJournalEntry(result.request.requestId);
  if (!file) {
    console.error('❌ No journal entry found for this requestId.');
    process.exit(5);
  }
  console.log(`✅ Journal entry written to ${file}`);

  // 7. verify Alpaca order ID if a trade happened
  if (result.decision.kind === 'TRADE') {
    const orderId = result.decision.execution.orderIds[0];
    if (!orderId) {
      console.error('❌ TRADE decision but no Alpaca order ID returned.');
      process.exit(6);
    }
    console.log(`✅ Alpaca order ID: ${orderId}`);
    console.log(`   View it at https://app.alpaca.markets/paper/dashboard/orders`);
  } else {
    console.log(`ℹ  Decision was NO_TRADE (${result.decision.reason}) — no order to verify.`);
  }

  console.log('\n🎉 Smoke test passed.\n');
  process.exit(0);
})().catch((err) => {
  console.error('Uncaught:', err);
  process.exit(99);
});
