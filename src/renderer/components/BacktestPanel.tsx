import { useState } from "react";
import type { BacktestPeriod, BacktestResult } from '../../types';

const PERIODS: BacktestPeriod[] = [90, 180, 365];

export function BacktestPanel(): JSX.Element {
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [running, setRunning] = useState(false);
  const [period, setPeriod] = useState<BacktestPeriod>(90);

  const run = async (p: BacktestPeriod): Promise<void> => {
    setRunning(true);
    setPeriod(p);
    try {
      setResult(await window.aurum.runBacktest(p));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div>
      <div className="card">
        <h3>Backtest</h3>
        <div className="backtest-controls">
          {PERIODS.map((p) => (
            <button
              key={p}
              className={`btn ${period === p ? 'btn-start' : ''}`}
              onClick={() => void run(p)}
              disabled={running}
            >
              {p} Days
            </button>
          ))}
        </div>
        {running && <div className="label">Running backtest…</div>}
      </div>

      {result && (
        <>
          <div className="card">
            <h3>Results — {result.period} Day</h3>
            <div className="grid-3">
              <div className="metric">
                <div className="value">{result.trades}</div>
                <div className="name">Trades</div>
              </div>
              <div className="metric">
                <div className="value">{(result.winRate * 100).toFixed(1)}%</div>
                <div className="name">Win Rate</div>
              </div>
              <div className="metric">
                <div className="value">
                  {result.profitFactor === Infinity ? '∞' : result.profitFactor.toFixed(2)}
                </div>
                <div className="name">Profit Factor</div>
              </div>
              <div className="metric">
                <div className="value">{result.avgR.toFixed(2)}R</div>
                <div className="name">Avg R</div>
              </div>
              <div className="metric">
                <div className="value neg">${result.maxDrawdown.toFixed(0)}</div>
                <div className="name">Max Drawdown</div>
              </div>
              <div className="metric">
                <div className={`value ${result.totalPnl >= 0 ? 'pos' : 'neg'}`}>
                  ${result.totalPnl.toFixed(0)}
                </div>
                <div className="name">Total P&amp;L</div>
              </div>
            </div>
          </div>

          <div className="card">
            <h3>By Setup</h3>
            {result.bySetup.length === 0 ? (
              <div className="empty">No setups triggered in this window</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Setup</th>
                    <th>Trades</th>
                    <th>Wins</th>
                    <th>Win Rate</th>
                    <th>Avg R</th>
                    <th>Net P&amp;L</th>
                  </tr>
                </thead>
                <tbody>
                  {result.bySetup.map((s) => (
                    <tr key={s.setup}>
                      <td>{s.setup}</td>
                      <td>{s.trades}</td>
                      <td>{s.wins}</td>
                      <td>{(s.winRate * 100).toFixed(1)}%</td>
                      <td>{s.avgR.toFixed(2)}R</td>
                      <td className={s.netPnl >= 0 ? 'pos' : 'neg'}>${s.netPnl.toFixed(0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
