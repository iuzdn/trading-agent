import { randomUUID } from 'node:crypto';
import { childLogger } from '../lib/logger.js';
import {
  placeBracketOrder,
  getOrder,
  getLatestTrade,
  tradingMode,
  type AlpacaOrder,
} from '../tools/alpaca.js';
import {
  ExecutionReportSchema,
  type ExecutionReport,
  type TradeProposal,
} from '../types/contracts.js';

export interface ExecutorInput {
  proposal: TradeProposal;
  requestId: string;
}

/**
 * Phase 1 executor: deterministic translation of an approved TradeProposal
 * into a single Alpaca bracket order. No LLM call — this layer is mechanical.
 * Phase 2 can swap in an LLM-driven version for TWAP slicing decisions.
 */
export async function executor(input: ExecutorInput): Promise<ExecutionReport> {
  const log = childLogger({ agentId: 'executor', requestId: input.requestId });
  const { proposal } = input;

  if (proposal.action === 'HOLD') {
    throw new Error('Executor invoked with HOLD action — orchestrator bug');
  }

  if (proposal.sizeUsd <= 0) {
    throw new Error('Executor invoked with sizeUsd <= 0');
  }

  const proposalId = randomUUID();
  const qty = Math.max(1, Math.floor(proposal.sizeUsd / proposal.entryPrice));
  const side = proposal.action === 'BUY' ? 'buy' : 'sell';

  log.info(
    {
      mode: tradingMode(),
      ticker: proposal.ticker,
      side,
      qty,
      entry: proposal.entryPrice,
      stop: proposal.stopLoss,
      target: proposal.takeProfit,
    },
    'submitting bracket order',
  );

  let order: AlpacaOrder;
  try {
    order = await placeBracketOrder({
      ticker: proposal.ticker,
      side,
      qty,
      entryPrice: proposal.entryPrice,
      stopLoss: proposal.stopLoss,
      takeProfit: proposal.takeProfit,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'place_order failed');
    const report: ExecutionReport = {
      proposalId,
      orderIds: [],
      fills: [],
      slippageBps: 0,
      status: 'REJECTED',
    };
    return ExecutionReportSchema.parse(report);
  }

  // Capture leg IDs for bracket OCO (Alpaca returns them in `legs`).
  const legs = order.legs ?? [];
  const takeProfitLeg = legs.find((l) => l.id && (l as { type?: string }).type === 'limit');
  const stopLossLeg = legs.find((l) => l.id && (l as { type?: string }).type === 'stop');
  const bracketOrderIds =
    takeProfitLeg && stopLossLeg
      ? { stop: stopLossLeg.id, target: takeProfitLeg.id }
      : legs.length === 2 && legs[0]!.id && legs[1]!.id
        ? { stop: legs[1]!.id, target: legs[0]!.id }
        : undefined;

  // Re-fetch the parent to capture any immediate fill.
  let parent = order;
  try {
    parent = await getOrder(order.id);
  } catch {
    // Non-fatal: status field on the initial response is enough.
  }

  const filledQty = parent.filled_qty ? parseFloat(parent.filled_qty) : 0;
  const filledPrice = parent.filled_avg_price ? parseFloat(parent.filled_avg_price) : 0;

  // Slippage relative to entryPrice hint.
  let slippageBps = 0;
  if (filledPrice > 0) {
    const ref = proposal.entryPrice;
    slippageBps = Math.round(((filledPrice - ref) / ref) * 10_000);
    // For sells, negative slippage is "bad" → invert sign convention.
    if (side === 'sell') slippageBps = -slippageBps;
  } else {
    try {
      const last = await getLatestTrade(proposal.ticker);
      slippageBps = Math.round(((last.p - proposal.entryPrice) / proposal.entryPrice) * 10_000);
      if (side === 'sell') slippageBps = -slippageBps;
    } catch {
      // ignore; leave at 0
    }
  }

  const orderIds = [order.id, ...(legs.map((l) => l.id).filter(Boolean) as string[])];
  const fills = filledQty > 0 && filledPrice > 0
    ? [{ qty: filledQty, price: filledPrice, ts: parent.submitted_at ?? new Date().toISOString() }]
    : [];

  const status: ExecutionReport['status'] =
    parent.status === 'filled'
      ? 'FILLED'
      : parent.status === 'partially_filled'
        ? 'PARTIAL'
        : parent.status === 'rejected' || parent.status === 'canceled'
          ? 'REJECTED'
          : 'PENDING';

  const report: ExecutionReport = {
    proposalId,
    orderIds,
    fills,
    slippageBps,
    status,
    ...(bracketOrderIds ? { bracketOrderIds } : {}),
  };

  const parsed = ExecutionReportSchema.parse(report);
  log.info(
    {
      mode: tradingMode(),
      orderId: order.id,
      status: parsed.status,
      slippageBps: parsed.slippageBps,
    },
    'execution complete',
  );
  return parsed;
}
