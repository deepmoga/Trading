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

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── INIT STATE ────────────────────────────────────────────────────────────────
let cfg = loadConfig();
// .env keys override saved config on startup
if (process.env.DHAN_CLIENT_ID)   cfg.dhanClientId = process.env.DHAN_CLIENT_ID;
if (process.env.DHAN_ACCESS_TOKEN) cfg.dhanToken   = process.env.DHAN_ACCESS_TOKEN;
if (process.env.ANTHROPIC_API_KEY) cfg.aiKey       = process.env.ANTHROPIC_API_KEY;
// Sync to process.env so dhan.js picks them up
process.env.DHAN_CLIENT_ID    = cfg.dhanClientId;
process.env.DHAN_ACCESS_TOKEN = cfg.dhanToken;
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

// Dhan security metadata per symbol
const DHAN_META = {
  NIFTY:       { id: '13',    exch: 'IDX_I',  instr: 'INDEX'  },
  BANKNIFTY:   { id: '25',    exch: 'IDX_I',  instr: 'INDEX'  },
  SENSEX:      { id: '51',    exch: 'IDX_I',  instr: 'INDEX'  },
  CRUDEOIL:    { id: '10596', exch: 'MCX_FO', instr: 'FUTCOM' },
  GOLD:        { id: '626',   exch: 'MCX_FO', instr: 'FUTCOM' },
  SILVER:      { id: '3563',  exch: 'MCX_FO', instr: 'FUTCOM' },
  NATURALGAS:  { id: '10428', exch: 'MCX_FO', instr: 'FUTCOM' },
  COPPER:      { id: '10440', exch: 'MCX_FO', instr: 'FUTCOM' },
};

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
    // Separate by exchange segment as Dhan API requires
    const body = {
      IDX_I:  ['13', '25', '51'],
      MCX_FO: ['10596', '626', '3563', '10428', '10440'],
    };
    const data = await dhan.getQuotes(body);
    const quotes = data.data || {};
    const symMap = {
      '13':'NIFTY','25':'BANKNIFTY','51':'SENSEX',
      '10596':'CRUDEOIL','626':'GOLD','3563':'SILVER','10428':'NATURALGAS','10440':'COPPER',
    };
    let updated = 0;
    for (const [sid, q] of Object.entries(quotes)) {
      const sym = symMap[sid];
      if (sym && q) {
        liveQuotes[sym] = {
          ltp:       q.last_price || q.ltp || BASE_LTP[sym],
          change:    q.net_change || 0,
          changePct: q.change_percentage || 0,
          open:      q.open_price || 0,
          high:      q.high_price || 0,
          low:       q.low_price  || 0,
          volume:    q.volume     || 0,
        };
        updated++;
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
  if (safe.dhanToken) safe.dhanToken = safe.dhanToken.slice(0, 8) + '••••••••';
  if (safe.aiKey)    safe.aiKey    = safe.aiKey.slice(0, 10) + '••••••••';
  res.json(safe);
});

app.post('/api/config', (req, res) => {
  const incoming = req.body;
  // If masked value comes back, keep existing
  if (!incoming.dhanToken || incoming.dhanToken.includes('••')) delete incoming.dhanToken;
  if (!incoming.aiKey    || incoming.aiKey.includes('••'))    delete incoming.aiKey;
  cfg = saveConfig({ ...cfg, ...incoming });
  process.env.DHAN_CLIENT_ID    = cfg.dhanClientId;
  process.env.DHAN_ACCESS_TOKEN = cfg.dhanToken;
  process.env.ANTHROPIC_API_KEY = cfg.aiKey;
  res.json({ ok: true });
});

// Fund limit — test connection
app.get('/api/funds', async (req, res) => {
  if (!hasDhan()) return res.status(400).json({ error: 'Dhan credentials not configured' });
  try {
    const data = await dhan.getFunds();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Positions from Dhan
app.get('/api/positions', async (req, res) => {
  if (!hasDhan()) return res.json({ data: state.openPositions });
  try {
    const data = await dhan.getPositions();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
  }
});

// Market quotes
app.post('/api/quotes', async (req, res) => {
  if (!hasDhan()) return res.json({ data: {} });
  try {
    const data = await dhan.getQuotes(req.body);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
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
    res.status(500).json({ error: e.message });
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
});
