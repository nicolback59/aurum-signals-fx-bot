/**
 * Backtest engine — replays historical bars through the SAME signal engine the
 * live bot uses (evaluateForBot) and simulates execution with the fixed risk
 * model. Whether a trade wins or loses is decided by which level (target/stop)
 * the subsequent bars touch first.
 *
 * Runnable standalone: `ts-node src/backtest/backtestEngine.ts <days>`.
 */

import { evaluateForBot } from '../engine/signalEngine';
import { calcRiskModel, calcPnl, calcPnlR } from '../risk/riskEngine';
import { buildReport } from './backtestReporter';
import type { OHLCV, Signal } from '../engine/signalEngine';
import type { BacktestPeriod, BacktestResult } from '../types';

export interface BacktestBars {
  mnq1m: OHLCV[];
  mnq5m: OHLCV[];
  es5m: OHLCV[];
  nq1m: OHLCV[];
}

export interface SimulatedTrade {
  signal: Signal;
  entry: number;
  stop: number;
  target: number;
  contracts: number;
  riskDollars: number;
  pnl: number;
  pnlR: number;
  outcome: 'WIN' | 'LOSS' | 'OPEN';
}

const WARMUP = 60;
const MAX_HOLD_BARS = 120; // 1m bars ≈ 2h max hold

function toMs(ts: number | string | Date): number {
  if (typeof ts === 'number') return ts;
  if (ts instanceof Date) return ts.getTime();
  return new Date(ts).getTime();
}

/**
 * Slices the 5m / breadth series up to the same wall-clock time as the MNQ
 * cursor so the engine sees only data available at that moment.
 */
function sliceUpTo(series: OHLCV[], cutoffMs: number): OHLCV[] {
  const out: OHLCV[] = [];
  for (const b of series) {
    if (toMs(b.timestamp) <= cutoffMs) out.push(b);
    else break;
  }
  return out;
}

/**
 * Walks forward from the entry bar to decide the outcome: which of stop/target
 * the price reaches first. Returns the exit price.
 */
function resolveOutcome(
  bars: OHLCV[],
  startIdx: number,
  direction: Signal['direction'],
  stop: number,
  target: number,
): { exit: number; outcome: 'WIN' | 'LOSS' | 'OPEN' } {
  const end = Math.min(bars.length, startIdx + MAX_HOLD_BARS);
  for (let i = startIdx + 1; i < end; i++) {
    const b = bars[i];
    if (direction === 'LONG') {
      const hitStop = b.low <= stop;
      const hitTarget = b.high >= target;
      if (hitStop && hitTarget) return { exit: stop, outcome: 'LOSS' }; // conservative
      if (hitStop) return { exit: stop, outcome: 'LOSS' };
      if (hitTarget) return { exit: target, outcome: 'WIN' };
    } else {
      const hitStop = b.high >= stop;
      const hitTarget = b.low <= target;
      if (hitStop && hitTarget) return { exit: stop, outcome: 'LOSS' };
      if (hitStop) return { exit: stop, outcome: 'LOSS' };
      if (hitTarget) return { exit: target, outcome: 'WIN' };
    }
  }
  const lastClose = bars[Math.min(end, bars.length) - 1].close;
  return { exit: lastClose, outcome: 'OPEN' };
}

export function runBacktest(
  period: BacktestPeriod,
  bars: BacktestBars,
): BacktestResult {
  const trades: SimulatedTrade[] = [];
  const mnq = bars.mnq1m;
  const recentFingerprints: Array<{ fingerprint: string; ts: number }> = [];
  let cooldownUntil = 0;

  for (let i = WARMUP; i < mnq.length; i++) {
    const cursor = mnq[i];
    const cursorMs = toMs(cursor.timestamp);
    if (cursorMs < cooldownUntil) continue;

    const window1m = mnq.slice(Math.max(0, i - 300), i + 1);
    const mnq5m = sliceUpTo(bars.mnq5m, cursorMs);
    const es5m = sliceUpTo(bars.es5m, cursorMs);
    const nq1m = sliceUpTo(bars.nq1m, cursorMs);

    const result = evaluateForBot({
      instrument: 'MNQ',
      bars: window1m,
      bars5m: mnq5m,
      esBars: es5m,
      es5mBars: es5m,
      nqBars: nq1m,
      timestamp: new Date(cursorMs),
    });

    if (!result.botTradable || !result.signal) continue;

    const signal = result.signal;

    // Dedup fingerprint, 15-min cooldown — mirrors live safety rule.
    const dup = recentFingerprints.some(
      (f) => f.fingerprint === signal.fingerprint && cursorMs - f.ts < 15 * 60 * 1000,
    );
    if (dup) continue;
    recentFingerprints.push({ fingerprint: signal.fingerprint, ts: cursorMs });

    const risk = calcRiskModel(signal.entry, signal.sl, signal.direction);
    if (!risk.valid) continue;

    const { exit, outcome } = resolveOutcome(
      mnq,
      i,
      signal.direction,
      risk.stop,
      risk.target,
    );
    const pnl = calcPnl(risk.entry, exit, risk.contracts, signal.direction);
    const pnlR = calcPnlR(pnl, risk.riskDollars);

    trades.push({
      signal,
      entry: risk.entry,
      stop: risk.stop,
      target: risk.target,
      contracts: risk.contracts,
      riskDollars: risk.riskDollars,
      pnl,
      pnlR,
      outcome: outcome === 'OPEN' ? (pnl >= 0 ? 'WIN' : 'LOSS') : outcome,
    });

    cooldownUntil = cursorMs + 15 * 60 * 1000;
  }

  return buildReport(period, trades);
}

// ── Standalone runner ──────────────────────────────────────────────────────────

if (require.main === module) {
  const days = Number(process.argv[2] ?? 90) as BacktestPeriod;
  // Standalone mode expects bars wired by an external data loader; this stub
  // documents the contract and prints an empty report when run without data.
  const empty: BacktestBars = { mnq1m: [], mnq5m: [], es5m: [], nq1m: [] };
  const report = runBacktest(days, empty);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));
}
