import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Bar } from '../../src/tools/alpaca.js';
import { agentResult } from '../helpers/mockRunAgent.js';

// Hoisted shared state so the vi.mock factories below can reference it.
const h = vi.hoisted(() => ({
  runAgent: vi.fn(),
  store: new Map<string, unknown>(),
}));

vi.mock('../../src/lib/claude.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/claude.js')>()),
  runAgent: h.runAgent,
}));

// Keep trendVsSma real; feed deterministic rising SPY bars (→ "above").
vi.mock('../../src/tools/marketIndex.js', async (orig) => ({
  ...(await orig<typeof import('../../src/tools/marketIndex.js')>()),
  getIndexData: vi.fn(
    async (): Promise<Bar[]> =>
      Array.from({ length: 250 }, (_, i) => ({ t: '', o: 0, h: 0, l: 0, c: 100 + i, v: 0 })),
  ),
}));

// In-memory state backend so the cache test doesn't touch disk.
vi.mock('../../src/lib/state.js', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/state.js')>()),
  readState: vi.fn(async (f: string) => (h.store.has(f) ? h.store.get(f) : null)),
  writeState: vi.fn(async (f: string, v: unknown) => {
    h.store.set(f, v);
  }),
}));

import { macroAnalyst, cachedMacro, MACRO_CACHE_FILE } from '../../src/agents/macroAnalyst.js';

function fixture() {
  return {
    label: 'RISK_ON',
    rationale: 'Low VIX, SPY above its 200-day average, curve modestly positive.',
    signals: { vix: 13.5, yieldCurve: 0.25, trendSpy200: 'below' }, // overridden by code
    validUntil: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
  };
}

beforeEach(() => {
  h.store.clear();
  h.runAgent.mockReset();
  h.runAgent.mockResolvedValue(agentResult(fixture()));
});

describe('macroAnalyst', () => {
  it('parses the model output and overrides trendSpy200 with the computed value', async () => {
    const regime = await macroAnalyst({ requestId: 'r1' });
    expect(regime.label).toBe('RISK_ON');
    expect(regime.signals.vix).toBe(13.5);
    // Rising SPY series → close above 200-DMA, regardless of what the model said.
    expect(regime.signals.trendSpy200).toBe('above');
  });
});

describe('cachedMacro', () => {
  it('runs the analyst once, then serves the cache while still valid', async () => {
    const first = await cachedMacro('r1');
    expect(h.runAgent).toHaveBeenCalledTimes(1);
    expect(h.store.has(MACRO_CACHE_FILE)).toBe(true);

    const second = await cachedMacro('r2');
    expect(h.runAgent).toHaveBeenCalledTimes(1); // no second model call
    expect(second).toEqual(first);
  });

  it('recomputes when the cached regime has expired', async () => {
    h.runAgent.mockResolvedValue(
      agentResult({ ...fixture(), validUntil: new Date(Date.now() - 1000).toISOString() }),
    );
    await cachedMacro('r1'); // writes an already-expired entry
    await cachedMacro('r2'); // must recompute
    expect(h.runAgent).toHaveBeenCalledTimes(2);
  });
});
