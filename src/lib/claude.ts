import Anthropic from '@anthropic-ai/sdk';
import { childLogger, type Logger } from './logger.js';

export type AnthropicModel =
  | 'claude-sonnet-4-5'
  | 'claude-haiku-4-5-20251001'
  | 'claude-opus-4-7';

export interface ClaudeToolSpec {
  name: string;
  description: string;
  // Anthropic JSONSchema shape for tool input
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  execute: (input: Record<string, unknown>) => Promise<unknown>;
}

export interface RunAgentOptions {
  system: string;
  messages: Anthropic.Messages.MessageParam[];
  tools: ClaudeToolSpec[];
  model: AnthropicModel;
  maxTokens?: number;
  maxToolIterations?: number;
  requestId: string;
  agentId: string;
  /**
   * Enable Anthropic's server-side web_search tool. `true` uses the default
   * cap; pass `{ maxUses }` to bound the number of searches per turn. The
   * search runs server-side — it never reaches the client tool map.
   */
  webSearch?: boolean | { maxUses?: number };
}

export interface RunAgentResult {
  finalText: string;
  rawMessages: Anthropic.Messages.MessageParam[];
  toolCalls: Array<{ name: string; input: unknown; output: unknown }>;
  usage: { inputTokens: number; outputTokens: number };
  stopReason: string | null;
}

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY missing');
    }
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _client;
}

/**
 * Tool-use loop. Iterates until the model stops requesting tools or we hit
 * maxToolIterations. Parallel tool calls in a single response are supported.
 */
export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const log: Logger = childLogger({ requestId: opts.requestId, agentId: opts.agentId });
  const toolMap = new Map(opts.tools.map((t) => [t.name, t]));
  const apiTools: Anthropic.Messages.ToolUnion[] = opts.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
  // Server-side web search. Declared as a tool but executed on Anthropic's
  // infrastructure — deliberately NOT added to toolMap, so the client-side
  // execution path below never tries to run it.
  if (opts.webSearch) {
    const maxUses =
      typeof opts.webSearch === 'object' ? opts.webSearch.maxUses : undefined;
    apiTools.push({
      type: 'web_search_20250305',
      name: 'web_search',
      ...(maxUses ? { max_uses: maxUses } : {}),
    });
  }

  const messages: Anthropic.Messages.MessageParam[] = [...opts.messages];
  const toolCalls: RunAgentResult['toolCalls'] = [];
  const maxIter = opts.maxToolIterations ?? 10;
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason: string | null = null;

  for (let iter = 0; iter < maxIter; iter++) {
    const t0 = Date.now();
    const response = await client().messages.create({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 4096,
      system: opts.system,
      tools: apiTools.length > 0 ? apiTools : undefined,
      messages,
    });
    inputTokens += response.usage.input_tokens;
    outputTokens += response.usage.output_tokens;
    stopReason = response.stop_reason;

    log.debug(
      {
        iter,
        stopReason,
        latencyMs: Date.now() - t0,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      'claude turn',
    );

    // Append assistant message verbatim
    messages.push({ role: 'assistant', content: response.content });

    // A server-side tool (e.g. web_search) ran its loop and hit the internal
    // iteration limit. Resume by re-sending — the API continues from the
    // trailing server_tool_use block. Do NOT append a user turn.
    if (response.stop_reason === 'pause_turn') {
      continue;
    }

    if (response.stop_reason !== 'tool_use') {
      const finalText = response.content
        .filter((b): b is Anthropic.Messages.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
      return {
        finalText,
        rawMessages: messages,
        toolCalls,
        usage: { inputTokens, outputTokens },
        stopReason,
      };
    }

    // Execute all tool_use blocks in this turn in parallel.
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === 'tool_use',
    );

    const results = await Promise.all(
      toolUseBlocks.map(async (block) => {
        const tool = toolMap.get(block.name);
        if (!tool) {
          log.error({ toolName: block.name }, 'unknown tool');
          return {
            type: 'tool_result' as const,
            tool_use_id: block.id,
            content: `Error: unknown tool "${block.name}"`,
            is_error: true,
          };
        }
        try {
          const output = await tool.execute(block.input as Record<string, unknown>);
          toolCalls.push({ name: block.name, input: block.input, output });
          return {
            type: 'tool_result' as const,
            tool_use_id: block.id,
            content: JSON.stringify(output),
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error({ toolName: block.name, err: msg }, 'tool execution failed');
          toolCalls.push({ name: block.name, input: block.input, output: { error: msg } });
          return {
            type: 'tool_result' as const,
            tool_use_id: block.id,
            content: `Tool error: ${msg}`,
            is_error: true,
          };
        }
      }),
    );

    messages.push({ role: 'user', content: results });
  }

  log.warn({ maxIter }, 'tool-use loop hit max iterations');
  return {
    finalText: '',
    rawMessages: messages,
    toolCalls,
    usage: { inputTokens, outputTokens },
    stopReason: 'max_iterations',
  };
}

/**
 * Extract the first fenced JSON block from text. Throws if none found.
 * Agents that must produce structured output should append a final assistant
 * turn ending in a ```json ... ``` block.
 */
export function extractJsonBlock(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1]! : text;
  return JSON.parse(raw.trim());
}
