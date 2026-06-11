import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { PipelineResult } from '../agents/orchestrator.js';
import { logger } from './logger.js';

const JOURNAL_DIR = join(process.cwd(), 'data', 'journal');

function fileForDate(d = new Date()): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return join(JOURNAL_DIR, `${yyyy}-${mm}.jsonl`);
}

export interface JournalEntry {
  requestId: string;
  timestamp: string;
  startedAt: string;
  finishedAt: string;
  latencyMs: number;
  ticker: string;
  triggerReason: string;
  decision: PipelineResult['decision'];
  trace: {
    research: PipelineResult['research'];
    technical: PipelineResult['technical'];
    macro?: PipelineResult['macro'];
    critique?: PipelineResult['critique'];
    proposal: PipelineResult['proposal'];
    risk?: PipelineResult['risk'];
    execution?: PipelineResult['execution'];
  };
}

export async function appendPipelineResult(result: PipelineResult): Promise<void> {
  const entry: JournalEntry = {
    requestId: result.request.requestId,
    timestamp: result.request.timestamp,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    latencyMs: result.latencyMs,
    ticker: result.request.ticker,
    triggerReason: result.request.triggerReason,
    decision: result.decision,
    trace: {
      research: result.research,
      technical: result.technical,
      ...(result.macro ? { macro: result.macro } : {}),
      ...(result.critique ? { critique: result.critique } : {}),
      proposal: result.proposal,
      ...(result.risk ? { risk: result.risk } : {}),
      ...(result.execution ? { execution: result.execution } : {}),
    },
  };
  const file = fileForDate(new Date(result.startedAt));
  try {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, JSON.stringify(entry) + '\n', 'utf8');
    logger.debug({ file, requestId: entry.requestId }, 'journal entry written');
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), file },
      'journal write failed',
    );
    throw err;
  }
}

/**
 * Count executed trades (decision.kind === 'TRADE') journaled on the UTC day of
 * `now`. Used by the Risk Manager to enforce maxNewTradesPerDay. Returns 0 if
 * today's journal file doesn't exist yet.
 */
export async function countTradesToday(now = new Date()): Promise<number> {
  const file = fileForDate(now);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return 0;
  }
  const dayPrefix = now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  let count = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as JournalEntry;
      if (entry.decision?.kind === 'TRADE' && entry.startedAt.slice(0, 10) === dayPrefix) {
        count++;
      }
    } catch {
      // skip malformed lines
    }
  }
  return count;
}

export { fileForDate };
