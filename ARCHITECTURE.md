# Investment Research Multi-Agent System

**Project:** Personal autonomous investment research & execution platform
**Version:** 0.1 (handover spec)
**Runtime:** Node.js 20+ (LTS), TypeScript recommended
**Primary LLM:** Anthropic Claude (Sonnet 4 + Haiku 4.5 mix)
**Broker:** Alpaca (paper trading first)
**Delivery:** Telegram bot (existing) + JSON trade journal

---

## 1. Purpose & Scope

Build a hierarchical multi-agent system that researches equities, decides on trades, applies risk controls, and routes orders through Alpaca. This is **personal use only** — no client money, no public signals, no regulated activity.

The system extends the existing trading-agent app (Dual Momentum with Regime Filter strategy, Telegram alerts) by adding a **research and decision layer** on top of the existing execution layer.

**Hard constraints:**
- Paper trading mode by default; live trading must be an explicit env flag (`TRADING_MODE=live`)
- Every numerical claim must be grounded in a tool result — never let the LLM invent figures
- Every decision must be logged to the trade journal with full agent trace
- Total cost per research run target: under $0.30

---

## 2. High-Level Architecture

```
                          ┌─────────────────┐
                          │  Trigger Layer  │
                          │ (cron / TG cmd) │
                          └────────┬────────┘
                                   │
                          ┌────────▼────────┐
                          │  Orchestrator   │  Sonnet 4
                          │  (router/PM     │
                          │   coordinator)  │
                          └────────┬────────┘
                                   │
              ┌────────────────────┼────────────────────┐
              │                    │                    │
       ┌──────▼──────┐     ┌───────▼──────┐     ┌───────▼──────┐
       │  Research   │     │    Macro     │     │   Technical  │
       │   Analyst   │     │   Analyst    │     │   Analyst    │
       │  (Sonnet 4) │     │  (Haiku 4.5) │     │  (Haiku 4.5) │
       └──────┬──────┘     └───────┬──────┘     └───────┬──────┘
              │                    │                    │
              └────────────────────┼────────────────────┘
                                   │
                          ┌────────▼────────┐
                          │  Devil's        │  Sonnet 4
                          │  Advocate       │  (challenges thesis)
                          └────────┬────────┘
                                   │
                          ┌────────▼────────┐
                          │  PM / Decision  │  Sonnet 4
                          │     Agent       │
                          └────────┬────────┘
                                   │
                          ┌────────▼────────┐
                          │  Risk Manager   │  Haiku 4.5
                          │   (veto power)  │  (rule-based)
                          └────────┬────────┘
                                   │
                          ┌────────▼────────┐
                          │   Execution     │  Haiku 4.5
                          │     Agent       │  (Alpaca API)
                          └────────┬────────┘
                                   │
                          ┌────────▼────────┐
                          │  Trade Journal  │
                          │   + Telegram    │
                          └─────────────────┘
```

**Coordination pattern:** Hierarchical with parallel fan-out for analysts, sequential gating for Risk and Execution.

---

## 3. Agent Specifications

Each agent is implemented as a discrete module under `src/agents/`, exporting a single async function with a typed input/output contract. Agents do not call each other directly — the Orchestrator wires them together.

### 3.1 Orchestrator

- **File:** `src/agents/orchestrator.ts`
- **Model:** `claude-sonnet-4-5` (when latency permits) or `claude-haiku-4-5-20251001` for simple routing
- **Role:** Dispatches work to analysts in parallel, gathers results, sequences gating agents, handles errors/retries
- **Inputs:** `ResearchRequest` (ticker, trigger reason, optional context)
- **Outputs:** `TradeDecision` or `NoTradeDecision` with full agent trace
- **Tools:** None directly — invokes other agents as functions
- **Rules:**
  - Fan out Research, Macro, Technical in parallel (Promise.all)
  - If any analyst returns confidence < 30, skip Devil's Advocate (no point)
  - Risk Manager runs after PM; if Risk vetoes, decision becomes NoTrade with reason
  - Always emit a trace event for each step (used by trade journal)

### 3.2 Research Analyst

- **File:** `src/agents/researchAnalyst.ts`
- **Model:** `claude-sonnet-4-5`
- **Role:** Fundamental + news/sentiment analysis on a single ticker
- **Inputs:** `{ ticker: string, lookbackDays: number }`
- **Outputs:** `ResearchReport` (see §4)
- **Tools:**
  - `get_financials(ticker)` → FMP / Alpha Vantage
  - `get_news(ticker, days)` → Finnhub news endpoint
  - `get_analyst_ratings(ticker)` → Finnhub
  - `get_earnings_history(ticker)` → FMP
  - `web_search` → Anthropic native (for recent qualitative context)
- **Rules:**
  - Must cite the source tool call for every number in the output
  - Sentiment score must be in [-1, +1]
  - Confidence score must reflect data quality (low if tools failed/returned stale data)

### 3.3 Macro Analyst

- **File:** `src/agents/macroAnalyst.ts`
- **Model:** `claude-haiku-4-5-20251001`
- **Role:** Determines current macro regime; cached for the session (don't run per-ticker)
- **Inputs:** `{ asOf: Date }`
- **Outputs:** `MacroRegime` (see §4)
- **Tools:**
  - `get_index_data(symbol)` → Alpaca market data (SPY, QQQ, IWM, TLT, GLD, DXY)
  - `web_search` → Fed policy, CPI prints, geopolitical
- **Rules:**
  - Output is a regime label: `RISK_ON | RISK_OFF | NEUTRAL | CRISIS`
  - Cache result for 4 hours (macro doesn't change minute to minute)

### 3.4 Technical Analyst

- **File:** `src/agents/technicalAnalyst.ts`
- **Model:** `claude-haiku-4-5-20251001`
- **Role:** Price action, momentum, trend, support/resistance
- **Inputs:** `{ ticker: string }`
- **Outputs:** `TechnicalReport`
- **Tools:**
  - `get_bars(ticker, timeframe, limit)` → Alpaca market data
  - `compute_indicators(bars)` → local function (no LLM call) for RSI, MACD, MAs
- **Rules:**
  - Indicators computed deterministically in code, not by the LLM
  - LLM only interprets the computed values
  - Output includes: trend direction, momentum strength, key levels, signal

### 3.5 Devil's Advocate

- **File:** `src/agents/devilsAdvocate.ts`
- **Model:** `claude-sonnet-4-5` (reasoning quality matters here)
- **Role:** Argues against the consensus thesis. Mandatory step before PM.
- **Inputs:** All three analyst reports + draft thesis
- **Outputs:** `Critique` with bear case, hidden risks, counter-evidence
- **Tools:** `web_search` (to find disconfirming evidence)
- **Rules:**
  - Must produce a bear case even if reports are uniformly bullish
  - Score the strength of the critique (1–10); PM weights this against the thesis

### 3.6 PM / Decision Agent

- **File:** `src/agents/portfolioManager.ts`
- **Model:** `claude-sonnet-4-5`
- **Role:** Synthesizes all inputs into a position recommendation
- **Inputs:** All analyst reports + Devil's Advocate critique + current portfolio state
- **Outputs:** `TradeProposal` (action, size, entry, stop, target, rationale)
- **Tools:** `get_portfolio_state()` → Alpaca account & positions
- **Rules:**
  - Position sizing follows Kelly fraction capped at user's max position % (default 15%)
  - Must produce a stop loss and target — no naked positions
  - Confidence < 55 → automatic HOLD (no action)
  - Must reference Devil's Advocate critique in rationale (acknowledge or refute)

### 3.7 Risk Manager

- **File:** `src/agents/riskManager.ts`
- **Model:** `claude-haiku-4-5-20251001` (mostly rule-based; LLM for edge-case judgment)
- **Role:** Veto-power gate before execution. Applies portfolio-level and personal rules.
- **Inputs:** `TradeProposal` + current portfolio state + personal rules config
- **Outputs:** `RiskAssessment` with `APPROVED | REJECTED | MODIFIED` and reason
- **Tools:** `get_portfolio_state()`, `get_correlations(tickers)`
- **Rules to enforce (configurable in `config/riskRules.json`):**
  - Single position ≤ 15% of equity
  - Sector concentration ≤ 35%
  - Total leverage ≤ 1.0 (no margin)
  - Max daily loss ≤ 2% (halt all new trades if breached)
  - Max 3 new trades per day
  - No trades in first 30 min after market open
  - No trades 30 min before close
  - Cooling-off period of 24h after stop-out on same ticker
  - Order size sanity check (fat-finger protection: notional ≤ 2x median position)

### 3.8 Execution Agent

- **File:** `src/agents/executor.ts`
- **Model:** `claude-haiku-4-5-20251001`
- **Role:** Translates approved `TradeProposal` into Alpaca orders
- **Inputs:** Approved `TradeProposal`
- **Outputs:** `ExecutionReport` (order IDs, fills, slippage)
- **Tools:**
  - `place_order()`, `cancel_order()`, `get_order_status()` → Alpaca
- **Rules:**
  - For positions >$5k, split into TWAP slices (4 slices over 20 min) — use Alpaca's algo orders
  - Always use limit orders (mid + 1bp aggressive) by default; market only if user override
  - Always attach bracket OCO (stop + target) when placing entry
  - Log every order action to trade journal

### 3.9 Post-Mortem Agent (Phase 3)

- **File:** `src/agents/postMortem.ts`
- **Model:** `claude-sonnet-4-5`
- **Role:** After a position closes (stop, target, or manual close), writes a learning entry
- **Inputs:** Full trade trace from journal + exit data
- **Outputs:** `PostMortemEntry` stored in vector DB
- **Trigger:** Listener on position-close event from Alpaca webhook

---

## 4. Data Contracts (TypeScript)

All contracts live in `src/types/contracts.ts`. Use Zod for runtime validation at agent boundaries.

```typescript
// === Inputs ===
export interface ResearchRequest {
  ticker: string;
  triggerReason: 'manual' | 'momentum_signal' | 'news_alert' | 'scheduled';
  context?: string;
  requestId: string;        // UUID for trace correlation
  timestamp: string;        // ISO 8601
}

// === Analyst Outputs ===
export interface ResearchReport {
  ticker: string;
  sentiment: { score: number; label: 'bearish' | 'neutral' | 'bullish' };
  fundamentals: {
    pe: number | null;
    evEbitda: number | null;
    revenueGrowthYoY: number | null;
    fcfYield: number | null;
    debtToEquity: number | null;
    score: number;          // 0–100
  };
  newsHighlights: Array<{ headline: string; sentiment: number; url: string; date: string }>;
  thesis: string;           // 3–5 sentence summary
  confidence: number;       // 0–100
  sourceCalls: Array<{ tool: string; ts: string }>;  // for grounding audit
}

export interface MacroRegime {
  label: 'RISK_ON' | 'RISK_OFF' | 'NEUTRAL' | 'CRISIS';
  rationale: string;
  signals: { vix: number; yieldCurve: number; trendSpy200: 'above' | 'below' };
  validUntil: string;       // ISO 8601, ~4 hours forward
}

export interface TechnicalReport {
  ticker: string;
  trend: 'up' | 'down' | 'sideways';
  momentum: number;         // -100 to +100
  rsi14: number;
  macdSignal: 'bullish' | 'bearish' | 'neutral';
  keyLevels: { support: number[]; resistance: number[] };
  signal: 'BUY' | 'HOLD' | 'SELL';
  confidence: number;
}

// === Decision ===
export interface Critique {
  bearCase: string;
  hiddenRisks: string[];
  counterEvidence: Array<{ point: string; sourceUrl?: string }>;
  strength: number;         // 1–10
}

export interface TradeProposal {
  ticker: string;
  action: 'BUY' | 'SELL' | 'HOLD' | 'CLOSE';
  sizeUsd: number;
  sizePctOfEquity: number;
  entryPrice: number;       // limit price target
  stopLoss: number;
  takeProfit: number;
  timeHorizonDays: number;
  rationale: string;
  confidence: number;
  agentTrace: string[];     // agent IDs that contributed
}

export interface RiskAssessment {
  status: 'APPROVED' | 'REJECTED' | 'MODIFIED';
  modifiedProposal?: TradeProposal;
  reason: string;
  rulesTriggered: string[];
}

// === Execution ===
export interface ExecutionReport {
  proposalId: string;
  orderIds: string[];
  fills: Array<{ qty: number; price: number; ts: string }>;
  slippageBps: number;
  status: 'FILLED' | 'PARTIAL' | 'REJECTED' | 'PENDING';
  bracketOrderIds?: { stop: string; target: string };
}

// === Top-level result ===
export type Decision =
  | { kind: 'TRADE'; proposal: TradeProposal; execution: ExecutionReport }
  | { kind: 'NO_TRADE'; reason: string; agentTrace: string[] };
```

---

## 5. Tools & External APIs

### 5.1 Required API keys (`.env`)

```bash
ANTHROPIC_API_KEY=
ALPACA_API_KEY=
ALPACA_API_SECRET=
ALPACA_PAPER=true                    # toggle paper/live
FMP_API_KEY=                         # Financial Modeling Prep
FINNHUB_API_KEY=
TELEGRAM_BOT_TOKEN=                  # from existing setup
TELEGRAM_CHAT_ID=
TRADING_MODE=paper                   # paper | live (live requires explicit confirm)
```

### 5.2 Tool implementations (`src/tools/`)

Each tool is a function with this shape — Anthropic tool-use friendly:

```typescript
export const getFinancials: ClaudeTool = {
  name: 'get_financials',
  description: 'Fetch latest fundamentals for a US-listed ticker. Returns P/E, EV/EBITDA, revenue growth, FCF yield, debt ratios.',
  input_schema: {
    type: 'object',
    properties: { ticker: { type: 'string' } },
    required: ['ticker'],
  },
  execute: async ({ ticker }) => { /* FMP call */ },
};
```

| Tool | Source | Rate limit | Cache TTL |
|---|---|---|---|
| `get_financials` | FMP | 250/day free | 24h |
| `get_news` | Finnhub | 60/min free | 15min |
| `get_analyst_ratings` | Finnhub | 60/min | 6h |
| `get_earnings_history` | FMP | 250/day | 24h |
| `get_bars` | Alpaca | very generous | 1min for intraday |
| `get_index_data` | Alpaca | – | 15min |
| `get_portfolio_state` | Alpaca | – | none (always fresh) |
| `place_order` | Alpaca | – | – |
| `web_search` | Anthropic native | included | – |

### 5.3 Caching layer

Wrap every external API call with a simple file or Redis cache keyed by `(toolName, normalizedArgs)`. Saves cost and respects rate limits during dev iteration.

---

## 6. Orchestration Implementation

```typescript
// src/agents/orchestrator.ts (sketch)
export async function runResearchPipeline(req: ResearchRequest): Promise<Decision> {
  const trace: string[] = [];

  // Phase 1 — parallel analyst fan-out
  const [research, macro, technical] = await Promise.all([
    researchAnalyst({ ticker: req.ticker, lookbackDays: 30 }),
    macroAnalyst.getOrCompute(),         // cached
    technicalAnalyst({ ticker: req.ticker }),
  ]);
  trace.push('research', 'macro', 'technical');

  // Early exit: if any analyst confidence is below floor
  if (research.confidence < 30 || technical.confidence < 30) {
    return { kind: 'NO_TRADE', reason: 'low_analyst_confidence', agentTrace: trace };
  }

  // Phase 2 — adversarial check
  const critique = await devilsAdvocate({ research, macro, technical });
  trace.push('devilsAdvocate');

  // Phase 3 — synthesis
  const proposal = await portfolioManager({ research, macro, technical, critique });
  trace.push('portfolioManager');

  if (proposal.action === 'HOLD') {
    return { kind: 'NO_TRADE', reason: 'pm_chose_hold', agentTrace: trace };
  }

  // Phase 4 — risk gate
  const risk = await riskManager({ proposal });
  trace.push('riskManager');

  if (risk.status === 'REJECTED') {
    return { kind: 'NO_TRADE', reason: risk.reason, agentTrace: trace };
  }

  const finalProposal = risk.status === 'MODIFIED' ? risk.modifiedProposal! : proposal;

  // Phase 5 — execution
  const execution = await executor({ proposal: finalProposal });
  trace.push('executor');

  await journal.append({ req, research, macro, technical, critique, proposal: finalProposal, risk, execution });
  await telegram.notify(formatDecision(finalProposal, execution));

  return { kind: 'TRADE', proposal: finalProposal, execution };
}
```

---

## 7. Memory & Persistence

### 7.1 Trade Journal (Phase 1)
- Simple JSONL file: `data/journal/YYYY-MM.jsonl`
- One line per pipeline run with full trace
- Used for post-hoc analysis and Post-Mortem agent later

### 7.2 Vector store (Phase 3)
- `pgvector` on local Postgres, or Qdrant in Docker
- Stores: research theses, post-mortems, prior decisions
- PM agent retrieves top-K similar past situations as context

### 7.3 State files
- `data/state/macroCache.json` — current regime + valid-until
- `data/state/portfolio.json` — mirrored from Alpaca for fast reads
- `data/state/cooldowns.json` — per-ticker cooling-off timers

---

## 8. Build Phases

### Phase 1 — Minimum viable pipeline (target: 1 weekend)
- [ ] Project scaffold + TypeScript + Zod + dotenv + pino logger
- [ ] Implement tool layer: `get_bars`, `get_financials`, `get_news`, `get_portfolio_state`, `place_order`
- [ ] Implement `researchAnalyst`, `technicalAnalyst`, `portfolioManager`, `executor` (skip Macro, Devil's Advocate, Risk for now)
- [ ] Wire orchestrator in linear mode
- [ ] Trade journal writer
- [ ] Telegram bot command: `/research TICKER`
- [ ] Paper trading only; assert `ALPACA_PAPER=true`

### Phase 2 — Adversarial & risk controls
- [x] Add `macroAnalyst` with caching (`data/state/macroCache.json`, 4h TTL;
      SPY 200-DMA trend computed in code, VIX + yield curve via web_search)
- [x] Add `devilsAdvocate` (web_search for disconfirming evidence)
- [x] Add `riskManager` with full rule set (deterministic `lib/riskRules.ts`;
      LLM decides APPROVED/REJECTED/MODIFIED, code re-asserts hard breaches)
- [x] Parallelize analyst fan-out (`Promise.all` in the orchestrator)
- [x] Add bracket OCO orders in executor (already shipped in Phase 1 via
      `placeBracketOrder` / `order_class: 'bracket'`)
- [ ] Migrate FMP (and Finnhub if available) tools from hand-coded REST
      wrappers to MCP-client wrappers. FMP exposes their full dataset via
      an MCP server at `https://financialmodelingprep.com/mcp?apikey=…`.
      Keeps the `ClaudeToolSpec` shape but removes the per-endpoint
      maintenance burden when FMP changes field names. Filter to an
      allowlist so we don't blow up the agent system prompt.
      **Deferred to a follow-up (decision: keep REST wrappers for now).**

**Phase 2 data gaps (deferred to Phase 3):**
- **Sector concentration** rule is implemented but not enforced — Alpaca
  positions carry no sector tag, so the check soft-passes with a note. Needs a
  sector data source.
- **Cooldown population**: `riskManager` reads `data/state/cooldowns.json`, but
  nothing writes it yet. Population belongs to the Phase-3 Alpaca close-event
  listener that detects stop-outs.
- **Latency**: a full live run measured ~83s (over the §12 <35s target). The
  Devil's Advocate (Sonnet + web_search) dominates. Per §12 the lever is to
  downgrade non-critical agents to Haiku — revisit before Phase 3.

### Phase 3 — Learning loop
- [ ] Add vector store
- [ ] Add `postMortem` agent on Alpaca close-event webhook
- [ ] PM retrieves similar past trades as context
- [ ] Weekly performance digest to Telegram

### Phase 4 — Specialization (optional)
- [ ] Vertical-specific Research analysts (Tech, Energy, Healthcare)
- [ ] Orchestrator routes ticker to correct vertical
- [ ] Alternative data tools (web traffic, app rankings) if data source available

---

## 9. Folder Structure

```
trading-agent/
├── ARCHITECTURE.md               (this file)
├── CLAUDE.md                     (Claude Code project memory)
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── src/
│   ├── index.ts                  (entrypoint: Telegram listener + cron)
│   ├── agents/
│   │   ├── orchestrator.ts
│   │   ├── researchAnalyst.ts
│   │   ├── macroAnalyst.ts
│   │   ├── technicalAnalyst.ts
│   │   ├── devilsAdvocate.ts
│   │   ├── portfolioManager.ts
│   │   ├── riskManager.ts
│   │   ├── executor.ts
│   │   └── postMortem.ts
│   ├── tools/
│   │   ├── alpaca.ts             (existing)
│   │   ├── fmp.ts
│   │   ├── finnhub.ts
│   │   ├── indicators.ts         (deterministic TA math)
│   │   └── index.ts              (tool registry)
│   ├── types/
│   │   └── contracts.ts          (all Zod schemas + TS types)
│   ├── lib/
│   │   ├── claude.ts             (Anthropic SDK wrapper with tool-use loop)
│   │   ├── cache.ts
│   │   ├── journal.ts
│   │   ├── logger.ts
│   │   └── telegram.ts           (existing)
│   ├── strategies/
│   │   └── dualMomentum.ts       (existing — feeds tickers to orchestrator)
│   └── config/
│       ├── riskRules.json
│       └── prompts/              (one .md file per agent system prompt)
├── data/
│   ├── journal/
│   ├── state/
│   └── cache/
└── tests/
    └── agents/
        └── *.test.ts
```

---

## 10. First Tasks for Claude Code (in order)

Hand the following ordered task list to your Claude Code agent. Each task should be a separate commit.

1. **Scaffold:** Init TypeScript project, install deps (`@anthropic-ai/sdk`, `@alpacahq/alpaca-trade-api`, `zod`, `pino`, `dotenv`, `node-cache`). Set up `tsconfig.json`, `.env.example`, `.gitignore`.

2. **Types:** Create `src/types/contracts.ts` with all Zod schemas from §4. Export inferred TS types.

3. **Claude wrapper:** Create `src/lib/claude.ts` exporting `runAgent({ system, messages, tools, model })` that handles the full tool-use loop until the model returns `stop_reason: 'end_turn'`. Must support parallel tool calls and emit structured logs.

4. **Tool registry:** Implement `src/tools/fmp.ts`, `src/tools/finnhub.ts`, extend existing `alpaca.ts` with `get_bars`, `get_portfolio_state`, `place_order` (bracket). Each tool exports `{ name, description, input_schema, execute }`. Wire them in `src/tools/index.ts`.

5. **Deterministic indicators:** `src/tools/indicators.ts` with RSI, MACD, SMA, EMA. Pure functions, unit-tested.

6. **Research Analyst:** Implement per §3.2. System prompt in `src/config/prompts/researchAnalyst.md`. Add Zod validation of output before return.

7. **Technical Analyst:** Implement per §3.4. LLM only interprets pre-computed indicators.

8. **PM Agent:** Implement per §3.6. Position sizing logic in pure helper function.

9. **Executor:** Implement per §3.8. Default to paper. Add bracket OCO.

10. **Orchestrator (linear):** Wire the three above in sequence. Skip Macro / Devil's Advocate / Risk for v1.

11. **Telegram command:** Wire `/research TICKER` to trigger orchestrator. Format response as compact summary card.

12. **Trade journal:** JSONL append-only writer at `data/journal/YYYY-MM.jsonl`. Include full trace.

13. **End-to-end smoke test:** `/research NVDA` on paper account. Verify orderID appears in Alpaca dashboard.

**Stop here — review with user before Phase 2.**

---

## 11. Operational Rules for Claude Code

- **Never** commit `.env` or any file under `data/`. Add to `.gitignore` from task 1.
- **Always** validate agent outputs with Zod before passing to the next agent. Throw on validation failure with the offending payload logged.
- **Always** wrap external API calls in the cache layer.
- **Never** invent numerical values in prompts or outputs — every number must trace to a tool result.
- **Always** include the `requestId` (UUID) in every log line for trace correlation.
- **Never** flip `TRADING_MODE` to `live` without an explicit confirmation prompt in the runtime.
- Use `pino` for structured logging; one log line per agent invocation with input hash, output hash, latency, token usage.
- Keep system prompts in `src/config/prompts/*.md` — never inline in code.
- Write a unit test for every deterministic helper (indicators, position sizing, risk rules).
- For each agent, write at least one integration test using a recorded fixture of tool outputs.

---

## 12. Cost & Latency Budget

| Phase | Target latency | Target cost/run |
|---|---|---|
| Phase 1 (3 agents) | < 25s | < $0.15 |
| Phase 2 (6 agents, parallel) | < 35s | < $0.30 |
| Phase 3 (with memory) | < 40s | < $0.40 |

If exceeded by >50%, downgrade non-critical agents to Haiku and reassess.

---

## 13. Out of Scope (do not build)

- Public-facing API or signal distribution (regulatory exposure)
- Options or derivatives trading
- Crypto (different broker, different risk profile)
- Order types beyond limit + bracket OCO
- Real-time tick-level data subscription
- Compliance/KYC layer (personal use only)
- Web UI (Telegram is sufficient for v1–v3)

---

*End of spec. Hand this file to Claude Code along with `CLAUDE.md` for project memory.*
