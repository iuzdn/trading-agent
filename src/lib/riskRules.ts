import type { TradeProposal } from '../types/contracts.js';
import type { PortfolioStateRaw } from '../tools/alpaca.js';
import rules from '../config/riskRules.json' with { type: 'json' };

export type RiskRules = typeof rules;

export interface RuleResult {
  /** Stable rule identifier (goes into RiskAssessment.rulesTriggered). */
  code: string;
  passed: boolean;
  /**
   * Hard rules force a REJECT regardless of LLM judgment. Non-hard breaches are
   * adjustable (the PM/Risk Manager may downsize into a MODIFIED proposal).
   */
  hard: boolean;
  detail: string;
}

export interface RiskRuleContext {
  proposal: TradeProposal;
  portfolio: PortfolioStateRaw;
  /** ticker → ISO-8601 timestamp until which the ticker is in cooldown. */
  cooldowns: Record<string, string>;
  /** Executed trades already journaled today. */
  tradesToday: number;
  now?: Date;
  rules?: RiskRules;
}

const MARKET_OPEN_MIN = 9 * 60 + 30; // 09:30 ET
const MARKET_CLOSE_MIN = 16 * 60; // 16:00 ET

/** Minutes-since-midnight and weekday (0=Sun..6=Sat) in US/Eastern. */
export function easternClock(now: Date): { minutes: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const hour = parseInt(get('hour'), 10) % 24;
  const minute = parseInt(get('minute'), 10);
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return { minutes: hour * 60 + minute, weekday: weekdayMap[get('weekday')] ?? 0 };
}

/**
 * True if `now` is inside the allowed trading window: a weekday, at least
 * `afterOpenMin` after the open and at least `beforeCloseMin` before the close.
 */
export function isWithinTradingWindow(
  now: Date,
  afterOpenMin: number,
  beforeCloseMin: number,
): { ok: boolean; detail: string } {
  const { minutes, weekday } = easternClock(now);
  if (weekday === 0 || weekday === 6) return { ok: false, detail: 'market closed (weekend)' };
  const earliest = MARKET_OPEN_MIN + afterOpenMin;
  const latest = MARKET_CLOSE_MIN - beforeCloseMin;
  if (minutes < MARKET_OPEN_MIN || minutes >= MARKET_CLOSE_MIN) {
    return { ok: false, detail: 'outside regular trading hours' };
  }
  if (minutes < earliest) return { ok: false, detail: `within ${afterOpenMin}m of the open` };
  if (minutes > latest) return { ok: false, detail: `within ${beforeCloseMin}m of the close` };
  return { ok: true, detail: 'within trading window' };
}

/** Median absolute market value across open positions (0 if none). */
export function medianPositionNotional(portfolio: PortfolioStateRaw): number {
  const vals = portfolio.positions.map((p) => Math.abs(p.marketValue)).sort((a, b) => a - b);
  if (vals.length === 0) return 0;
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[mid]! : (vals[mid - 1]! + vals[mid]!) / 2;
}

/**
 * Deterministically evaluate every configured risk rule against a proposal.
 * Pure — no I/O, no clock reads beyond `now`. The Risk Manager passes these
 * results to the LLM and also enforces hard breaches in code.
 */
export function evaluateRiskRules(ctx: RiskRuleContext): RuleResult[] {
  const r = ctx.rules ?? rules;
  const now = ctx.now ?? new Date();
  const { proposal, portfolio } = ctx;
  const out: RuleResult[] = [];

  // 1. Single-position size cap (adjustable → MODIFIED candidate).
  out.push({
    code: 'single_position_pct',
    hard: false,
    passed: proposal.sizePctOfEquity <= r.maxPositionPctOfEquity + 0.01,
    detail: `position ${proposal.sizePctOfEquity.toFixed(1)}% vs cap ${r.maxPositionPctOfEquity}%`,
  });

  // 2. Sector concentration — sector data not yet sourced (Phase-3 gap).
  out.push({
    code: 'sector_concentration',
    hard: false,
    passed: true,
    detail: `not enforced: per-position sector data unavailable (cap ${r.maxSectorConcentrationPct}%)`,
  });

  // 3. Leverage: post-trade gross exposure ≤ maxLeverage × equity (hard).
  const grossExisting = portfolio.positions.reduce((s, p) => s + Math.abs(p.marketValue), 0);
  const grossAfter = grossExisting + proposal.sizeUsd;
  const leverageAfter = portfolio.equity > 0 ? grossAfter / portfolio.equity : Infinity;
  out.push({
    code: 'leverage',
    hard: true,
    passed: leverageAfter <= r.maxLeverage + 1e-6,
    detail: `post-trade gross ${leverageAfter.toFixed(2)}x vs max ${r.maxLeverage}x`,
  });

  // 4. Daily-loss kill-switch vs previous close (hard).
  const dailyPnlPct =
    portfolio.lastEquity > 0
      ? ((portfolio.equity - portfolio.lastEquity) / portfolio.lastEquity) * 100
      : 0;
  out.push({
    code: 'daily_loss_limit',
    hard: true,
    passed: dailyPnlPct > -r.maxDailyLossPct,
    detail: `day P/L ${dailyPnlPct.toFixed(2)}% vs limit -${r.maxDailyLossPct}%`,
  });

  // 5. Max new trades per day (hard).
  out.push({
    code: 'max_trades_per_day',
    hard: true,
    passed: ctx.tradesToday < r.maxNewTradesPerDay,
    detail: `${ctx.tradesToday} trades today vs max ${r.maxNewTradesPerDay}`,
  });

  // 6. No-trade windows around open/close (hard).
  const window = isWithinTradingWindow(now, r.noTradeMinutesAfterOpen, r.noTradeMinutesBeforeClose);
  out.push({
    code: 'trading_window',
    hard: true,
    passed: window.ok,
    detail: window.detail,
  });

  // 7. Cooldown after a stop-out on the same ticker (hard).
  const cooldownUntil = ctx.cooldowns[proposal.ticker];
  const inCooldown = cooldownUntil
    ? new Date(cooldownUntil).getTime() > now.getTime()
    : false;
  out.push({
    code: 'cooldown',
    hard: true,
    passed: !inCooldown,
    detail: inCooldown ? `cooling off until ${cooldownUntil}` : 'no active cooldown',
  });

  // 8. Fat-finger: notional ≤ multiplier × median position (hard when checkable).
  const median = medianPositionNotional(portfolio);
  if (median > 0) {
    out.push({
      code: 'fat_finger',
      hard: true,
      passed: proposal.sizeUsd <= median * r.fatFingerMultiplier,
      detail: `notional $${proposal.sizeUsd.toFixed(0)} vs ${r.fatFingerMultiplier}× median $${median.toFixed(0)}`,
    });
  } else {
    out.push({
      code: 'fat_finger',
      hard: false,
      passed: true,
      detail: 'no existing positions to compare against',
    });
  }

  return out;
}
