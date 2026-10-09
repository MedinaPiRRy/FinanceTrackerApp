import { useEffect, useState } from 'react'
import { monthEnd } from '../../core/budgets'
import { useKept } from '../nav'
import { api } from '../api'
import { ReviewNotice } from '../components/ReviewNotice'
import { txnPreset } from '../txnLink'
import { Card, ErrorBox } from '../components/ui'
import { formatCents, monthLabel } from '../format'
import type { Insight } from '../../core/insights'
import type { Evidence } from '../../db/insights'
import type { CategoryInfo, Profile } from '../../db/queries'
import type { Page, TxnPreset } from '../App'

type Filter = 'all' | 'look' | 'good' | 'facts'
const FILTERS: { id: Filter; label: string }[] = [{ id: 'all', label: 'All' }, { id: 'look', label: 'Worth a look' }, { id: 'good', label: 'Going well' }, { id: 'facts', label: 'Just facts' }]
const matches = (i: Insight, f: Filter) => f === 'all' || (f === 'look' && i.tone === 'warn') || (f === 'good' && i.tone === 'good') || (f === 'facts' && i.tone === 'neutral')
const TYPE_LABEL: Record<string, string> = { fact: 'Fact', trend: 'Trend', anomaly: 'Unusual', recommendation: 'Worth a look' }
const PAGE_LABEL: Record<string, string> = { transactions: 'transactions', budget: 'Budget', goals: 'Goals', recurring: 'Recurring', forecast: 'Forecast', accounts: 'Accounts' }

export function Insights({ profile, categories, goto, openId }: { profile: Profile; categories: CategoryInfo[]; goto: (p: Page, preset?: TxnPreset) => void; openId?: string }) {
  const [month, setMonth] = useKept<string | undefined>('month', undefined)
  const [data, setData] = useState<Awaited<ReturnType<typeof api<'insights'>>> | null>(null)
  const [filter, setFilter] = useKept<Filter>('filter', 'all')
  const [open, setOpen] = useKept<string | null>('open', openId ?? null)
  const [evidence, setEvidence] = useState<Record<string, Evidence>>({})
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { void api('insights', profile.id, month).then((d) => { setData(d); setMonth((m) => m ?? d.month ?? undefined) }).catch((e: Error) => setError(e.message)) }, [profile.id, month])

  const loadEvidence = (i: Insight) => {
    if (i.ref && i.id && !evidence[i.id]) void api('insightEvidence', profile.id, i.ref).then((e) => setEvidence((ev) => ({ ...ev, [i.id!]: e }))).catch((e: Error) => setError(e.message))
  }
  const toggle = (i: Insight) => {
    if (open === i.id) { setOpen(null); return }
    setOpen(i.id!)
    loadEvidence(i)
  }
  useEffect(() => { // arriving from the banner: open that insight straight away
    const i = data?.insights.find((x) => x.id === openId)
    if (i) loadEvidence(i)
  }, [data, openId]) // eslint-disable-line react-hooks/exhaustive-deps

  const goToRef = (i: Insight) => {
    const r = i.ref!
    if (r.page === 'transactions') {
      const categoryId = r.category ? categories.find((c) => c.name === r.category && c.kind === 'expense')?.id : undefined
      if (r.txnId !== undefined && r.accountId !== undefined && r.date) goto('transactions', txnPreset({ id: r.txnId, accountId: r.accountId, date: r.date }))
      else goto('transactions', { categoryId, text: r.text, from: r.month ? `${r.month}-01` : undefined, to: r.month ? monthEnd(r.month) : undefined })
    } else goto(r.page as Page)
  }

  if (!data) return <p className="muted">Loading…</p>
  const list = data.insights.filter((i) => matches(i, filter))

  return (
    <>
      <div className="page-head">
        <div><h1>Insights</h1><p>Patterns in your own data. Open one to see the transactions behind it.</p></div>
        {data.availableMonths.length > 0 && <label className="field">Month<select value={month} onChange={(e) => { setMonth(e.target.value); setOpen(null); setEvidence({}) }}>{[...data.availableMonths].reverse().map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}</select></label>}
      </div>
      <ErrorBox error={error} />
      <ReviewNotice profileId={profile.id} goto={goto} />
      <div className="chips" role="group" aria-label="Filter insights" style={{ marginBottom: 12 }}>
        {FILTERS.map((f) => <button key={f.id} className={`btn small ${filter === f.id ? 'primary' : ''}`} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label} ({data.insights.filter((i) => matches(i, f.id)).length})</button>)}
      </div>
      {list.length === 0 ? <Card><p className="sub" style={{ margin: 0 }}>{data.insights.length === 0 ? 'Not enough data for insights yet. Import a month or two of transactions and they will appear here.' : 'Nothing in this group for this month.'}</p></Card> : (
        <div className="grid" style={{ gap: 12 }}>
          {list.map((i) => {
            const isOpen = open === i.id
            const ev = evidence[i.id!]
            return (
              <Card key={i.id}>
                <button onClick={() => toggle(i)} aria-expanded={isOpen} style={{ background: 'none', border: 0, padding: 0, margin: 0, font: 'inherit', color: 'inherit', textAlign: 'left', cursor: 'pointer', display: 'flex', gap: 12, alignItems: 'flex-start', width: '100%' }}>
                  <span className={`badge ${i.tone === 'warn' ? 'warn' : i.tone === 'good' ? 'good' : ''}`}>{i.tone === 'warn' && i.type !== 'anomaly' ? 'Worth a look' : TYPE_LABEL[i.type]}</span>
                  <span style={{ flex: 1 }}><strong>{i.title}</strong>{i.detail && <span className="muted" style={{ display: 'block', marginTop: 2 }}>{i.detail}</span>}</span>
                  <span className="muted" aria-hidden="true">{isOpen ? '▲' : '▼'}</span>
                </button>
                {isOpen && (
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)', display: 'grid', gap: 10 }}>
                    {i.meaning && <div><div className="muted" style={{ fontSize: 12, marginBottom: 2 }}>What this means</div>{i.meaning}</div>}
                    {ev?.kind === 'transactions' && (
                      <div>
                        <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>The numbers behind it ({ev.total} transaction{ev.total === 1 ? '' : 's'}, {formatCents(ev.sumCents, { sign: true })} net{ev.rows.length < ev.total ? `, largest ${ev.rows.length} shown` : ''})</div>
                        <div className="table-wrap"><table><tbody>
                          {ev.rows.map((r) => <tr key={r.id}><td className="num">{r.date}</td><td><button className="txn-link" title="Show this transaction in its account" onClick={() => goto('transactions', txnPreset(r))}>{r.description}</button><div className="muted">{r.category ?? r.account}</div></td><td className="r num">{formatCents(r.amountCents, { sign: true })}</td></tr>)}
                        </tbody></table></div>
                      </div>
                    )}
                    {ev?.kind === 'budget' && <div className="kv"><div><div className="k">Budget</div><div className="v num">{formatCents(ev.line.budgetCents)}</div></div><div><div className="k">Spent</div><div className="v num">{formatCents(ev.line.spentCents)}</div></div><div><div className="k">Left</div><div className="v num">{formatCents(ev.line.remainingCents)}</div></div><div><div className="k">Categories</div><div className="v">{ev.line.categoryNames.join(', ')}</div></div></div>}
                    {ev?.kind === 'goal' && <div className="kv"><div><div className="k">Target</div><div className="v num">{formatCents(ev.goal.targetCents)}</div></div><div><div className="k">So far</div><div className="v num">{ev.goal.progress.achievedCents === null ? '—' : formatCents(ev.goal.progress.achievedCents)}</div></div><div><div className="k">Remaining</div><div className="v num">{formatCents(ev.goal.progress.remainingCents)}</div></div><div><div className="k">Planned / month</div><div className="v num">{ev.goal.plannedMonthlyCents ? formatCents(ev.goal.plannedMonthlyCents) : 'Not set'}</div></div></div>}
                    {i.ref && <div><button className="btn" onClick={() => goToRef(i)}>Open {PAGE_LABEL[i.ref.page]}{i.ref.page === 'transactions' ? ' for this' : ''}</button></div>}
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      )}
    </>
  )
}
