# 🤖 Alpaca Autonomous Trading Agent

A fully autonomous trading agent powered by **Claude AI** + **Alpaca API**. Implements a Dual Momentum strategy with regime filtering across US equities and crypto.

## How It Works

```
Cron trigger (2x/day equities + daily crypto)
    ↓
Claude (claude-sonnet-4) reasons through strategy
    ↓
Tools: get_account, compute_momentum, place_order, close_position...
    ↓
Alpaca API executes trades
    ↓
Telegram alert with run summary
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
```bash
cp .env.example .env
# Edit .env with your keys
```

**Keys you need:**
- `ANTHROPIC_API_KEY` → [console.anthropic.com](https://console.anthropic.com)
- `ALPACA_API_KEY` + `ALPACA_SECRET_KEY` → [alpaca.markets](https://alpaca.markets) (Paper trading keys first!)
- `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` → Optional but recommended

### 3. Get Telegram alerts (optional)
1. Message [@BotFather](https://t.me/botfather) on Telegram → `/newbot`
2. Copy the token to `TELEGRAM_BOT_TOKEN`
3. Message your bot once, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates`
4. Copy the `chat.id` to `TELEGRAM_CHAT_ID`

### 4. Test run (paper mode)
```bash
npm run now
```
This runs the full agent cycle immediately. Watch the logs — Claude will explain every decision.

### 5. Start scheduler
```bash
npm start
```
Runs automatically:
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
- Watchlist: SPY, QQQ, NVDA, MSFT, AAPL, AMZN, META, TSM, ASML
- Ranks by 20-day return
- Only buys symbols above both MA20 and MA50
- Targets top 3 qualifying symbols

### Crypto Selection
- Watchlist: BTC/USD, ETH/USD, SOL/USD
- Same momentum filter (above MA20 + MA50)
- Max 20% portfolio allocation to crypto

### Rebalancing
- Exits positions that fall below MA50
- Rotates into better-ranked symbols
- Avoids unnecessary churn (holds qualifying positions)

---

## Risk Controls

| Control | Default | Config key |
|---------|---------|------------|
| Max position size | 10% of portfolio | `MAX_POSITION_PCT` |
| Max single order | $500 | `MAX_TRADE_USD` |
| Daily loss kill-switch | -3% | `DAILY_LOSS_LIMIT_PCT` |
| Paper mode | ON | `PAPER_MODE` |

**Kill-switch**: If daily P&L drops below `-3%`, the agent cancels all orders, closes all positions, sends a Telegram alert, and stops.

---

## Going Live

When you're ready to trade with real money:
1. Run in paper mode for at least **4-6 weeks**
2. Review trade logs and Telegram alerts
3. Change `.env`:
   ```
   ALPACA_BASE_URL=https://api.alpaca.markets
   PAPER_MODE=false
   ```
4. Consider lowering `MAX_TRADE_USD` initially (e.g. $100)

---

## Customizing the Strategy

Edit `src/agent.js` → `buildSystemPrompt()` to adjust:
- Watchlists (add/remove symbols)
- MA periods (default: 20/50 day)
- Allocation rules
- Rebalancing frequency

The strategy is expressed in plain English in the system prompt — Claude interprets it. You can iterate on it like you're writing a spec.

---

## Project Structure

```
alpaca-agent/
├── index.js          # Entry point + cron scheduler
├── src/
│   ├── agent.js      # Claude agentic loop
│   ├── tools.js      # Tool definitions + executors
│   ├── alpaca.js     # Alpaca REST API client
│   └── telegram.js   # Alert notifications
├── .env.example
└── README.md
```
