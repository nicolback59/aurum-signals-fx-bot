import { useEffect, useState } from "react";
import type { BotTrade } from '../../types';

function resultPill(t: BotTrade): JSX.Element {
  switch (t.status) {
    case 'WIN':
      return <span className="pill pill-green">WIN</span>;
    case 'LOSS':
      return <span className="pill pill-red">LOSS</span>;
    case 'OPEN':
      return <span className="pill pill-gold">OPEN</span>;
    case 'REJECTED':
      return <span className="pill pill-gray">REJECTED</span>;
    default:
      return <span className="pill pill-gray">{t.status}</span>;
  }
}

export function TradeHistory(): JSX.Element {
  const [trades, setTrades] = useState<BotTrade[]>([]);

  useEffect(() => {
    void window.aurum.listTrades().then(setTrades);
    const off = window.aurum.onTradeExecuted(() => {
      void window.aurum.listTrades().then(setTrades);
    });
    return off;
  }, []);

  if (trades.length === 0) {
    return (
      <div className="card">
        <h3>Trade History</h3>
        <div className="empty">No trades recorded yet</div>
      </div>
    );
  }

  return (
    <div className="card">
      <h3>Trade History</h3>
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Dir</th>
            <th>Setup</th>
            <th>Grade</th>
            <th>Score</th>
            <th>Entry</th>
            <th>Stop</th>
            <th>Target</th>
            <th>Result</th>
            <th>P&amp;L</th>
            <th>R</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => (
            <tr key={t.id}>
              <td>{t.openTime ? new Date(t.openTime).toLocaleString() : '--'}</td>
              <td>
                <span className={`pill ${t.direction === 'LONG' ? 'pill-green' : 'pill-red'}`}>
                  {t.direction}
                </span>
              </td>
              <td>{t.signalType}</td>
              <td>{t.grade}</td>
              <td>{t.score}</td>
              <td>{t.entry.toFixed(2)}</td>
              <td>{t.stop.toFixed(2)}</td>
              <td>{t.target.toFixed(2)}</td>
              <td>{resultPill(t)}</td>
              <td className={t.pnl != null ? (t.pnl >= 0 ? 'pos' : 'neg') : ''}>
                {t.pnl != null ? `$${t.pnl.toFixed(2)}` : '--'}
              </td>
              <td className={t.pnlR != null ? (t.pnlR >= 0 ? 'pos' : 'neg') : ''}>
                {t.pnlR != null ? `${t.pnlR.toFixed(2)}R` : '--'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
