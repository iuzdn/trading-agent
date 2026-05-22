import { runAgent, extractJsonBlock } from '../lib/claude.js';
import { loadPrompt } from '../lib/prompts.js';
import { childLogger } from '../lib/logger.js';
import { pmTools } from '../tools/index.js';
import { getPortfolioState } from '../tools/alpaca.js';
import { computePositionSize } from '../lib/positionSizing.js';
import {
  TradeProposalSchema,
  type TradeProposal,
  type ResearchReport,
  type TechnicalReport,
} from '../types/contracts.js';
import riskRules from '../config/riskRules.json' with { type: 'json' };

export interface PMInput {
  research: ResearchReport;
  technical: TechnicalReport;
  requestId: string;
}

export async function portfolioManager(input: PMInput): Promise<TradeProposal> {
  const log = childLogger({ agentId: 'portfolioManager', requestId: input.requestId });
  const system = await loadPrompt('portfolioManager');
  const t0 = Date.now();

  const portfolio = await getPortfolioState();

  const result = await runAgent({
    system,
    model: 'claude-sonnet-4-5',
    requestId: input.requestId,
    agentId: 'portfolioManager',
    tools: pmTools,
    maxToolIterations: 3,
    messages: [
      {
        role: 'user',
        content: `Analyst reports for ${input.research.ticker}:

## Research
\`\`\`json
${JSON.stringify(input.research, null, 2)}
\`\`\`

## Technical
\`\`\`json
${JSON.stringify(input.technical, null, 2)}
\`\`\`

## Current portfolio (already fetched for you)
\`\`\`json
${JSON.stringify(portfolio, null, 2)}
\`\`\`

Decide BUY / SELL / HOLD / CLOSE per the system prompt. Leave sizeUsd and sizePctOfEquity at 0; the orchestrator will compute them.`,
      },
    ],
  });

  const json = extractJsonBlock(result.finalText);
  const parsed = TradeProposalSchema.safeParse(json);
  if (!parsed.success) {
    log.error({ issues: parsed.error.issues, raw: json }, 'PM output failed schema');
    throw new Error(`TradeProposal schema violation: ${parsed.error.message}`);
  }
  let proposal = parsed.data;

  // Auto-HOLD on low conviction per ARCHITECTURE §3.6.
  if (
    proposal.action !== 'HOLD' &&
    (proposal.confidence < riskRules.pmHoldConfidenceFloor || input.research.confidence < 50)
  ) {
    log.info(
      { confidence: proposal.confidence, researchConf: input.research.confidence },
      'PM auto-HOLD: confidence below floor',
    );
    proposal = { ...proposal, action: 'HOLD', sizeUsd: 0, sizePctOfEquity: 0 };
  }

  // Deterministic position sizing — overwrite whatever the LLM put in.
  if (proposal.action === 'BUY' || proposal.action === 'SELL') {
    const sized = computePositionSize({
      confidence: proposal.confidence,
      entryPrice: proposal.entryPrice,
      stopLoss: proposal.stopLoss,
      takeProfit: proposal.takeProfit,
      equity: portfolio.equity,
      maxPctOfEquity: riskRules.maxPositionPctOfEquity,
    });
    proposal = { ...proposal, sizeUsd: sized.sizeUsd, sizePctOfEquity: sized.sizePctOfEquity };
    if (sized.sizeUsd === 0) {
      log.info('Sizing returned 0 — downgrading to HOLD');
      proposal = { ...proposal, action: 'HOLD' };
    }
  }

  log.info(
    {
      latencyMs: Date.now() - t0,
      action: proposal.action,
      sizeUsd: proposal.sizeUsd,
      confidence: proposal.confidence,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    },
    'PM done',
  );
  return proposal;
}
