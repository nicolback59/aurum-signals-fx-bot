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
  const daily = state?.dailyTradeCount ?? 0;
  const maxDay = state?.maxTradesPerDay ?? 1;
  const weekly = state?.weeklyTradeCount ?? 0;
  const max = state?.maxTradesPerWeek ?? 5;
  const pct = Math.min(100, (weekly / max) * 100);
  const brokerLabel = (state?.brokerType ?? 'ib').toUpperCase();

  return (
    <div>
      <div className="card">
        <h3>Bot Status</h3>
        <div className="row">
          <span className="label">Bot</span>
          {runPill(state?.runState)}
        </div>
        <div className="row">
          <span className="label">Broker</span>
          <span className="pill pill-gold">{brokerLabel}</span>
        </div>
        <div className="row">
          <span className="label">API Key</span>
          {state?.apiKeyConfigured ? (
            <span className="pill pill-green">CONFIGURED</span>
          ) : (
            <span className="pill pill-red">NOT SET</span>
          )}
        </div>
        <div className="row">
          <span className="label">Connection</span>
          {state?.apiConnected ? (
            <span className="pill pill-green">CONNECTED</span>
          ) : (
            <span className="pill pill-gray">DISCONNECTED</span>
          )}
        </div>
        <div className="row">
          <span className="label">Auto-Execute</span>
          {state?.autoExecuteEnabled ? (
            <span className="pill pill-green">ON</span>
          ) : (
            <span className="pill pill-red">OFF</span>
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
        <h3>Today's Trades</h3>
        <div className="row">
          <span className="label">Used</span>
          <strong style={{ color: daily >= maxDay ? 'var(--neg)' : undefined }}>
            {daily}/{maxDay}
          </strong>
        </div>
        <div className="row">
          <span className="label">Status</span>
          {daily >= maxDay ? (
            <span className="pill pill-red">LOCKED OUT</span>
          ) : (
            <span className="pill pill-green">AVAILABLE</span>
          )}
        </div>
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
