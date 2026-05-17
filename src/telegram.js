import fetch from 'node-fetch';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

export async function sendAlert(message) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log('[Telegram skipped - not configured]', message);
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: message,
        parse_mode: 'Markdown',
      }),
    });
  } catch (e) {
    console.error('Telegram alert failed:', e.message);
  }
}

// Convert the agent's markdown to Telegram-compatible markdown and truncate.
function toTelegramMd(text, maxLen = 3200) {
  const converted = text
    .replace(/\*\*(.+?)\*\*/gs, '*$1*')  // **bold** → *bold*
    .replace(/^#{1,3} (.+)$/gm, '*$1*')  // ## Heading → *Heading*
    .replace(/^- /gm, '• ');             // - list item → • list item
  return converted.length > maxLen
    ? converted.slice(0, maxLen).trimEnd() + '…'
    : converted;
}

export function formatRunSummary(log) {
  const trades = log.filter(l => l.type === 'trade');
  const stops = log.filter(l => l.type === 'trailing_stop');
  const summary = log.find(l => l.type === 'summary');
  const totalUsd = trades.reduce((sum, t) => sum + (parseFloat(t.notional) || 0), 0);

  const lines = [
    `🤖 *Alpaca Agent Run* — ${new Date().toUTCString()}`,
    '',
  ];

  if (stops.length > 0) {
    lines.push(`🛑 *Trailing stops triggered (${stops.length}):*`);
    stops.forEach(s => {
      lines.push(`• *${s.symbol}*: \\-${s.drawdown_pct}% from high $${s.high} (now $${s.current})`);
    });
    lines.push('');
  }

  if (trades.length > 0) {
    lines.push(`💹 *Trades (${trades.length}${totalUsd ? `, ~$${totalUsd.toFixed(0)} total` : ''}):*`);
    trades.forEach(t => {
      lines.push(`${t.side === 'buy' ? '🟢' : '🔴'} ${t.side.toUpperCase()} $${t.notional || t.qty} of *${t.symbol}*`);
    });
  } else if (stops.length === 0) {
    lines.push('💹 _No trades placed — held or risk\\-off_');
  }

  if (log.some(l => l.type === 'killswitch')) {
    lines.push('', '🚨 *KILL SWITCH TRIGGERED — daily loss limit hit*');
  }

  if (summary?.text) {
    lines.push('', '─────────────────', '', toTelegramMd(summary.text));
  }

  return lines.join('\n');
}

// Long-poll Telegram for incoming commands from CHAT_ID only.
// handlers: { '/command': async () => void }
export async function startCommandListener(handlers) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log('[Telegram] Not configured — command listener disabled');
    return;
  }
  console.log('[Telegram] Command listener active. Send /status, /run, or /stop');

  let offset = 0;
  while (true) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${offset}&timeout=30`,
        { signal: AbortSignal.timeout(35_000) },
      );
      const data = await res.json();
      for (const update of data.result || []) {
        offset = update.update_id + 1;
        const text = update.message?.text?.trim().toLowerCase();
        const chatId = String(update.message?.chat?.id);
        if (chatId !== String(CHAT_ID)) continue;
        const handler = handlers[text];
        if (handler) {
          handler().catch(e => sendAlert(`❌ Command error: ${e.message}`));
        } else if (text?.startsWith('/')) {
          await sendAlert(`Unknown command: ${text}\nAvailable: /status /run /stop`);
        }
      }
    } catch (e) {
      if (e.name !== 'TimeoutError' && e.name !== 'AbortError') {
        console.error('[Telegram] Poll error:', e.message);
      }
      await new Promise(r => setTimeout(r, 5_000));
    }
  }
}
