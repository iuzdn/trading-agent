import type { ClaudeToolSpec } from '../lib/claude.js';
import { withCache, TTL } from '../lib/cache.js';

const BASE = 'https://finnhub.io/api/v1';

function key(): string {
  const k = process.env.FINNHUB_API_KEY;
  if (!k) throw new Error('FINNHUB_API_KEY missing');
  return k;
}

async function fhGet<T>(path: string): Promise<T> {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${BASE}${path}${sep}token=${key()}`);
  if (!res.ok) throw new Error(`Finnhub ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export interface NewsItem {
  headline: string;
  summary: string;
  url: string;
  date: string;
  source: string;
}

export async function getNews(ticker: string, days: number): Promise<NewsItem[]> {
  return withCache('get_news', { ticker, days }, TTL.FIFTEEN_MIN, async () => {
    const to = new Date().toISOString().split('T')[0];
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0];
    const raw = await fhGet<
      Array<{
        headline: string;
        summary: string;
        url: string;
        datetime: number;
        source: string;
      }>
    >(`/company-news?symbol=${ticker}&from=${from}&to=${to}`);
    return raw.slice(0, 25).map((n) => ({
      headline: n.headline,
      summary: n.summary,
      url: n.url,
      date: new Date(n.datetime * 1000).toISOString(),
      source: n.source,
    }));
  });
}

export const getNewsTool: ClaudeToolSpec = {
  name: 'get_news',
  description:
    'Fetch recent company news headlines for a ticker over the last N days. Returns up to 25 items.',
  input_schema: {
    type: 'object',
    properties: {
      ticker: { type: 'string' },
      days: { type: 'number', description: 'Lookback window in days, max 30' },
    },
    required: ['ticker', 'days'],
  },
  execute: async (input) => {
    const { ticker, days } = input as { ticker: string; days: number };
    return getNews(ticker, Math.min(days, 30));
  },
};

export interface AnalystRatings {
  asOf: string;
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
}

export async function getAnalystRatings(ticker: string): Promise<AnalystRatings | null> {
  return withCache('get_analyst_ratings', { ticker }, TTL.SIX_HOUR, async () => {
    const raw = await fhGet<
      Array<{
        period: string;
        strongBuy: number;
        buy: number;
        hold: number;
        sell: number;
        strongSell: number;
      }>
    >(`/stock/recommendation?symbol=${ticker}`);
    const latest = raw[0];
    if (!latest) return null;
    return {
      asOf: latest.period,
      strongBuy: latest.strongBuy,
      buy: latest.buy,
      hold: latest.hold,
      sell: latest.sell,
      strongSell: latest.strongSell,
    };
  });
}

export const getAnalystRatingsTool: ClaudeToolSpec = {
  name: 'get_analyst_ratings',
  description:
    'Fetch the latest sell-side analyst recommendation distribution (strong buy/buy/hold/sell/strong sell).',
  input_schema: {
    type: 'object',
    properties: { ticker: { type: 'string' } },
    required: ['ticker'],
  },
  execute: async (input) => getAnalystRatings((input as { ticker: string }).ticker),
};
