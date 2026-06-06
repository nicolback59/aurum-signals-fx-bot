import { useState, useCallback } from 'react';

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

interface Props {
  onLogin: () => void;
}

export function LoginScreen({ onLogin }: Props): JSX.Element {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!username || !password) return;
      setBusy(true);
      setError('');
      try {
        const hash = await sha256Hex(password);
        const result = await window.aurum.login(username, hash);
        if (result.success) {
          onLogin();
        } else {
          setError('Invalid username or password.');
        }
      } catch {
        setError('Login failed. Please try again.');
      } finally {
        setBusy(false);
      }
    },
    [username, password, onLogin],
  );

  return (
    <div className="login-overlay">
      <div className="login-box">
        <div className="login-logo">
          <span className="login-logo-text">AURUM</span>
          <span className="login-logo-sub">SIGNALS FX BOT</span>
        </div>
        <form onSubmit={handleSubmit} className="login-form">
          <div className="login-field">
            <label>Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              spellCheck={false}
              disabled={busy}
            />
          </div>
          <div className="login-field">
            <label>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              disabled={busy}
            />
          </div>
          {error && <div className="login-error">{error}</div>}
          <button type="submit" className="btn btn-start login-btn" disabled={busy}>
            {busy ? 'Signing in…' : 'SIGN IN'}
          </button>
        </form>
      </div>
    </div>
  );
}
