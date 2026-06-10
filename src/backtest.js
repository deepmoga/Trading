// Backtesting engine — runs MA/RSI/Breakout strategies on historical candle data
const { computeSignal, simulateCandles, parseDhanCandles, BASE_LTP } = require('./signals');

function runBacktest(sym, candles, config = {}) {
  const sl = config.sl || 1.5;
  const target = config.target || 3.0;
  const capital = config.capital || 500000;
  const riskPct = config.riskPct || 1;

  const trades = [];
  let openTrade = null;
  let equity = capital;
  const equityCurve = [capital];

  // Need at least 25 candles for indicators
  const minIdx = 25;

  for (let i = minIdx; i < candles.length; i++) {
    const window = candles.slice(0, i + 1);
    const sig = computeSignal(sym, window, null);
    const ltp = candles[i].close;

    if (openTrade) {
      const pnlPct = openTrade.direction === 1
        ? ((ltp - openTrade.entry) / openTrade.entry) * 100
        : ((openTrade.entry - ltp) / openTrade.entry) * 100;

      let exitReason = null;
      if (pnlPct <= -sl) exitReason = 'STOP_LOSS';
      else if (pnlPct >= target) exitReason = 'TARGET';
      else if (sig.signal !== 0 && sig.signal !== openTrade.direction) exitReason = 'SIGNAL_FLIP';

      if (exitReason) {
        const pnl = (pnlPct / 100) * openTrade.capital;
        equity += pnl;
        trades.push({
          symbol: sym,
          direction: openTrade.direction,
          entry: openTrade.entry,
          exit: ltp,
          entryIdx: openTrade.idx,
          exitIdx: i,
          pnl: +pnl.toFixed(2),
          pnlPct: +pnlPct.toFixed(2),
          exitReason,
        });
        openTrade = null;
        equityCurve.push(+equity.toFixed(2));
      }
    } else if (sig.signal !== 0 && sig.confidence >= 0.6) {
      const tradeCapital = capital * riskPct / 100 * (sl / 100) * (1 / (sl / 100));
      openTrade = {
        direction: sig.signal,
        entry: ltp,
        idx: i,
        capital: Math.min(tradeCapital, capital * 0.2),
      };
    }
  }

  // Close any open trade at end
  if (openTrade) {
    const ltp = candles[candles.length - 1].close;
    const pnlPct = openTrade.direction === 1
      ? ((ltp - openTrade.entry) / openTrade.entry) * 100
      : ((openTrade.entry - ltp) / openTrade.entry) * 100;
    const pnl = (pnlPct / 100) * openTrade.capital;
    equity += pnl;
    trades.push({
      symbol: sym, direction: openTrade.direction,
      entry: openTrade.entry, exit: ltp,
      pnl: +pnl.toFixed(2), pnlPct: +pnlPct.toFixed(2),
      exitReason: 'END_OF_DATA',
    });
    equityCurve.push(+equity.toFixed(2));
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
  const profitFactor = avgLoss > 0 ? (wins.length * avgWin) / (losses.length * avgLoss) : wins.length > 0 ? 99 : 0;

  // Max drawdown
  let peak = capital;
  let maxDD = 0;
  for (const eq of equityCurve) {
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  // Sharpe (simplified, annualized)
  const returns = [];
  for (let i = 1; i < equityCurve.length; i++) {
    returns.push((equityCurve[i] - equityCurve[i - 1]) / equityCurve[i - 1]);
  }
  const meanR = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const stdR = returns.length > 1
    ? Math.sqrt(returns.reduce((s, r) => s + Math.pow(r - meanR, 2), 0) / returns.length)
    : 1;
  const sharpe = stdR > 0 ? (meanR / stdR) * Math.sqrt(252) : 0;

  return {
    symbol: sym,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? +(wins.length / trades.length).toFixed(3) : 0,
    totalPnl: +totalPnl.toFixed(2),
    avgWin: +avgWin.toFixed(2),
    avgLoss: +avgLoss.toFixed(2),
    profitFactor: +profitFactor.toFixed(2),
    maxDrawdown: +maxDD.toFixed(4),
    sharpe: +sharpe.toFixed(2),
    equityCurve: equityCurve.slice(0, 60),
    trades: trades.slice(-20),
  };
}

module.exports = { runBacktest };
