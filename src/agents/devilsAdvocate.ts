import { runAgent, extractJsonBlock } from '../lib/claude.js';
import { loadPrompt } from '../lib/prompts.js';
import { childLogger } from '../lib/logger.js';
import {
  CritiqueSchema,
  type Critique,
  type ResearchReport,
  type TechnicalReport,
  type MacroRegime,
} from '../types/contracts.js';

export interface DevilsAdvocateInput {
  research: ResearchReport;
  technical: TechnicalReport;
  macro: MacroRegime;
  requestId: string;
}

/**
 * Devil's Advocate (ARCHITECTURE §3.5). Mandatory adversarial step before the
 * PM. Argues against the consensus thesis and scores how strong the bear case
 * is. Uses web_search to find disconfirming evidence.
 */
export async function devilsAdvocate(input: DevilsAdvocateInput): Promise<Critique> {
  const log = childLogger({ agentId: 'devilsAdvocate', requestId: input.requestId });
  const system = await loadPrompt('devilsAdvocate');
  const t0 = Date.now();

  const result = await runAgent({
    system,
    model: 'claude-sonnet-4-5',
    requestId: input.requestId,
    agentId: 'devilsAdvocate',
    tools: [],
    webSearch: { maxUses: 5 },
    maxToolIterations: 8,
    messages: [
      {
        role: 'user',
        content: `Argue against the trade thesis for ${input.research.ticker}.

## Research
\`\`\`json
${JSON.stringify(input.research, null, 2)}
\`\`\`

## Technical
\`\`\`json
${JSON.stringify(input.technical, null, 2)}
\`\`\`

## Macro regime
\`\`\`json
${JSON.stringify(input.macro, null, 2)}
\`\`\`

Use web_search to find disconfirming evidence, then emit the structured Critique JSON per the system prompt.`,
      },
    ],
  });

  const json = extractJsonBlock(result.finalText);
  const parsed = CritiqueSchema.safeParse(json);
  if (!parsed.success) {
    log.error({ issues: parsed.error.issues, raw: json }, 'devilsAdvocate output failed schema');
    throw new Error(`Critique schema violation: ${parsed.error.message}`);
  }

  log.info(
    {
      latencyMs: Date.now() - t0,
      strength: parsed.data.strength,
      counterEvidence: parsed.data.counterEvidence.length,
      toolCalls: result.toolCalls.length,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    },
    'devilsAdvocate done',
  );
  return parsed.data;
}
