import 'dotenv/config';
import { startCommandListener, sendMessage } from './lib/telegram.js';
import { runResearchPipeline } from './agents/orchestrator.js';
import { formatDecisionCard } from './lib/formatDecision.js';
import { logger } from './lib/logger.js';
import { tradingMode } from './tools/alpaca.js';

logger.info(
  { mode: tradingMode() },
  '🤖 Phase 1 research pipeline starting',
);

if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY missing');
if (!process.env.ALPACA_API_KEY) throw new Error('ALPACA_API_KEY missing');

let running = false;

async function handleResearch(arg: string): Promise<void> {
  const ticker = arg.trim().toUpperCase().split(/\s+/)[0];
  if (!ticker || !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) {
    await sendMessage(`Usage: /research <TICKER>   (got "${arg || 'nothing'}")`);
    return;
  }
  if (running) {
    await sendMessage(`⏳ A research run is already in flight. Try again when it finishes.`);
    return;
  }
  running = true;
  await sendMessage(`🔎 Researching *${ticker}*...`);
  try {
    const result = await runResearchPipeline({ ticker, triggerReason: 'manual' });
    await sendMessage(formatDecisionCard(result));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ ticker, err: msg }, 'research run failed');
    await sendMessage(`❌ Research on ${ticker} failed: ${msg}`);
  } finally {
    running = false;
  }
}

startCommandListener([{ prefix: '/research', handle: handleResearch }]).catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, 'listener crashed');
  process.exit(1);
});
