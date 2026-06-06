import { useEffect, useState } from "react";
import type { WeeklyStats, DailyStats } from '../../types';

export function WeeklyReport(): JSX.Element {
  const [weekly, setWeekly] = useState<WeeklyStats | null>(null);
  const [daily, setDaily] = useState<DailyStats | null>(null);

  useEffect(() => {
    void window.aurum.weeklyReport().then(setWeekly);
    void window.aurum.dailyReport().then(setDaily);
  }, []);

  return (
    <div>
      <div className="card">
        <h3>Today</h3>
        {daily ? (
          <div className="grid-3">
            <div className="metric">
              <div className="value">{daily.tradeCount}</div>
              <div className="name">Trades</div>
            </div>
            <div className="metric">
              <div className="value">{(daily.winRate * 100).toFixed(0)}%</div>
              <div className="name">Win Rate</div>
            </div>
            <div className="metric">
              <div className={`value ${daily.netPnl >= 0 ? 'pos' : 'neg'}`}>
                ${daily.netPnl.toFixed(0)}
              </div>
              <div className="name">Net P&amp;L</div>
            </div>
          </div>
        ) : (
          <div className="label">Loading…</div>
        )}
      </div>

      <div className="card">
        <h3>This Week {weekly ? `(${weekly.week})` : ''}</h3>
        {weekly ? (
          <>
            <div className="grid-3">
              <div className="metric">
                <div className="value">{weekly.tradeCount}</div>
                <div className="name">Trades</div>
              </div>
              <div className="metric">
                <div className="value">{(weekly.winRate * 100).toFixed(0)}%</div>
                <div className="name">Win Rate</div>
              </div>
              <div className="metric">
                <div className={`value ${weekly.netPnl >= 0 ? 'pos' : 'neg'}`}>
                  ${weekly.netPnl.toFixed(0)}
                </div>
                <div className="name">Net P&amp;L</div>
              </div>
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <span className="label">Wins / Losses</span>
              <strong>
                {weekly.wins} / {weekly.losses}
              </strong>
            </div>
            <div className="row">
              <span className="label">Avg R</span>
              <strong>{weekly.avgR.toFixed(2)}R</strong>
            </div>
            <div className="row">
              <span className="label">Best Setup</span>
              <span className="pill pill-green">{weekly.bestSetup}</span>
            </div>
            <div className="row">
              <span className="label">Worst Setup</span>
              <span className="pill pill-red">{weekly.worstSetup}</span>
            </div>
          </>
        ) : (
          <div className="label">Loading…</div>
        )}
      </div>
    </div>
  );
}
