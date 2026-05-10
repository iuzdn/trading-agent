import fetch from 'node-fetch';

const BASE_URL = process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';
const DATA_URL = 'https://data.alpaca.markets';
const HEADERS = {
  'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
  'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
  'Content-Type': 'application/json',
};

async function request(url, options = {}) {
  const res = await fetch(url, { headers: HEADERS, ...options });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Alpaca API error ${res.status}: ${err}`);
  }
  return res.json();
}

// ── Account ────────────────────────────────────────────────────────────────
export async function getAccount() {
  return request(`${BASE_URL}/v2/account`);
}

export async function getPositions() {
  return request(`${BASE_URL}/v2/positions`);
}

export async function getOrders(status = 'open') {
  return request(`${BASE_URL}/v2/orders?status=${status}&limit=50`);
}

// ── Market Data ────────────────────────────────────────────────────────────
export async function getBars(symbol, timeframe = '1Day', limit = 60) {
  const isCrypto = symbol.includes('/');
  const endpoint = isCrypto
    ? `${DATA_URL}/v1beta3/crypto/us/bars?symbols=${symbol}&timeframe=${timeframe}&limit=${limit}`
    : `${DATA_URL}/v2/stocks/${symbol}/bars?timeframe=${timeframe}&limit=${limit}&feed=iex`;
  const data = await request(endpoint);
  return isCrypto ? data.bars[symbol] : data.bars;
}

export async function getLatestQuote(symbol) {
  const isCrypto = symbol.includes('/');
  const endpoint = isCrypto
    ? `${DATA_URL}/v1beta3/crypto/us/latest/quotes?symbols=${symbol}`
    : `${DATA_URL}/v2/stocks/${symbol}/quotes/latest?feed=iex`;
  const data = await request(endpoint);
  return isCrypto ? data.quotes[symbol] : data.quote;
}

export async function getLatestTrade(symbol) {
  const isCrypto = symbol.includes('/');
  if (isCrypto) {
    const data = await request(`${DATA_URL}/v1beta3/crypto/us/latest/trades?symbols=${symbol}`);
    return data.trades[symbol];
  }
  const data = await request(`${DATA_URL}/v2/stocks/${symbol}/trades/latest?feed=iex`);
  return data.trade;
}

// ── Orders ─────────────────────────────────────────────────────────────────
export async function placeOrder({ symbol, qty, notional, side, type = 'market', time_in_force = 'gtc' }) {
  const body = { symbol, side, type, time_in_force };
  if (notional) body.notional = String(notional);
  else body.qty = String(qty);
  return request(`${BASE_URL}/v2/orders`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function cancelOrder(orderId) {
  return request(`${BASE_URL}/v2/orders/${orderId}`, { method: 'DELETE' });
}

export async function cancelAllOrders() {
  return request(`${BASE_URL}/v2/orders`, { method: 'DELETE' });
}

export async function closePosition(symbol) {
  const encoded = encodeURIComponent(symbol);
  return request(`${BASE_URL}/v2/positions/${encoded}`, { method: 'DELETE' });
}

// ── Helpers ────────────────────────────────────────────────────────────────
export function computeMomentum(bars, shortDays = 20, longDays = 50) {
  if (!bars || bars.length < longDays) return null;
  const closes = bars.map(b => b.c);
  const latest = closes[closes.length - 1];
  const ma20 = closes.slice(-shortDays).reduce((a, b) => a + b, 0) / shortDays;
  const ma50 = closes.slice(-longDays).reduce((a, b) => a + b, 0) / longDays;
  const ret20 = (latest - closes[closes.length - shortDays]) / closes[closes.length - shortDays];
  const ret50 = (latest - closes[closes.length - longDays]) / closes[closes.length - longDays];
  return { latest, ma20, ma50, ret20, ret50, aboveMa20: latest > ma20, aboveMa50: latest > ma50 };
}
