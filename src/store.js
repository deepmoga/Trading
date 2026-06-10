const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

const defaultConfig = {
  dhanClientId: '',
  dhanToken: '',
  aiKey: '',
  aiStyle: 'moderate',
  capital: 500000,
  riskPct: 1,
  maxLoss: 15000,
  maxPos: 3,
  sl: 1.5,
  target: 3.0,
  interval: 5,
  useMA: true,
  useRSI: true,
  useBreakout: true,
  useAIFilter: true,
  autoExec: false,
  mode: 'PAPER',
};

const defaultState = {
  pnl: 0,
  trades: 0,
  wins: 0,
  losses: 0,
  openPositions: [],
  closedTrades: [],
  equity: [],
};

function loadConfig() {
  ensureDir();
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      return { ...defaultConfig, ...saved };
    }
  } catch (_) {}
  return { ...defaultConfig };
}

function saveConfig(cfg) {
  ensureDir();
  // Merge env vars as fallback (server-side keys take priority)
  if (process.env.DHAN_CLIENT_ID) cfg.dhanClientId = process.env.DHAN_CLIENT_ID;
  if (process.env.DHAN_ACCESS_TOKEN) cfg.dhanToken = process.env.DHAN_ACCESS_TOKEN;
  if (process.env.ANTHROPIC_API_KEY) cfg.aiKey = process.env.ANTHROPIC_API_KEY;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  // Sync to process.env for Dhan/AI clients
  if (cfg.dhanClientId) process.env.DHAN_CLIENT_ID = cfg.dhanClientId;
  if (cfg.dhanToken) process.env.DHAN_ACCESS_TOKEN = cfg.dhanToken;
  if (cfg.aiKey) process.env.ANTHROPIC_API_KEY = cfg.aiKey;
  return cfg;
}

function loadState() {
  ensureDir();
  try {
    if (fs.existsSync(STATE_FILE)) {
      const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      return { ...defaultState, ...saved };
    }
  } catch (_) {}
  return { ...defaultState };
}

function saveState(state) {
  ensureDir();
  // Keep equity curve to last 200 points
  if (state.equity && state.equity.length > 200) {
    state.equity = state.equity.slice(-200);
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

module.exports = { loadConfig, saveConfig, loadState, saveState };
