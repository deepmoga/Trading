// Dhan Instrument Master — lets users search ANY tradable symbol (stocks, indices,
// futures, commodities) and resolve its securityId / exchangeSegment / instrument
// type for charting & quotes.
// Docs: https://dhanhq.co/docs/v2/instruments/

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CSV_URL = 'https://images.dhan.co/api-data/api-scrip-master.csv';
const CACHE_FILE = path.join(__dirname, '..', 'data', 'scrip-master.csv');
const REFRESH_MS = 24 * 3600 * 1000; // refresh once a day

// Maps SEM_EXM_EXCH_ID + SEM_SEGMENT -> Dhan API exchangeSegment string
const SEGMENT_MAP = {
  'NSE_I': 'IDX_I',
  'BSE_I': 'IDX_I',
  'NSE_E': 'NSE_EQ',
  'BSE_E': 'BSE_EQ',
  'NSE_D': 'NSE_FNO',
  'BSE_D': 'BSE_FNO',
  'MCX_M': 'MCX_FO',
  'NSE_C': 'NSE_CURRENCY',
  'BSE_C': 'BSE_CURRENCY',
};

// Instrument types we can meaningfully chart
const CHARTABLE = new Set(['INDEX', 'EQUITY', 'FUTCOM', 'FUTIDX', 'FUTSTK']);

let instruments = [];
let loading = false;
let loadedAt = 0;

function toExchangeSegment(exch, seg) {
  return SEGMENT_MAP[`${exch}_${seg}`] || null;
}

// Minimal CSV line splitter (handles simple quoted fields if present)
function splitCSVLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === ',' && !inQuotes) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function parseCSV(text) {
  const lines = text.split('\n');
  if (!lines.length) return [];
  const headers = splitCSVLine(lines[0]).map(h => h.trim());
  const idx = {};
  headers.forEach((h, i) => { idx[h] = i; });
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const cols = splitCSVLine(line);
    if (cols.length < headers.length - 2) continue;
    const exch = cols[idx['SEM_EXM_EXCH_ID']];
    const seg = cols[idx['SEM_SEGMENT']];
    const instrumentName = cols[idx['SEM_INSTRUMENT_NAME']];
    if (!CHARTABLE.has(instrumentName)) continue;
    const exchangeSegment = toExchangeSegment(exch, seg);
    if (!exchangeSegment) continue;
    out.push({
      exch,
      seg,
      securityId: cols[idx['SEM_SMST_SECURITY_ID']],
      instrument: instrumentName,
      expiryDate: cols[idx['SEM_EXPIRY_DATE']],
      tradingSymbol: cols[idx['SEM_TRADING_SYMBOL']],
      customSymbol: cols[idx['SEM_CUSTOM_SYMBOL']],
      symbolName: cols[idx['SM_SYMBOL_NAME']] || cols[idx['SEM_TRADING_SYMBOL']],
      exchangeSegment,
    });
  }
  return out;
}

function expiryTime(r) {
  if (!r.expiryDate || r.expiryDate.startsWith('0001-01-01')) return 0;
  const t = new Date(r.expiryDate).getTime();
  return isNaN(t) ? 0 : t;
}

async function loadInstruments(force = false) {
  if (loading) return;
  if (!force && instruments.length && Date.now() - loadedAt < REFRESH_MS) return;
  loading = true;
  try {
    let text;
    // Use cached file if fresh enough and not forced
    if (!force && fs.existsSync(CACHE_FILE)) {
      const stat = fs.statSync(CACHE_FILE);
      if (Date.now() - stat.mtimeMs < REFRESH_MS) {
        text = fs.readFileSync(CACHE_FILE, 'utf8');
      }
    }
    if (!text) {
      const res = await axios.get(CSV_URL, { timeout: 60000, responseType: 'text' });
      text = res.data;
      try {
        if (!fs.existsSync(path.dirname(CACHE_FILE))) fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
        fs.writeFileSync(CACHE_FILE, text);
      } catch (_) {}
    }
    instruments = parseCSV(text);
    loadedAt = Date.now();
    console.log(`[instruments] loaded ${instruments.length} chartable instruments`);
  } catch (e) {
    console.error('[instruments] load failed:', e.message);
    // fall back to stale cache file if we have nothing
    if (!instruments.length && fs.existsSync(CACHE_FILE)) {
      try {
        instruments = parseCSV(fs.readFileSync(CACHE_FILE, 'utf8'));
        loadedAt = Date.now();
      } catch (_) {}
    }
  } finally {
    loading = false;
  }
}

// Search by symbol name / trading symbol / display name.
// For futures (FUTCOM/FUTIDX/FUTSTK) with multiple expiries, returns only the
// nearest non-expired contract per underlying symbol.
function searchInstruments(query, limit = 15) {
  const q = (query || '').trim().toUpperCase();
  if (!q || !instruments.length) return [];
  const now = Date.now() - 86400000; // allow today's expiry
  const groups = new Map();
  for (const r of instruments) {
    const hay = `${r.symbolName} ${r.tradingSymbol} ${r.customSymbol}`.toUpperCase();
    if (!hay.includes(q)) continue;
    const et = expiryTime(r);
    if (et && et < now) continue; // skip expired contracts
    const key = `${r.symbolName}|${r.instrument}|${r.exch}`;
    const eff = et || Infinity;
    const cur = groups.get(key);
    if (!cur || eff < cur._eff) groups.set(key, { ...r, _eff: eff });
  }
  const results = Array.from(groups.values())
    // prefer exact / startswith matches first
    .sort((a, b) => {
      const an = a.symbolName.toUpperCase(), bn = b.symbolName.toUpperCase();
      const aScore = an === q ? 0 : an.startsWith(q) ? 1 : 2;
      const bScore = bn === q ? 0 : bn.startsWith(q) ? 1 : 2;
      if (aScore !== bScore) return aScore - bScore;
      return an.localeCompare(bn);
    })
    .slice(0, limit)
    .map(r => ({
      symbol: r.symbolName,
      name: r.customSymbol || r.tradingSymbol,
      tradingSymbol: r.tradingSymbol,
      securityId: r.securityId,
      exchangeSegment: r.exchangeSegment,
      instrument: r.instrument,
      expiry: r.expiryDate && !r.expiryDate.startsWith('0001-01-01') ? r.expiryDate.slice(0, 10) : null,
    }));
  return results;
}

// Resolve the nearest non-expired contract for a given underlying symbol
// (used to auto-resolve commodity futures security IDs which roll every month)
function resolveSymbol(symbolName, exch, instrument) {
  if (!instruments.length) return null;
  const now = Date.now() - 86400000;
  let best = null;
  for (const r of instruments) {
    if (r.symbolName !== symbolName || r.exch !== exch || r.instrument !== instrument) continue;
    const et = expiryTime(r);
    if (et && et < now) continue;
    const eff = et || Infinity;
    if (!best || eff < best._eff) best = { ...r, _eff: eff };
  }
  if (!best) return null;
  return {
    securityId: best.securityId,
    exchangeSegment: best.exchangeSegment,
    instrument: best.instrument,
    expiry: best.expiryDate && !best.expiryDate.startsWith('0001-01-01') ? best.expiryDate.slice(0, 10) : null,
  };
}

function isReady() {
  return instruments.length > 0;
}

module.exports = { loadInstruments, searchInstruments, resolveSymbol, isReady };
