import { useEffect, useState } from 'react'
import { Card, ErrorBox } from './ui'
import { formatCents } from '../format'
import { txnPreset } from '../txnLink'
import type { Page, TxnPreset } from '../App'
import type { BudgetDrill as Drill } from '../../db/budgetDrill'

const monthName = (m: string) => new Date(`${m}-15T12:00:00`).toLocaleString('en-CA', { month: 'long', year: 'numeric' })

/** The transactions behind one budget for one month, a column per account (or one combined list). Click a transaction to see it in its account. */
export function BudgetDrill({ load, goto, onClose }: { load: () => Promise<Drill>; goto: (p: Page, pre?: TxnPreset) => void; onClose: () => void }) {
  const [data, setData] = useState<Drill | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [oneList, setOneList] = useState(false)
  useEffect(() => { setData(null); load().then(setData).catch((e: Error) => setError(e.message)) }, [load])

  const open = (r: Drill['columns'][number]['rows'][number]) => goto('transactions', txnPreset(r))
  const line = (r: Drill['columns'][number]['rows'][number], account?: string) => (
    <li key={r.id} style={{ display: 'flex', gap: 8, justifyContent: 'space-between', padding: '6px 0', borderTop: '1px solid var(--border)' }}>
      <span>
        <span className="muted num">{r.date.slice(5)}</span>{' '}
        <button className="txn-link" title="Show this transaction in its account" onClick={() => open(r)}>{r.description}</button>
        {(account || r.category) && <div className="muted" style={{ fontSize: 12 }}>{[account, r.category].filter(Boolean).join(' · ')}</div>}
      </span>
      <span className={`num ${r.cents < 0 ? 'pos' : ''}`}>{formatCents(r.cents)}</span>
    </li>
  )

  return (
    <Card>
      <div className="card-head">
        <h2>{data ? `${data.name}: transactions in ${monthName(data.month)}` : 'Loading…'}</h2>
        <span style={{ display: 'flex', gap: 8 }}>
          {data && data.columns.length > 1 && <button className="btn small" aria-pressed={oneList} onClick={() => setOneList(!oneList)}>{oneList ? 'Split by account' : 'Show as one list'}</button>}
          <button className="btn small" onClick={onClose}>Close</button>
        </span>
      </div>
      <ErrorBox error={error} />
      {data && (
        <>
          <p className="sub" style={{ marginTop: 0 }}>{formatCents(data.totalCents)} spent of a {formatCents(data.budgetCents)} budget, across {data.columns.length} account{data.columns.length === 1 ? '' : 's'}. Refunds are shown as money back.</p>
          {data.columns.length === 0 ? <p className="muted">Nothing was spent in this budget this month.</p> : oneList ? (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {data.columns.flatMap((c) => c.rows.map((r) => ({ r, account: c.owner ? `${c.account} (${c.owner})` : c.account }))).sort((a, b) => b.r.date.localeCompare(a.r.date) || b.r.id - a.r.id).map(({ r, account }) => line(r, account))}
            </ul>
          ) : (
            <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', alignItems: 'start' }}>
              {data.columns.map((c) => (
                <section key={c.accountId} aria-label={c.account}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
                    <b>{c.account}{c.owner && <span className="muted"> ({c.owner})</span>}</b>
                    <b className="num">{formatCents(c.totalCents)}</b>
                  </div>
                  <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>{c.rows.map((r) => line(r))}</ul>
                  {c.hidden > 0 && <p className="muted" style={{ fontSize: 12 }}>{c.hidden} older transaction{c.hidden === 1 ? '' : 's'} not shown; the total includes them.</p>}
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </Card>
  )
}
