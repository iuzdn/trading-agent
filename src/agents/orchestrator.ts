import { randomUUID } from 'node:crypto';
import { childLogger } from '../lib/logger.js';
import { appendPipelineResult } from '../lib/journal.js';
import { formatDecisionCard, formatShortlistCard } from '../lib/formatDecision.js';
import { getPortfolioState } from '../tools/alpaca.js';
import { researchAnalyst } from './researchAnalyst.js';
import { technicalAnalyst } from './technicalAnalyst.js';
import { cachedMacro } from './macroAnalyst.js';
import { scout } from './scout.js';
import { devilsAdvocate } from './devilsAdvocate.js';
import { portfolioManager } from './portfolioManager.js';
import { riskManager } from './riskManager.js';
import { executor } from './executor.js';
import {
  ResearchRequestSchema,
  type ResearchRequest,
  type Decision,
  type ResearchReport,
  type TechnicalReport,
  type MacroRegime,
  type Critique,
  type RiskAssessment,
  type TradeProposal,
  type ExecutionReport,
  type Shortlist,
} from '../types/contracts.js';

export interface PipelineResult {
  request: ResearchRequest;
  research: ResearchReport;
  technical: TechnicalReport;
  macro?: MacroRegime;
  critique?: Critique;
  proposal: TradeProposal;
  risk?: RiskAssessment;
  execution?: ExecutionReport;
  decision: Decision;
  startedAt: string;
  finishedAt: string;
  latencyMs: number;
}

/** Everything finalize() needs; stage-specific fields are filled as we learn them. */
interface PipelineParts {
  research: ResearchReport;
  technical: TechnicalReport;
  macro?: MacroRegime;
  critique?: Critique;
  proposal: TradeProposal;
  risk?: RiskAssessment;
  execution?: ExecutionReport;
  decision: Decision;
}

export interface PipelineOptions {
  /** Skip Alpaca order submission (dry run). */
  dryRun?: boolean;
  /** Lookback for news. Defaults to 30 days. */
  newsLookbackDays?: number;
  /** Skip writing to the trade journal. Defaults to false. */
  skipJournal?: boolean;
}

/**
 * Phase 2 hierarchical orchestrator (ARCHITECTURE §6). Sequence:
 *   [research ‖ technical ‖ macro] → devil's advocate → PM
 *     → risk gate → (executor if approved)
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
  const startedAt = new Date(t0).toISOString();
  log.info({ trigger: request.triggerReason }, 'pipeline start');

  const finalize = async (parts: PipelineParts): Promise<PipelineResult> => {
    const finishedAt = new Date().toISOString();
    const result: PipelineResult = {
      request,
      research: parts.research,
      technical: parts.technical,
      ...(parts.macro ? { macro: parts.macro } : {}),
      ...(parts.critique ? { critique: parts.critique } : {}),
      proposal: parts.proposal,
      ...(parts.risk ? { risk: parts.risk } : {}),
      ...(parts.execution ? { execution: parts.execution } : {}),
      decision: parts.decision,
      startedAt,
      finishedAt,
      latencyMs: Date.now() - t0,
    };
    if (!options.skipJournal) {
      try {
        await appendPipelineResult(result);
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          'journal append failed — continuing',
        );
      }
    }
    log.info({ kind: parts.decision.kind, latencyMs: result.latencyMs }, 'pipeline done');
    return result;
  };

  // Phase 1 — parallel analyst fan-out (macro is session-cached).
  const [research, technical, macro] = await Promise.all([
    researchAnalyst({
      ticker: request.ticker,
      lookbackDays: options.newsLookbackDays ?? 30,
      requestId: request.requestId,
    }),
    technicalAnalyst({ ticker: request.ticker, requestId: request.requestId }),
    cachedMacro(request.requestId),
  ]);

  // Early exit: low analyst confidence — skip the adversarial check (§3.1).
  if (research.confidence < 30 || technical.confidence < 30) {
    log.info({ research: research.confidence, technical: technical.confidence }, 'low confidence');
    return finalize({
      research,
      technical,
      macro,
      proposal: synthEmptyProposal(request.ticker),
      decision: {
        kind: 'NO_TRADE',
        reason: 'low_analyst_confidence',
        agentTrace: ['researchAnalyst', 'technicalAnalyst', 'macroAnalyst'],
      },
    });
  }

  // Phase 2 — adversarial check, then synthesis.
  const critique = await devilsAdvocate({ research, technical, macro, requestId: request.requestId });

  const proposal = await portfolioManager({
    research,
    technical,
    macro,
    critique,
    requestId: request.requestId,
  });

  const preExecTrace = [
    'researchAnalyst',
    'technicalAnalyst',
    'macroAnalyst',
    'devilsAdvocate',
    'portfolioManager',
  ];

  if (proposal.action === 'HOLD') {
    log.info({ confidence: proposal.confidence }, 'PM chose HOLD');
    return finalize({
      research,
      technical,
      macro,
      critique,
      proposal,
      decision: { kind: 'NO_TRADE', reason: 'pm_chose_hold', agentTrace: preExecTrace },
    });
  }

  if (options.dryRun) {
    log.info('dryRun: skipping risk gate + executor');
    return finalize({
      research,
      technical,
      macro,
      critique,
      proposal,
      decision: { kind: 'NO_TRADE', reason: 'dry_run', agentTrace: preExecTrace },
    });
  }

  // Phase 3 — risk gate (veto power).
  const portfolio = await getPortfolioState();
  const risk = await riskManager({ proposal, portfolio, macro, requestId: request.requestId });
  const riskTrace = [...preExecTrace, 'riskManager'];

  if (risk.status === 'REJECTED') {
    log.info({ reason: risk.reason, rules: risk.rulesTriggered }, 'risk manager vetoed');
    return finalize({
      research,
      technical,
      macro,
      critique,
      proposal,
      risk,
      decision: { kind: 'NO_TRADE', reason: `risk_rejected: ${risk.reason}`, agentTrace: riskTrace },
    });
  }

  const finalProposal =
    risk.status === 'MODIFIED' && risk.modifiedProposal ? risk.modifiedProposal : proposal;

  // Phase 4 — execution.
  const execution = await executor({ proposal: finalProposal, requestId: request.requestId });
  return finalize({
    research,
    technical,
    macro,
    critique,
    proposal: finalProposal,
    risk,
    execution,
    decision: { kind: 'TRADE', proposal: finalProposal, execution },
  });
}

export interface ScoutPipelineOptions {
  /** How many shortlist candidates get the full pipeline. Default 3; 0 = shortlist only. */
  fanOut?: number;
  /** Forwarded to each runResearchPipeline call. */
  dryRun?: boolean;
  /** Progress callback (e.g. Telegram sendMessage) — called with formatted cards. */
  onUpdate?: (message: string) => Promise<void>;
}

export interface ScoutPipelineResult {
  shortlist: Shortlist;
  results: PipelineResult[];
}

/**
 * Scout entry point: screen the market into a Shortlist, then fan the top
 * `fanOut` candidates through the full research pipeline SEQUENTIALLY (bounds
 * cost/rate limits; macro stays cached across runs). One candidate failing
 * logs and continues to the next.
 */
export async function runScoutPipeline(
  options: ScoutPipelineOptions = {},
): Promise<ScoutPipelineResult> {
  const requestId = randomUUID();
  const log = childLogger({ requestId, agentId: 'scoutPipeline' });
  const fanOut = Math.max(0, Math.min(options.fanOut ?? 3, 5));

  const shortlist = await scout({ requestId });
  log.info(
    { regime: shortlist.regime, candidates: shortlist.candidates.length, fanOut },
    'shortlist ready',
  );
  if (options.onUpdate) {
    await options.onUpdate(formatShortlistCard(shortlist, fanOut));
  }

  const results: PipelineResult[] = [];
  const toRun = shortlist.candidates.slice(0, fanOut);
  for (const candidate of toRun) {
    try {
      const result = await runResearchPipeline(
        {
          ticker: candidate.ticker,
          triggerReason: 'momentum_signal',
          context: `Scout pick (score ${candidate.score}, regime ${shortlist.regime}): ${candidate.reason}`,
        },
        { dryRun: options.dryRun ?? false },
      );
      results.push(result);
      if (options.onUpdate) {
        await options.onUpdate(formatDecisionCard(result));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ ticker: candidate.ticker, err: msg }, 'fan-out candidate failed — continuing');
      if (options.onUpdate) {
        await options.onUpdate(`❌ ${candidate.ticker} pipeline failed: ${msg}`);
      }
    }
  }

  log.info(
    {
      ran: results.length,
      trades: results.filter((r) => r.decision.kind === 'TRADE').length,
    },
    'scout pipeline done',
  );
  return { shortlist, results };
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
