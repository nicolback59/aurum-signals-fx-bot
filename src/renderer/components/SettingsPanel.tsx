import { useCallback, useEffect, useState } from 'react';

interface Settings {
  broker_api_key: string;
  broker_type: string;
  auto_execute: string;
  risk_dollars: string;
  target_dollars: string;
  max_trades_per_week: string;
  account_mode: string;
}

const DEFAULTS: Settings = {
  broker_api_key: '',
  broker_type: 'topstep',
  auto_execute: 'true',
  risk_dollars: '600',
  target_dollars: '2000',
  max_trades_per_week: '5',
  account_mode: 'evaluation',
};

export function SettingsPanel(): JSX.Element {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    void window.aurum.getSettings().then((s) => {
      setSettings({
        broker_api_key: s.broker_api_key ?? '',
        broker_type: s.broker_type ?? 'topstep',
        auto_execute: s.auto_execute ?? 'true',
        risk_dollars: s.risk_dollars ?? '600',
        target_dollars: s.target_dollars ?? '2000',
        max_trades_per_week: s.max_trades_per_week ?? '5',
        account_mode: s.account_mode ?? 'evaluation',
      });
    });
  }, []);

  const handleSave = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setBusy(true);
      setSaved(false);
      await window.aurum.saveSettings(settings as unknown as Record<string, string>);
      setBusy(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
    [settings],
  );

  const set = (key: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setSettings((prev) => ({ ...prev, [key]: e.target.value }));

  return (
    <div className="settings-panel">
      <h2 className="settings-title">Settings</h2>
      <form onSubmit={handleSave} className="settings-form">

        <section className="settings-section settings-section-mode">
          <h3>Account Mode</h3>
          <div className="mode-toggle-row">
            <button
              type="button"
              className={`mode-btn ${settings.account_mode === 'evaluation' ? 'mode-btn-active-eval' : ''}`}
              onClick={() => setSettings((p) => ({ ...p, account_mode: 'evaluation' }))}
              disabled={busy}
            >
              <span className="mode-btn-icon">🧪</span>
              <span className="mode-btn-label">Evaluation Mode</span>
              <span className="mode-btn-desc">Prop firm evaluation account — conservative limits apply</span>
            </button>
            <button
              type="button"
              className={`mode-btn ${settings.account_mode === 'funded' ? 'mode-btn-active-funded' : ''}`}
              onClick={() => setSettings((p) => ({ ...p, account_mode: 'funded' }))}
              disabled={busy}
            >
              <span className="mode-btn-icon">💰</span>
              <span className="mode-btn-label">Funded Account Mode</span>
              <span className="mode-btn-desc">Live funded account — full execution active</span>
            </button>
          </div>
          <span className="settings-hint" style={{ marginTop: 8, display: 'block' }}>
            {settings.account_mode === 'evaluation'
              ? 'Evaluation mode enforces stricter daily loss limits to protect your evaluation.'
              : 'Funded mode runs the full execution engine on your live funded account.'}
          </span>
        </section>

        <section className="settings-section">
          <h3>Broker Connection</h3>
          <div className="settings-row">
            <label>Broker Type</label>
            <select value={settings.broker_type} onChange={set('broker_type')} disabled={busy}>
              <option value="topstep">Topstep (ProjectX)</option>
              <option value="tradovate">Tradovate</option>
              <option value="ib">Interactive Brokers (TWS)</option>
              <option value="rithmic">Rithmic</option>
            </select>
          </div>
          <div className="settings-row">
            <label>API Key</label>
            <div className="api-key-row">
              <input
                type={showKey ? 'text' : 'password'}
                value={settings.broker_api_key}
                onChange={set('broker_api_key')}
                placeholder="Paste your broker API key here"
                disabled={busy}
                spellCheck={false}
              />
              <button
                type="button"
                className="btn"
                onClick={() => setShowKey((v) => !v)}
                style={{ minWidth: 60 }}
              >
                {showKey ? 'Hide' : 'Show'}
              </button>
            </div>
            <span className="settings-hint">
              Your API key is encrypted at rest using your OS keychain (Electron safeStorage).
              {settings.broker_api_key === '••••••••••••••••' && (
                <span style={{ color: 'var(--green)', marginLeft: 6 }}>Key is saved &amp; encrypted.</span>
              )}
            </span>
          </div>
        </section>

        <section className="settings-section">
          <h3>Auto Execution</h3>
          <div className="settings-row">
            <label>Auto-Execute Signals</label>
            <select value={settings.auto_execute} onChange={set('auto_execute')} disabled={busy}>
              <option value="true">Enabled — trades fire automatically</option>
              <option value="false">Disabled — manual confirmation required</option>
            </select>
            <span className="settings-hint">
              When enabled, the bot will place a bracket order as soon as a qualifying signal fires.
            </span>
          </div>
        </section>

        <section className="settings-section">
          <h3>Risk Parameters</h3>
          <div className="settings-row">
            <label>Risk per Trade ($)</label>
            <input
              type="number"
              min="50"
              max="10000"
              value={settings.risk_dollars}
              onChange={set('risk_dollars')}
              disabled={busy}
            />
          </div>
          <div className="settings-row">
            <label>Target per Trade ($)</label>
            <input
              type="number"
              min="100"
              max="50000"
              value={settings.target_dollars}
              onChange={set('target_dollars')}
              disabled={busy}
            />
          </div>
          <div className="settings-row">
            <label>Max Trades per Week</label>
            <input
              type="number"
              min="1"
              max="50"
              value={settings.max_trades_per_week}
              onChange={set('max_trades_per_week')}
              disabled={busy}
            />
          </div>
        </section>

        <div className="settings-actions">
          <button type="submit" className="btn btn-start" disabled={busy}>
            {busy ? 'Saving…' : 'Save Settings'}
          </button>
          {saved && <span className="settings-saved">Settings saved!</span>}
        </div>
      </form>
    </div>
  );
}
