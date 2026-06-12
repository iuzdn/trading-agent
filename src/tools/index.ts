import type { ClaudeToolSpec } from '../lib/claude.js';
import {
  getBarsTool,
  getPortfolioStateTool,
  placeOrderTool,
} from './alpaca.js';
import {
  getFinancialsTool,
  getEarningsHistoryTool,
} from './fmp.js';
import {
  getNewsTool,
  getAnalystRatingsTool,
} from './finnhub.js';
import { getIndexDataTool } from './marketIndex.js';
import { getCorrelationsTool } from './correlations.js';
import { getMarketMoversTool } from './screener.js';

export const allTools: ClaudeToolSpec[] = [
  getBarsTool,
  getPortfolioStateTool,
  placeOrderTool,
  getFinancialsTool,
  getEarningsHistoryTool,
  getNewsTool,
  getAnalystRatingsTool,
  getIndexDataTool,
  getCorrelationsTool,
  getMarketMoversTool,
];

export const researchTools: ClaudeToolSpec[] = [
  getFinancialsTool,
  getEarningsHistoryTool,
  getNewsTool,
  getAnalystRatingsTool,
];

export const technicalTools: ClaudeToolSpec[] = [getBarsTool];

export const pmTools: ClaudeToolSpec[] = [getPortfolioStateTool];

export const executorTools: ClaudeToolSpec[] = [placeOrderTool, getPortfolioStateTool];

export const macroTools: ClaudeToolSpec[] = [getIndexDataTool];

export const riskTools: ClaudeToolSpec[] = [getPortfolioStateTool, getCorrelationsTool];

export {
  getBarsTool,
  getPortfolioStateTool,
  placeOrderTool,
  getFinancialsTool,
  getEarningsHistoryTool,
  getNewsTool,
  getAnalystRatingsTool,
  getIndexDataTool,
  getCorrelationsTool,
  getMarketMoversTool,
};
