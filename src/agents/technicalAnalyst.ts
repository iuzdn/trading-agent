import { runAgent, extractJsonBlock } from '../lib/claude.js';
import { loadPrompt } from '../lib/prompts.js';
import { childLogger } from '../lib/logger.js';
import { getBars, type Bar } from '../tools/alpaca.js';
import {
  sma,
  rsi,
  macd as macdFn,
  keyLevels,
  momentumScore,
} from '../tools/indicators.js';
import {
  TechnicalReportSchema,
  type TechnicalReport,
} from '../types/contracts.js';

export interface TechnicalInput {
  ticker: string;
  requestId: string;
}

interface ComputedIndicators {
  ticker: string;
  lastClose: number;
  rsi14: number;
  macd: { macd: number; signal: number; histogram: number };
  sma50: number | null;
  sma200: number | null;
  momentum: number;
  keyLevels: { support: number[]; resistance: number[] };
}

function computeIndicators(ticker: string, bars: Bar[]): ComputedIndicators {
  if (bars.length < 50) {
    throw new Error(`Not enough bars to compute indicators (got ${bars.length})`);
  }
  const closes = bars.map((b) => b.c);
  const lastClose = closes[closes.length - 1]!;
  const rsiSeries = rsi(closes, 14);
  const macdSeries = macdFn(closes);
  const sma50Series = sma(closes, 50);
  const sma200Series = sma(closes, 200);
  return {
    ticker,
    lastClose,
    rsi14: rsiSeries[rsiSeries.length - 1] ?? 50,
    macd: {
      macd: macdSeries.macd[macdSeries.macd.length - 1] ?? 0,
      signal: macdSeries.signal[macdSeries.signal.length - 1] ?? 0,
      histogram: macdSeries.histogram[macdSeries.histogram.length - 1] ?? 0,
    },
    sma50: sma50Series[sma50Series.length - 1] ?? null,
    sma200: sma200Series[sma200Series.length - 1] ?? null,
    momentum: momentumScore(closes),
    keyLevels: keyLevels(bars),
  };
}

export async function technicalAnalyst(input: TechnicalInput): Promise<TechnicalReport> {
  const log = childLogger({ agentId: 'technicalAnalyst', requestId: input.requestId });
  const system = await loadPrompt('technicalAnalyst');
  const t0 = Date.now();

  const bars = await getBars(input.ticker, '1Day', 250);
  const indicators = computeIndicators(input.ticker, bars);
  log.debug({ indicators }, 'computed indicators');

  const result = await runAgent({
    system,
    model: 'claude-haiku-4-5-20251001',
    requestId: input.requestId,
    agentId: 'technicalAnalyst',
    tools: [], // No tools — indicators are pre-computed
    maxToolIterations: 1,
    messages: [
      {
        role: 'user',
        content: `Interpret the following pre-computed indicators for ${input.ticker}:

\`\`\`json
${JSON.stringify(indicators, null, 2)}
\`\`\`

Emit the structured JSON report per the system prompt.`,
      },
    ],
  });

  const json = extractJsonBlock(result.finalText);
  const parsed = TechnicalReportSchema.safeParse(json);
  if (!parsed.success) {
    log.error({ issues: parsed.error.issues, raw: json }, 'technicalAnalyst output failed schema');
    throw new Error(`TechnicalReport schema violation: ${parsed.error.message}`);
  }
  log.info(
    {
      latencyMs: Date.now() - t0,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      signal: parsed.data.signal,
      confidence: parsed.data.confidence,
    },
    'technicalAnalyst done',
  );
  return parsed.data;
}

export { computeIndicators };
