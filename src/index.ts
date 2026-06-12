import 'dotenv/config';
import cron from 'node-cron';
import { startCommandListener, sendMessage } from './lib/telegram.js';
import { runResearchPipeline, runScoutPipeline } from './agents/orchestrator.js';
import { formatDecisionCard } from './lib/formatDecision.js';
import { logger } from './lib/logger.js';
import { tradingMode } from './tools/alpaca.js';

logger.info(
  { mode: tradingMode() },
  '🤖 Research pipeline starting',
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

/** /scout → fan-out 3; /scout N (1–5) → fan-out N; /scout list → shortlist only. */
async function handleScout(arg: string): Promise<void> {
  const word = arg.trim().toLowerCase().split(/\s+/)[0] ?? '';
  let fanOut = 3;
  if (word === 'list') fanOut = 0;
  else if (/^[1-5]$/.test(word)) fanOut = parseInt(word, 10);
  else if (word !== '') {
    await sendMessage(`Usage: /scout [1-5 | list]   (got "${arg}")`);
    return;
  }

  if (running) {
    await sendMessage(`⏳ A run is already in flight. Try again when it finishes.`);
    return;
  }
  running = true;
  await sendMessage(`🧭 Scouting the market${fanOut > 0 ? ` (top ${fanOut} get the full treatment)` : ' (shortlist only)'}...`);
  try {
    // The shortlist card and each decision card stream via onUpdate as they
    // complete; finish with a one-line summary when candidates were run.
    const { results } = await runScoutPipeline({
      fanOut,
      onUpdate: async (msg) => sendMessage(msg),
    });
    if (results.length > 0) {
      const trades = results.filter((r) => r.decision.kind === 'TRADE').length;
      await sendMessage(
        `🧭 Scout run complete: ${results.length} researched, ${trades} trade(s).`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err: msg }, 'scout run failed');
    await sendMessage(`❌ Scout failed: ${msg}`);
  } finally {
    running = false;
  }
}

// Opt-in scheduled scout: set SCOUT_SCHEDULE to a cron expression (ET), e.g.
// SCOUT_SCHEDULE="15 9 * * 1-5" for weekdays 09:15 America/New_York.
const scoutSchedule = process.env.SCOUT_SCHEDULE;
if (scoutSchedule) {
  if (!cron.validate(scoutSchedule)) {
    logger.error({ scoutSchedule }, 'invalid SCOUT_SCHEDULE cron expression — ignoring');
  } else {
    cron.schedule(
      scoutSchedule,
      () => {
        logger.info({ scoutSchedule }, '⏰ scheduled scout triggered');
        handleScout('').catch((err) =>
          logger.error(
            { err: err instanceof Error ? err.message : String(err) },
            'scheduled scout failed',
          ),
        );
      },
      { timezone: 'America/New_York' },
    );
    logger.info({ scoutSchedule }, 'scheduled scout enabled (America/New_York)');
  }
}

startCommandListener([
  { prefix: '/research', handle: handleResearch },
  { prefix: '/scout', handle: handleScout },
]).catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, 'listener crashed');
  process.exit(1);
});
