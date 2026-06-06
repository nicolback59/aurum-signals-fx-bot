/**
 * Backtest reporter — turns simulated trades into aggregate statistics:
 * win rate, profit factor, max drawdown, average R and per-setup breakdown.
 */

import type { SimulatedTrade } from './backtestEngine';
import type {
  BacktestPeriod,
  BacktestResult,
  BacktestSetupStats,
} from '../types';
import type { SignalType } from '../engine/signalEngine';

const SETUPS: SignalType[] = [
  'CONTINUATION_PULLBACK',
  'VWAP_RECLAIM',
  'SWEEP_REVERSAL',
  'COMPRESSION_BREAKOUT',
];

export function buildReport(
  period: BacktestPeriod,
  trades: SimulatedTrade[],
): BacktestResult {
  const wins = trades.filter((t) => t.outcome === 'WIN').length;
  const losses = trades.filter((t) => t.outcome === 'LOSS').length;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgR = trades.length ? trades.reduce((s, t) => s + t.pnlR, 0) / trades.length : 0;

  const grossProfit = trades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  const maxDrawdown = computeMaxDrawdown(trades);

  const bySetup: BacktestSetupStats[] = SETUPS.map((setup) => {
    const subset = trades.filter((t) => t.signal.signalType === setup);
    const sWins = subset.filter((t) => t.outcome === 'WIN').length;
    const sPnl = subset.reduce((s, t) => s + t.pnl, 0);
    const sAvgR = subset.length ? subset.reduce((s, t) => s + t.pnlR, 0) / subset.length : 0;
    return {
      setup,
      trades: subset.length,
      wins: sWins,
      winRate: subset.length ? sWins / subset.length : 0,
      netPnl: sPnl,
      avgR: sAvgR,
    };
  }).filter((s) => s.trades > 0);

  return {
    period,
    trades: trades.length,
    wins,
    losses,
    winRate: trades.length ? wins / trades.length : 0,
    profitFactor,
    maxDrawdown,
    avgR,
    totalPnl,
    bySetup,
  };
}

function computeMaxDrawdown(trades: SimulatedTrade[]): number {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of trades) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}
