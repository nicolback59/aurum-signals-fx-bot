import type { SignalSnapshot } from '../../types';

function scoreClass(score: number): string {
  if (score >= 80) return 'score-green';
  if (score >= 60) return 'score-yellow';
  return 'score-gray';
}

function CheckRow({ ok, label }: { ok: boolean; label: string }): JSX.Element {
  return (
    <div className="check-row">
      <span className={ok ? 'check-ok' : 'check-no'}>{ok ? '✓' : '✕'}</span>
      <span>{label}</span>
    </div>
  );
}

export function SignalPanel({ signal }: { signal: SignalSnapshot | null }): JSX.Element {
  const score = signal?.score ?? 0;
  const dir = signal?.direction ?? null;
  const es = signal?.esChecks;

  return (
    <div className="card">
      <h3>Current Signal</h3>
      <div style={{ display: 'flex', gap: 24, alignItems: 'center' }}>
        <div>
          <div className={`score-big ${scoreClass(score)}`}>{score || '--'}</div>
          <div className="label" style={{ marginTop: 6 }}>
            Signal Score
          </div>
        </div>
        <div style={{ flex: 1 }}>
          <div className="row">
            <span className="label">Grade</span>
            {signal?.grade ? (
              <span className="pill pill-gold">{signal.grade}</span>
            ) : (
              <span className="pill pill-gray">--</span>
            )}
          </div>
          <div className="row">
            <span className="label">Setup</span>
            <strong>{signal?.signalType ?? '--'}</strong>
          </div>
          <div className="row">
            <span className="label">Direction</span>
            {dir === 'LONG' ? (
              <span className="pill pill-green">LONG</span>
            ) : dir === 'SHORT' ? (
              <span className="pill pill-red">SHORT</span>
            ) : (
              <span className="pill pill-gray">--</span>
            )}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
        <div className="label" style={{ marginBottom: 6 }}>
          ES Confirmation
        </div>
        {es ? (
          <>
            <CheckRow ok={es.aboveVwap} label="ES on correct side of VWAP" />
            <CheckRow ok={es.emaAligned} label="ES EMA9 / EMA21 aligned" />
            <CheckRow ok={es.htfAligned} label="ES HTF bias aligned" />
            <CheckRow ok={es.structure} label="ES structure (HH/HL or LH/LL)" />
            <CheckRow ok={es.momentum} label="ES momentum aligned" />
          </>
        ) : (
          <div className="label">No ES confirmation data</div>
        )}
      </div>

      {signal?.rejectReasons && signal.rejectReasons.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="label">Reject Reasons</div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {signal.rejectReasons.join('; ')}
          </div>
        </div>
      )}

      <div className="label" style={{ marginTop: 12, fontSize: 11 }}>
        Last evaluated: {signal ? new Date(signal.evaluatedAt).toLocaleTimeString() : '--'}
      </div>
    </div>
  );
}
