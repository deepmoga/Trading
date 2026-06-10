// Technical analysis signal generation
// Works with real OHLCV candle data from Dhan or simulated data

const SYMBOLS = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'CRUDEOIL', 'GOLD', 'SILVER', 'NATURALGAS', 'COPPER'];

const BASE_LTP = {
  NIFTY: 22500, BANKNIFTY: 48200, SENSEX: 74100,
  CRUDEOIL: 6820, GOLD: 72100, SILVER: 85500,
  NATURALGAS: 245, COPPER: 730,
};

// ── INDICATORS ────────────────────────────────────────────────────────────────

function calcSMA(closes, period) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  const changes = [];
  for (let i = 1; i < closes.length; i++) {
    changes.push(closes[i] - closes[i - 1]);
  }
  const recent = changes.slice(-period);
  const gains = recent.filter(c => c > 0);
  const losses = recent.filter(c => c < 0).map(c => Math.abs(c));
  const avgGain = gains.reduce((a, b) => a + b, 0) / period;
  const avgLoss = losses.reduce((a, b) => a + b, 0) / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calcBreakout(highs, lows, closes, lookback = 20) {
  if (closes.length < lookback + 1) return 0;
  const prevHighs = highs.slice(-lookback - 1, -1);
  const prevLows = lows.slice(-lookback - 1, -1);
  const resistance = Math.max(...prevHighs);
  const support = Math.min(...prevLows);
  const ltp = closes[closes.length - 1];
  if (ltp > resistance) return 1;
  if (ltp < support) return -1;
  return 0;
}

// ── SIGNAL ENGINE ─────────────────────────────────────────────────────────────

function computeSignal(sym, candles, liveQuote) {
  const closes = candles.map(c => c.close);
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);

  const ltp = liveQuote?.ltp || closes[closes.length - 1] || BASE_LTP[sym];
  const change = liveQuote?.change ?? (closes.length > 1 ? ((ltp - closes[closes.length - 2]) / closes[closes.length - 2]) * 100 : 0);

  const maFast = calcEMA(closes, 9);
  const maSlow = calcEMA(closes, 21);
  const rsiVal = calcRSI(closes, 14);
  const boSig = calcBreakout(highs, lows, closes, 20);

  const maSignal = maFast !== null && maSlow !== null ? (maFast > maSlow ? 1 : -1) : 0;
  const rsiSignal = rsiVal > 55 ? 1 : rsiVal < 45 ? -1 : 0;
  const boSignal = boSig;

  const sigs = [maSignal, rsiSignal, boSignal];
  const buy = sigs.filter(s => s === 1).length;
  const sell = sigs.filter(s => s === -1).length;
  const finalSignal = buy >= 2 ? 1 : sell >= 2 ? -1 : 0;
  const confidence = finalSignal !== 0 ? Math.max(buy, sell) / 3 : 0;

  const reasonParts = [];
  if (maSignal === 1) reasonParts.push('EMA9>EMA21');
  else if (maSignal === -1) reasonParts.push('EMA9<EMA21');
  if (rsiSignal === 1) reasonParts.push(`RSI(${rsiVal.toFixed(0)}) bullish`);
  else if (rsiSignal === -1) reasonParts.push(`RSI(${rsiVal.toFixed(0)}) bearish`);
  if (boSignal === 1) reasonParts.push('Breakout up');
  else if (boSignal === -1) reasonParts.push('Breakdown');

  return {
    symbol: sym,
    ltp: +ltp.toFixed(2),
    change: +change.toFixed(2),
    signal: finalSignal,
    confidence: +confidence.toFixed(2),
    ma_signal: maSignal,
    rsi_signal: rsiSignal,
    bo_signal: boSignal,
    rsi_value: +rsiVal.toFixed(1),
    ma_fast: maFast !== null ? +maFast.toFixed(2) : null,
    ma_slow: maSlow !== null ? +maSlow.toFixed(2) : null,
    reason: reasonParts.length ? reasonParts.join(' | ') : 'No clear signal',
  };
}

// Generate simulated candles for a symbol (used when Dhan data unavailable)
function simulateCandles(sym, count = 100) {
  let price = BASE_LTP[sym];
  const candles = [];
  for (let i = 0; i < count; i++) {
    const change = (Math.random() - 0.48) * price * 0.005;
    const open = price;
    const close = +(price + change).toFixed(2);
    const high = +(Math.max(open, close) * (1 + Math.random() * 0.003)).toFixed(2);
    const low = +(Math.min(open, close) * (1 - Math.random() * 0.003)).toFixed(2);
    candles.push({ open, high, low, close, volume: Math.floor(Math.random() * 100000) });
    price = close;
  }
  return candles;
}

// Parse Dhan historical response into candle array
// Dhan returns: { open: [...], high: [...], low: [...], close: [...], volume: [...], timestamp: [...] }
// or nested under data.data
function parseDhanCandles(raw) {
  const data = raw?.data || raw || {};
  const opens   = data.open   || data.opens   || [];
  const highs   = data.high   || data.highs   || [];
  const lows    = data.low    || data.lows    || [];
  const closes  = data.close  || data.closes  || [];
  const volumes = data.volume || data.volumes || [];
  const candles = [];
  const len = closes.length;
  for (let i = 0; i < len; i++) {
    const c = +closes[i];
    if (!c || isNaN(c)) continue;
    candles.push({
      open:   +(opens[i]   || c),
      high:   +(highs[i]   || c),
      low:    +(lows[i]    || c),
      close:  c,
      volume: +(volumes[i] || 0),
    });
  }
  return candles;
}

module.exports = { SYMBOLS, BASE_LTP, computeSignal, simulateCandles, parseDhanCandles, calcRSI, calcSMA, calcEMA };
