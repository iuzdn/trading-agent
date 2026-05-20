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

export const allTools: ClaudeToolSpec[] = [
  getBarsTool,
  getPortfolioStateTool,
  placeOrderTool,
  getFinancialsTool,
  getEarningsHistoryTool,
  getNewsTool,
  getAnalystRatingsTool,
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

export {
  getBarsTool,
  getPortfolioStateTool,
  placeOrderTool,
  getFinancialsTool,
  getEarningsHistoryTool,
  getNewsTool,
  getAnalystRatingsTool,
};
