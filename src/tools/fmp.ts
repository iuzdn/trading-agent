import type { ClaudeToolSpec } from '../lib/claude.js';
import { withCache, TTL } from '../lib/cache.js';

const BASE = 'https://financialmodelingprep.com/api/v3';

function key(): string {
  const k = process.env.FMP_API_KEY;
  if (!k) throw new Error('FMP_API_KEY missing');
  return k;
}

async function fmpGet<T>(path: string): Promise<T> {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${BASE}${path}${sep}apikey=${key()}`);
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

export async function getFinancials(ticker: string): Promise<Fundamentals> {
  return withCache('get_financials', { ticker }, TTL.DAY, async () => {
    const [ratios, keyMetrics, income] = await Promise.all([
      fmpGet<
        Array<{
          priceEarningsRatio?: number;
          enterpriseValueMultiple?: number;
          debtEquityRatio?: number;
        }>
      >(`/ratios-ttm/${ticker}`),
      fmpGet<
        Array<{
          marketCapTTM?: number;
          freeCashFlowYieldTTM?: number;
        }>
      >(`/key-metrics-ttm/${ticker}`),
      fmpGet<Array<{ revenue: number; date: string }>>(`/income-statement/${ticker}?limit=5`),
    ]);

    const r = ratios[0] ?? {};
    const km = keyMetrics[0] ?? {};
    let revenueGrowthYoY: number | null = null;
    if (income.length >= 2 && income[1]!.revenue) {
      revenueGrowthYoY = (income[0]!.revenue - income[1]!.revenue) / income[1]!.revenue;
    }

    return {
      pe: r.priceEarningsRatio ?? null,
      evEbitda: r.enterpriseValueMultiple ?? null,
      revenueGrowthYoY,
      fcfYield: km.freeCashFlowYieldTTM ?? null,
      debtToEquity: r.debtEquityRatio ?? null,
      marketCap: km.marketCapTTM ?? null,
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

export async function getEarningsHistory(ticker: string): Promise<EarningsRow[]> {
  return withCache('get_earnings_history', { ticker }, TTL.DAY, async () => {
    const raw = await fmpGet<
      Array<{ date: string; eps: number | null; epsEstimated: number | null }>
    >(`/historical/earning_calendar/${ticker}?limit=8`);
    return raw.map((r) => ({
      date: r.date,
      epsActual: r.eps,
      epsEstimated: r.epsEstimated,
      surprise:
        r.eps != null && r.epsEstimated ? (r.eps - r.epsEstimated) / Math.abs(r.epsEstimated) : null,
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
