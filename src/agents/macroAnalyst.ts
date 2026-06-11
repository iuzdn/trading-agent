import { runAgent, extractJsonBlock } from '../lib/claude.js';
import { loadPrompt } from '../lib/prompts.js';
import { childLogger } from '../lib/logger.js';
import { readState, writeState, isFresh } from '../lib/state.js';
import { macroTools } from '../tools/index.js';
import { getIndexData, trendVsSma } from '../tools/marketIndex.js';
import { MacroRegimeSchema, type MacroRegime } from '../types/contracts.js';

const MACRO_CACHE_FILE = 'macroCache.json';

export interface MacroInput {
  asOf?: Date;
  requestId: string;
}

/**
 * Macro Analyst (ARCHITECTURE §3.3). Classifies the current market regime.
 * SPY's 200-DMA trend is computed deterministically and handed to the model;
 * VIX and the yield-curve spread are sourced via web_search. Every number in
 * the output therefore traces to a tool result.
 */
export async function macroAnalyst(input: MacroInput): Promise<MacroRegime> {
  const log = childLogger({ agentId: 'macroAnalyst', requestId: input.requestId });
  const system = await loadPrompt('macroAnalyst');
  const asOf = input.asOf ?? new Date();
  const t0 = Date.now();

  const spyBars = await getIndexData('SPY', 250);
  const trendSpy200 = trendVsSma(spyBars.map((b) => b.c), 200);
  log.debug({ trendSpy200, bars: spyBars.length }, 'computed SPY trend');

  const result = await runAgent({
    system,
    model: 'claude-haiku-4-5-20251001',
    requestId: input.requestId,
    agentId: 'macroAnalyst',
    tools: macroTools,
    webSearch: { maxUses: 5 },
    maxToolIterations: 8,
    messages: [
      {
        role: 'user',
        content: `Classify the current market regime as of ${asOf.toISOString()}.

Pre-computed (copy verbatim into signals.trendSpy200): \`${trendSpy200}\`

Use web_search to find the current VIX level and the 10y–2y Treasury yield-curve spread, then emit the structured JSON report per the system prompt. Set validUntil to ~4 hours after asOf.`,
      },
    ],
  });

  const json = extractJsonBlock(result.finalText);
  const parsed = MacroRegimeSchema.safeParse(json);
  if (!parsed.success) {
    log.error({ issues: parsed.error.issues, raw: json }, 'macroAnalyst output failed schema');
    throw new Error(`MacroRegime schema violation: ${parsed.error.message}`);
  }

  // Trust our deterministic trend over whatever the model echoed back.
  const regime: MacroRegime = {
    ...parsed.data,
    signals: { ...parsed.data.signals, trendSpy200 },
  };

  log.info(
    {
      latencyMs: Date.now() - t0,
      label: regime.label,
      vix: regime.signals.vix,
      yieldCurve: regime.signals.yieldCurve,
      toolCalls: result.toolCalls.length,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    },
    'macroAnalyst done',
  );
  return regime;
}

/**
 * Returns the cached regime if it is still valid (validUntil in the future),
 * otherwise runs the analyst and persists the result. Macro is shared across
 * the session and changes slowly, so the orchestrator calls this rather than
 * macroAnalyst() directly.
 */
export async function cachedMacro(requestId: string): Promise<MacroRegime> {
  const log = childLogger({ agentId: 'macroAnalyst', requestId });
  const cached = await readState<MacroRegime>(MACRO_CACHE_FILE);
  if (cached) {
    const valid = MacroRegimeSchema.safeParse(cached);
    if (valid.success && isFresh(valid.data.validUntil)) {
      log.debug({ validUntil: valid.data.validUntil }, 'macro cache hit');
      return valid.data;
    }
  }
  const regime = await macroAnalyst({ requestId });
  await writeState(MACRO_CACHE_FILE, regime);
  return regime;
}

export { MACRO_CACHE_FILE };
