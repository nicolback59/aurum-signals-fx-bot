import { useCallback, useEffect, useRef, useState } from 'react';
import { SignalPanel } from './SignalPanel';
import { TradePanel } from './TradePanel';
import type { BotState, ConnectionPhase, ApiAuthStatus, StartupLogEntry } from '../../types';

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtPhase(phase: ConnectionPhase): string {
  switch (phase) {
    case 'disconnected': return 'Disconnected';
    case 'connecting': return 'Connecting';
    case 'authenticating': return 'Authenticating';
    case 'connected': return 'Connected';
    case 'data-feed-active': return 'Data Feed Active';
    case 'bot-running': return 'Bot Running';
    case 'stopped': return 'Stopped';
    case 'warning': return 'Warning';
    case 'error': return 'Error';
    default: return 'Unknown';
  }
}

function phaseColor(phase: ConnectionPhase): string {
  switch (phase) {
    case 'bot-running': return 'green';
    case 'data-feed-active': return 'green';
    case 'connected': return 'green';
    case 'authenticating': return 'yellow';
    case 'connecting': return 'yellow';
    case 'warning': return 'yellow';
    case 'error': return 'red';
    case 'stopped': return 'gray';
    default: return 'gray';
  }
}

function authStatusLabel(s: ApiAuthStatus): string {
  switch (s) {
    case 'authenticated': return 'Authenticated';
    case 'validating': return 'Validating...';
    case 'failed': return 'Auth Failed';
    default: return 'Not Configured';
  }
}

function authStatusColor(s: ApiAuthStatus): string {
  switch (s) {
    case 'authenticated': return 'green';
    case 'validating': return 'yellow';
    case 'failed': return 'red';
    default: return 'gray';
  }
}

function healthColor(h: 'healthy' | 'degraded' | 'critical' | undefined): string {
  if (h === 'healthy') return 'green';
  if (h === 'degraded') return 'yellow';
  if (h === 'critical') return 'red';
  return 'gray';
}

function fmtTs(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

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

function brokerDisplayName(t: string | undefined): string {
  switch (t) {
    case 'topstep': return 'Topstep (ProjectX)';
    case 'alphafutures': return 'Alpha Futures';
    case 'rithmic': return 'Rithmic';
    case 'ib': return 'Interactive Brokers';
    default: return 'Not Configured';
  }
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatusBadge({
  label,
  color,
  pulse = false,
}: {
  label: string;
  color: 'green' | 'red' | 'yellow' | 'gray' | 'gold';
  pulse?: boolean;
}): JSX.Element {
  return (
    <span className={`cc-badge cc-badge-${color} ${pulse ? 'cc-badge-pulse' : ''}`}>
      <span className="cc-badge-dot" />
      {label}
    </span>
  );
}

function PhaseIndicator({ phase }: { phase: ConnectionPhase }): JSX.Element {
  const color = phaseColor(phase);
  const pulse = phase === 'bot-running' || phase === 'data-feed-active' || phase === 'connecting' || phase === 'authenticating';
  return (
    <div className="cc-phase-indicator">
      <span className={`cc-phase-dot cc-phase-dot-${color} ${pulse ? 'cc-phase-dot-pulse' : ''}`} />
      <span className="cc-phase-label">{fmtPhase(phase)}</span>
    </div>
  );
}

function StartupLogConsole({ logs }: { logs: StartupLogEntry[] }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [logs]);

  return (
    <div className="card cc-log-card">
      <div className="cc-log-header">
        <h3>Startup Log Console</h3>
        <span className="cc-log-count">{logs.length} entries</span>
      </div>
      <div className="cc-log-console" ref={ref}>
        {logs.length === 0 ? (
          <div className="cc-log-empty">Waiting for startup...</div>
        ) : (
          logs.map((entry, i) => (
            <div key={i} className={`cc-log-line cc-log-${entry.level}`}>
              <span className="cc-log-ts">{fmtTs(entry.ts)}</span>
              <span className={`cc-log-level-tag cc-log-level-${entry.level}`}>{entry.level}</span>
              <span className="cc-log-msg">{entry.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function SystemStatusPanel({ state }: { state: BotState | null }): JSX.Element {
  const cs = state?.connectionStatus;
  const phase = cs?.phase ?? 'disconnected';
  const running = state?.runState === 'running';
  const connecting = state?.runState === 'connecting';

  const statuses: Array<{ label: string; color: 'green' | 'red' | 'yellow' | 'gray' | 'gold'; pulse?: boolean }> = [
    {
      label: 'Broker Connected',
      color: state?.apiConnected ? 'green' : 'gray',
    },
    {
      label: authStatusLabel(cs?.apiAuthStatus ?? 'unconfigured'),
      color: authStatusColor(cs?.apiAuthStatus ?? 'unconfigured') as 'green' | 'red' | 'yellow' | 'gray',
      pulse: cs?.apiAuthStatus === 'validating',
    },
    {
      label: cs?.accountVerified ? 'Account Verified' : 'Account Unverified',
      color: cs?.accountVerified ? 'green' : 'gray',
    },
    {
      label: cs?.mnqFeedActive ? 'MNQ Feed Active' : 'MNQ Feed Offline',
      color: cs?.mnqFeedActive ? 'green' : 'gray',
      pulse: cs?.mnqFeedActive,
    },
    {
      label: running ? 'Bot Running' : connecting ? 'Bot Connecting' : 'Bot Stopped',
      color: running ? 'green' : connecting ? 'yellow' : 'gray',
      pulse: running || connecting,
    },
    {
      label: state?.marketOpen ? 'Market Open' : 'Market Closed',
      color: state?.marketOpen ? 'green' : 'gray',
    },
    {
      label: state?.inTradingWindow ? 'Window Active' : `Window in ${fmtCountdown(state?.nextWindowMs ?? null)}`,
      color: state?.inTradingWindow ? 'gold' : 'gray',
    },
    {
      label: `System ${(cs?.systemHealth ?? 'healthy').charAt(0).toUpperCase() + (cs?.systemHealth ?? 'healthy').slice(1)}`,
      color: healthColor(cs?.systemHealth) as 'green' | 'red' | 'yellow' | 'gray',
    },
  ];

  if (phase === 'error' || state?.runState === 'error') {
    statuses.push({ label: 'Error State', color: 'red' });
  }

  return (
    <div className="card">
      <h3>System Status</h3>
      <div className="cc-status-grid">
        {statuses.map((s, i) => (
          <StatusBadge key={i} label={s.label} color={s.color} pulse={s.pulse} />
        ))}
      </div>
      {state?.lastError && (
        <div className="cc-error-banner">
          <span className="cc-error-icon">&#9888;</span>
          {state.lastError}
        </div>
      )}
    </div>
  );
}

function ConnectionDataFeedSection({ state }: { state: BotState | null }): JSX.Element {
  const cs = state?.connectionStatus;

  const rows: Array<{ label: string; value: string | JSX.Element; highlight?: boolean }> = [
    {
      label: 'Broker / Provider',
      value: brokerDisplayName(state?.brokerType),
    },
    {
      label: 'Broker Connection',
      value: (
        <StatusBadge
          label={state?.apiConnected ? 'CONNECTED' : 'DISCONNECTED'}
          color={state?.apiConnected ? 'green' : 'gray'}
          pulse={state?.apiConnected}
        />
      ),
    },
    {
      label: 'API Authentication',
      value: (
        <StatusBadge
          label={authStatusLabel(cs?.apiAuthStatus ?? 'unconfigured')}
          color={authStatusColor(cs?.apiAuthStatus ?? 'unconfigured') as 'green' | 'red' | 'yellow' | 'gray'}
          pulse={cs?.apiAuthStatus === 'validating'}
        />
      ),
    },
    {
      label: 'Account Authorization',
      value: (
        <StatusBadge
          label={cs?.accountVerified ? 'VERIFIED' : 'NOT VERIFIED'}
          color={cs?.accountVerified ? 'green' : 'gray'}
        />
      ),
    },
    {
      label: 'MNQ Data Feed',
      value: (
        <StatusBadge
          label={cs?.mnqFeedActive ? 'ACTIVE' : 'INACTIVE'}
          color={cs?.mnqFeedActive ? 'green' : 'gray'}
          pulse={cs?.mnqFeedActive}
        />
      ),
      highlight: true,
    },
    {
      label: 'Last MNQ Price',
      value: cs?.mnqLastPrice != null ? cs.mnqLastPrice.toFixed(2) : '—',
      highlight: cs?.mnqFeedActive,
    },
    {
      label: 'Last MNQ Volume',
      value: cs?.mnqLastVolume != null ? cs.mnqLastVolume.toLocaleString() : '—',
    },
    {
      label: 'Last Data Update',
      value: fmtTs(cs?.lastDataUpdate),
      highlight: cs?.mnqFeedActive,
    },
    {
      label: 'Connection Latency',
      value: cs?.latencyMs != null ? `${cs.latencyMs}ms` : '—',
    },
    {
      label: 'Reconnect Attempts',
      value: String(cs?.reconnectAttempts ?? 0),
    },
    {
      label: 'System Health',
      value: (
        <StatusBadge
          label={(cs?.systemHealth ?? 'healthy').toUpperCase()}
          color={healthColor(cs?.systemHealth) as 'green' | 'red' | 'yellow' | 'gray'}
        />
      ),
    },
    {
      label: 'API Key',
      value: (
        <StatusBadge
          label={state?.apiKeyConfigured ? 'CONFIGURED' : 'NOT SET'}
          color={state?.apiKeyConfigured ? 'green' : 'red'}
        />
      ),
    },
    {
      label: 'API Validated',
      value: (
        <StatusBadge
          label={state?.apiValidated ? 'VALIDATED' : 'NOT VALIDATED'}
          color={state?.apiValidated ? 'green' : 'gray'}
        />
      ),
    },
    {
      label: 'Auto-Execute',
      value: (
        <StatusBadge
          label={state?.autoExecuteEnabled ? 'ENABLED' : 'DISABLED'}
          color={state?.autoExecuteEnabled ? 'green' : 'red'}
        />
      ),
    },
  ];

  return (
    <div className="card">
      <h3>Connection &amp; Data Feed</h3>
      <div className="cc-conn-table">
        {rows.map((row, i) => (
          <div key={i} className={`cc-conn-row ${row.highlight ? 'cc-conn-row-highlight' : ''}`}>
            <span className="cc-conn-label">{row.label}</span>
            <span className="cc-conn-value">{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Inline Broker Config ──────────────────────────────────────────────────────

function BrokerConfigCard({
  state,
  onValidate,
  validating,
}: {
  state: BotState | null;
  onValidate: () => void;
  validating: boolean;
}): JSX.Element {
  const [brokerType, setBrokerType] = useState(state?.brokerType ?? 'topstep');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState('');

  useEffect(() => {
    void window.aurum.getSettings().then((s) => {
      setBrokerType(s.broker_type ?? 'topstep');
      setApiKey(s.broker_api_key ?? '');
    });
  }, []);

  const needsApiKey = brokerType !== 'ib';

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSavedMsg('');
    await window.aurum.saveSettings({ broker_type: brokerType, broker_api_key: apiKey });
    setSaving(false);
    setSavedMsg('Saved!');
    setTimeout(() => setSavedMsg(''), 2500);
  }, [brokerType, apiKey]);

  const canValidate = needsApiKey && apiKey.trim().length > 0 && !validating && state?.runState !== 'running';

  return (
    <div className="card">
      <h3>Broker Connection</h3>
      <div className="cc-conn-table">
        <div className="cc-conn-row">
          <span className="cc-conn-label">Broker Type</span>
          <span className="cc-conn-value">
            <select
              value={brokerType}
              onChange={(e) => setBrokerType(e.target.value)}
              disabled={saving || state?.runState === 'running'}
              style={{ background: '#1a1a2e', color: '#e0e0e0', border: '1px solid #333', borderRadius: 4, padding: '4px 8px' }}
            >
              <option value="topstep">Topstep (ProjectX)</option>
              <option value="alphafutures">Alpha Futures</option>
              <option value="ib">Interactive Brokers (TWS)</option>
              <option value="rithmic">Rithmic</option>
            </select>
          </span>
        </div>
        {needsApiKey && (
          <div className="cc-conn-row">
            <span className="cc-conn-label">API Key</span>
            <span className="cc-conn-value" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Paste your API key"
                disabled={saving || state?.runState === 'running'}
                spellCheck={false}
                style={{ background: '#1a1a2e', color: '#e0e0e0', border: '1px solid #333', borderRadius: 4, padding: '4px 8px', flex: 1, minWidth: 0 }}
              />
              <button
                type="button"
                className="btn"
                onClick={() => setShowKey((v) => !v)}
                style={{ minWidth: 50, fontSize: 12 }}
              >
                {showKey ? 'Hide' : 'Show'}
              </button>
            </span>
          </div>
        )}
        <div className="cc-conn-row">
          <span className="cc-conn-label">Status</span>
          <span className="cc-conn-value" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <StatusBadge
              label={state?.apiValidated ? 'VALIDATED' : state?.apiKeyConfigured ? 'NOT VALIDATED' : 'NOT CONFIGURED'}
              color={state?.apiValidated ? 'green' : state?.apiKeyConfigured ? 'yellow' : 'gray'}
            />
          </span>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
        <button
          className="btn btn-start"
          onClick={handleSave}
          disabled={saving || state?.runState === 'running'}
          style={{ fontSize: 13 }}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {needsApiKey && (
          <button
            className={`btn cc-btn-validate ${!canValidate ? 'cc-btn-validate-disabled' : ''}`}
            onClick={onValidate}
            disabled={!canValidate}
            style={{ fontSize: 13 }}
          >
            {validating ? (
              <><span className="cc-spin" />VALIDATING...</>
            ) : (
              'Validate Connection'
            )}
          </button>
        )}
        {savedMsg && <span style={{ color: '#4caf50', fontSize: 13 }}>{savedMsg}</span>}
      </div>
    </div>
  );
}

// ── Main ControlCenter ────────────────────────────────────────────────────────

interface Props {
  state: BotState | null;
  busy: boolean;
  validating: boolean;
  startupLogs: StartupLogEntry[];
  onStart: () => void;
  onStop: () => void;
  onValidate: () => void;
}

export function ControlCenter({
  state,
  busy,
  validating,
  startupLogs,
  onStart,
  onStop,
  onValidate,
}: Props): JSX.Element {
  const running = state?.runState === 'running';
  const connecting = state?.runState === 'connecting';
  const brokerType = state?.brokerType ?? 'topstep';
  const needsApiKey = brokerType !== 'ib';
  const apiKeyConfigured = state?.apiKeyConfigured ?? false;
  const apiValidated = state?.apiValidated ?? false;

  const marketOpen = state?.marketOpen ?? false;
  const canStart = !running && !connecting && !busy && marketOpen && (!needsApiKey || (apiKeyConfigured && apiValidated));
  const canStop = state?.runState !== 'stopped' && !busy;
  const canValidate = needsApiKey && apiKeyConfigured && !validating && !running;

  const cs = state?.connectionStatus;
  const phase = cs?.phase ?? (state?.runState === 'stopped' ? 'stopped' : 'disconnected');

  const showStartupLog = startupLogs.length > 0;

  function getStartDisabledReason(): string {
    if (busy) return 'Operation in progress';
    if (running || connecting) return 'Bot is already running';
    if (!marketOpen) return 'Market is closed — bot can only start during market hours';
    if (needsApiKey && !apiKeyConfigured) return 'Enter and save an API key in the Broker Connection section above';
    if (needsApiKey && !apiValidated) return 'Click Validate Connection to verify your API key';
    return '';
  }

  return (
    <div className="control-center">

      {/* ── Broker Connection ─────────────────────────────────────────────────── */}
      <BrokerConfigCard state={state} onValidate={onValidate} validating={validating} />

      {/* ── Bot Controls Section ─────────────────────────────────────────────── */}
      <div className="card cc-controls-card">
        <div className="cc-controls-top">
          <PhaseIndicator phase={phase as ConnectionPhase} />

          <div className="cc-controls-buttons">
            {running ? (
              <button className="btn cc-btn-running" disabled>
                <span className="cc-btn-dot cc-btn-dot-green" />
                BOT RUNNING
              </button>
            ) : (
              <button
                className={`btn cc-btn-start ${!canStart ? 'cc-btn-start-disabled' : ''}`}
                onClick={onStart}
                disabled={!canStart}
                title={getStartDisabledReason()}
              >
                {connecting ? (
                  <>
                    <span className="cc-btn-dot cc-btn-dot-yellow cc-btn-dot-pulse" />
                    CONNECTING...
                  </>
                ) : busy ? (
                  <>
                    <span className="cc-btn-dot cc-btn-dot-yellow cc-btn-dot-pulse" />
                    STARTING...
                  </>
                ) : (
                  'START BOT'
                )}
              </button>
            )}

            <button
              className="btn cc-btn-stop"
              onClick={onStop}
              disabled={!canStop}
            >
              STOP BOT
            </button>
          </div>

          {needsApiKey && !apiValidated && !running && (
            <div className="cc-validate-area">
              <button
                className={`btn cc-btn-validate ${!canValidate ? 'cc-btn-validate-disabled' : ''}`}
                onClick={onValidate}
                disabled={!canValidate}
              >
                {validating ? (
                  <>
                    <span className="cc-spin" />
                    VALIDATING...
                  </>
                ) : (
                  'VALIDATE CONNECTION'
                )}
              </button>
              {!apiKeyConfigured && (
                <span className="cc-validate-hint">
                  Enter your API key in Settings, then click Validate
                </span>
              )}
              {apiKeyConfigured && !apiValidated && !validating && (
                <span className="cc-validate-hint cc-hint-warn">
                  API key saved — click Validate to enable Start Bot
                </span>
              )}
            </div>
          )}

          {running && (
            <div className="cc-active-indicator">
              <span className="cc-active-dot" />
              <span className="cc-active-label">ACTIVE — Monitoring MNQ Signals</span>
            </div>
          )}
        </div>

        {!marketOpen && !running && !connecting && (
          <div className="cc-setup-banner">
            <span className="cc-setup-icon">&#9432;</span>
            Market is currently <strong>closed</strong>. Start Bot will be enabled when the market opens.
            {state?.nextWindowMs != null && state.nextWindowMs > 0 && (
              <> Next NY Open window in <strong>{fmtCountdown(state.nextWindowMs)}</strong>.</>
            )}
          </div>
        )}
        {marketOpen && needsApiKey && !apiKeyConfigured && (
          <div className="cc-setup-banner">
            <span className="cc-setup-icon">&#9432;</span>
            Enter and save your API key in the <strong>Broker Connection</strong> section above, then click Validate to start the bot.
          </div>
        )}
      </div>

      {/* ── System Status Panel ─────────────────────────────────────────────── */}
      <SystemStatusPanel state={state} />

      {/* ── Startup Log Console ─────────────────────────────────────────────── */}
      {showStartupLog && <StartupLogConsole logs={startupLogs} />}

      {/* ── Connection & Data Feed ──────────────────────────────────────────── */}
      <ConnectionDataFeedSection state={state} />

      {/* ── Signal & Trade panels ───────────────────────────────────────────── */}
      <div className="grid-2">
        <SignalPanel signal={state?.signal ?? null} />
        <TradePanel trade={state?.openTrade ?? null} />
      </div>

    </div>
  );
}
