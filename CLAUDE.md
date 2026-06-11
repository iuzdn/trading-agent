# CLAUDE.md — Project Memory for Trading Agent

This file is read by Claude Code at the start of every session. Keep it tight.

## Project

Personal multi-agent investment research & execution system. Paper trading on Alpaca by default. See `ARCHITECTURE.md` for the full spec.

## Stack

- Node.js 20+ / TypeScript (strict mode)
- Anthropic SDK (`@anthropic-ai/sdk`)
- Alpaca SDK (`@alpacahq/alpaca-trade-api`)
- Zod for runtime validation
- Pino for logging
- Vitest for tests

## Golden Rules

1. **Paper first, always.** `TRADING_MODE=live` is opt-in only; default to `paper`.
2. **No invented numbers.** Every metric in an agent output must come from a tool call.
3. **Validate at boundaries.** Zod-parse every agent input and output. Crash loud on schema violations.
4. **One agent, one file** under `src/agents/`. No agent calls another directly — the Orchestrator wires them.
5. **System prompts live in `src/config/prompts/*.md`**, never inline.
6. **Cache external API calls.** Saves cost during iteration.
7. **Never commit `.env` or `data/`.**
8. **Log with `requestId`** on every line so traces correlate.

## Commands

```bash
npm run dev              # ts-node-dev entrypoint, watches Telegram + cron
npm run research TICKER  # one-shot research run from CLI
npm test                 # vitest
npm run typecheck        # tsc --noEmit
npm run lint             # eslint
```

## Where things live

- Agents → `src/agents/`
- Tools (API wrappers) → `src/tools/`
- Types & Zod schemas → `src/types/contracts.ts`
- System prompts → `src/config/prompts/`
- Risk rule config → `src/config/riskRules.json`
- Trade journal → `data/journal/YYYY-MM.jsonl`
- State files → `data/state/`

## When implementing a new agent

1. Read `ARCHITECTURE.md` §3 for that agent's spec.
2. Add/extend its Zod contract in `src/types/contracts.ts`.
3. Write the system prompt in `src/config/prompts/<agent>.md`.
4. Implement in `src/agents/<agent>.ts` — pure async function, validates output with Zod before returning.
5. Add a fixture-based integration test in `tests/agents/<agent>.test.ts`.
6. Wire it into the Orchestrator only after tests pass.

## When adding a new tool

1. Add to `src/tools/<provider>.ts` following the `ClaudeTool` interface.
2. Register in `src/tools/index.ts`.
3. Wrap in the shared cache layer with appropriate TTL (see ARCHITECTURE §5.2).
4. Add an entry to the rate-limit table in `ARCHITECTURE.md`.

## Build order (do not skip ahead)

See `ARCHITECTURE.md` §10. Tasks 1–13 are Phase 1. Stop and review with me before Phase 2.

## Stop conditions

If any of these happen, stop and ask:

- You need to bypass Zod validation
- You need to inline a system prompt
- You need to make an agent call another agent directly
- A test cannot be written for what you're building
- You need to commit anything to `data/` or anything env-sensitive
- Phase 1 task list is complete (then pause for review)
