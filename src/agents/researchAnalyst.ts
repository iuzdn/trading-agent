import { runAgent, extractJsonBlock } from '../lib/claude.js';
import { loadPrompt } from '../lib/prompts.js';
import { childLogger } from '../lib/logger.js';
import { researchTools } from '../tools/index.js';
import { ResearchReportSchema, type ResearchReport } from '../types/contracts.js';

export interface ResearchInput {
  ticker: string;
  lookbackDays: number;
  requestId: string;
}

export async function researchAnalyst(input: ResearchInput): Promise<ResearchReport> {
  const log = childLogger({ agentId: 'researchAnalyst', requestId: input.requestId });
  const system = await loadPrompt('researchAnalyst');
  const t0 = Date.now();

  const result = await runAgent({
    system,
    model: 'claude-sonnet-4-5',
    requestId: input.requestId,
    agentId: 'researchAnalyst',
    tools: researchTools,
    maxToolIterations: 6,
    messages: [
      {
        role: 'user',
        content: `Research the ticker ${input.ticker}. News lookback: ${input.lookbackDays} days. Produce the structured JSON report per the system prompt.`,
      },
    ],
  });

  const json = extractJsonBlock(result.finalText);
  const parsed = ResearchReportSchema.safeParse(json);
  if (!parsed.success) {
    log.error({ issues: parsed.error.issues, raw: json }, 'researchAnalyst output failed schema');
    throw new Error(`ResearchReport schema violation: ${parsed.error.message}`);
  }
  log.info(
    {
      latencyMs: Date.now() - t0,
      toolCalls: result.toolCalls.length,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      confidence: parsed.data.confidence,
    },
    'researchAnalyst done',
  );
  return parsed.data;
}
