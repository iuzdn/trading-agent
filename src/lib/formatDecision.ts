import type { PipelineResult } from '../agents/orchestrator.js';
import { sanitizeMarkdownV1 } from './telegram.js';

export interface FormatOptions {
  /**
   * Escape LLM-generated prose for Telegram's legacy Markdown parser.
   * Defaults to true (the Telegram path). Console callers pass false so the
   * output isn't littered with backslashes.
   */
  escapeProse?: boolean;
}

/**
 * Telegram summary card for a pipeline result. Plain Markdown (the v1 dialect).
 * Includes a snapshot line per agent plus each agent's reasoning prose.
 */
export function formatDecisionCard(r: PipelineResult, opts: FormatOptions = {}): string {
  const esc = opts.escapeProse === false ? (s: string) => s : sanitizeMarkdownV1;
  const ticker = r.request.ticker;
  const elapsed = (r.latencyMs / 1000).toFixed(1);
  const lines: string[] = [];
  lines.push(`*Research: ${ticker}*  _${r.request.triggerReason}_`);
  lines.push('');

  // ── Snapshot ──────────────────────────────────────────────────────────
  const sLabel = r.research.sentiment.label;
  const sentEmoji = sLabel === 'bullish' ? '🟢' : sLabel === 'bearish' ? '🔴' : '⚪️';
  lines.push(
    `${sentEmoji} *Research:* ${sLabel} (conf ${r.research.confidence})  •  fundscore ${r.research.fundamentals.score}`,
  );
  const tEmoji = r.technical.signal === 'BUY' ? '🟢' : r.technical.signal === 'SELL' ? '🔴' : '⚪️';
  lines.push(
    `${tEmoji} *Technical:* ${r.technical.signal} ${r.technical.trend}  •  RSI ${r.technical.rsi14.toFixed(0)}  MACD ${r.technical.macdSignal}`,
  );

  // ── Reasoning ─────────────────────────────────────────────────────────
  lines.push('');
  lines.push('🧠 *Reasoning*');
  lines.push(`*Research —* ${esc(r.research.thesis)}`);
  if (r.technical.commentary) {
    lines.push(`*Technical —* ${esc(r.technical.commentary)}`);
  }
  // The PM rationale only exists for a real proposal (not the low-confidence
  // early-exit placeholder). Show it whenever the PM actually ran.
  const pmRan = r.proposal.agentTrace.includes('portfolioManager');
  if (pmRan && r.proposal.rationale) {
    lines.push(`*Decision —* ${esc(r.proposal.rationale)}`);
  }

  // ── Outcome ───────────────────────────────────────────────────────────
  lines.push('');
  if (r.decision.kind === 'NO_TRADE') {
    lines.push(`⏸ *No trade* — _${esc(r.decision.reason)}_`);
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
