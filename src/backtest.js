#!/usr/bin/env node
// Backtest harness for the dual-momentum strategy.
//
// Replays the deterministic rules in agent.js buildSystemPrompt() against
// historical Alpaca bars. Does NOT call Claude — the agent loop is replaced
// by the pure functions in backtestStrategy.js.
//
// Usage:
//   npm run backtest -- [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--capital N]
//                       [--slippage-bps N] [--out-dir PATH]

import 'dotenv/config';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { getHistoricalBars } from './alpaca.js';
import { decideTargets, allocateTargets, priceOn } from './backtestStrategy.js';
import { BacktestPortfolio } from './backtestPortfolio.js';

const EQUITY_WATCHLIST = [
  'SPY', 'QQQ', 'IWM',
  'XLE', 'XLF', 'XLV', 'XLP', 'XLU', 'XLI', 'XLY', 'XLK', 'XLB',
  'NVDA', 'MSFT',
];
const CRYPTO_WATCHLIST = ['BTC/USD', 'ETH/USD', 'SOL/USD'];

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      args[key] = val;
    }
  }
  return args;
}

// Parses "--signals" value into { name -> weight } map. Accepts:
//   "momentum,sharpe,lowvol,reversal"           → equal weights
//   "momentum:0.4,sharpe:0.3,lowvol:0.2,..."    → custom weights
//   "momentum"                                   → single-signal (weight 1.0)
function parseSignalWeights(raw) {
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  const out = {};
  let anyWeighted = false;
  for (const p of parts) {
    const [name, w] = p.split(':').map(s => s.trim());
    if (w !== undefined) {
      out[name] = parseFloat(w);
      anyWeighted = true;
    } else {
      out[name] = 1;
    }
  }
  // If any were weighted, leave as-is (decideTargets normalizes). If all equal,
  // weights are already uniform — no normalization needed here either.
  return out;
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(date, n) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

function isWeekday(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z').getUTCDay();
  return d >= 1 && d <= 5;
}

// Returns true if this date is a rebalance decision day. For 'weekly' we use
// Monday (UTC day 1) — if Monday is a holiday for equities, the equity branch
// in simulate() skips it via the weekday check anyway. Risk controls (stops,
// kill-switch) run every day regardless.
function shouldRebalanceToday(dateStr, frequency) {
  if (frequency === 'daily') return true;
  return new Date(dateStr + 'T00:00:00Z').getUTCDay() === 1;
}

async function fetchAllBars(symbols, from, to, label) {
  const out = {};
  for (const sym of symbols) {
    process.stdout.write(`  ${label}: fetching ${sym}... `);
    try {
      const bars = await getHistoricalBars(sym, from, to, '1Day');
      out[sym] = bars;
      console.log(`${bars.length} bars`);
    } catch (e) {
      console.log(`FAILED (${e.message})`);
      out[sym] = [];
    }
  }
  return out;
}

// Build a sorted list of all trading dates from union of all bar timestamps.
function buildCalendar(...barCollections) {
  const dates = new Set();
  for (const collection of barCollections) {
    for (const bars of Object.values(collection)) {
      for (const b of bars) dates.add((b.t || '').slice(0, 10));
    }
  }
  return [...dates].filter(Boolean).sort();
}

// Compute the close price for every symbol on `date` (null if no bar that day).
function closesOn(barsBySymbol, date) {
  const out = {};
  for (const [sym, bars] of Object.entries(barsBySymbol)) {
    out[sym] = priceOn(bars, date);
  }
  return out;
}

// Rebalance one asset class: close non-targets, trim oversized targets,
// then top up undersized targets.
function rebalance({
  portfolio, assetClass, targets, allocations, prices, currentHeld, date,
  ranked, config,
}) {
  // 1. Close any held position not in targets. Reason depends on why it left.
  const targetSet = new Set(targets);
  for (const sym of currentHeld) {
    if (targetSet.has(sym)) continue;
    if (prices[sym] == null) continue;
    const r = ranked.find(x => x.symbol === sym);
    const reason = r && r.latest < r.ma50 ? 'ma50_breach' : 'rank_swap';
    portfolio.closePosition({ symbol: sym, closePrice: prices[sym], date, reason });
  }

  // 2. Trim any target whose current value exceeds target × trimBand.
  // Done BEFORE buys so freed cash can be redeployed within this tick.
  const trimBand = config.trimBand || 0;
  if (trimBand > 0) {
    for (const sym of targets) {
      const want = allocations[sym] || 0;
      if (want <= 0) continue;
      if (prices[sym] == null) continue;
      const have = portfolio.positionValue(sym, prices);
      if (have > want * trimBand) {
        portfolio.trim({
          symbol: sym,
          sellNotional: have - want,
          closePrice: prices[sym],
          date,
        });
      }
    }
  }

  // 3. For each target, buy up to its allocation (after subtracting existing holding).
  const equity = portfolio.markToMarket(prices);
  for (const sym of targets) {
    const want = allocations[sym] || 0;
    if (want <= 0) continue;
    const have = portfolio.positionValue(sym, prices);
    const gap = want - have;
    if (gap <= 0) continue;
    if (prices[sym] == null) continue;
    const reason = currentHeld.has(sym) ? 'rank_swap' : 'rank_entry';
    portfolio.buy({
      symbol: sym,
      notional: gap,
      closePrice: prices[sym],
      date,
      reason,
      equity,
    });
  }
}

// Close all positions of one asset class because regime is OFF.
function liquidateAssetClass({ portfolio, assetClass, prices, date }) {
  for (const sym of Object.keys(portfolio.positions)) {
    const isCrypto = sym.includes('/');
    if (assetClass === 'crypto' && !isCrypto) continue;
    if (assetClass === 'equity' && isCrypto) continue;
    if (prices[sym] == null) continue;
    portfolio.closePosition({ symbol: sym, closePrice: prices[sym], date, reason: 'regime_off' });
  }
}

// Run the simulation. Returns { equityCurve, trades, summary }.
function simulate({ calendar, barsBySymbol, spyBars, btcBars, startingCash, slippageBps, config }) {
  const portfolio = new BacktestPortfolio({ startingCash, slippageBps, config });
  const equityCurve = [];
  let prevEquity = startingCash;
  let peakEquity = startingCash;
  let maxDrawdown = 0;
  let regimeOffDays = 0;

  for (const date of calendar) {
    portfolio.resetKillSwitchForNewDay();
    const prices = closesOn(barsBySymbol, date);
    const weekday = isWeekday(date);

    portfolio.updateHighWaterMarks(prices);
    portfolio.applyTrailingStops({ prices, date, equityMarketOpen: weekday });

    const preDecisionEquity = portfolio.markToMarket(prices);
    const killed = portfolio.applyKillSwitch({
      prevEquity,
      currentEquity: preDecisionEquity,
      prices,
      date,
    });

    const isRebalanceDay = shouldRebalanceToday(date, config.rebalanceFrequency);

    if (!killed && isRebalanceDay) {
      // Decide equities (weekday only — matches live cron Mon–Fri).
      if (weekday) {
        const equityDecision = decideTargets({
          date,
          assetClass: 'equity',
          watchlist: EQUITY_WATCHLIST,
          barsBySymbol,
          regimeBars: spyBars,
          config,
        });
        const heldEquity = new Set(
          Object.keys(portfolio.positions).filter(s => !s.includes('/'))
        );
        if (equityDecision.regimeOff) {
          regimeOffDays++;
          liquidateAssetClass({ portfolio, assetClass: 'equity', prices, date });
        } else {
          const equityNow = portfolio.markToMarket(prices);
          const allocations = allocateTargets({
            assetClass: 'equity',
            targets: equityDecision.targets,
            equity: equityNow,
            cash: portfolio.cash,
            config,
            barsBySymbol,
            date,
          });
          rebalance({
            portfolio,
            assetClass: 'equity',
            targets: equityDecision.targets,
            allocations,
            prices,
            currentHeld: heldEquity,
            date,
            ranked: equityDecision.ranked,
            config,
          });
        }
      }

      // Decide crypto every rebalance day (live cron runs 08:00 UTC daily;
      // backtest aligns with the configured frequency).
      const cryptoDecision = decideTargets({
        date,
        assetClass: 'crypto',
        watchlist: CRYPTO_WATCHLIST,
        barsBySymbol,
        regimeBars: btcBars,
        config,
      });
      const heldCrypto = new Set(
        Object.keys(portfolio.positions).filter(s => s.includes('/'))
      );
      if (cryptoDecision.regimeOff) {
        liquidateAssetClass({ portfolio, assetClass: 'crypto', prices, date });
      } else {
        const equityNow = portfolio.markToMarket(prices);
        const allocations = allocateTargets({
          assetClass: 'crypto',
          targets: cryptoDecision.targets,
          equity: equityNow,
          cash: portfolio.cash,
          config,
          barsBySymbol,
          date,
        });
        rebalance({
          portfolio,
          assetClass: 'crypto',
          targets: cryptoDecision.targets,
          allocations,
          prices,
          currentHeld: heldCrypto,
          date,
          ranked: cryptoDecision.ranked,
          config,
        });
      }
    }

    const equityNow = portfolio.markToMarket(prices);
    if (equityNow > peakEquity) peakEquity = equityNow;
    const dd = (peakEquity - equityNow) / peakEquity;
    if (dd > maxDrawdown) maxDrawdown = dd;

    equityCurve.push({
      date,
      cash: portfolio.cash,
      equity: equityNow,
      num_positions: Object.keys(portfolio.positions).length,
      drawdown_pct: dd * 100,
    });
    prevEquity = equityNow;
  }

  return { portfolio, equityCurve, peakEquity, maxDrawdown, regimeOffDays };
}

function summarize({ equityCurve, trades, peakEquity, maxDrawdown, regimeOffDays, startingCash, spyBars, calendar }) {
  const start = equityCurve[0];
  const end = equityCurve[equityCurve.length - 1];
  const totalReturn = (end.equity - startingCash) / startingCash;
  const years = (new Date(end.date) - new Date(start.date)) / (365.25 * 24 * 3600 * 1000);
  const cagr = years > 0 ? Math.pow(end.equity / startingCash, 1 / years) - 1 : 0;

  // Daily log returns of the portfolio.
  const rets = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const r = (equityCurve[i].equity - equityCurve[i - 1].equity) / equityCurve[i - 1].equity;
    if (Number.isFinite(r)) rets.push(r);
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  const closes = trades.filter(t => t.side === 'sell');
  const wins = closes.filter(t => t.pnl > 0).length;
  const winRate = closes.length > 0 ? wins / closes.length : 0;

  // Buy-and-hold SPY comparison. Use first/last bars in window so we don't get
  // tripped up by holidays/weekends on the boundary dates.
  const spyInRange = spyBars.filter(b => {
    const d = (b.t || '').slice(0, 10);
    return d >= start.date && d <= end.date;
  });
  const spyStart = spyInRange[0]?.c ?? null;
  const spyEnd = spyInRange[spyInRange.length - 1]?.c ?? null;
  const spyReturn = spyStart && spyEnd ? (spyEnd - spyStart) / spyStart : null;

  return {
    period: `${start.date} → ${end.date}`,
    days: equityCurve.length,
    startingCapital: startingCash,
    endingEquity: end.equity,
    totalReturn,
    cagr,
    maxDrawdown,
    sharpe,
    winRate,
    numTrades: trades.length,
    numCloses: closes.length,
    regimeOffDays,
    spyBuyHoldReturn: spyReturn,
  };
}

// Split the equity curve into N equal-length segments and compute per-segment
// metrics against a continuous portfolio. Returns one row per segment.
function walkForwardSegments({ equityCurve, trades, spyBars, periods }) {
  if (periods <= 1 || equityCurve.length < periods * 2) return [];
  const n = equityCurve.length;
  const rows = [];
  for (let i = 0; i < periods; i++) {
    const startIdx = Math.floor((i * n) / periods);
    const endIdx = Math.floor(((i + 1) * n) / periods) - 1;
    const slice = equityCurve.slice(startIdx, endIdx + 1);
    if (slice.length < 2) continue;

    const startDate = slice[0].date;
    const endDate = slice[slice.length - 1].date;
    const startEquity = slice[0].equity;
    const endEquity = slice[slice.length - 1].equity;
    const periodReturn = startEquity > 0 ? (endEquity - startEquity) / startEquity : 0;

    // Max drawdown within the period (peak relative to in-period running max).
    let peak = startEquity;
    let maxDd = 0;
    for (const row of slice) {
      if (row.equity > peak) peak = row.equity;
      const dd = peak > 0 ? (peak - row.equity) / peak : 0;
      if (dd > maxDd) maxDd = dd;
    }

    // Sharpe over the period's daily returns.
    const rets = [];
    for (let j = 1; j < slice.length; j++) {
      const r = slice[j - 1].equity > 0
        ? (slice[j].equity - slice[j - 1].equity) / slice[j - 1].equity
        : 0;
      if (Number.isFinite(r)) rets.push(r);
    }
    const mean = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : 0;
    const variance = rets.length
      ? rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length
      : 0;
    const std = Math.sqrt(variance);
    const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

    const periodTrades = trades.filter(t => t.date >= startDate && t.date <= endDate);

    const spyInRange = spyBars.filter(b => {
      const d = (b.t || '').slice(0, 10);
      return d >= startDate && d <= endDate;
    });
    const spyStart = spyInRange[0]?.c ?? null;
    const spyEnd = spyInRange[spyInRange.length - 1]?.c ?? null;
    const spyReturn = spyStart && spyEnd ? (spyEnd - spyStart) / spyStart : null;

    rows.push({
      period_start: startDate,
      period_end: endDate,
      start_equity: startEquity,
      end_equity: endEquity,
      return_pct: periodReturn * 100,
      max_dd_pct: maxDd * 100,
      sharpe,
      trades: periodTrades.length,
      spy_return_pct: spyReturn != null ? spyReturn * 100 : null,
    });
  }
  return rows;
}

function printWalkForward(rows) {
  if (!rows || rows.length === 0) return;
  const pct = x => x == null ? '   n/a' : (x.toFixed(1) + '%').padStart(7);
  const money = x => ('$' + Math.round(x).toLocaleString('en-US')).padStart(9);
  console.log('\n──────────────────────────────────────────────────────────────────────────────────');
  console.log('         WALK-FORWARD (continuous portfolio, equal-length segments)');
  console.log('──────────────────────────────────────────────────────────────────────────────────');
  console.log('Period (start → end)         Start →   End      Return    MaxDD   Sharpe  Trd   SPY');
  for (const r of rows) {
    console.log(
      `${r.period_start} → ${r.period_end}  ${money(r.start_equity)} → ${money(r.end_equity)}  ${pct(r.return_pct)}  ${pct(r.max_dd_pct)}  ${r.sharpe.toFixed(2).padStart(5)}  ${String(r.trades).padStart(4)}  ${pct(r.spy_return_pct)}`,
    );
  }

  const rets = rows.map(r => r.return_pct);
  const positive = rets.filter(r => r > 0).length;
  const meanRet = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varRet = rets.reduce((a, b) => a + (b - meanRet) ** 2, 0) / rets.length;
  const sdRet = Math.sqrt(varRet);
  const beatsSpy = rows.filter(r => r.spy_return_pct != null && r.return_pct > r.spy_return_pct).length;
  const best = Math.max(...rets);
  const worst = Math.min(...rets);
  console.log('──────────────────────────────────────────────────────────────────────────────────');
  console.log(`Positive periods:     ${positive}/${rows.length}   Beats SPY: ${beatsSpy}/${rows.length}`);
  console.log(`Mean period return:   ${meanRet.toFixed(2)}%    stdev: ${sdRet.toFixed(2)}%`);
  console.log(`Best:                 ${best.toFixed(2)}%        Worst: ${worst.toFixed(2)}%`);
  console.log('──────────────────────────────────────────────────────────────────────────────────\n');
}

function writeCsv(path, header, rows) {
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(header.map(k => {
      const v = row[k];
      if (v == null) return '';
      if (typeof v === 'number') return v.toString();
      return String(v).includes(',') ? `"${v}"` : String(v);
    }).join(','));
  }
  writeFileSync(path, lines.join('\n'));
}

function printSummary(s) {
  const pct = x => x == null ? 'n/a' : (x * 100).toFixed(2) + '%';
  const money = x => '$' + x.toLocaleString('en-US', { maximumFractionDigits: 0 });
  console.log('\n────────────────────────────────────────────');
  console.log('         BACKTEST SUMMARY');
  console.log('────────────────────────────────────────────');
  console.log(`Period:               ${s.period}  (${s.days} days)`);
  console.log(`Starting capital:     ${money(s.startingCapital)}`);
  console.log(`Ending equity:        ${money(s.endingEquity)}`);
  console.log(`Total return:         ${pct(s.totalReturn)}`);
  console.log(`CAGR:                 ${pct(s.cagr)}`);
  console.log(`Max drawdown:         ${pct(s.maxDrawdown)}`);
  console.log(`Sharpe ratio:         ${s.sharpe.toFixed(2)}`);
  console.log(`Win rate (closes):    ${pct(s.winRate)}  (${s.numCloses} closes)`);
  console.log(`Total trades:         ${s.numTrades}`);
  console.log(`Regime-off days:      ${s.regimeOffDays}`);
  console.log(`SPY buy-and-hold:     ${pct(s.spyBuyHoldReturn)}`);
  console.log('────────────────────────────────────────────\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const today = new Date();
  const fiveYrAgo = new Date(today);
  fiveYrAgo.setUTCFullYear(fiveYrAgo.getUTCFullYear() - 5);

  const from = args.from || fmtDate(fiveYrAgo);
  const to = args.to || fmtDate(addDays(today, -1)); // exclude today (incomplete bar)
  const startingCash = parseFloat(args.capital || '100000');
  const slippageBps = parseFloat(args['slippage-bps'] || '5');
  const outDir = args['out-dir'] || './backtest-out';

  const config = {
    maxPositionPct: parseFloat(process.env.MAX_POSITION_PCT || '0.10'),
    dailyLossLimitPct: parseFloat(process.env.DAILY_LOSS_LIMIT_PCT || '0.03'),
    trailingStopPct: parseFloat(process.env.TRAILING_STOP_PCT || '0.08'),
    cryptoCapPct: 0.20,
    // Backtest-only improvements (CLI-overridable)
    trimBand: parseFloat(args['trim-band'] ?? '1.5'),
    volSizing: (args['vol-sizing'] ?? 'true') !== 'false',
    minTradePct: parseFloat(args['min-trade-pct'] ?? '0.01'),
    rebalanceFrequency: args['rebalance'] || 'weekly',
    cooldownDays: parseInt(args['cooldown-days'] ?? '5', 10),
    signalWeights: parseSignalWeights(
      args['signals'] ?? 'momentum,sharpe,lowvol,reversal'
    ),
  };
  const periods = parseInt(args['periods'] ?? '10', 10);

  const signalSummary = Object.entries(config.signalWeights)
    .map(([n, w]) => `${n}:${w}`).join(',');

  console.log(`\nBacktest: ${from} → ${to}`);
  console.log(`Capital: $${startingCash}, slippage: ${slippageBps}bps`);
  console.log(`Risk: cap ${config.maxPositionPct * 100}%, kill ${config.dailyLossLimitPct * 100}%, trail ${config.trailingStopPct * 100}%`);
  console.log(`Improvements: trimBand=${config.trimBand}, volSizing=${config.volSizing}, minTradePct=${config.minTradePct}, rebalance=${config.rebalanceFrequency}, cooldown=${config.cooldownDays}d`);
  console.log(`Signals: ${signalSummary}\n`);

  if (!process.env.ALPACA_API_KEY) {
    console.error('Missing ALPACA_API_KEY in environment.');
    process.exit(1);
  }

  console.log('Fetching bars...');
  const equityBars = await fetchAllBars(EQUITY_WATCHLIST, from, to, 'equity');
  const cryptoBars = await fetchAllBars(CRYPTO_WATCHLIST, from, to, 'crypto');
  const barsBySymbol = { ...equityBars, ...cryptoBars };
  const spyBars = equityBars['SPY'] || [];
  const btcBars = cryptoBars['BTC/USD'] || [];

  if (spyBars.length === 0) {
    console.error('No SPY bars returned; cannot run equity regime filter.');
    process.exit(1);
  }

  // Calendar = union of all dates. Equities-only days skip crypto naturally
  // (crypto trades 7 days/week, so its calendar is the superset).
  const calendar = buildCalendar(equityBars, cryptoBars);
  console.log(`\nCalendar: ${calendar.length} days, ${calendar[0]} → ${calendar[calendar.length - 1]}\n`);

  const result = simulate({
    calendar, barsBySymbol, spyBars, btcBars, startingCash, slippageBps, config,
  });

  const summary = summarize({
    equityCurve: result.equityCurve,
    trades: result.portfolio.trades,
    peakEquity: result.peakEquity,
    maxDrawdown: result.maxDrawdown,
    regimeOffDays: result.regimeOffDays,
    startingCash,
    spyBars,
    calendar,
  });

  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeCsv(
    join(outDir, 'trades.csv'),
    ['date', 'symbol', 'side', 'qty', 'fillPrice', 'notional', 'reason', 'pnl'],
    result.portfolio.trades,
  );
  writeCsv(
    join(outDir, 'equity.csv'),
    ['date', 'cash', 'equity', 'num_positions', 'drawdown_pct'],
    result.equityCurve,
  );

  printSummary(summary);

  const walkRows = walkForwardSegments({
    equityCurve: result.equityCurve,
    trades: result.portfolio.trades,
    spyBars,
    periods,
  });
  if (walkRows.length > 0) {
    printWalkForward(walkRows);
    writeCsv(
      join(outDir, 'walkforward.csv'),
      ['period_start', 'period_end', 'start_equity', 'end_equity',
       'return_pct', 'max_dd_pct', 'sharpe', 'trades', 'spy_return_pct'],
      walkRows,
    );
  }

  console.log(`Wrote ${result.portfolio.trades.length} trades → ${outDir}/trades.csv`);
  console.log(`Wrote ${result.equityCurve.length} equity rows → ${outDir}/equity.csv`);
  if (walkRows.length > 0) {
    console.log(`Wrote ${walkRows.length} walk-forward rows → ${outDir}/walkforward.csv`);
  }
}

main().catch(e => {
  console.error('Backtest failed:', e);
  process.exit(1);
});
