import { useCallback, useEffect, useState } from "react";

import { StatusBar } from './components/StatusBar';
import { Dashboard } from './components/Dashboard';
import { TradeHistory } from './components/TradeHistory';
import { BacktestPanel } from './components/BacktestPanel';
import { WeeklyReport } from './components/WeeklyReport';
import { ErrorLog } from './components/ErrorLog';
import { LoginScreen } from './components/LoginScreen';
import { SettingsPanel } from './components/SettingsPanel';
import type { BotState } from '../types';

type Tab = 'live' | 'trades' | 'backtest' | 'reports' | 'logs' | 'settings';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'live', label: 'Live' },
  { id: 'trades', label: 'Trades' },
  { id: 'backtest', label: 'Backtest' },
  { id: 'reports', label: 'Reports' },
  { id: 'logs', label: 'Logs' },
  { id: 'settings', label: 'Settings' },
];

export function App(): JSX.Element {
  const [loggedIn, setLoggedIn] = useState(false);
  const [state, setState] = useState<BotState | null>(null);
  const [tab, setTab] = useState<Tab>('live');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loggedIn) return;
    void window.aurum.getState().then(setState);
    const off = window.aurum.onState(setState);
    return off;
  }, [loggedIn]);

  const start = useCallback(async () => {
    setBusy(true);
    setState(await window.aurum.startBot());
    setBusy(false);
  }, []);

  const stop = useCallback(async () => {
    setBusy(true);
    setState(await window.aurum.stopBot());
    setBusy(false);
  }, []);

  const logout = useCallback(() => {
    setLoggedIn(false);
    setState(null);
    setTab('live');
  }, []);

  if (!loggedIn) {
    return <LoginScreen onLogin={() => setLoggedIn(true)} />;
  }

  const running = state?.runState === 'running' || state?.runState === 'connecting';

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>AURUM SIGNALS FX BOT</h1>
          <div className="sub">Automated MNQ Futures Execution — NY Open</div>
        </div>
        <div className="header-actions">
          {running ? (
            <button className="btn btn-stop" onClick={stop} disabled={busy}>
              STOP BOT
            </button>
          ) : (
            <button className="btn btn-start" onClick={start} disabled={busy}>
              START BOT
            </button>
          )}
          <button className="btn" onClick={logout} style={{ marginLeft: 8 }}>
            Log Out
          </button>
        </div>
      </header>

      <div className="body">
        <aside className="sidebar">
          <StatusBar state={state} />
        </aside>

        <main className="main">
          <nav className="tabs">
            {TABS.map((t) => (
              <div
                key={t.id}
                className={`tab ${tab === t.id ? 'active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </div>
            ))}
          </nav>

          <section className="content">
            {tab === 'live' && <Dashboard state={state} />}
            {tab === 'trades' && <TradeHistory />}
            {tab === 'backtest' && <BacktestPanel />}
            {tab === 'reports' && <WeeklyReport />}
            {tab === 'logs' && <ErrorLog />}
            {tab === 'settings' && <SettingsPanel />}
          </section>
        </main>
      </div>
    </div>
  );
}
