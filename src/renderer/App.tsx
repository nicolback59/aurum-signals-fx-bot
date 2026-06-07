import { useCallback, useEffect, useState } from "react";

import { ControlCenter } from './components/ControlCenter';
import { TradeHistory } from './components/TradeHistory';
import { WeeklyReport } from './components/WeeklyReport';
import { ErrorLog } from './components/ErrorLog';
import { LoginScreen } from './components/LoginScreen';
import { SettingsPanel } from './components/SettingsPanel';
import type { BotState, StartupLogEntry } from '../types';

type Tab = 'live' | 'trades' | 'reports' | 'logs' | 'settings';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'live', label: 'Control Center' },
  { id: 'trades', label: 'Trades' },
  { id: 'reports', label: 'Reports' },
  { id: 'logs', label: 'Logs' },
  { id: 'settings', label: 'Settings' },
];

export function App(): JSX.Element {
  const [loggedIn, setLoggedIn] = useState(false);
  const [state, setState] = useState<BotState | null>(null);
  const [tab, setTab] = useState<Tab>('live');
  const [busy, setBusy] = useState(false);
  const [validating, setValidating] = useState(false);
  const [startupLogs, setStartupLogs] = useState<StartupLogEntry[]>([]);

  useEffect(() => {
    if (!loggedIn) return;
    void window.aurum.getState().then(setState);
    void window.aurum.getStartupLogs().then(setStartupLogs);
    const offState = window.aurum.onState(setState);
    const offLog = window.aurum.onStartupLog((entry) =>
      setStartupLogs((prev) => [...prev, entry]),
    );
    return () => { offState(); offLog(); };
  }, [loggedIn]);

  const start = useCallback(async () => {
    setBusy(true);
    setStartupLogs([]);
    setState(await window.aurum.startBot());
    setBusy(false);
  }, []);

  const stop = useCallback(async () => {
    setBusy(true);
    setState(await window.aurum.stopBot());
    setBusy(false);
  }, []);

  const validate = useCallback(async () => {
    setValidating(true);
    await window.aurum.validateApi();
    const updated = await window.aurum.getState();
    setState(updated);
    setValidating(false);
  }, []);

  const logout = useCallback(() => {
    setLoggedIn(false);
    setState(null);
    setStartupLogs([]);
    setTab('live');
  }, []);

  if (!loggedIn) {
    return <LoginScreen onLogin={() => setLoggedIn(true)} />;
  }

  const running = state?.runState === 'running';
  const connecting = state?.runState === 'connecting';
  const brokerType = state?.brokerType ?? 'topstep';
  const needsApiKey = brokerType !== 'ib';
  const marketOpen = state?.marketOpen ?? false;
  const canStart =
    !running &&
    !connecting &&
    !busy &&
    marketOpen &&
    (!needsApiKey || (state?.apiKeyConfigured && state?.apiValidated));
  const canStop = state?.runState !== 'stopped' && !busy;

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>AURUM SIGNALS FX BOT</h1>
          <div className="sub">Automated MNQ Futures Execution — NY Open</div>
        </div>
        <div className="header-actions">
          {running ? (
            <button className="btn btn-running-sm" disabled>
              BOT RUNNING
            </button>
          ) : (
            <button
              className="btn btn-start"
              onClick={start}
              disabled={!canStart}
              title={!canStart && needsApiKey && !state?.apiValidated ? 'Validate API key first in Control Center' : undefined}
            >
              {connecting ? 'CONNECTING…' : busy ? 'STARTING…' : 'START BOT'}
            </button>
          )}
          <button
            className="btn btn-stop"
            onClick={stop}
            disabled={!canStop}
            style={{ marginLeft: 0 }}
          >
            STOP BOT
          </button>
          <button className="btn" onClick={logout} style={{ marginLeft: 8 }}>
            Log Out
          </button>
        </div>
      </header>

      <div className="body">
        <main className="main" style={{ width: '100%' }}>
          <nav className="tabs">
            {TABS.map((t) => (
              <div
                key={t.id}
                className={`tab ${tab === t.id ? 'active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
                {t.id === 'live' && running && (
                  <span className="tab-live-dot" />
                )}
              </div>
            ))}
          </nav>

          <section className="content">
            {tab === 'live' && (
              <ControlCenter
                state={state}
                busy={busy}
                validating={validating}
                startupLogs={startupLogs}
                onStart={start}
                onStop={stop}
                onValidate={validate}
              />
            )}
            {tab === 'trades' && <TradeHistory />}
            {tab === 'reports' && <WeeklyReport />}
            {tab === 'logs' && <ErrorLog />}
            {tab === 'settings' && <SettingsPanel />}
          </section>
        </main>
      </div>
    </div>
  );
}
