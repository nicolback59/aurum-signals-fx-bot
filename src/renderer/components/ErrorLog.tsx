import { useEffect, useState } from "react";
import type { SystemLogEntry } from '../../types';

export function ErrorLog(): JSX.Element {
  const [logs, setLogs] = useState<SystemLogEntry[]>([]);

  useEffect(() => {
    const load = (): void => {
      void window.aurum.listLogs().then(setLogs);
    };
    load();
    const id = setInterval(load, 5000);
    const off = window.aurum.onState(load);
    return () => {
      clearInterval(id);
      off();
    };
  }, []);

  return (
    <div className="card">
      <h3>System Logs</h3>
      {logs.length === 0 ? (
        <div className="empty">No log entries</div>
      ) : (
        <div>
          {logs.map((l, i) => (
            <div key={l.id ?? i} className="log-line">
              <span className="log-ts">{new Date(l.ts).toLocaleTimeString()}</span>
              <span className={`log-${l.level}`}>[{l.level}]</span>
              <span>{l.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
