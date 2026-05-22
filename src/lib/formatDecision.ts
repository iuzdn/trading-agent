import type { PipelineResult } from '../agents/orchestrator.js';

/**
 * Compact Telegram summary card for a pipeline result. Plain Markdown
 * (the v1 Telegram dialect), kept short enough to fit one message.
 */
export function formatDecisionCard(r: PipelineResult): string {
  const ticker = r.request.ticker;
  const elapsed = (r.latencyMs / 1000).toFixed(1);
  const lines: string[] = [];
  lines.push(`*Research: ${ticker}*  _${r.request.triggerReason}_`);
  lines.push('');

  // Analyst snapshot
  const sLabel = r.research.sentiment.label;
  const sentEmoji = sLabel === 'bullish' ? '🟢' : sLabel === 'bearish' ? '🔴' : '⚪️';
  lines.push(
    `${sentEmoji} *Research:* ${sLabel} (conf ${r.research.confidence})  •  fundscore ${r.research.fundamentals.score}`,
  );
  const tEmoji = r.technical.signal === 'BUY' ? '🟢' : r.technical.signal === 'SELL' ? '🔴' : '⚪️';
  lines.push(
    `${tEmoji} *Technical:* ${r.technical.signal} ${r.technical.trend}  •  RSI ${r.technical.rsi14.toFixed(0)}  MACD ${r.technical.macdSignal}`,
  );
  lines.push('');

  // Decision
  if (r.decision.kind === 'NO_TRADE') {
    lines.push(`⏸ *No trade* — _${r.decision.reason}_`);
  } else {
    const p = r.proposal;
    const e = r.execution;
    const sideEmoji = p.action === 'BUY' ? '🟢' : '🔴';
    lines.push(`${sideEmoji} *${p.action} ${ticker}*  $${p.sizeUsd.toFixed(0)} (${p.sizePctOfEquity.toFixed(1)}%)`);
    lines.push(
      `entry $${p.entryPrice.toFixed(2)}  •  stop $${p.stopLoss.toFixed(2)}  •  target $${p.takeProfit.toFixed(2)}`,
    );
    lines.push(`horizon ${p.timeHorizonDays}d  •  conf ${p.confidence}`);
    if (e) {
      lines.push('');
      lines.push(
        `📨 *Order:* ${e.status}  •  ${e.orderIds[0]?.slice(0, 8) ?? '—'}  •  slip ${e.slippageBps}bps`,
      );
    }
  }

  lines.push('');
  lines.push(`_${elapsed}s • req ${r.request.requestId.slice(0, 8)}_`);
  return lines.join('\n');
}
