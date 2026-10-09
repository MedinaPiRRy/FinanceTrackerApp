import { useCallback, useEffect, useState } from 'react'
import { monthEnd } from '../../core/budgets'
import { useKept } from '../nav'
import { api } from '../api'
import { ReviewNotice } from '../components/ReviewNotice'
import { BudgetDrill } from '../components/BudgetDrill'
import { txnPreset } from '../txnLink'
import { Card, Delta, ErrorBox, ProgressBar, StateBadge, Stat } from '../components/ui'
import { formatCents, monthLabel, pct } from '../format'
import type { MonthlyReview as Review } from '../../db/monthly'
import type { CategoryInfo, Profile } from '../../db/queries'
import type { Page, TxnPreset } from '../App'

const TYPE_LABEL = { fact: 'Fact', trend: 'Trend', anomaly: 'Unusual', recommendation: 'Worth a look' } as const

export function MonthlyReview({ profile, goto, categories }: { profile: Profile; goto: (p: Page, pre?: TxnPreset) => void; categories: CategoryInfo[] }) {
  const [month, setMonth] = useKept<string | undefined>('month', undefined)
  const [drillId, setDrillId] = useKept<number | null>('drillId', null)
  const [data, setData] = useState<Review | null | undefined>(undefined)
  const drillLoad = useCallback(() => api('budgetDrill', profile.id, drillId!, (month ?? data?.month)!), [profile.id, drillId, month]) // eslint-disable-line react-hooks/exhaustive-deps
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { api('monthlyReview', profile.id, month).then(setData).catch((e: Error) => setError(e.message)) }, [profile.id, month])

  if (error) return <ErrorBox error={error} />
  if (data === undefined) return <p className="muted">Loading…</p>
  if (data === null) return <Card><h2>Nothing to review yet</h2><p className="sub">There are no transactions for {profile.name} yet.</p></Card>

  const s = data.summary
  const prev = data.previous
  /** Open the Transactions page on this month, optionally for one kind of money or one category. */
  const go = (kind?: string, categoryName?: string) => goto('transactions', { kind, categoryId: categoryName ? categories.find((c) => c.kind === 'expense' && c.name === categoryName)?.id : undefined, from: `${data.month}-01`, to: monthEnd(data.month) })
  const verdict = s.incomeCents === 0 && s.expenseCents === 0 ? 'No activity recorded.' : s.netCents >= 0 ? `You came out ${formatCents(s.netCents)} ahead.` : `You spent ${formatCents(-s.netCents)} more than you brought in.`
  const overBudgets = data.budget.lines.filter((l) => l.state === 'over')

  return (
    <>
      <div className="page-head">
        <div><h1>Monthly review · {monthLabel(data.month)}</h1><p>{verdict}</p></div>
        <label className="field">Month<select value={data.month} onChange={(e) => setMonth(e.target.value)}>{[...data.availableMonths].reverse().map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}</select></label>
      </div>

      <ReviewNotice profileId={profile.id} goto={goto} />
      {(data.pending.reviewCount > 0 || data.pending.uncategorizedCount > 0) && (
        <div className="banner">
          <span>{data.pending.reviewCount > 0 && <>{data.pending.reviewCount} transactions are waiting for your review and are not counted. </>}{data.pending.uncategorizedCount > 0 && <>{data.pending.uncategorizedCount} this month have no category.</>}</span>
          <button className="btn small" onClick={() => goto('review')}>Review now</button>
        </div>
      )}

      <div className="grid stats">
        <Stat label="Total income" value={formatCents(s.incomeCents)} hint={prev ? <Delta now={s.incomeCents} then={prev.incomeCents} goodWhen="up" /> : undefined} onClick={() => go('income')} title="See the money that came in" />
        <Stat label="Total spending" value={formatCents(s.expenseCents)} hint={prev ? <Delta now={s.expenseCents} then={prev.expenseCents} goodWhen="down" /> : undefined} onClick={() => go('expense,refund')} title="See the money that went out" />
        <Stat label="Net income" value={formatCents(s.netCents, { sign: true })} tone={s.netCents < 0 ? 'neg' : 'pos'} hint={prev ? <Delta now={s.netCents} then={prev.netCents} goodWhen="up" /> : undefined} onClick={() => go('income,expense,refund')} title="See all the income and spending" />
        <Stat label="Savings rate" value={pct(s.savingsRate)} hint={prev ? `Last month ${pct(prev.savingsRate)}` : undefined} onClick={() => go('income,expense,refund')} title="See the income and spending behind it" />
        <Stat label="Over budget" value={`${overBudgets.length} of ${data.budget.lines.length}`} tone={overBudgets.length ? 'neg' : undefined} onClick={() => goto('budget', { month: data.month })} title="Open this month's budgets" />
      </div>

      {drillId !== null && <BudgetDrill load={drillLoad} goto={goto} onClose={() => setDrillId(null)} />}
      <div className="grid two">
        <Card>
          <div className="card-head"><h2>Budget performance</h2><button className="btn small" onClick={() => goto('budget')}>Open budgets</button></div>
          {data.budget.lines.length === 0 ? <p className="muted">No budgets set. <button className="btn small" onClick={() => goto('budget')}>Add a budget</button></p> : (
            <div className="table-wrap"><table><tbody>
              {data.budget.lines.map((l) => (
                <tr key={l.id}>
                  <td><button className="txn-link" title="See the transactions in this budget, by account" onClick={() => setDrillId(l.id)}>{l.name}</button><ProgressBar value={l.ratio ?? (l.spentCents > 0 ? 1 : 0)} tone={l.state} label={`${l.name} budget used`} /></td>
                  <td className="r num">{formatCents(l.spentCents)}<div className="muted" style={{ fontSize: 12 }}>of {formatCents(l.budgetCents)}</div></td>
                  <td><StateBadge state={l.state} /></td>
                </tr>
              ))}
            </tbody></table></div>
          )}
        </Card>

        <Card>
          <div className="card-head"><h2>What changed from {prev ? monthLabel(prev.month) : 'last month'}</h2></div>
          {data.categoryChanges.length === 0 ? <p className="muted">No earlier month to compare with.</p> : (
            <div className="table-wrap"><table>
              <thead><tr><th>Category</th><th className="r">This month</th><th className="r">Change</th></tr></thead>
              <tbody>
                {data.categoryChanges.map((c) => (
                  <tr key={c.name}><td><button className="txn-link" title="See this category's transactions this month" onClick={() => go(undefined, c.name)}>{c.name}</button></td><td className="r num">{formatCents(c.cents)}</td><td className="r"><Delta now={c.cents} then={c.prevCents} goodWhen="down" /></td></tr>
                ))}
              </tbody>
            </table></div>
          )}
        </Card>
      </div>

      <div className="grid two">
        <Card>
          <div className="card-head"><h2>Biggest expenses</h2><button className="btn small" onClick={() => go('expense')}>See all spending</button></div>
          <div className="table-wrap"><table><tbody>
            {data.topExpenses.map((t) => <tr key={t.id}><td className="num">{t.date.slice(5)}</td><td><button className="txn-link" title="Show this transaction in its account" onClick={() => goto('transactions', txnPreset(t))}>{t.description}</button><div className="muted" style={{ fontSize: 12 }}>{t.category ?? 'Uncategorized'}</div></td><td className="r num">{formatCents(t.cents)}</td></tr>)}
          </tbody></table></div>
        </Card>
        <Card>
          <div className="card-head"><h2>Biggest spending categories</h2></div>
          <div className="table-wrap"><table><tbody>
            {Object.entries(s.byCategory).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, cents]) => <tr key={name}><td><button className="txn-link" title="See this category's transactions this month" onClick={() => go(undefined, name)}>{name}</button></td><td className="r num">{formatCents(cents)}</td><td className="r muted num">{pct(s.expenseCents > 0 ? cents / s.expenseCents : null)}</td></tr>)}
          </tbody></table></div>
        </Card>
      </div>

      <div className="grid two">
        <Card>
          <div className="card-head"><h2>Recurring bills</h2><button className="btn small" onClick={() => goto('recurring')}>Open recurring</button><span className="muted">Matched by name or amount, so treat "not seen" as a prompt to check</span></div>
          {data.recurring.length === 0 ? <p className="muted">No regular bills to check.</p> : (
            <div className="table-wrap"><table><tbody>
              {data.recurring.map((r) => (
                <tr key={r.name}>
                  <td><button className="txn-link" title="Open recurring bills" onClick={() => goto('recurring')}>{r.name}</button><div className="muted" style={{ fontSize: 12 }}>{r.account ?? ''}</div></td>
                  <td className="r num">{formatCents(r.paidCents ?? r.expectedCents)}{r.date && <div className="muted" style={{ fontSize: 12 }}>{r.date}</div>}</td>
                  <td>{r.status === 'paid' ? <span className="badge good">✓ Paid</span> : <span className="badge warn">? Not seen</span>}</td>
                </tr>
              ))}
            </tbody></table></div>
          )}
        </Card>
        <Card>
          <div className="card-head"><h2>Financial goals</h2><button className="btn small" onClick={() => goto('goals')}>Open goals</button></div>
          {data.goals.length === 0 ? <p className="muted">No goals yet. <button className="btn small" onClick={() => goto('goals')}>Add a goal</button></p> : (
            <div className="table-wrap"><table><tbody>
              {data.goals.map((g) => (
                <tr key={g.id}>
                  <td><button className="txn-link" title="Open your goals" onClick={() => goto('goals')}>{g.name}</button><ProgressBar value={g.progress.progress} tone="goal" label={`${g.name} progress`} /></td>
                  <td className="r num">{pct(g.progress.progress)}<div className="muted" style={{ fontSize: 12 }}>{g.progress.estimatedMonth ? `est. ${monthLabel(g.progress.estimatedMonth)}` : ''}</div></td>
                </tr>
              ))}
            </tbody></table></div>
          )}
        </Card>
      </div>

      <Card>
        <div className="card-head"><h2>Insights</h2><button className="btn small" onClick={() => goto('insights')}>Open insights</button><span className="muted">From your recorded data only</span></div>
        {data.insights.length === 0 ? <p className="muted">Not enough data for insights.</p> : (
          <div className="insights">
            {data.insights.map((i, idx) => (
              <div className="insight" key={idx}>
                <span className={`badge ${i.tone === 'warn' ? 'warn' : i.tone === 'good' ? 'good' : ''}`}>{TYPE_LABEL[i.type]}</span>
                <div><button className="txn-link" title="Open this insight and see what is behind it" onClick={() => goto('insights', { insightId: i.id })}><strong>{i.title}</strong></button>{i.detail && <p>{i.detail}</p>}</div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  )
}
