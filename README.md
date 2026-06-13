# 🤖 Alpaca Autonomous Trading Agent

A fully autonomous trading agent powered by **Claude AI** + **Alpaca API**. Paper trading first, always.

The repo now contains **two layers**:

1. **Execution layer (JS)** — the original single-agent **Dual Momentum + Regime Filter** strategy that runs on a cron and trades US equities and crypto. Documented below, starting at [How It Works](#how-it-works).
2. **Research layer (TypeScript)** — a new **hierarchical multi-agent research & decision pipeline** that analyzes a single ticker, debates a thesis, and proposes a paper trade. See [Multi-Agent Research Layer](#multi-agent-research-layer-new). Full spec lives in [ARCHITECTURE.md](ARCHITECTURE.md).

The two layers are independent entrypoints today — the legacy strategy keeps trading on schedule, while the research pipeline is driven on demand via `/research TICKER`.

## How It Works

```
Cron trigger (2x/day equities + daily crypto)
    ↓
Claude reasons through strategy (model configurable via ANTHROPIC_MODEL)
    ↓
Tools: get_account, compute_momentum, place_order, close_position...
    ↓
Alpaca API executes trades
    ↓
Telegram alert with run summary + live commands available
```

Claude runs an **agentic loop** — it calls tools, gets results, reasons about them, calls more tools, and continues until it's done. You don't need to be present.

---

## Setup

### 1. Clone & install
```bash
git clone <this-repo>
cd alpaca-agent
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in your keys:

```env
# Anthropic
ANTHROPIC_API_KEY=...
ANTHROPIC_MODEL=claude-sonnet-4-6   # or claude-opus-4-7 for stronger reasoning

# Alpaca (shared by both layers)
ALPACA_API_KEY=...
ALPACA_API_SECRET=...
ALPACA_PAPER=true
TRADING_MODE=paper           # paper | live — going live needs TRADING_MODE=live AND ALPACA_PAPER=false

# Telegram (optional but recommended)
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...

# Risk controls (execution layer)
MAX_POSITION_PCT=0.10        # max 10% of portfolio per position
DAILY_LOSS_LIMIT_PCT=0.03    # kill-switch at 3% daily loss
TRAILING_STOP_PCT=0.08       # close any position drawn down >8% from high
```

> **Migration note:** the broker env vars are now shared by both layers. The old names still work as deprecated fallbacks — `ALPACA_SECRET_KEY` (→ `ALPACA_API_SECRET`), and `PAPER_MODE=false` / `ALPACA_BASE_URL` (→ `ALPACA_PAPER` + `TRADING_MODE`).

**Keys you need:**
- `ANTHROPIC_API_KEY` → [console.anthropic.com](https://console.anthropic.com)
- `ALPACA_API_KEY` + `ALPACA_SECRET_KEY` → [alpaca.markets](https://alpaca.markets) (use Paper keys first)
- `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` → optional, enables live control via Telegram

### 3. Get Telegram alerts + control (optional)
1. Message [@BotFather](https://t.me/botfather) on Telegram → `/newbot`
2. Copy the token to `TELEGRAM_BOT_TOKEN`
3. Message your bot once, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates`
4. Copy the `chat.id` to `TELEGRAM_CHAT_ID`

Once configured, you can control the agent from your phone — see [Telegram Commands](#telegram-commands) below.

### 4. Test run (paper mode)
```bash
npm run now
```
Runs the full agent cycle immediately. Watch the logs — Claude explains every decision.

### 5. Start scheduler
```bash
npm start
```
Runs automatically on:
- **09:45 ET** weekdays (equities — after open)
- **15:30 ET** weekdays (equities — before close)
- **08:00 UTC** daily (crypto)

---

## Strategy: Dual Momentum + Regime Filter

### Regime Filter (safety first)
- Checks SPY (equities) and BTC/USD (crypto) vs their 50-day MA
- If market is in downtrend → goes to cash. No longs opened.
- Automatically recovers when trend turns positive.

### Equity Selection
- Watchlist: SPY, QQQ, IWM, XLE, XLF, XLV, XLP, XLU, XLI, XLY, XLK, XLB, NVDA, MSFT
- Ranks by **63-day return** (3-month momentum), with 20-day as tiebreaker
- Only buys symbols above both MA20 and MA50
- Targets top 3 qualifying symbols, allocated equally from available cash

### Crypto Selection
- Watchlist: BTC/USD, ETH/USD, SOL/USD
- Same momentum filter (above MA20 + MA50)
- Max 20% portfolio allocation to crypto

### Rebalancing
- Exits positions that fall below MA50
- Rotates into better-ranked symbols
- Avoids unnecessary churn (holds qualifying positions)
- **One order per symbol per run** — position size is capped by `MAX_POSITION_PCT`, never split across multiple orders
- **Per-position trailing stop** — runs before each agent cycle, auto-closes anything drawn down more than `TRAILING_STOP_PCT` from its post-entry high. High-water marks persist in `state.json`.

---

## Risk Controls

| Control | Default | Config key |
|---------|---------|------------|
| Max position size | 10% of portfolio | `MAX_POSITION_PCT` |
| Daily loss kill-switch | -3% | `DAILY_LOSS_LIMIT_PCT` |
| Per-position trailing stop | -8% from high | `TRAILING_STOP_PCT` |
| Paper mode | ON | `PAPER_MODE` |

**Position-size cap is enforced in code** (in [src/tools.js](src/tools.js) `place_order`), not just by the model. Buy orders that would push a position past the cap, or that exceed available cash, are rejected before reaching Alpaca.

**Automatic kill-switch**: if daily P&L drops below `-3%`, the agent cancels all orders, closes all positions, sends a Telegram alert, and stops immediately. Checked eagerly at the start of every run, before the model gets a turn.

**Trailing stop**: at the start of every run, the agent updates a per-symbol high-water mark and force-closes any position drawn down more than `TRAILING_STOP_PCT` from its high. Equity stops only fire while the US market is open; crypto stops fire 24/7.

**Market hours**: equity buys are rejected when the US market is closed (Alpaca clock check). Scheduled equity cron runs skip entirely on holidays / early closes.

---

## Telegram Commands

When the scheduler is running (`npm start`), the bot listens for commands from your configured chat. Only messages from `TELEGRAM_CHAT_ID` are accepted.

| Command | What it does |
|---------|-------------|
| `/status` | Account equity, daily P&L, open positions, scheduler state |
| `/stop` | Halts the agent's current reasoning loop — positions are untouched |
| `/pause` | Suspends all scheduled cron runs until resumed |
| `/resume` | Re-enables the cron schedule |
| `/run` | Triggers an immediate agent run (works even while paused) |
| `/close-positions` | Cancels all open orders and market-sells all positions |

> `/stop` and `/pause` are independent. `/stop` interrupts a run in progress. `/pause` prevents future scheduled runs from starting. `/run` always works regardless of pause state.

---

## Choosing a Model

Set `ANTHROPIC_MODEL` in `.env`:

| Model | Speed | Cost | Best for |
|-------|-------|------|----------|
| `claude-haiku-4-5-20251001` | Fastest | Lowest | High-frequency testing |
| `claude-sonnet-4-6` | Balanced | Medium | Default — daily trading |
| `claude-opus-4-7` | Slowest | Highest | Complex market conditions |

---

## Going Live

When you're ready to trade real money:
1. Run in paper mode for at least **4–6 weeks**
2. Review Telegram summaries and trade logs
3. Update `.env` (both flags are required — this is a deliberate double opt-in):
   ```
   TRADING_MODE=live
   ALPACA_PAPER=false
   ```
4. Start conservatively — lower `MAX_POSITION_PCT` (e.g. `0.05`) until you trust the system

---

## Customizing the Strategy

Edit [src/agent.js](src/agent.js) → `buildSystemPrompt()` to adjust:
- Watchlists (add/remove symbols)
- MA periods (default: 20/50 day)
- Allocation rules
- Rebalancing logic

The strategy is expressed in plain English in the system prompt — Claude interprets it. You can iterate on it like writing a spec.

---

## Multi-Agent Research Layer (new)

A second, independent pipeline (TypeScript) that researches **one ticker** end to end and proposes a paper trade. Where the Dual Momentum executor above runs a fixed rules-based strategy on a schedule, this layer reasons about an individual name on demand — gathering fundamentals, news, and price action, then synthesizing a sized position recommendation.

> **Status: Phase 2 complete, plus Scout (Phase 2.5).** The full hierarchical pipeline is wired in [src/agents/orchestrator.ts](src/agents/orchestrator.ts) — parallel analyst fan-out (research ‖ technical ‖ macro), an adversarial Devil's Advocate check, the PM synthesis, and a Risk Manager rule gate with veto power. A separate **Scout** agent screens the whole market into a shortlist and fans the top names through that same pipeline. Paper trading only. Full spec: [ARCHITECTURE.md](ARCHITECTURE.md).

### Pipeline

```
/research TICKER  (Telegram command or CLI)
    ↓
Orchestrator  (hierarchical, src/agents/orchestrator.ts)
    ↓
┌─ Research Analyst   →  fundamentals + news/sentiment   (Sonnet, FMP + Finnhub)
├─ Technical Analyst  →  trend, RSI/MACD, key levels      (Haiku, Alpaca bars)
└─ Macro Analyst      →  market regime, session-cached     (Haiku, native web_search)
    ↓   (early exit if research or technical confidence < 30)
Devil's Advocate   →  bear-case critique + strength score   (Sonnet)
    ↓
PM / Decision Agent  →  TradeProposal: action, size, entry, stop, target   (Sonnet)
    ↓   (HOLD ⇒ no trade)
Risk Manager  →  deterministic rule gate + correlations   (Haiku, veto power)
    ↓   (REJECTED ⇒ no trade · MODIFIED ⇒ resized · APPROVED ⇒ pass through)
Execution Agent  →  Alpaca paper order
    ↓
JSONL trade journal  →  data/journal/YYYY-MM.jsonl  (full agent trace)
    ↓
Telegram decision card
```

Every numerical claim an agent makes must trace to a tool call, and every agent input/output is validated with Zod at the boundary (see [src/types/contracts.ts](src/types/contracts.ts)). System prompts live as Markdown in [src/config/prompts/](src/config/prompts/), never inline.

### Scout (whole-market screen)

Where `/research TICKER` analyzes a name you name, **Scout** finds the names. It runs a two-stage funnel and then drives the full pipeline above for the best candidates:

```
/scout [N]  (Telegram) · npm run scout  (CLI) · opt-in cron (SCOUT_SCHEDULE)
    ↓
Scout  (src/agents/scout.ts)
    ↓
Stage 1 — deterministic screen   (Alpaca movers + most-actives, regime-filtered, no LLM)
Stage 2 — Haiku triage            (picks ONLY from screened names; off-universe tickers dropped)
    ↓
Shortlist  →  top N candidates fan out through the full /research pipeline (sequential)
```

In a **CRISIS** regime Scout returns an empty shortlist and spends no LLM tokens. Cooldowns and positions already over the size cap are filtered out before triage. The Telegram form is `/scout` (top 3), `/scout N` (1–5), or `/scout list` (shortlist only). Scheduling is opt-in: set `SCOUT_SCHEDULE` to a cron expression (interpreted in America/New_York).

### Agents

| Agent | File | Model | Role |
|-------|------|-------|------|
| Orchestrator | [src/agents/orchestrator.ts](src/agents/orchestrator.ts) | — | Sequences the pipeline, applies confidence floors, writes the journal |
| Research Analyst | [src/agents/researchAnalyst.ts](src/agents/researchAnalyst.ts) | Sonnet | Fundamentals + news/sentiment, grounded in FMP/Finnhub tool calls |
| Technical Analyst | [src/agents/technicalAnalyst.ts](src/agents/technicalAnalyst.ts) | Haiku | Interprets deterministically-computed indicators (RSI, MACD, MAs) |
| Macro Analyst | [src/agents/macroAnalyst.ts](src/agents/macroAnalyst.ts) | Haiku | Classifies the market regime (RISK_ON … CRISIS); session-cached, native web_search |
| Devil's Advocate | [src/agents/devilsAdvocate.ts](src/agents/devilsAdvocate.ts) | Sonnet | Builds the bear case against the thesis with a 1–10 strength score |
| PM / Decision | [src/agents/portfolioManager.ts](src/agents/portfolioManager.ts) | Sonnet | Synthesizes a sized proposal with stop + target; `<55` confidence ⇒ HOLD |
| Risk Manager | [src/agents/riskManager.ts](src/agents/riskManager.ts) | Haiku | Deterministic rule gate + correlation check; can REJECT or resize (MODIFIED) |
| Scout | [src/agents/scout.ts](src/agents/scout.ts) | Haiku | Screens the market into a ranked, regime-filtered Shortlist |
| Execution | [src/agents/executor.ts](src/agents/executor.ts) | Haiku | Routes the approved proposal to Alpaca (paper) |

### Commands

```bash
npm run dev              # start the Telegram listener for /research + /scout (tsx watch src/index.ts)
npm run research TICKER  # one-shot research run from the CLI
npm run scout            # one-shot whole-market scout from the CLI
npm run smoke            # end-to-end smoke test against the paper account
npm test                 # vitest
npm run typecheck        # tsc --noEmit
```

On Telegram, `/research TICKER` triggers a single-name run and `/scout [N]` screens the market, each replying with decision cards. Only one run is in flight at a time.

### Environment

In addition to the Alpaca/Telegram keys above, the research layer reads:

```env
ANTHROPIC_API_KEY=...
FMP_API_KEY=...          # Financial Modeling Prep — fundamentals & earnings
FINNHUB_API_KEY=...      # news & analyst ratings
TRADING_MODE=paper       # paper | live (live requires explicit opt-in)
SCOUT_SCHEDULE=          # optional cron expr (America/New_York) to auto-run Scout; unset = manual only
```

External API calls are wrapped in a cache layer ([src/lib/cache.ts](src/lib/cache.ts)) to save cost and respect free-tier rate limits during iteration. See [ARCHITECTURE.md §5](ARCHITECTURE.md) for the per-tool rate-limit and TTL table.

---

## Project Structure

```
alpaca-agent/
├── index.js              # Execution layer entry: cron scheduler + Telegram handlers
├── ARCHITECTURE.md       # Full spec for the multi-agent research layer
├── src/
│   ├── agent.js          # (execution) Claude agentic loop + stop signal
│   ├── tools.js          # (execution) Dual Momentum tool definitions + executors
│   ├── alpaca.js         # (execution) Alpaca REST client
│   ├── telegram.js       # (execution) alerts + command listener
│   │
│   ├── index.ts          # Research layer entry: Telegram /research + /scout listener, opt-in cron
│   ├── agents/           # orchestrator + research/technical/macro analysts, devil's advocate, PM, risk, scout, executor
│   ├── tools/            # alpaca, fmp, finnhub, screener, indicators + registry (index.ts)
│   ├── lib/              # claude wrapper, cache, journal, logger, telegram, sizing, screen, state
│   ├── types/            # contracts.ts — all Zod schemas + inferred TS types
│   ├── config/
│   │   ├── prompts/      # one .md system prompt per agent
│   │   └── riskRules.json
│   └── cli/              # research.ts, scout.ts (one-shot), smokeTest.ts
└── README.md
```
