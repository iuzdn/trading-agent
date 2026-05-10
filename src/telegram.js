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

export function formatRunSummary(log) {
  const trades = log.filter(l => l.type === 'trade');
  const decisions = log.filter(l => l.type === 'decision');
  const lines = [
    `🤖 *Alpaca Agent Run* — ${new Date().toUTCString()}`,
    '',
    `📊 *Decisions made:* ${decisions.length}`,
    `💹 *Trades executed:* ${trades.length}`,
    '',
  ];
  trades.forEach(t => {
    lines.push(`${t.side === 'buy' ? '🟢' : '🔴'} ${t.side.toUpperCase()} $${t.notional || t.qty} of *${t.symbol}*`);
  });
  if (log.some(l => l.type === 'killswitch')) {
    lines.push('', '⚠️ *KILL SWITCH TRIGGERED — daily loss limit hit*');
  }
  return lines.join('\n');
}
