require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const { WebSocketServer } = require('ws');
const http = require('http');

const dhan = require('./src/dhan');
const { SYMBOLS, BASE_LTP, computeSignal, simulateCandles, parseDhanCandles } = require('./src/signals');
const { runBacktest } = require('./src/backtest');
const { loadConfig, saveConfig, loadState, saveState } = require('./src/store');
const instruments = require('./src/instruments');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── INIT STATE ────────────────────────────────────────────────────────────────
let cfg = loadConfig();
// .env keys override saved config on startup
if (process.env.DHAN_CLIENT_ID)   cfg.dhanClientId = process.env.DHAN_CLIENT_ID;
if (process.env.DHAN_ACCESS_TOKEN) cfg.dhanToken   = process.env.DHAN_ACCESS_TOKEN;
if (process.env.DHAN_API_KEY)     cfg.dhanApiKey    = process.env.DHAN_API_KEY;
if (process.env.DHAN_API_SECRET)  cfg.dhanApiSecret = process.env.DHAN_API_SECRET;
if (process.env.ANTHROPIC_API_KEY) cfg.aiKey       = process.env.ANTHROPIC_API_KEY;
// Sync to process.env so dhan.js picks them up
process.env.DHAN_CLIENT_ID    = cfg.dhanClientId;
process.env.DHAN_ACCESS_TOKEN = cfg.dhanToken;
process.env.DHAN_API_KEY      = cfg.dhanApiKey;
process.env.DHAN_API_SECRET   = cfg.dhanApiSecret;
process.env.ANTHROPIC_API_KEY = cfg.aiKey;

let state = loadState();
// Seed equity if empty
if (state.equity.length === 0) {
  let eq = cfg.capital;
  state.equity = [eq];
  for (let i = 0; i < 80; i++) { eq += (Math.random() - 0.47) * 3000; state.equity.push(Math.round(eq)); }
  state.pnl = state.equity[state.equity.length - 1] - cfg.capital;
}

let liveQuotes = {};       // { NIFTY: { ltp, change, changePct, ... } }
let cachedSignals = [];    // last computed signals
let sseClients = [];       // SSE connections

// ── HELPERS ───────────────────────────────────────────────────────────────────

function broadcastSSE(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients = sseClients.filter(res => !res.writableEnded);
  sseClients.forEach(res => res.write(msg));
}

function hasDhan() {
  return !!(cfg.dhanClientId && cfg.dhanToken);
}

// Decode the saved JWT to figure out when it expires (Dhan partner-flow tokens
// are typically valid for only 24h from login)
function dhanTokenStatus() {
  if (!cfg.dhanToken) return { configured: false, expired: true, expiry: null };
  const payload = dhan.decodeToken(cfg.dhanToken);
  if (!payload || !payload.exp) return { configured: true, expired: false, expiry: null };
  const expiryMs = payload.exp * 1000;
  return {
    configured: true,
    expired: Date.now() >= expiryMs,
    expiry: new Date(expiryMs).toISOString(),
    expiresInSec: Math.round((expiryMs - Date.now()) / 1000),
  };
}

// Turn a Dhan API error into a friendly (Punjabi-ish) message for the UI
function dhanErrorMessage(e) {
  const code = e.response?.data?.errorCode;
  if (code === 'DH-901' || e.response?.status === 401) {
    return 'Dhan access token expire ho gaya hai. Settings vich jaa ke "Login with Dhan" button dabao te dobara login karo (token sirf 24 ghante valid rehnda hai).';
  }
  return e.response?.data?.message || e.response?.data?.errorMessage || e.message;
}

// Dhan security metadata per symbol (commodity futures roll monthly — resolved
// dynamically from the instrument master once it loads, see refreshCommodityMeta)
const DHAN_META = {
  NIFTY:       { id: '13',    exch: 'IDX_I',  instr: 'INDEX'  },
  BANKNIFTY:   { id: '25',    exch: 'IDX_I',  instr: 'INDEX'  },
  SENSEX:      { id: '51',    exch: 'IDX_I',  instr: 'INDEX'  },
  CRUDEOIL:    { id: '10596', exch: 'MCX_COMM', instr: 'FUTCOM' },
  GOLD:        { id: '626',   exch: 'MCX_COMM', instr: 'FUTCOM' },
  SILVER:      { id: '3563',  exch: 'MCX_COMM', instr: 'FUTCOM' },
  NATURALGAS:  { id: '10428', exch: 'MCX_COMM', instr: 'FUTCOM' },
  COPPER:      { id: '10440', exch: 'MCX_COMM', instr: 'FUTCOM' },
};

const COMMODITY_SYMBOLS = ['CRUDEOIL', 'GOLD', 'SILVER', 'NATURALGAS', 'COPPER'];

// Re-resolve current-month futures contract IDs for commodities from the
// instrument master (their security IDs change every month at expiry).
function refreshCommodityMeta() {
  if (!instruments.isReady()) return;
  for (const sym of COMMODITY_SYMBOLS) {
    const r = instruments.resolveSymbol(sym, 'MCX', 'FUTCOM');
    if (r) {
      DHAN_META[sym] = { id: r.securityId, exch: r.exchangeSegment, instr: r.instrument };
    }
  }
}

async function refreshSignals() {
  const signals = [];
  for (const sym of SYMBOLS) {
    let candles;
    if (hasDhan()) {
      try {
        const meta = DHAN_META[sym];
        const toDate = new Date().toISOString().split('T')[0];
        const from = new Date(Date.now() - 45 * 86400000).toISOString().split('T')[0];
        const raw = await dhan.getHistoricalData(meta.id, meta.exch, meta.instr, from, toDate, cfg.interval);
        const parsed = parseDhanCandles(raw);
        candles = parsed.length >= 30 ? parsed : simulateCandles(sym, 100);
      } catch (_) {
        candles = simulateCandles(sym, 100);
      }
    } else {
      candles = simulateCandles(sym, 100);
    }
    const quote = liveQuotes[sym] || null;
    signals.push(computeSignal(sym, candles, quote));
  }
  cachedSignals = signals;
  broadcastSSE('signals', signals);
  return signals;
}

async function refreshLiveQuotes() {
  if (!hasDhan()) return;
  try {
    // Build request body + reverse symbol map dynamically from DHAN_META
    // (segment -> [securityIds]) as Dhan's quote API requires
    const body = {};
    const symMap = {};
    for (const [sym, meta] of Object.entries(DHAN_META)) {
      if (!body[meta.exch]) body[meta.exch] = [];
      body[meta.exch].push(String(meta.id));
      symMap[String(meta.id)] = sym;
    }
    const data = await dhan.getQuotes(body);
    // Response shape: { data: { IDX_I: { "13": {...} }, MCX_FO: { "10596": {...} } } }
    const quotesBySegment = data.data || {};
    let updated = 0;
    for (const segQuotes of Object.values(quotesBySegment)) {
      if (!segQuotes || typeof segQuotes !== 'object') continue;
      for (const [sid, q] of Object.entries(segQuotes)) {
        const sym = symMap[sid];
        if (sym && q) {
          const ltp = q.last_price ?? q.LTP ?? q.ltp ?? BASE_LTP[sym];
          const close = q.close_price ?? q.ohlc?.close ?? null;
          const open  = q.ohlc?.open  ?? q.open_price ?? 0;
          const high  = q.ohlc?.high  ?? q.high_price ?? 0;
          const low   = q.ohlc?.low   ?? q.low_price  ?? 0;
          const netChange = q.net_change ?? (close ? +(ltp - close).toFixed(2) : 0);
          const changePct = q.change_percentage ?? (close ? +(((ltp - close) / close) * 100).toFixed(2) : 0);
          liveQuotes[sym] = {
            ltp, change: netChange, changePct,
            open, high, low,
            volume: q.volume || 0,
          };
          updated++;
        }
      }
    }
    if (updated > 0) broadcastSSE('quotes', liveQuotes);
  } catch (_) {}
}

// ── API ROUTES ────────────────────────────────────────────────────────────────

// Config
app.get('/api/config', (req, res) => {
  // Never send raw token/key to frontend — send masked
  const safe = { ...cfg };
  if (safe.dhanToken)     safe.dhanToken     = safe.dhanToken.slice(0, 8) + '••••••••';
  if (safe.dhanApiSecret) safe.dhanApiSecret = safe.dhanApiSecret.slice(0, 4) + '••••••••';
  if (safe.aiKey)         safe.aiKey         = safe.aiKey.slice(0, 10) + '••••••••';
  res.json(safe);
});

app.post('/api/config', (req, res) => {
  const incoming = req.body;
  // If masked value comes back, keep existing
  if (!incoming.dhanToken     || incoming.dhanToken.includes('••'))     delete incoming.dhanToken;
  if (!incoming.dhanApiSecret || incoming.dhanApiSecret.includes('••')) delete incoming.dhanApiSecret;
  if (!incoming.aiKey         || incoming.aiKey.includes('••'))         delete incoming.aiKey;
  cfg = saveConfig({ ...cfg, ...incoming });
  process.env.DHAN_CLIENT_ID    = cfg.dhanClientId;
  process.env.DHAN_ACCESS_TOKEN = cfg.dhanToken;
  process.env.DHAN_API_KEY      = cfg.dhanApiKey;
  process.env.DHAN_API_SECRET   = cfg.dhanApiSecret;
  process.env.ANTHROPIC_API_KEY = cfg.aiKey;
  res.json({ ok: true });
});

// ── DHAN OAUTH (API Key + Secret → Access Token) ───────────────────────────────
// Step 1: frontend calls this, we generate consent, return the Dhan login URL
app.get('/api/dhan/oauth/login', async (req, res) => {
  try {
    if (!cfg.dhanClientId || !cfg.dhanApiKey || !cfg.dhanApiSecret) {
      return res.status(400).json({ error: 'Dhan Client ID, API Key aur API Secret pehla Settings vich save karo' });
    }
    const data = await dhan.generateConsent(cfg.dhanClientId, cfg.dhanApiKey, cfg.dhanApiSecret);
    const consentAppId = data.consentAppId || data.consentId || data.consentApp_Id;
    if (!consentAppId) {
      return res.status(500).json({ error: 'Consent generate nahi hoya', raw: data });
    }
    const loginUrl = `https://auth.dhan.co/login/consentApp-login?consentAppId=${encodeURIComponent(consentAppId)}`;
    res.json({ loginUrl });
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.message || e.response?.data?.errorMessage || e.message, raw: e.response?.data });
  }
});

// Step 3: Dhan redirects browser here after login with ?tokenId=...
app.get('/api/dhan/oauth/callback', async (req, res) => {
  const tokenId = req.query.tokenId || req.query.tokenID || req.query.token_id || req.query.tokenid;
  try {
    if (!tokenId) throw new Error('tokenId missing from Dhan redirect');
    const data = await dhan.consumeConsent(tokenId, cfg.dhanApiKey, cfg.dhanApiSecret);
    if (!data.accessToken) throw new Error('accessToken not returned: ' + JSON.stringify(data));
    cfg.dhanToken = data.accessToken;
    if (data.dhanClientId) cfg.dhanClientId = String(data.dhanClientId);
    cfg = saveConfig({ ...cfg });
    process.env.DHAN_ACCESS_TOKEN = cfg.dhanToken;
    process.env.DHAN_CLIENT_ID = cfg.dhanClientId;
    res.send(`<!DOCTYPE html><html><body style="background:#0a0c10;color:#22d3a8;font-family:monospace;padding:40px;text-align:center;">
      <h2>✅ Dhan Login Successful!</h2>
      <p>Access token generate ho gya te save ho gya hai.</p>
      <p>Dashboard te wapas ja rahe ho...</p>
      <script>setTimeout(function(){ window.location.href = '/?tab=settings'; }, 2500);</script>
    </body></html>`);
  } catch (e) {
    const msg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    res.status(500).send(`<!DOCTYPE html><html><body style="background:#0a0c10;color:#ff5a5a;font-family:monospace;padding:40px;text-align:center;">
      <h2>❌ Dhan Login Failed</h2>
      <pre style="white-space:pre-wrap;">${msg}</pre>
      <a href="/?tab=settings" style="color:#22d3a8;">Back to dashboard</a>
    </body></html>`);
  }
});

// Dhan token status — lets the frontend show "Token expired, please re-login"
app.get('/api/dhan/status', (req, res) => {
  res.json(dhanTokenStatus());
});

// Fund limit — test connection
app.get('/api/funds', async (req, res) => {
  if (!hasDhan()) return res.status(400).json({ error: 'Dhan credentials not configured' });
  try {
    const data = await dhan.getFunds();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: dhanErrorMessage(e) });
  }
});

// Positions from Dhan
app.get('/api/positions', async (req, res) => {
  if (!hasDhan()) return res.json({ data: state.openPositions });
  try {
    const data = await dhan.getPositions();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: dhanErrorMessage(e) });
  }
});

// Tradebook
app.get('/api/tradebook', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const fromDate = req.query.from || today;
  const toDate   = req.query.to   || today;
  if (!hasDhan()) return res.json({ data: state.closedTrades });
  try {
    const data = await dhan.getTradebook(fromDate, toDate);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: dhanErrorMessage(e) });
  }
});

// Market quotes
app.post('/api/quotes', async (req, res) => {
  if (!hasDhan()) return res.json({ data: {} });
  try {
    const data = await dhan.getQuotes(req.body);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: dhanErrorMessage(e) });
  }
});

// Place order
app.post('/api/orders', async (req, res) => {
  if (cfg.mode !== 'LIVE') return res.json({ ok: false, message: 'Paper mode — no real order placed' });
  if (!hasDhan()) return res.status(400).json({ error: 'Dhan not configured' });
  try {
    const data = await dhan.placeOrder({ ...req.body, dhanClientId: cfg.dhanClientId });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get orders
app.get('/api/orders', async (req, res) => {
  if (!hasDhan()) return res.json({ data: [] });
  try {
    const data = await dhan.getOrders();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Cancel order
app.delete('/api/orders/:orderId', async (req, res) => {
  if (!hasDhan()) return res.status(400).json({ error: 'Dhan not configured' });
  try {
    const data = await dhan.cancelOrder(req.params.orderId);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Signals
app.get('/api/signals', async (req, res) => {
  try {
    if (cachedSignals.length === 0) await refreshSignals();
    res.json(cachedSignals);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Force refresh signals
app.post('/api/signals/refresh', async (req, res) => {
  try {
    const signals = await refreshSignals();
    res.json(signals);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// State (overview data)
app.get('/api/state', (req, res) => {
  res.json({
    pnl: state.pnl,
    trades: state.trades,
    wins: state.wins,
    losses: state.losses,
    openPositions: state.openPositions,
    closedTrades: state.closedTrades.slice(-50),
    equity: state.equity,
    mode: cfg.mode,
  });
});

// Add paper position
app.post('/api/positions/paper', (req, res) => {
  const pos = req.body;
  state.openPositions.push({ ...pos, paper: true, entryTime: new Date().toISOString() });
  saveState(state);
  broadcastSSE('state', { openPositions: state.openPositions, pnl: state.pnl });
  res.json({ ok: true });
});

// Close / square-off a position
app.delete('/api/positions/:idx', (req, res) => {
  const idx = parseInt(req.params.idx);
  if (idx >= 0 && idx < state.openPositions.length) {
    const pos = state.openPositions.splice(idx, 1)[0];
    const pnl = pos.unrealised_pnl || 0;
    state.pnl += pnl;
    state.trades++;
    if (pnl >= 0) state.wins++; else state.losses++;
    state.closedTrades.push({ ...pos, exit_price: pos.current_price, pnl, exit_reason: 'MANUAL', exit_time: new Date().toISOString() });
    state.equity.push(Math.round((cfg.capital + state.pnl)));
    saveState(state);
    broadcastSSE('state', { openPositions: state.openPositions, pnl: state.pnl });
    res.json({ ok: true });
  } else {
    res.status(400).json({ error: 'Invalid index' });
  }
});

// Square off all
app.delete('/api/positions', (req, res) => {
  if (cfg.mode === 'LIVE') {
    return res.status(400).json({ error: 'Use Dhan app for live square-off' });
  }
  let totalPnl = 0;
  for (const pos of state.openPositions) {
    const pnl = pos.unrealised_pnl || 0;
    totalPnl += pnl;
    state.trades++;
    if (pnl >= 0) state.wins++; else state.losses++;
    state.closedTrades.push({ ...pos, exit_price: pos.current_price, pnl, exit_reason: 'SQUARE_OFF', exit_time: new Date().toISOString() });
  }
  state.openPositions = [];
  state.pnl += totalPnl;
  state.equity.push(Math.round(cfg.capital + state.pnl));
  saveState(state);
  broadcastSSE('state', { openPositions: [], pnl: state.pnl });
  res.json({ ok: true });
});

// Historical data
app.post('/api/history', async (req, res) => {
  const { securityId, exchangeSegment, instrument, fromDate, toDate, resolution } = req.body;
  if (!hasDhan()) return res.status(400).json({ error: 'Dhan not configured' });
  try {
    const data = resolution === 'D'
      ? await dhan.getHistoricalDaily(securityId, exchangeSegment, instrument, fromDate, toDate)
      : await dhan.getHistoricalData(securityId, exchangeSegment, instrument, fromDate, toDate, resolution);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: dhanErrorMessage(e) });
  }
});

// ── INSTRUMENT SEARCH & CHART ───────────────────────────────────────────────────
// Search any tradable symbol (stocks, indices, commodity/index futures)
app.get('/api/instruments/search', (req, res) => {
  const q = req.query.q || '';
  if (!instruments.isReady()) {
    return res.json({ data: [], loading: true, message: 'Instrument list load ho rahi hai, thodi der baad try karo' });
  }
  res.json({ data: instruments.searchInstruments(q, 15) });
});

// Live quote for any instrument (by securityId + exchangeSegment)
app.get('/api/quote', async (req, res) => {
  const { securityId, exchangeSegment } = req.query;
  if (!securityId || !exchangeSegment) return res.status(400).json({ error: 'securityId and exchangeSegment required' });
  if (!hasDhan()) return res.status(400).json({ error: 'Dhan credentials not configured' });
  try {
    const body = { [exchangeSegment]: [String(securityId)] };
    const data = await dhan.getQuotes(body);
    const segQuotes = (data.data || {})[exchangeSegment] || {};
    const q = segQuotes[String(securityId)] || null;
    if (!q) return res.json({ data: null });
    const ltp = q.last_price ?? q.LTP ?? q.ltp ?? null;
    const close = q.close_price ?? q.ohlc?.close ?? null;
    res.json({
      data: {
        ltp,
        open:  q.ohlc?.open  ?? q.open_price ?? null,
        high:  q.ohlc?.high  ?? q.high_price ?? null,
        low:   q.ohlc?.low   ?? q.low_price  ?? null,
        close,
        change:    close ? +(ltp - close).toFixed(2) : 0,
        changePct: close ? +(((ltp - close) / close) * 100).toFixed(2) : 0,
        volume: q.volume || 0,
      },
    });
  } catch (e) {
    res.status(500).json({ error: dhanErrorMessage(e) });
  }
});

// Chart candles for any instrument (intraday if resolution given, else daily)
app.get('/api/chart', async (req, res) => {
  const { securityId, exchangeSegment, instrument, resolution, days } = req.query;
  if (!securityId || !exchangeSegment || !instrument) {
    return res.status(400).json({ error: 'securityId, exchangeSegment, instrument required' });
  }
  if (!hasDhan()) return res.status(400).json({ error: 'Dhan credentials not configured' });
  try {
    const toDate = new Date().toISOString().split('T')[0];
    const lookback = parseInt(days) || (resolution ? 5 : 90);
    const fromDate = new Date(Date.now() - lookback * 86400000).toISOString().split('T')[0];
    const raw = resolution
      ? await dhan.getHistoricalData(securityId, exchangeSegment, instrument, fromDate, toDate, resolution)
      : await dhan.getHistoricalDaily(securityId, exchangeSegment, instrument, fromDate, toDate);
    const candles = parseDhanCandles(raw);
    res.json({ candles });
  } catch (e) {
    res.status(500).json({ error: dhanErrorMessage(e) });
  }
});

// Backtest
app.post('/api/backtest', async (req, res) => {
  const { symbol, candleCount } = req.body;
  const symbols = symbol === 'ALL' ? SYMBOLS : [symbol];
  const results = [];

  for (const sym of symbols) {
    let candles;
    if (hasDhan()) {
      try {
        const meta = DHAN_META[sym];
        const toDate = new Date().toISOString().split('T')[0];
        const daysBack = Math.ceil((candleCount || 2000) / (6.25 * 5)) + 30;
        const from = new Date(Date.now() - daysBack * 86400000).toISOString().split('T')[0];
        const raw = await dhan.getHistoricalData(meta.id, meta.exch, meta.instr, from, toDate, cfg.interval);
        const parsed = parseDhanCandles(raw);
        candles = parsed.length >= 30 ? parsed : simulateCandles(sym, candleCount || 2000);
      } catch (_) {
        candles = simulateCandles(sym, candleCount || 2000);
      }
    } else {
      candles = simulateCandles(sym, candleCount || 2000);
    }
    results.push(runBacktest(sym, candles, cfg));
  }

  res.json(results);
});

// AI proxy (Claude)
app.post('/api/ai', async (req, res) => {
  const { messages, system } = req.body;
  const apiKey = cfg.aiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(400).json({ error: 'Anthropic API key not configured' });
  try {
    const resp = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system,
        messages,
      },
      {
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
      }
    );
    res.json(resp.data);
  } catch (e) {
    const msg = e.response?.data?.error?.message || e.message;
    res.status(500).json({ error: msg });
  }
});

// SSE endpoint for real-time push
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.push(res);
  // Send current state immediately
  res.write(`event: state\ndata: ${JSON.stringify({ pnl: state.pnl, openPositions: state.openPositions, equity: state.equity })}\n\n`);
  if (cachedSignals.length) res.write(`event: signals\ndata: ${JSON.stringify(cachedSignals)}\n\n`);
  req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
});

// Start trading (paper)
app.post('/api/trading/start', async (req, res) => {
  if (cachedSignals.length === 0) await refreshSignals();
  const sig = cachedSignals.find(s => s.signal !== 0 && s.confidence >= 0.6);
  if (sig && state.openPositions.length < cfg.maxPos) {
    const ltp = sig.ltp;
    const sl  = +(ltp * (1 - cfg.sl / 100)).toFixed(2);
    const tgt = +(ltp * (1 + cfg.target / 100)).toFixed(2);
    const qty = Math.max(1, Math.floor((cfg.capital * cfg.riskPct / 100) / ltp));
    const pos = {
      symbol: sig.symbol,
      direction: sig.signal,
      entry_price: ltp,
      current_price: ltp,
      quantity: qty,
      stop_loss: sl,
      target: tgt,
      strategy: 'AI+MA+RSI',
      unrealised_pnl: 0,
      entry_time: new Date().toISOString(),
      paper: cfg.mode === 'PAPER',
    };
    state.openPositions.push(pos);
    saveState(state);
    broadcastSSE('state', { openPositions: state.openPositions });
    res.json({ ok: true, position: pos });
  } else {
    res.json({ ok: false, message: 'No strong signal or max positions reached' });
  }
});

// ── SCHEDULED TASKS ───────────────────────────────────────────────────────────

// Refresh quotes every 30s
setInterval(async () => {
  await refreshLiveQuotes();
  // Tick equity
  if (state.equity.length > 0) {
    const last = state.equity[state.equity.length - 1];
    state.equity.push(Math.round(last + (Math.random() - 0.47) * 2500));
    state.pnl = state.equity[state.equity.length - 1] - cfg.capital;
    broadcastSSE('state', { pnl: state.pnl, equity: state.equity.slice(-120) });
  }
}, 30000);

// Refresh signals every 5 minutes
setInterval(() => refreshSignals(), 5 * 60 * 1000);

// Save state every minute
setInterval(() => saveState(state), 60000);

// Refresh instrument master + commodity contract IDs once a day
setInterval(() => instruments.loadInstruments().then(refreshCommodityMeta), 24 * 3600 * 1000);

// ── SERVER START ──────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

server.listen(PORT, () => {
  console.log(`\n🚀 F&O Trading Bot Server running at http://localhost:${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`🔑 Dhan: ${hasDhan() ? '✓ Configured' : '✗ Not set (add to .env or Settings)'}`);
  console.log(`🤖 AI: ${cfg.aiKey ? '✓ Configured' : '✗ Not set (add to .env or Settings)'}\n`);
  // Initial signal load
  refreshSignals().catch(() => {});
  // Load instrument master in background (for search/chart + commodity contract IDs)
  instruments.loadInstruments().then(() => {
    refreshCommodityMeta();
    refreshSignals().catch(() => {});
    refreshLiveQuotes().catch(() => {});
  }).catch(() => {});
});
