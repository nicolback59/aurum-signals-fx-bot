import { useEffect, useState } from "react";
import type { BotTrade } from '../../types';

const MNQ_POINT_VALUE = 2.0;

function livePnl(trade: BotTrade, mark: number): number {
  const points = trade.direction === 'LONG' ? mark - trade.entry : trade.entry - mark;
  return points * MNQ_POINT_VALUE * trade.contracts;
}

function duration(openTime: string | null): string {
  if (!openTime) return '--';
  const ms = Date.now() - new Date(openTime).getTime();
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

export function TradePanel({ trade }: { trade: BotTrade | null }): JSX.Element {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  if (!trade) {
    return (
      <div className="card">
        <h3>Active Trade</h3>
        <div className="empty">No open trade</div>
      </div>
    );
  }

  // Mark is unavailable in this snapshot; show realized P&L if closed,
  // otherwise estimate against entry (0 until a mark feed is wired).
  const mark = trade.closePrice ?? trade.entry;
  const pnl = trade.pnl ?? livePnl(trade, mark);
  const pnlClass = pnl >= 0 ? 'pos' : 'neg';

  return (
    <div className="card">
      <h3>Active Trade</h3>
      <div className="grid-3">
        <div className="metric">
          <div className="value">{trade.entry.toFixed(2)}</div>
          <div className="name">Entry</div>
        </div>
        <div className="metric">
          <div className="value" style={{ color: 'var(--red)' }}>
            {trade.stop.toFixed(2)}
          </div>
          <div className="name">Stop</div>
        </div>
        <div className="metric">
          <div className="value" style={{ color: 'var(--green)' }}>
            {trade.target.toFixed(2)}
          </div>
          <div className="name">Target</div>
        </div>
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <span className="label">Direction</span>
        <span className={`pill ${trade.direction === 'LONG' ? 'pill-green' : 'pill-red'}`}>
          {trade.direction}
        </span>
      </div>
      <div className="row">
        <span className="label">Contracts</span>
        <strong>{trade.contracts}</strong>
      </div>
      <div className="row">
        <span className="label">Risk / Target</span>
        <strong>
          ${trade.riskDollars.toFixed(0)} / ${trade.targetDollars.toFixed(0)}
        </strong>
      </div>
      <div className="row">
        <span className="label">RR</span>
        <strong>{trade.actualRR.toFixed(2)}R</strong>
      </div>
      <div className="row">
        <span className="label">P&amp;L</span>
        <strong className={pnlClass}>${pnl.toFixed(2)}</strong>
      </div>
      <div className="row">
        <span className="label">Duration</span>
        <strong>{duration(trade.openTime)}</strong>
      </div>
    </div>
  );
}
