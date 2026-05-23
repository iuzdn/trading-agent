import type { ClaudeToolSpec } from '../lib/claude.js';
import { withCache, TTL } from '../lib/cache.js';

// FMP retired the /api/v3 endpoints in August 2025. New users only have
// access to the "stable" API. See:
// https://site.financialmodelingprep.com/developer/docs/stable
const BASE = 'https://financialmodelingprep.com/stable';

function key(): string {
  const k = process.env.FMP_API_KEY;
  if (!k) throw new Error('FMP_API_KEY missing');
  return k;
}

async function fmpGet<T>(path: string, params: Record<string, string | number>): Promise<T> {
  const search = new URLSearchParams({ ...params, apikey: key() } as Record<string, string>);
  const res = await fetch(`${BASE}${path}?${search.toString()}`);
  if (!res.ok) throw new Error(`FMP ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export interface Fundamentals {
  pe: number | null;
  evEbitda: number | null;
  revenueGrowthYoY: number | null;
  fcfYield: number | null;
  debtToEquity: number | null;
  marketCap: number | null;
  asOf: string;
}

interface RatiosTTM {
  priceToEarningsRatioTTM?: number;
  debtToEquityRatioTTM?: number;
}

interface KeyMetricsTTM {
  marketCap?: number;
  evToEBITDATTM?: number;
  freeCashFlowYieldTTM?: number;
}

interface IncomeStatementRow {
  revenue: number;
  date: string;
}

export async function getFinancials(ticker: string): Promise<Fundamentals> {
  return withCache('get_financials', { ticker }, TTL.DAY, async () => {
    const [ratios, keyMetrics, income] = await Promise.all([
      fmpGet<RatiosTTM[]>('/ratios-ttm', { symbol: ticker }),
      fmpGet<KeyMetricsTTM[]>('/key-metrics-ttm', { symbol: ticker }),
      fmpGet<IncomeStatementRow[]>('/income-statement', { symbol: ticker, limit: 5 }),
    ]);

    const r = ratios[0] ?? {};
    const km = keyMetrics[0] ?? {};
    let revenueGrowthYoY: number | null = null;
    if (income.length >= 2 && income[1]!.revenue) {
      revenueGrowthYoY = (income[0]!.revenue - income[1]!.revenue) / income[1]!.revenue;
    }

    return {
      pe: r.priceToEarningsRatioTTM ?? null,
      evEbitda: km.evToEBITDATTM ?? null,
      revenueGrowthYoY,
      fcfYield: km.freeCashFlowYieldTTM ?? null,
      debtToEquity: r.debtToEquityRatioTTM ?? null,
      marketCap: km.marketCap ?? null,
      asOf: new Date().toISOString(),
    };
  });
}

export const getFinancialsTool: ClaudeToolSpec = {
  name: 'get_financials',
  description:
    'Fetch trailing-twelve-month fundamentals: P/E, EV/EBITDA, revenue growth YoY, FCF yield, debt/equity, market cap.',
  input_schema: {
    type: 'object',
    properties: { ticker: { type: 'string' } },
    required: ['ticker'],
  },
  execute: async (input) => getFinancials((input as { ticker: string }).ticker),
};

export interface EarningsRow {
  date: string;
  epsActual: number | null;
  epsEstimated: number | null;
  surprise: number | null;
}

interface EarningsApiRow {
  date: string;
  epsActual: number | null;
  epsEstimated: number | null;
}

export async function getEarningsHistory(ticker: string): Promise<EarningsRow[]> {
  return withCache('get_earnings_history', { ticker }, TTL.DAY, async () => {
    const raw = await fmpGet<EarningsApiRow[]>('/earnings', {
      symbol: ticker,
      limit: 8,
    });
    return raw.map((r) => ({
      date: r.date,
      epsActual: r.epsActual,
      epsEstimated: r.epsEstimated,
      surprise:
        r.epsActual != null && r.epsEstimated
          ? (r.epsActual - r.epsEstimated) / Math.abs(r.epsEstimated)
          : null,
    }));
  });
}

export const getEarningsHistoryTool: ClaudeToolSpec = {
  name: 'get_earnings_history',
  description:
    'Fetch the last 8 quarters of EPS actuals vs estimates for a ticker, including surprise percentage.',
  input_schema: {
    type: 'object',
    properties: { ticker: { type: 'string' } },
    required: ['ticker'],
  },
  execute: async (input) => getEarningsHistory((input as { ticker: string }).ticker),
};
