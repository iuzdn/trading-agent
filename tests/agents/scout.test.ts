import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Bar } from '../../src/tools/alpaca.js';
import type { MacroRegime } from '../../src/types/contracts.js';
import { agentResult } from '../helpers/mockRunAgent.js';

const h = vi.hoisted(() => ({
  runAgent: vi.fn(),
  store: new Map<string, unknown>(),
  regime: { label: 'RISK_ON' } as { label: MacroRegime['label'] },
}));

vi.mock('../../src/lib/claude.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/claude.js')>()),
  runAgent: h.runAgent,
}));

vi.mock('../../src/agents/macroAnalyst.js', async (orig) => ({
  ...(await orig<typeof import('../../src/agents/macroAnalyst.js')>()),
  cachedMacro: vi.fn(
    async (): Promise<MacroRegime> => ({
      label: h.regime.label,
      rationale: 'test regime',
      signals: { vix: 15, yieldCurve: 0.3, trendSpy200: 'above' },
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    }),
  ),
}));

vi.mock('../../src/tools/screener.js', async (orig) => ({
  ...(await orig<typeof import('../../src/tools/screener.js')>()),
  getMovers: vi.fn(async () => [
    { symbol: 'AAA', price: 50, percentChange: 4.2 },
    { symbol: 'BBB', price: 80, percentChange: 2.1 },
  ]),
  getMostActives: vi.fn(async () => [{ symbol: 'CCC', volume: 9_000_000 }]),
}));

// Rising-with-pullbacks 250-bar series → above 200-DMA, positive momentum,
// moderate RSI (a monotonic rise would pin RSI at 100 and fail the screen).
vi.mock('../../src/tools/alpaca.js', async (orig) => ({
  ...(await orig<typeof import('../../src/tools/alpaca.js')>()),
  getBars: vi.fn(
    async (): Promise<Bar[]> =>
      Array.from({ length: 250 }, (_, i) => {
        const c = 50 + i * 0.1 + Math.sin((i + 8) / 3) * 2;
        return { t: `d${i}`, o: c, h: c * 1.01, l: c * 0.99, c, v: 1000 };
      }),
  ),
  getPortfolioState: vi.fn(async () => ({
    equity: 100_000,
    lastEquity: 100_000,
    cash: 50_000,
    buyingPower: 100_000,
    dayTradeCount: 0,
    positions: [],
  })),
}));

vi.mock('../../src/lib/state.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/state.js')>()),
  readState: vi.fn(async (f: string) => (h.store.has(f) ? h.store.get(f) : null)),
  writeState: vi.fn(async (f: string, v: unknown) => {
    h.store.set(f, v);
  }),
}));

import { scout, LAST_SHORTLIST_FILE } from '../../src/agents/scout.js';

function shortlistFixture(tickers: string[]) {
  return {
    asOf: new Date().toISOString(),
    regime: 'RISK_ON',
    universeSize: 3,
    candidates: tickers.map((ticker, i) => ({
      ticker,
      score: 90 - i * 10,
      reason: `strong momentum with healthy RSI for ${ticker}`,
      stats: { momentum: 50, rsi14: 55, vs200dma: 'above', pctChange: 3.1 },
    })),
  };
}

beforeEach(() => {
  h.store.clear();
  h.regime.label = 'RISK_ON';
  h.runAgent.mockReset();
});

describe('scout', () => {
  it('produces a grounded shortlist and persists it', async () => {
    h.runAgent.mockResolvedValue(agentResult(shortlistFixture(['AAA', 'CCC'])));
    const out = await scout({ requestId: 'r1' });
    expect(out.candidates.map((c) => c.ticker)).toEqual(['AAA', 'CCC']);
    expect(out.regime).toBe('RISK_ON');
    expect(out.universeSize).toBe(3);
    expect(h.store.has(LAST_SHORTLIST_FILE)).toBe(true);
    expect(h.runAgent).toHaveBeenCalledTimes(1); // exactly one triage call
  });

  it('drops hallucinated tickers outside the screened universe', async () => {
    h.runAgent.mockResolvedValue(agentResult(shortlistFixture(['AAA', 'NVDA'])));
    const out = await scout({ requestId: 'r1' });
    expect(out.candidates.map((c) => c.ticker)).toEqual(['AAA']); // NVDA not screened
  });

  it('CRISIS short-circuits: empty shortlist, zero LLM calls', async () => {
    h.regime.label = 'CRISIS';
    const out = await scout({ requestId: 'r1' });
    expect(out.candidates).toEqual([]);
    expect(out.regime).toBe('CRISIS');
    expect(h.runAgent).not.toHaveBeenCalled();
    expect(h.store.has(LAST_SHORTLIST_FILE)).toBe(true);
  });

  it('caps candidates at maxCandidates', async () => {
    h.runAgent.mockResolvedValue(agentResult(shortlistFixture(['AAA', 'BBB', 'CCC'])));
    const out = await scout({ requestId: 'r1', maxCandidates: 2 });
    expect(out.candidates).toHaveLength(2);
  });
});
