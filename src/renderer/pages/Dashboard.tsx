import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { Chart, type ChartColors } from '../components/Chart'
import { Card, ChartCard, Delta, ErrorBox, Segmented, Stat } from '../components/ui'
import { formatCents, monthLabel, pct, shortMonth } from '../format'
import type { Dashboard as DashboardData, CategoryInfo, RecurringRow, Profile } from '../../db/queries'
import type { Page, TxnPreset } from '../App'

type Period = '3' | '6' | '12' | 'ytd' | 'all'
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const dollars = (cents: number) => (Math.abs(cents) >= 100000 ? `${(cents / 100000).toFixed(1)}k` : `${Math.round(cents / 100)}`)
const TYPE_LABEL = { fact: 'Fact', trend: 'Trend', anomaly: 'Unusual', recommendation: 'Worth a look' } as const

export function Dashboard({ profile, categories, goto }: { profile: Profile; categories: CategoryInfo[]; goto: (p: Page, preset?: TxnPreset) => void }) {
  const [month, setMonth] = useState<string | undefined>()
  const [period, setPeriod] = useState<Period>('6')
  const [data, setData] = useState<DashboardData | null | undefined>(undefined)
  const [recurring, setRecurring] = useState<RecurringRow[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api('dashboard', profile.id, month).then(setData).catch((e: Error) => setError(e.message))
  }, [profile.id, month])
  useEffect(() => {
    api('recurring', profile.id).then(setRecurring).catch(() => {})
  }, [profile.id])

  const series = useMemo(() => {
    if (!data) return []
    const upTo = data.series.filter((s) => s.month <= data.month)
    if (period === 'all') return upTo
    if (period === 'ytd') return upTo.filter((s) => s.month.slice(0, 4) === data.month.slice(0, 4))
    return upTo.slice(-Number(period))
  }, [data, period])

  const barOption = useMemo(
    () => (c: ChartColors) => ({
      grid: { left: 52, right: 12, top: 36, bottom: 28 },
      legend: { top: 0, right: 0, textStyle: { color: c.text2 }, itemWidth: 12, itemHeight: 12 },
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: c.surface, borderColor: c.grid, textStyle: { color: c.text },
        formatter: (p: { dataIndex: number }[]) => {
          const s = series[p[0]!.dataIndex]!
          return `<b>${monthLabel(s.month)}</b><br/>Income: ${formatCents(s.incomeCents)}<br/>Spending: ${formatCents(s.expenseCents)}<br/>Net: ${formatCents(s.netCents, { sign: true })}`
        }
      },
      xAxis: { type: 'category', data: series.map((s) => shortMonth(s.month)), axisLine: { lineStyle: { color: c.grid } }, axisTick: { show: false }, axisLabel: { color: c.muted } },
      yAxis: { type: 'value', axisLabel: { color: c.muted, formatter: (v: number) => `$${dollars(v * 100)}` }, splitLine: { lineStyle: { color: c.grid } } },
      series: [
        { name: 'Income', type: 'bar', data: series.map((s) => s.incomeCents / 100), itemStyle: { color: c.s1, borderRadius: [4, 4, 0, 0], borderColor: c.surface, borderWidth: 1 }, barMaxWidth: 22 },
        { name: 'Spending', type: 'bar', data: series.map((s) => s.expenseCents / 100), itemStyle: { color: c.s2, borderRadius: [4, 4, 0, 0], borderColor: c.surface, borderWidth: 1 }, barMaxWidth: 22 }
      ]
    }),
    [series]
  )

  const cumulative = useMemo(() => {
    let run = 0
    return series.map((s) => (run += s.netCents))
  }, [series])
  const lineOption = useMemo(
    () => (c: ChartColors) => ({
      grid: { left: 56, right: 16, top: 16, bottom: 28 },
      tooltip: {
        trigger: 'axis', backgroundColor: c.surface, borderColor: c.grid, textStyle: { color: c.text },
        formatter: (p: { dataIndex: number }[]) => `<b>${monthLabel(series[p[0]!.dataIndex]!.month)}</b><br/>Net that month: ${formatCents(series[p[0]!.dataIndex]!.netCents, { sign: true })}<br/>Cumulative: ${formatCents(cumulative[p[0]!.dataIndex]!)}`
      },
      xAxis: { type: 'category', data: series.map((s) => shortMonth(s.month)), axisLine: { lineStyle: { color: c.grid } }, axisTick: { show: false }, axisLabel: { color: c.muted } },
      yAxis: { type: 'value', axisLabel: { color: c.muted, formatter: (v: number) => `$${dollars(v * 100)}` }, splitLine: { lineStyle: { color: c.grid } } },
      series: [{ type: 'line', data: cumulative.map((v) => v / 100), lineStyle: { width: 2, color: c.s1 }, itemStyle: { color: c.s1, borderColor: c.surface, borderWidth: 2 }, symbolSize: 8, areaStyle: { color: c.s1, opacity: 0.08 } }]
    }),
    [series, cumulative]
  )

  const cats = useMemo(() => {
    if (!data) return []
    const all = Object.entries(data.summary.byCategory).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])
    const top = all.slice(0, 8)
    const rest = all.slice(8).reduce((a, [, v]) => a + v, 0)
    return rest > 0 ? [...top, ['Other', rest] as [string, number]] : top
  }, [data])
  const catOption = useMemo(
    () => (c: ChartColors) => ({
      grid: { left: 8, right: 70, top: 4, bottom: 4, containLabel: true },
      tooltip: { trigger: 'item', backgroundColor: c.surface, borderColor: c.grid, textStyle: { color: c.text }, formatter: (p: { name: string; value: number }) => `${esc(p.name)}<br/><b>${formatCents(Math.round(p.value * 100))}</b>` },
      xAxis: { type: 'value', show: false },
      yAxis: { type: 'category', inverse: true, data: cats.map(([n]) => n), axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: c.text2, width: 150, overflow: 'truncate' } },
      series: [{ type: 'bar', data: cats.map(([, v]) => v / 100), itemStyle: { color: c.s1, borderRadius: [0, 4, 4, 0] }, barMaxWidth: 16, label: { show: true, position: 'right', color: c.text2, formatter: (p: { value: number }) => `$${Math.round(p.value).toLocaleString()}` } }]
    }),
    [cats]
  )

  if (error) return <ErrorBox error={error} />
  if (data === undefined) return <p className="muted">Loading…</p>
  if (data === null) return <Card><h2>No transactions yet</h2><p className="sub">Nothing has been recorded for {profile.name}. Import transactions or add tips from the Cash page.</p></Card>

  const s = data.summary
  const catId = (name: string) => categories.find((c) => c.kind === 'expense' && c.name === name)?.id
  const monthRange = { from: `${data.month}-01`, to: `${data.month}-31` }
  const comparisons: { label: string; sum: typeof s | null; avg?: boolean }[] = [
    { label: 'Previous month', sum: data.previous },
    { label: 'Same month last year', sum: data.lastYear }
  ]
  const avg = data.average
  const topRecurring = [...recurring].filter((r) => r.direction === 'expense' && r.countsInBudget && r.status !== 'cancelled').sort((a, b) => b.monthlyCents - a.monthlyCents).slice(0, 5)

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{monthLabel(data.month)}</h1>
          <p>How {profile.name}'s finances performed this month.</p>
        </div>
        <label className="field">
          Month
          <select value={data.month} onChange={(e) => setMonth(e.target.value)} aria-label="Select month">
            {[...data.availableMonths].reverse().map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
        </label>
      </div>

      {data.reviewCount > 0 && (
        <div className="banner">
          <span>{data.reviewCount} transaction{data.reviewCount === 1 ? '' : 's'} need your review. Until then they are not counted as income or spending.</span>
          <button className="btn small" onClick={() => goto('review')}>Review now</button>
        </div>
      )}

      <div className="grid stats">
        <Stat label="Income" value={formatCents(s.incomeCents)} hint="Recorded income this month" />
        <Stat label="Spending" value={formatCents(s.expenseCents)} hint="After refunds, excluding transfers" />
        <Stat label="Net" value={formatCents(s.netCents, { sign: true })} tone={s.netCents < 0 ? 'neg' : 'pos'} hint={`Savings rate ${pct(s.savingsRate)}`} />
        <Stat label="Accounts" value={formatCents(data.assetsCents)} hint={`Owed: ${formatCents(data.owedCardsCents)} on cards${data.otherDebtCents ? ` + ${formatCents(data.otherDebtCents)} loans` : ''}`} />
        {!data.budget && <Stat label="Budget" value="Not set" hint={<button className="btn small" onClick={() => goto('budget')}>Add a budget</button>} />}
        {data.budget && <Stat label="Budget left" value={formatCents(data.budget.remainingCents)} tone={data.budget.remainingCents < 0 ? 'neg' : undefined} hint={`${formatCents(data.budget.spentCents)} of ${formatCents(data.budget.budgetCents)}${data.budget.overCount ? ` · ${data.budget.overCount} over` : ''}`} />}
        <Stat label="Recurring bills" value={`${formatCents(data.recurring.monthlyCents)}/mo`} hint={`${formatCents(data.recurring.annualCents)}/yr · ${pct(data.recurring.pctOfIncome)} of avg income`} />
      </div>

      <Card className="compare" >
        <div className="card-head"><h2>Compared with</h2></div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th></th><th className="r">{monthLabel(data.month)}</th>{comparisons.map((c) => <th key={c.label} className="r">{c.label}</th>)}<th className="r">Average{avg ? ` (${avg.months} mo)` : ''}</th></tr>
            </thead>
            <tbody>
              {([['Income', s.incomeCents, 'incomeCents', 'up'], ['Spending', s.expenseCents, 'expenseCents', 'down'], ['Net', s.netCents, 'netCents', 'up']] as const).map(([label, now, key, good]) => (
                <tr key={label}>
                  <td>{label}</td>
                  <td className="r num"><b>{formatCents(now)}</b></td>
                  {comparisons.map((c) => (
                    <td key={c.label} className="r num">{c.sum ? <>{formatCents(c.sum[key])}<br /><Delta now={now} then={c.sum[key]} goodWhen={good} /></> : <span className="muted">no data</span>}</td>
                  ))}
                  <td className="r num">{avg ? <>{formatCents(avg[key])}<br /><Delta now={now} then={avg[key]} goodWhen={good} /></> : <span className="muted">no data</span>}</td>
                </tr>
              ))}
              <tr>
                <td>Savings rate</td>
                <td className="r num"><b>{pct(s.savingsRate)}</b></td>
                {comparisons.map((c) => <td key={c.label} className="r num">{c.sum ? pct(c.sum.savingsRate) : <span className="muted">no data</span>}</td>)}
                <td className="r num">{avg && avg.incomeCents > 0 ? pct(avg.netCents / avg.incomeCents) : <span className="muted">no data</span>}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      <div style={{ height: 16 }} />
      <div className="grid two">
        <ChartCard
          title="Income vs spending"
          subtitle="Hover a month for the exact figures"
          controls={<Segmented small label="Time period" value={period} onChange={setPeriod} options={[{ value: '3', label: '3M' }, { value: '6', label: '6M' }, { value: '12', label: '12M' }, { value: 'ytd', label: 'YTD' }, { value: 'all', label: 'All' }]} />}
          table={{ headers: ['Month', 'Income', 'Spending', 'Net'], rows: series.map((m) => [monthLabel(m.month), formatCents(m.incomeCents), formatCents(m.expenseCents), formatCents(m.netCents, { sign: true })]) }}
        >
          <Chart build={barOption} label="Bar chart of monthly income and spending" />
        </ChartCard>
        <ChartCard
          title={`Where the money went · ${monthLabel(data.month)}`}
          subtitle="Click a bar to see those transactions"
          table={{ headers: ['Category', 'Spent'], rows: cats.map(([n, v]) => [n, formatCents(v)]) }}
        >
          <Chart build={catOption} height={Math.max(220, cats.length * 30 + 20)} label="Bar chart of spending by category this month" onClick={(name) => { const id = catId(name); if (id) goto('transactions', { categoryId: id, ...monthRange }) }} />
        </ChartCard>
      </div>

      <div className="grid two">
        <ChartCard title="Cumulative net" subtitle="Running total of recorded income minus spending over the period" table={{ headers: ['Month', 'Net', 'Cumulative'], rows: series.map((m, i) => [monthLabel(m.month), formatCents(m.netCents, { sign: true }), formatCents(cumulative[i]!)]) }}>
          <Chart build={lineOption} label="Line chart of cumulative net" />
        </ChartCard>
        <Card>
          <div className="card-head"><h2>Insights</h2><button className="btn small" onClick={() => goto('insights')}>See all and what they mean</button></div>
          {data.insights.length === 0 ? <p className="muted">Not enough data for insights yet.</p> : (
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
      </div>

      <div className="grid two">
        <Card>
          <div className="card-head"><h2>Largest expenses</h2></div>
          <div className="table-wrap"><table><tbody>
            {data.largestExpenses.map((t) => (
              <tr key={t.id}><td>{t.date.slice(5)}</td><td>{t.description}<div className="muted">{t.category ?? 'Uncategorized'}</div></td><td className="r num">{formatCents(t.cents)}</td></tr>
            ))}
          </tbody></table></div>
        </Card>
        <Card>
          <div className="card-head"><h2>Biggest recurring bills</h2><button className="btn small" onClick={() => goto('recurring')}>See all</button></div>
          {topRecurring.length === 0 ? <p className="muted">No recurring bills recorded.</p> : (
            <div className="table-wrap"><table><tbody>
              {topRecurring.map((r) => <tr key={r.id}><td>{r.name}<div className="muted">{r.account ?? r.paidWith ?? ''}</div></td><td className="r num">{formatCents(r.monthlyCents)}/mo</td></tr>)}
            </tbody></table></div>
          )}
        </Card>
      </div>
    </>
  )
}
