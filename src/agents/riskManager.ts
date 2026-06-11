import { runAgent, extractJsonBlock } from '../lib/claude.js';
import { loadPrompt } from '../lib/prompts.js';
import { childLogger } from '../lib/logger.js';
import { readState } from '../lib/state.js';
import { countTradesToday } from '../lib/journal.js';
import { computePositionSize } from '../lib/positionSizing.js';
import { evaluateRiskRules, type RuleResult } from '../lib/riskRules.js';
import { riskTools } from '../tools/index.js';
import { getCorrelations } from '../tools/correlations.js';
import type { PortfolioStateRaw } from '../tools/alpaca.js';
import {
  RiskAssessmentSchema,
  TradeProposalSchema,
  type RiskAssessment,
  type TradeProposal,
  type MacroRegime,
} from '../types/contracts.js';
import riskRulesConfig from '../config/riskRules.json' with { type: 'json' };

export const COOLDOWNS_FILE = 'cooldowns.json';

export interface RiskInput {
  proposal: TradeProposal;
  portfolio: PortfolioStateRaw;
  macro: MacroRegime;
  requestId: string;
}

/**
 * Risk Manager (ARCHITECTURE §3.7). Veto gate before execution. Rules are
 * evaluated deterministically first; the LLM decides APPROVED/REJECTED/MODIFIED
 * with that evidence, and the code re-asserts every hard breach so the model
 * can never approve around one.
 */
export async function riskManager(input: RiskInput): Promise<RiskAssessment> {
  const log = childLogger({ agentId: 'riskManager', requestId: input.requestId });
  const system = await loadPrompt('riskManager');
  const t0 = Date.now();

  const cooldowns = (await readState<Record<string, string>>(COOLDOWNS_FILE)) ?? {};
  const tradesToday = await countTradesToday();
  const ruleResults = evaluateRiskRules({
    proposal: input.proposal,
    portfolio: input.portfolio,
    cooldowns,
    tradesToday,
  });
  const hardFailures = ruleResults.filter((r) => r.hard && !r.passed);

  const correlations = await getCorrelations(
    input.proposal.ticker,
    input.portfolio.positions.map((p) => p.symbol),
  );

  const result = await runAgent({
    system,
    model: 'claude-haiku-4-5-20251001',
    requestId: input.requestId,
    agentId: 'riskManager',
    tools: riskTools,
    maxToolIterations: 3,
    messages: [
      {
        role: 'user',
        content: `Review this trade proposal for ${input.proposal.ticker}.

## Proposal
\`\`\`json
${JSON.stringify(input.proposal, null, 2)}
\`\`\`

## Deterministic rule checks (authoritative — any hard failure ⇒ REJECTED)
\`\`\`json
${JSON.stringify(ruleResults, null, 2)}
\`\`\`

## Portfolio
\`\`\`json
${JSON.stringify(input.portfolio, null, 2)}
\`\`\`

## Correlations vs current holdings
\`\`\`json
${JSON.stringify(correlations, null, 2)}
\`\`\`

Emit the RiskAssessment JSON per the system prompt.`,
      },
    ],
  });

  const json = extractJsonBlock(result.finalText);
  const parsed = RiskAssessmentSchema.safeParse(json);
  if (!parsed.success) {
    log.error({ issues: parsed.error.issues, raw: json }, 'riskManager output failed schema');
    throw new Error(`RiskAssessment schema violation: ${parsed.error.message}`);
  }
  let assessment = parsed.data;

  // Deterministic safety override: a hard breach is always a REJECT, no matter
  // what the model returned. Merge the failed codes into rulesTriggered.
  if (hardFailures.length > 0) {
    const codes = hardFailures.map((r) => r.code);
    assessment = {
      status: 'REJECTED',
      reason: `Hard risk rule(s) breached: ${hardFailures.map((r) => r.detail).join('; ')}`,
      rulesTriggered: [...new Set([...assessment.rulesTriggered, ...codes])],
    };
    log.info({ rulesTriggered: assessment.rulesTriggered }, 'risk veto: hard rule breach');
  } else if (assessment.status === 'MODIFIED') {
    assessment = normalizeModified(assessment, input.portfolio, log);
  }

  log.info(
    {
      latencyMs: Date.now() - t0,
      status: assessment.status,
      rulesTriggered: assessment.rulesTriggered,
      hardFailures: hardFailures.length,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    },
    'riskManager done',
  );
  return assessment;
}

/**
 * Re-validate a MODIFIED proposal and re-run deterministic sizing so the
 * downsized order is rule-compliant rather than whatever number the LLM picked.
 */
function normalizeModified(
  assessment: RiskAssessment,
  portfolio: PortfolioStateRaw,
  log: ReturnType<typeof childLogger>,
): RiskAssessment {
  const mp = assessment.modifiedProposal;
  if (!mp) {
    log.warn('MODIFIED without modifiedProposal — coercing to REJECTED');
    return {
      status: 'REJECTED',
      reason: 'Risk Manager returned MODIFIED without a proposal',
      rulesTriggered: assessment.rulesTriggered,
    };
  }
  const sized = computePositionSize({
    confidence: mp.confidence,
    entryPrice: mp.entryPrice,
    stopLoss: mp.stopLoss,
    takeProfit: mp.takeProfit,
    equity: portfolio.equity,
    maxPctOfEquity: riskRulesConfig.maxPositionPctOfEquity,
  });
  const candidate: TradeProposal = {
    ...mp,
    sizeUsd: sized.sizeUsd,
    sizePctOfEquity: sized.sizePctOfEquity,
  };
  const valid = TradeProposalSchema.safeParse(candidate);
  if (!valid.success || sized.sizeUsd <= 0) {
    return {
      status: 'REJECTED',
      reason: 'Risk-adjusted size collapsed to zero or failed validation',
      rulesTriggered: [...new Set([...assessment.rulesTriggered, 'single_position_pct'])],
    };
  }
  return { ...assessment, modifiedProposal: valid.data };
}

export { type RuleResult };
