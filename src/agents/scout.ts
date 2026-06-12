import { runAgent, extractJsonBlock } from '../lib/claude.js';
import { loadPrompt } from '../lib/prompts.js';
import { childLogger } from '../lib/logger.js';
import { readState, writeState } from '../lib/state.js';
import { getBars, getPortfolioState } from '../tools/alpaca.js';
import { getMovers, getMostActives, type ScreenedSymbol } from '../tools/screener.js';
import { buildCandidateStats, filterAndRank, type RankedCandidate } from '../lib/screen.js';
import { cachedMacro } from './macroAnalyst.js';
import { COOLDOWNS_FILE } from './riskManager.js';
import { ShortlistSchema, type Shortlist } from '../types/contracts.js';
import riskRules from '../config/riskRules.json' with { type: 'json' };

export const LAST_SHORTLIST_FILE = 'lastShortlist.json';

export interface ScoutInput {
  requestId: string;
  maxCandidates?: number;
}

/**
 * Scout (Phase 2.5). Two-stage funnel: a deterministic screen over Alpaca
 * movers + most-actives builds a regime-filtered ranked list (no LLM), then a
 * single Haiku call triages it into a Shortlist. The LLM can only choose from
 * names the real screen surfaced — hallucinated tickers are dropped.
 */
export async function scout(input: ScoutInput): Promise<Shortlist> {
  const log = childLogger({ agentId: 'scout', requestId: input.requestId });
  const maxCandidates = Math.min(input.maxCandidates ?? 5, 5);
  const asOf = new Date().toISOString();
  const t0 = Date.now();

  const macro = await cachedMacro(input.requestId);

  // CRISIS: no new longs, no LLM spend.
  if (macro.label === 'CRISIS') {
    log.info('CRISIS regime — empty shortlist, skipping screen + triage');
    const empty: Shortlist = { asOf, regime: macro.label, universeSize: 0, candidates: [] };
    await writeState(LAST_SHORTLIST_FILE, empty);
    return empty;
  }

  // Stage 1 — deterministic screen.
  const [movers, actives] = await Promise.all([getMovers(25), getMostActives(25)]);
  const universe = new Map<string, ScreenedSymbol>();
  for (const s of [...movers, ...actives]) {
    if (!universe.has(s.symbol)) universe.set(s.symbol, s);
  }
  log.info({ movers: movers.length, actives: actives.length, universe: universe.size }, 'universe built');

  const [cooldowns, portfolio] = await Promise.all([
    readState<Record<string, string>>(COOLDOWNS_FILE),
    getPortfolioState(),
  ]);
  const now = Date.now();
  const activeCooldowns = Object.entries(cooldowns ?? {})
    .filter(([, until]) => new Date(until).getTime() > now)
    .map(([ticker]) => ticker);
  const heldOverCap = portfolio.positions
    .filter(
      (p) =>
        portfolio.equity > 0 &&
        (Math.abs(p.marketValue) / portfolio.equity) * 100 >= riskRules.maxPositionPctOfEquity,
    )
    .map((p) => p.symbol);

  const statsList = (
    await Promise.all(
      [...universe.values()].map(async (s) => {
        try {
          const bars = await getBars(s.symbol, '1Day', 250);
          return buildCandidateStats(s.symbol, bars, s.percentChange ?? null);
        } catch (err) {
          log.debug(
            { symbol: s.symbol, err: err instanceof Error ? err.message : String(err) },
            'bars fetch failed — skipping symbol',
          );
          return null;
        }
      }),
    )
  ).filter((s): s is NonNullable<typeof s> => s !== null);

  const ranked = filterAndRank(statsList, macro.label, {
    cooldowns: activeCooldowns,
    heldOverCap,
  });
  log.info(
    { withStats: statsList.length, ranked: ranked.length, regime: macro.label },
    'deterministic screen done',
  );

  if (ranked.length === 0) {
    const empty: Shortlist = {
      asOf,
      regime: macro.label,
      universeSize: universe.size,
      candidates: [],
    };
    await writeState(LAST_SHORTLIST_FILE, empty);
    log.info('no candidates survived the screen — empty shortlist');
    return empty;
  }

  // Stage 2 — single Haiku triage call.
  const shortlist = await triage(input.requestId, asOf, macro.label, universe.size, ranked, maxCandidates);
  await writeState(LAST_SHORTLIST_FILE, shortlist);

  log.info(
    { latencyMs: Date.now() - t0, picks: shortlist.candidates.map((c) => c.ticker) },
    'scout done',
  );
  return shortlist;
}

async function triage(
  requestId: string,
  asOf: string,
  regime: Shortlist['regime'],
  universeSize: number,
  ranked: RankedCandidate[],
  maxCandidates: number,
): Promise<Shortlist> {
  const log = childLogger({ agentId: 'scout', requestId });
  const system = await loadPrompt('scout');

  const result = await runAgent({
    system,
    model: 'claude-haiku-4-5-20251001',
    requestId,
    agentId: 'scout',
    tools: [],
    maxToolIterations: 1,
    messages: [
      {
        role: 'user',
        content: `Triage today's screened candidates into a shortlist (max ${maxCandidates}).

asOf: ${asOf}
universeSize: ${universeSize}

## Macro regime
\`\`\`json
${JSON.stringify({ label: regime }, null, 2)}
\`\`\`

## Ranked candidates (deterministic screen output — pick ONLY from these)
\`\`\`json
${JSON.stringify(ranked, null, 2)}
\`\`\`

Emit the Shortlist JSON per the system prompt.`,
      },
    ],
  });

  const json = extractJsonBlock(result.finalText);
  const parsed = ShortlistSchema.safeParse(json);
  if (!parsed.success) {
    log.error({ issues: parsed.error.issues, raw: json }, 'scout output failed schema');
    throw new Error(`Shortlist schema violation: ${parsed.error.message}`);
  }

  // Grounding guard: drop any ticker the screen didn't surface, re-anchor the
  // metadata fields, and cap at maxCandidates.
  const allowed = new Map(ranked.map((r) => [r.ticker, r]));
  const grounded = parsed.data.candidates.filter((c) => {
    if (allowed.has(c.ticker)) return true;
    log.warn({ ticker: c.ticker }, 'scout picked a ticker outside the screened universe — dropped');
    return false;
  });

  return {
    asOf,
    regime,
    universeSize,
    candidates: grounded.slice(0, maxCandidates),
  };
}
