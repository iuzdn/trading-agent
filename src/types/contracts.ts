import { z } from 'zod';

// ─── Request ──────────────────────────────────────────────────────────────
export const TickerSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9.\-]{0,9}$/, 'invalid ticker');

export const ResearchRequestSchema = z.object({
  ticker: TickerSchema,
  triggerReason: z.enum(['manual', 'momentum_signal', 'news_alert', 'scheduled']),
  context: z.string().optional(),
  requestId: z.string().uuid(),
  timestamp: z.string().datetime(),
});
export type ResearchRequest = z.infer<typeof ResearchRequestSchema>;

// ─── Analyst outputs ──────────────────────────────────────────────────────
const SourceCallSchema = z.object({
  tool: z.string(),
  ts: z.string().datetime(),
});

export const ResearchReportSchema = z.object({
  ticker: TickerSchema,
  sentiment: z.object({
    score: z.number().min(-1).max(1),
    label: z.enum(['bearish', 'neutral', 'bullish']),
  }),
  fundamentals: z.object({
    pe: z.number().nullable(),
    evEbitda: z.number().nullable(),
    revenueGrowthYoY: z.number().nullable(),
    fcfYield: z.number().nullable(),
    debtToEquity: z.number().nullable(),
    score: z.number().min(0).max(100),
  }),
  newsHighlights: z
    .array(
      z.object({
        headline: z.string(),
        sentiment: z.number().min(-1).max(1),
        url: z.string().url(),
        date: z.string(),
      }),
    )
    .max(20),
  thesis: z.string().min(20),
  confidence: z.number().min(0).max(100),
  sourceCalls: z.array(SourceCallSchema).min(1),
});
export type ResearchReport = z.infer<typeof ResearchReportSchema>;

export const MacroRegimeSchema = z.object({
  label: z.enum(['RISK_ON', 'RISK_OFF', 'NEUTRAL', 'CRISIS']),
  rationale: z.string(),
  signals: z.object({
    vix: z.number(),
    yieldCurve: z.number(),
    trendSpy200: z.enum(['above', 'below']),
  }),
  validUntil: z.string().datetime(),
});
export type MacroRegime = z.infer<typeof MacroRegimeSchema>;

// ─── Scout / screening ────────────────────────────────────────────────────
export const ScoutCandidateSchema = z.object({
  ticker: TickerSchema,
  score: z.number().min(0).max(100),
  reason: z.string().min(10),
  stats: z.object({
    momentum: z.number().min(-100).max(100),
    rsi14: z.number().min(0).max(100),
    vs200dma: z.enum(['above', 'below']),
    pctChange: z.number().nullable(),
  }),
});
export type ScoutCandidate = z.infer<typeof ScoutCandidateSchema>;

export const ShortlistSchema = z.object({
  asOf: z.string().datetime(),
  regime: z.enum(['RISK_ON', 'RISK_OFF', 'NEUTRAL', 'CRISIS']),
  universeSize: z.number().int().nonnegative(),
  candidates: z.array(ScoutCandidateSchema).max(5),
});
export type Shortlist = z.infer<typeof ShortlistSchema>;

export const TechnicalReportSchema = z.object({
  ticker: TickerSchema,
  trend: z.enum(['up', 'down', 'sideways']),
  momentum: z.number().min(-100).max(100),
  rsi14: z.number().min(0).max(100),
  macdSignal: z.enum(['bullish', 'bearish', 'neutral']),
  keyLevels: z.object({
    support: z.array(z.number().positive()).max(5),
    resistance: z.array(z.number().positive()).max(5),
  }),
  signal: z.enum(['BUY', 'HOLD', 'SELL']),
  confidence: z.number().min(0).max(100),
  // One- to two-sentence interpretation of the indicators. Presentational —
  // optional so a missing commentary never aborts a decision.
  commentary: z.string().min(10).optional(),
});
export type TechnicalReport = z.infer<typeof TechnicalReportSchema>;

// ─── Decision ─────────────────────────────────────────────────────────────
export const CritiqueSchema = z.object({
  bearCase: z.string().min(20),
  hiddenRisks: z.array(z.string()).min(1),
  counterEvidence: z.array(
    z.object({ point: z.string(), sourceUrl: z.string().url().optional() }),
  ),
  strength: z.number().int().min(1).max(10),
});
export type Critique = z.infer<typeof CritiqueSchema>;

export const TradeActionSchema = z.enum(['BUY', 'SELL', 'HOLD', 'CLOSE']);
export type TradeAction = z.infer<typeof TradeActionSchema>;

export const TradeProposalSchema = z
  .object({
    ticker: TickerSchema,
    action: TradeActionSchema,
    sizeUsd: z.number().nonnegative(),
    sizePctOfEquity: z.number().min(0).max(100),
    // Price/horizon fields are required for BUY/SELL/CLOSE and must be positive
    // there; for HOLD the PM may legitimately emit 0 since no order is placed.
    // The refinements below enforce positivity + ordering only for non-HOLD.
    entryPrice: z.number().nonnegative(),
    stopLoss: z.number().nonnegative(),
    takeProfit: z.number().nonnegative(),
    timeHorizonDays: z.number().int().nonnegative().max(365),
    rationale: z.string().min(20),
    confidence: z.number().min(0).max(100),
    agentTrace: z.array(z.string()).min(1),
  })
  .refine(
    (p) =>
      p.action === 'HOLD' ||
      (p.entryPrice > 0 && p.stopLoss > 0 && p.takeProfit > 0 && p.timeHorizonDays > 0),
    {
      message:
        'BUY/SELL/CLOSE require positive entryPrice, stopLoss, takeProfit, and timeHorizonDays',
    },
  )
  .refine((p) => p.action !== 'BUY' || p.stopLoss < p.entryPrice, {
    message: 'BUY: stopLoss must be below entryPrice',
  })
  .refine((p) => p.action !== 'BUY' || p.takeProfit > p.entryPrice, {
    message: 'BUY: takeProfit must be above entryPrice',
  })
  .refine((p) => p.action !== 'SELL' || p.stopLoss > p.entryPrice, {
    message: 'SELL: stopLoss must be above entryPrice (short)',
  })
  .refine((p) => p.action !== 'SELL' || p.takeProfit < p.entryPrice, {
    message: 'SELL: takeProfit must be below entryPrice (short)',
  });
export type TradeProposal = z.infer<typeof TradeProposalSchema>;

export const RiskAssessmentSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED', 'MODIFIED']),
  modifiedProposal: TradeProposalSchema.optional(),
  reason: z.string(),
  rulesTriggered: z.array(z.string()),
});
export type RiskAssessment = z.infer<typeof RiskAssessmentSchema>;

// ─── Execution ────────────────────────────────────────────────────────────
export const ExecutionReportSchema = z.object({
  proposalId: z.string(),
  orderIds: z.array(z.string()),
  fills: z.array(
    z.object({
      qty: z.number(),
      price: z.number(),
      ts: z.string().datetime(),
    }),
  ),
  slippageBps: z.number(),
  status: z.enum(['FILLED', 'PARTIAL', 'REJECTED', 'PENDING']),
  bracketOrderIds: z
    .object({ stop: z.string(), target: z.string() })
    .optional(),
});
export type ExecutionReport = z.infer<typeof ExecutionReportSchema>;

// ─── Top-level ────────────────────────────────────────────────────────────
export const DecisionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('TRADE'),
    proposal: TradeProposalSchema,
    execution: ExecutionReportSchema,
  }),
  z.object({
    kind: z.literal('NO_TRADE'),
    reason: z.string(),
    agentTrace: z.array(z.string()),
  }),
]);
export type Decision = z.infer<typeof DecisionSchema>;

// ─── Portfolio state (Alpaca-mirrored) ────────────────────────────────────
export const PortfolioPositionSchema = z.object({
  symbol: z.string(),
  qty: z.number(),
  marketValue: z.number(),
  costBasis: z.number(),
  unrealizedPl: z.number(),
  unrealizedPlPct: z.number(),
});
export type PortfolioPosition = z.infer<typeof PortfolioPositionSchema>;

export const PortfolioStateSchema = z.object({
  equity: z.number(),
  cash: z.number(),
  buyingPower: z.number(),
  positions: z.array(PortfolioPositionSchema),
  dayTradeCount: z.number().int().nonnegative(),
});
export type PortfolioState = z.infer<typeof PortfolioStateSchema>;
