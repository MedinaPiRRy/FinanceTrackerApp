import { useEffect, useState } from 'react'
import { api } from '../api'
import { Card, ErrorBox } from './ui'
import { Pager, PAGE_SIZE } from './Pager'
import { useKept } from '../nav'
import { txnPreset } from '../txnLink'
import { formatCents } from '../format'
import type { GoalDetail as Detail } from '../../db/goalDetail'
import type { Page, TxnPreset } from '../App'

export type DetailSource = { goalId: number } | { item: { accountId?: number; debtId?: number }; label: string }

/** The goal or card/loan a page was opened on (kept in the history entry's preset), if any. */
export function detailSource(preset: TxnPreset | undefined): DetailSource | null {
  if (preset?.goalId !== undefined) return { goalId: preset.goalId }
  if (preset?.payoff) {
    const [kind, ref] = preset.payoff.split(':')
    return { item: kind === 'card' ? { accountId: Number(ref) } : { debtId: Number(ref) }, label: preset.payoffLabel ?? 'Payments' }
  }
  return null
}

/** What counts toward a goal (or one card or loan of the payoff planner): how many transactions, how much, and the list, 50 at a time. */
export function GoalDetailView({ profileId, source, goto }: { profileId: number; source: DetailSource; goto: (p: Page, preset?: TxnPreset) => void }) {
  const [page, setPage] = useKept('goalDetailPage', 0)
  const [d, setD] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const key = 'goalId' in source ? `g${source.goalId}` : `p${source.item.accountId ?? ''}-${source.item.debtId ?? ''}`
  useEffect(() => {
    const call = 'goalId' in source ? api('goalDetail', profileId, source.goalId, page * PAGE_SIZE, PAGE_SIZE) : api('payoffDetail', source.item, source.label, page * PAGE_SIZE, PAGE_SIZE)
    void call.then((r) => { setD(r); setError(null) }).catch((e: Error) => setError(e.message))
  }, [profileId, key, page]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="page-head">
        <div>
          <button className="btn small" onClick={() => goto('goals')} aria-label="Back to goals">← Back to goals</button>
          <h1 style={{ marginTop: 8 }}>{d?.title ?? ('label' in source ? source.label : 'Goal')}</h1>
          {d && <p>{d.explain}</p>}
        </div>
        {d?.openIn && <button className="btn" onClick={() => goto('transactions', d.openIn!)}>Open in Transactions</button>}
      </div>
      <ErrorBox error={error} />
      {!d ? <p className="muted">Loading…</p> : (
        <>
          <div className="grid stats">
            <Card className="stat"><div className="label">Transactions counted</div><div className="value num">{d.count.toLocaleString()}</div></Card>
            <Card className="stat"><div className="label">{d.inCents !== null && d.outCents !== null && d.countedCents < 0 ? 'Net so far' : 'Gone toward it'}</div><div className="value num">{formatCents(d.countedCents)}</div>{d.manualCents > 0 && <div className="hint">plus {formatCents(d.manualCents)} you entered by hand</div>}</Card>
            {d.inCents !== null && d.outCents !== null && <Card className="stat"><div className="label">In / out</div><div className="value num" style={{ fontSize: 18 }}>{formatCents(d.inCents)} / {formatCents(d.outCents)}</div></Card>}
          </div>
          <Card>
            {d.rows.length === 0 ? <p className="muted">{d.count === 0 ? 'No transactions count toward this yet.' : 'Nothing on this page.'}</p> : (
              <div className="table-wrap"><table>
                <caption className="sr-only">Transactions counted toward {d.title}</caption>
                <thead><tr><th>Date</th><th>Description</th><th>Account</th><th>Category</th><th className="r">Amount</th></tr></thead>
                <tbody>{d.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="num" style={{ whiteSpace: 'nowrap' }}>{r.date}</td>
                    <td><button className="txn-link" title="Show this transaction in its account" onClick={() => goto('transactions', txnPreset(r))}>{r.description}</button></td>
                    <td>{r.account}</td>
                    <td>{r.category ?? <span className="muted">—</span>}</td>
                    <td className={`r num ${r.amountCents > 0 ? 'pos' : ''}`}>{formatCents(r.amountCents, { sign: true })}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
            <Pager page={page} total={d.count} pageSize={PAGE_SIZE} onPage={setPage} noun="Transactions" />
          </Card>
        </>
      )}
    </>
  )
}
