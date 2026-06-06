import type { BotState, BiasLabel } from '../../types';

function fmtCountdown(ms: number | null): string {
  if (ms == null || ms <= 0) return 'NOW';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function biasPill(b: BiasLabel): JSX.Element {
  const cls = b === 'BULL' ? 'pill-green' : b === 'BEAR' ? 'pill-red' : 'pill-gray';
  return <span className={`pill ${cls}`}>{b}</span>;
}

function runPill(s: BotState['runState'] | undefined): JSX.Element {
  switch (s) {
    case 'running':
      return <span className="pill pill-green">RUNNING</span>;
    case 'connecting':
      return <span className="pill pill-yellow">CONNECTING</span>;
    case 'error':
      return <span className="pill pill-red">ERROR</span>;
    default:
      return <span className="pill pill-gray">STOPPED</span>;
  }
}

export function StatusBar({ state }: { state: BotState | null }): JSX.Element {
  const weekly = state?.weeklyTradeCount ?? 0;
  const max = state?.maxTradesPerWeek ?? 5;
  const pct = Math.min(100, (weekly / max) * 100);

  return (
    <div>
      <div className="card">
        <h3>Bot Status</h3>
        <div className="row">
          <span className="label">Bot</span>
          {runPill(state?.runState)}
        </div>
        <div className="row">
          <span className="label">API</span>
          {state?.apiConnected ? (
            <span className="pill pill-green">CONNECTED</span>
          ) : (
            <span className="pill pill-red">DISCONNECTED</span>
          )}
        </div>
        <div className="row">
          <span className="label">Market</span>
          {state?.marketOpen ? (
            <span className="pill pill-green">OPEN</span>
          ) : (
            <span className="pill pill-gray">CLOSED</span>
          )}
        </div>
        <div className="row">
          <span className="label">Window</span>
          {state?.inTradingWindow ? (
            <span className="pill pill-gold">ACTIVE</span>
          ) : (
            <span className="pill pill-gray">INACTIVE</span>
          )}
        </div>
        {!state?.inTradingWindow && (
          <div className="row">
            <span className="label">Next Window</span>
            <span className="pill pill-yellow">{fmtCountdown(state?.nextWindowMs ?? null)}</span>
          </div>
        )}
      </div>

      <div className="card">
        <h3>Weekly Trades</h3>
        <div className="row">
          <span className="label">Used</span>
          <strong>
            {weekly}/{max}
          </strong>
        </div>
        <div className="progress">
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="card">
        <h3>Current Bias</h3>
        <div className="row">
          <span className="label">ES</span>
          {biasPill(state?.bias.esBias ?? 'NEUTRAL')}
        </div>
        <div className="row">
          <span className="label">MNQ</span>
          {biasPill(state?.bias.mnqBias ?? 'NEUTRAL')}
        </div>
      </div>

      {state?.lastError && (
        <div className="card">
          <h3>Last Error</h3>
          <div className="neg" style={{ fontSize: 12 }}>
            {state.lastError}
          </div>
        </div>
      )}
    </div>
  );
}
