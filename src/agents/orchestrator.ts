import { randomUUID } from 'node:crypto';
import { childLogger } from '../lib/logger.js';
import { researchAnalyst } from './researchAnalyst.js';
import { technicalAnalyst } from './technicalAnalyst.js';
import { portfolioManager } from './portfolioManager.js';
import { executor } from './executor.js';
import {
  ResearchRequestSchema,
  type ResearchRequest,
  type Decision,
  type ResearchReport,
  type TechnicalReport,
  type TradeProposal,
  type ExecutionReport,
} from '../types/contracts.js';

export interface PipelineResult {
  request: ResearchRequest;
  research: ResearchReport;
  technical: TechnicalReport;
  proposal: TradeProposal;
  execution?: ExecutionReport;
  decision: Decision;
  startedAt: string;
  finishedAt: string;
  latencyMs: number;
}

export interface PipelineOptions {
  /** Skip Alpaca order submission (dry run). */
  dryRun?: boolean;
  /** Lookback for news. Defaults to 30 days. */
  newsLookbackDays?: number;
}

/**
 * Linear Phase 1 orchestrator. Sequence:
 *   research → technical → PM → (executor if non-HOLD)
 * Macro / Devil's Advocate / Risk Manager are Phase 2.
 */
export async function runResearchPipeline(
  input: { ticker: string; triggerReason?: ResearchRequest['triggerReason']; context?: string },
  options: PipelineOptions = {},
): Promise<PipelineResult> {
  const request = ResearchRequestSchema.parse({
    ticker: input.ticker,
    triggerReason: input.triggerReason ?? 'manual',
    context: input.context,
    requestId: randomUUID(),
    timestamp: new Date().toISOString(),
  });

  const log = childLogger({ requestId: request.requestId, ticker: request.ticker });
  const t0 = Date.now();
  log.info({ trigger: request.triggerReason }, 'pipeline start');

  const research = await researchAnalyst({
    ticker: request.ticker,
    lookbackDays: options.newsLookbackDays ?? 30,
    requestId: request.requestId,
  });

  const technical = await technicalAnalyst({
    ticker: request.ticker,
    requestId: request.requestId,
  });

  // Early exit: low analyst confidence (ARCHITECTURE §6).
  if (research.confidence < 30 || technical.confidence < 30) {
    const decision: Decision = {
      kind: 'NO_TRADE',
      reason: 'low_analyst_confidence',
      agentTrace: ['researchAnalyst', 'technicalAnalyst'],
    };
    log.info({ research: research.confidence, technical: technical.confidence }, decision.reason);
    const finishedAt = new Date().toISOString();
    return {
      request,
      research,
      technical,
      proposal: synthEmptyProposal(request.ticker),
      decision,
      startedAt: new Date(t0).toISOString(),
      finishedAt,
      latencyMs: Date.now() - t0,
    };
  }

  const proposal = await portfolioManager({
    research,
    technical,
    requestId: request.requestId,
  });

  if (proposal.action === 'HOLD') {
    const decision: Decision = {
      kind: 'NO_TRADE',
      reason: 'pm_chose_hold',
      agentTrace: ['researchAnalyst', 'technicalAnalyst', 'portfolioManager'],
    };
    log.info({ confidence: proposal.confidence }, 'PM chose HOLD');
    return {
      request,
      research,
      technical,
      proposal,
      decision,
      startedAt: new Date(t0).toISOString(),
      finishedAt: new Date().toISOString(),
      latencyMs: Date.now() - t0,
    };
  }

  if (options.dryRun) {
    log.info('dryRun: skipping executor');
    const decision: Decision = {
      kind: 'NO_TRADE',
      reason: 'dry_run',
      agentTrace: ['researchAnalyst', 'technicalAnalyst', 'portfolioManager'],
    };
    return {
      request,
      research,
      technical,
      proposal,
      decision,
      startedAt: new Date(t0).toISOString(),
      finishedAt: new Date().toISOString(),
      latencyMs: Date.now() - t0,
    };
  }

  const execution = await executor({ proposal, requestId: request.requestId });
  const decision: Decision = { kind: 'TRADE', proposal, execution };
  const finishedAt = new Date().toISOString();
  log.info(
    { action: proposal.action, executionStatus: execution.status, latencyMs: Date.now() - t0 },
    'pipeline done',
  );
  return {
    request,
    research,
    technical,
    proposal,
    execution,
    decision,
    startedAt: new Date(t0).toISOString(),
    finishedAt,
    latencyMs: Date.now() - t0,
  };
}

function synthEmptyProposal(ticker: string): TradeProposal {
  return {
    ticker,
    action: 'HOLD',
    sizeUsd: 0,
    sizePctOfEquity: 0,
    entryPrice: 1,
    stopLoss: 0.5,
    takeProfit: 1.5,
    timeHorizonDays: 1,
    rationale: 'placeholder — low-confidence early exit',
    confidence: 0,
    agentTrace: ['orchestrator'],
  };
}
