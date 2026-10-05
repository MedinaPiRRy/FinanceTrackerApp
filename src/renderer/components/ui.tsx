import { useState, type ReactNode } from 'react'
import { formatCents } from '../format'

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`card ${className}`}>{children}</section>
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'pos' | 'neg' }) {
  return (
    <Card className="stat">
      <div className="label">{label}</div>
      <div className={`value num ${tone ?? ''}`}>{value}</div>
      {hint && <div className="hint">{hint}</div>}
    </Card>
  )
}

export function Segmented<T extends string>({ options, value, onChange, small, label }: { options: { value: T; label: string; disabled?: boolean; title?: string }[]; value: T; onChange: (v: T) => void; small?: boolean; label: string }) {
  return (
    <div className={`segmented ${small ? 'small' : ''}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} disabled={o.disabled} title={o.title} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Change vs a comparison value. Direction is always shown with an arrow and sign, never colour alone. */
export function Delta({ now, then, goodWhen }: { now: number; then: number | null | undefined; goodWhen: 'up' | 'down' }) {
  if (then === null || then === undefined) return <span className="muted">n/a</span>
  const d = now - then
  if (d === 0) return <span className="muted">no change</span>
  const good = goodWhen === 'up' ? d > 0 : d < 0
  // A percentage against a tiny or zero baseline is meaningless, so only show it when the baseline is $50+ and the change is under 1000%.
  const pctChange = Math.abs(then) >= 5000 ? Math.round((Math.abs(d) / Math.abs(then)) * 100) : null
  const ratio = pctChange !== null && pctChange < 1000 ? ` (${d > 0 ? '+' : '-'}${pctChange}%)` : ''
  return (
    <span className={`chip num ${good ? 'pos' : 'neg'}`}>
      {d > 0 ? '▲' : '▼'} {d > 0 ? '+' : '-'}
      {formatCents(Math.abs(d))}
      {ratio}
    </span>
  )
}

/** A chart plus its data as a table (accessibility, and exact values on demand). */
export function ChartCard({ title, subtitle, controls, children, table }: { title: string; subtitle?: string; controls?: ReactNode; children: ReactNode; table: { headers: string[]; rows: (string | number)[][] } }) {
  const [showTable, setShowTable] = useState(false)
  return (
    <Card>
      <div className="card-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <div className="muted">{subtitle}</div>}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {controls}
          <button className="btn small" type="button" aria-pressed={showTable} onClick={() => setShowTable((s) => !s)}>
            {showTable ? 'Chart' : 'Table'}
          </button>
        </div>
      </div>
      {showTable ? (
        <div className="chart-table table-wrap">
          <table>
            <thead><tr>{table.headers.map((h, i) => <th key={h} className={i ? 'r' : ''}>{h}</th>)}</tr></thead>
            <tbody>{table.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={`${j ? 'r' : ''} num`}>{c}</td>)}</tr>)}</tbody>
          </table>
        </div>
      ) : (
        children
      )}
    </Card>
  )
}

export function ErrorBox({ error }: { error: string | null }) {
  return error ? <div className="error" role="alert">{error}</div> : null
}

export function Toast({ message }: { message: string | null }) {
  return message ? <div className="toast" role="status">{message}</div> : null
}

/** Progress toward a limit or goal. State is always shown in words as well as colour. */
export function ProgressBar({ value, tone, label }: { value: number; tone: 'ok' | 'near' | 'over' | 'goal'; label: string }) {
  const pct = Math.max(0, Math.min(1, value))
  const color = tone === 'over' ? 'var(--neg)' : tone === 'near' ? 'var(--warn)' : tone === 'goal' ? 'var(--accent)' : 'var(--pos)'
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)} style={{ height: 8, borderRadius: 999, background: 'var(--surface-2)', border: '1px solid var(--border)', overflow: 'hidden', minWidth: 90 }}>
      <div style={{ width: `${pct * 100}%`, height: '100%', background: color, borderRadius: 999 }} />
    </div>
  )
}

export function StateBadge({ state }: { state: 'ok' | 'near' | 'over' }) {
  return state === 'over' ? <span className="badge bad">▲ Over budget</span> : state === 'near' ? <span className="badge warn">● Near budget</span> : <span className="badge good">✓ On track</span>
}

/** Small outline icons for buttons. Decorative: the button text carries the meaning. */
export function Icon({ name }: { name: 'idea' | 'wand' }) {
  const paths: Record<string, string> = {
    idea: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z',
    wand: 'M4 20 15 9M14 4l1 2 2 1-2 1-1 2-1-2-2-1 2-1zM19 12l.7 1.3L21 14l-1.3.7L19 16l-.7-1.3L17 14l1.3-.7z'
  }
  return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ marginRight: 6, verticalAlign: '-2px' }}><path d={paths[name]} /></svg>
}
