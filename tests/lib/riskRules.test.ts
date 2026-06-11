import { describe, it, expect } from 'vitest';
import {
  evaluateRiskRules,
  isWithinTradingWindow,
  medianPositionNotional,
  type RiskRuleContext,
} from '../../src/lib/riskRules.js';
import type { TradeProposal } from '../../src/types/contracts.js';
import type { PortfolioStateRaw } from '../../src/tools/alpaca.js';

// Thursday 2026-06-11, 14:00 ET (18:00 UTC, EDT) — comfortably inside the window.
const MIDDAY_ET = new Date('2026-06-11T18:00:00Z');

function makeProposal(over: Partial<TradeProposal> = {}): TradeProposal {
  return {
    ticker: 'NVDA',
    action: 'BUY',
    sizeUsd: 8000,
    sizePctOfEquity: 8,
    entryPrice: 100,
    stopLoss: 95,
    takeProfit: 115,
    timeHorizonDays: 30,
    rationale: 'baseline test proposal with enough characters',
    confidence: 70,
    agentTrace: ['test'],
    ...over,
  };
}

function makePortfolio(over: Partial<PortfolioStateRaw> = {}): PortfolioStateRaw {
  return {
    equity: 100_000,
    lastEquity: 100_000,
    cash: 50_000,
    buyingPower: 100_000,
    dayTradeCount: 0,
    positions: [
      { symbol: 'AAPL', qty: 50, marketValue: 10_000, costBasis: 9_000, unrealizedPl: 1_000, unrealizedPlPct: 0.11 },
      { symbol: 'MSFT', qty: 30, marketValue: 12_000, costBasis: 11_000, unrealizedPl: 1_000, unrealizedPlPct: 0.09 },
    ],
    ...over,
  };
}

function baseCtx(over: Partial<RiskRuleContext> = {}): RiskRuleContext {
  return {
    proposal: makeProposal(),
    portfolio: makePortfolio(),
    cooldowns: {},
    tradesToday: 0,
    now: MIDDAY_ET,
    ...over,
  };
}

const byCode = (results: ReturnType<typeof evaluateRiskRules>, code: string) =>
  results.find((r) => r.code === code)!;

describe('evaluateRiskRules', () => {
  it('passes every rule for a clean baseline trade', () => {
    const results = evaluateRiskRules(baseCtx());
    expect(results.every((r) => r.passed)).toBe(true);
  });

  it('flags an oversized position (adjustable, not hard)', () => {
    const r = byCode(evaluateRiskRules(baseCtx({ proposal: makeProposal({ sizePctOfEquity: 20 }) })), 'single_position_pct');
    expect(r.passed).toBe(false);
    expect(r.hard).toBe(false);
  });

  it('rejects on leverage > 1.0 (hard)', () => {
    const r = byCode(evaluateRiskRules(baseCtx({ proposal: makeProposal({ sizeUsd: 90_000 }) })), 'leverage');
    expect(r.passed).toBe(false);
    expect(r.hard).toBe(true);
  });

  it('rejects when the daily loss limit is breached (hard)', () => {
    const r = byCode(evaluateRiskRules(baseCtx({ portfolio: makePortfolio({ equity: 97_000 }) })), 'daily_loss_limit');
    expect(r.passed).toBe(false);
    expect(r.hard).toBe(true);
  });

  it('rejects after the daily trade cap (hard)', () => {
    const r = byCode(evaluateRiskRules(baseCtx({ tradesToday: 3 })), 'max_trades_per_day');
    expect(r.passed).toBe(false);
    expect(r.hard).toBe(true);
  });

  it('rejects when the ticker is in cooldown (hard)', () => {
    const r = byCode(
      evaluateRiskRules(baseCtx({ cooldowns: { NVDA: '2026-06-12T00:00:00Z' } })),
      'cooldown',
    );
    expect(r.passed).toBe(false);
    expect(r.hard).toBe(true);
  });

  it('rejects a fat-finger notional (hard)', () => {
    // median position = 11,000; 2× = 22,000. 30,000 exceeds it.
    const r = byCode(evaluateRiskRules(baseCtx({ proposal: makeProposal({ sizeUsd: 30_000 }) })), 'fat_finger');
    expect(r.passed).toBe(false);
    expect(r.hard).toBe(true);
  });
});

describe('isWithinTradingWindow', () => {
  it('allows a weekday mid-session', () => {
    expect(isWithinTradingWindow(MIDDAY_ET, 30, 30).ok).toBe(true);
  });

  it('blocks weekends', () => {
    // Saturday 2026-06-13
    expect(isWithinTradingWindow(new Date('2026-06-13T18:00:00Z'), 30, 30).ok).toBe(false);
  });

  it('blocks the first 30 minutes after the open', () => {
    // 09:40 ET = 13:40 UTC (EDT)
    expect(isWithinTradingWindow(new Date('2026-06-11T13:40:00Z'), 30, 30).ok).toBe(false);
  });

  it('blocks the last 30 minutes before the close', () => {
    // 15:45 ET = 19:45 UTC (EDT)
    expect(isWithinTradingWindow(new Date('2026-06-11T19:45:00Z'), 30, 30).ok).toBe(false);
  });
});

describe('medianPositionNotional', () => {
  it('returns 0 with no positions', () => {
    expect(medianPositionNotional(makePortfolio({ positions: [] }))).toBe(0);
  });

  it('averages the two middle values for an even count', () => {
    expect(medianPositionNotional(makePortfolio())).toBe(11_000);
  });
});
