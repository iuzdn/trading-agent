import { logger } from './logger.js';

const API = 'https://api.telegram.org';

function botToken(): string | null {
  return process.env.TELEGRAM_BOT_TOKEN ?? null;
}

function chatId(): string | null {
  return process.env.TELEGRAM_CHAT_ID ?? null;
}

function escapeMarkdown(text: string): string {
  // Telegram MarkdownV2 reserved characters.
  return text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/**
 * Sanitize prose for Telegram's legacy `Markdown` parse mode (what sendMessage
 * uses). Legacy Markdown does NOT honor backslash escapes, so the only safe
 * way to neutralize entity-opening characters in LLM-generated prose is to
 * substitute them with visually similar non-reserved characters. Without this,
 * a stray `_` or `*` leaves an emphasis span unclosed and Telegram returns 400
 * ("can't parse entities").
 */
function sanitizeMarkdownV1(text: string): string {
  return text
    .replace(/\*/g, '•')   // bullet — won't open bold
    .replace(/_/g, ' ')    // space — won't open italic
    .replace(/`/g, "'")    // apostrophe — won't open code
    .replace(/\[/g, '(')   // paren — won't open link
    .replace(/\]/g, ')');
}

export async function sendMessage(text: string, opts: { parseMode?: 'Markdown' | 'MarkdownV2' } = {}): Promise<void> {
  const token = botToken();
  const chat = chatId();
  if (!token || !chat) {
    logger.warn({ preview: text.slice(0, 80) }, 'telegram not configured — skipping');
    return;
  }
  const body = {
    chat_id: chat,
    text,
    parse_mode: opts.parseMode ?? 'Markdown',
  };
  try {
    const res = await fetch(`${API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      logger.error({ status: res.status, body: await res.text() }, 'telegram send failed');
    }
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'telegram send threw');
  }
}

export interface PrefixHandler {
  /** Command prefix including the slash, e.g. "/research" */
  prefix: string;
  /** Called with the substring after the prefix, trimmed. */
  handle: (rest: string) => Promise<void> | void;
}

export async function startCommandListener(handlers: PrefixHandler[]): Promise<void> {
  const token = botToken();
  const chat = chatId();
  if (!token || !chat) {
    logger.warn('telegram not configured — listener disabled');
    return;
  }
  logger.info(
    { commands: handlers.map((h) => h.prefix).join(' ') },
    'telegram listener active',
  );

  let offset = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const url = `${API}/bot${token}/getUpdates?offset=${offset}&timeout=30`;
      const res = await fetch(url, { signal: AbortSignal.timeout(35_000) });
      const data = (await res.json()) as {
        result?: Array<{ update_id: number; message?: { text?: string; chat?: { id: number } } }>;
      };
      for (const update of data.result ?? []) {
        offset = update.update_id + 1;
        const text = update.message?.text?.trim();
        const senderId = String(update.message?.chat?.id ?? '');
        if (!text || senderId !== chat) continue;
        const handler = handlers.find((h) =>
          text === h.prefix || text.toLowerCase().startsWith(`${h.prefix.toLowerCase()} `),
        );
        if (!handler) {
          if (text.startsWith('/')) {
            await sendMessage(`Unknown command: ${escapeMarkdown(text)}`);
          }
          continue;
        }
        const rest = text.slice(handler.prefix.length).trim();
        Promise.resolve(handler.handle(rest)).catch(async (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error({ prefix: handler.prefix, err: msg }, 'command handler threw');
          await sendMessage(`Error running ${handler.prefix}: ${msg}`);
        });
      }
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name !== 'TimeoutError' && name !== 'AbortError') {
        logger.error({ err: err instanceof Error ? err.message : String(err) }, 'telegram poll error');
      }
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}

export { escapeMarkdown, sanitizeMarkdownV1 };
