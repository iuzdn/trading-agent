import type { RunAgentResult } from '../../src/lib/claude.js';

/**
 * Build a RunAgentResult whose finalText is a fenced JSON block of `fixture`,
 * exactly as the real model would emit it. Lets a test drive any agent through
 * its extractJsonBlock → Zod-parse → post-processing path without a live call.
 *
 * Usage (vitest):
 *   const h = vi.hoisted(() => ({ runAgent: vi.fn() }));
 *   vi.mock('../../src/lib/claude.js', async (orig) => ({
 *     ...(await orig<typeof import('../../src/lib/claude.js')>()),
 *     runAgent: h.runAgent,
 *   }));
 *   h.runAgent.mockResolvedValue(agentResult(myFixture));
 */
export function agentResult(
  fixture: unknown,
  over: Partial<RunAgentResult> = {},
): RunAgentResult {
  return {
    finalText: '```json\n' + JSON.stringify(fixture, null, 2) + '\n```',
    rawMessages: [],
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    stopReason: 'end_turn',
    ...over,
  };
}
