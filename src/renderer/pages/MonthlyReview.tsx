import { useEffect, useState } from 'react'
import { api } from '../api'
import { Card, Delta, ErrorBox, ProgressBar, StateBadge, Stat } from '../components/ui'
import { formatCents, monthLabel, pct } from '../format'
import type { MonthlyReview as Review } from '../../db/monthly'
import type { Profile } from '../../db/queries'
import type { Page } from '../App'

const TYPE_LABEL = { fact: 'Fact', trend: 'Trend', anomaly: 'Unusual', recommendation: 'Worth a look' } as const

export function MonthlyReview({ profile, goto }: { profile: Profile; goto: (p: Page) => void }) {
  const [month, setMonth] = useState<string | undefined>()
  const [data, setData] = useState<Review | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { api('monthlyReview', profile.id, month).then(setData).catch((e: Error) => setError(e.message)) }, [profile.id, month])

  if (error) return <ErrorBox error={error} />
  if (data === undefined) return <p className="muted">Loading…</p>
  if (data === null) return <Card><h2>Nothing to review yet</h2><p className="sub">There are no transactions for {profile.name} yet.</p></Card>

  const s = data.summary
  const prev = data.previous
  const verdict = s.incomeCents === 0 && s.expenseCents === 0 ? 'No activity recorded.' : s.netCents >= 0 ? `You came out ${formatCents(s.netCents)} ahead.` : `You spent ${formatCents(-s.netCents)} more than you brought in.`
  const overBudgets = data.budget.lines.filter((l) => l.state === 'over')

  return (
    <>
      <div className="page-head">
        <div><h1>Monthly review · {monthLabel(data.month)}</h1><p>{verdict}</p></div>
        <label className="field">Month<select value={data.month} onChange={(e) => setMonth(e.target.value)}>{[...data.availableMonths].reverse().map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}</select></label>
      </div>

      {(data.pending.reviewCount > 0 || data.pending.uncategorizedCount > 0) && (
        <div className="banner">
          <span>{data.pending.reviewCount > 0 && <>{data.pending.reviewCount} transactions are waiting for your review and are not counted. </>}{data.pending.uncategorizedCount > 0 && <>{data.pending.uncategorizedCount} this month have no category.</>}</span>
          <button className="btn small" onClick={() => goto('review')}>Review now</button>
        </div>
      )}

      <div className="grid stats">
        <Stat label="Total income" value={formatCents(s.incomeCents)} hint={prev ? <Delta now={s.incomeCents} then={prev.incomeCents} goodWhen="up" /> : undefined} />
        <Stat label="Total spending" value={formatCents(s.expenseCents)} hint={prev ? <Delta now={s.expenseCents} then={prev.expenseCents} goodWhen="down" /> : undefined} />
        <Stat label="Net income" value={formatCents(s.netCents, { sign: true })} tone={s.netCents < 0 ? 'neg' : 'pos'} hint={prev ? <Delta now={s.netCents} then={prev.netCents} goodWhen="up" /> : undefined} />
        <Stat label="Savings rate" value={pct(s.savingsRate)} hint={prev ? `Last month ${pct(prev.savingsRate)}` : undefined} />
        <Stat label="Over budget" value={`${overBudgets.length} of ${data.budget.lines.length}`} tone={overBudgets.length ? 'neg' : undefined} />
      </div>

      <div className="grid two">
        <Card>
          <div className="card-head"><h2>Budget performance</h2><button className="btn small" onClick={() => goto('budget')}>Open budgets</button></div>
          {data.budget.lines.length === 0 ? <p className="muted">No budgets set. <button className="btn small" onClick={() => goto('budget')}>Add a budget</button></p> : (
            <div className="table-wrap"><table><tbody>
              {data.budget.lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.name}<ProgressBar value={l.ratio ?? (l.spentCents > 0 ? 1 : 0)} tone={l.state} label={`${l.name} budget used`} /></td>
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
                  <tr key={c.name}><td>{c.name}</td><td className="r num">{formatCents(c.cents)}</td><td className="r"><Delta now={c.cents} then={c.prevCents} goodWhen="down" /></td></tr>
                ))}
              </tbody>
            </table></div>
          )}
        </Card>
      </div>

      <div className="grid two">
        <Card>
          <div className="card-head"><h2>Biggest expenses</h2></div>
          <div className="table-wrap"><table><tbody>
            {data.topExpenses.map((t) => <tr key={t.id}><td className="num">{t.date.slice(5)}</td><td>{t.description}<div className="muted" style={{ fontSize: 12 }}>{t.category ?? 'Uncategorized'}</div></td><td className="r num">{formatCents(t.cents)}</td></tr>)}
          </tbody></table></div>
        </Card>
        <Card>
          <div className="card-head"><h2>Biggest spending categories</h2></div>
          <div className="table-wrap"><table><tbody>
            {Object.entries(s.byCategory).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, cents]) => <tr key={name}><td>{name}</td><td className="r num">{formatCents(cents)}</td><td className="r muted num">{pct(s.expenseCents > 0 ? cents / s.expenseCents : null)}</td></tr>)}
          </tbody></table></div>
        </Card>
      </div>

      <div className="grid two">
        <Card>
          <div className="card-head"><h2>Recurring bills</h2><span className="muted">Matched by name or amount, so treat "not seen" as a prompt to check</span></div>
          {data.recurring.length === 0 ? <p className="muted">No regular bills to check.</p> : (
            <div className="table-wrap"><table><tbody>
              {data.recurring.map((r) => (
                <tr key={r.name}>
                  <td>{r.name}<div className="muted" style={{ fontSize: 12 }}>{r.account ?? ''}</div></td>
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
                  <td>{g.name}<ProgressBar value={g.progress.progress} tone="goal" label={`${g.name} progress`} /></td>
                  <td className="r num">{pct(g.progress.progress)}<div className="muted" style={{ fontSize: 12 }}>{g.progress.estimatedMonth ? `est. ${monthLabel(g.progress.estimatedMonth)}` : ''}</div></td>
                </tr>
              ))}
            </tbody></table></div>
          )}
        </Card>
      </div>

      <Card>
        <div className="card-head"><h2>Insights</h2><span className="muted">From your recorded data only</span></div>
        {data.insights.length === 0 ? <p className="muted">Not enough data for insights.</p> : (
          <div className="insights">
            {data.insights.map((i, idx) => (
              <div className="insight" key={idx}>
                <span className={`badge ${i.tone === 'warn' ? 'warn' : i.tone === 'good' ? 'good' : ''}`}>{TYPE_LABEL[i.type]}</span>
                <div><strong>{i.title}</strong>{i.detail && <p>{i.detail}</p>}</div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  )
}
