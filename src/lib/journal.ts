import { appendFile, mkdir } from 'node:fs/promises';
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
    proposal: PipelineResult['proposal'];
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
      proposal: result.proposal,
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

export { fileForDate };
