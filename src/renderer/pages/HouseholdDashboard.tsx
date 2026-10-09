import { useEffect, useMemo, useState } from 'react'
import { monthEnd } from '../../core/budgets'
import { useKept } from '../nav'
import { api } from '../api'
import { ReviewNotice } from '../components/ReviewNotice'
import { Chart, type ChartColors } from '../components/Chart'
import { Card, ChartCard, ErrorBox, Segmented, Stat } from '../components/ui'
import { formatCents, monthLabel, pct, shortMonth } from '../format'
import type { HouseholdOverview } from '../../db/household'
import type { Page, TxnPreset } from '../App'

type Period = '3' | '6' | '12' | 'all'
const dollars = (cents: number) => (Math.abs(cents) >= 100000 ? `${(cents / 100000).toFixed(1)}k` : `${Math.round(cents / 100)}`)
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** Colour slot by owner position so each person keeps their colour everywhere: first person blue, second orange, shared aqua. */
const slotColor = (c: ChartColors, i: number) => [c.s1, c.s2, c.s3][i] ?? c.s3
const slotVar = (i: number) => ['var(--series-1)', 'var(--series-2)', 'var(--series-3)'][i] ?? 'var(--series-3)'

export function HouseholdDashboard({ goto }: { goto: (p: Page, preset?: TxnPreset) => void }) {
  const [month, setMonth] = useKept<string | undefined>('month', undefined)
  const [period, setPeriod] = useKept<Period>('period', '6')
  const [data, setData] = useState<HouseholdOverview | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { api('householdOverview', month).then(setData).catch((e: Error) => setError(e.message)) }, [month])

  const series = useMemo(() => {
    if (!data) return []
    const upTo = data.series.filter((s) => s.month <= data.month)
    return period === 'all' ? upTo : upTo.slice(-Number(period))
  }, [data, period])

  const barOption = useMemo(() => (c: ChartColors) => {
    const owners = data?.owners ?? []
    return {
      grid: { left: 52, right: 12, top: 36, bottom: 28 },
      legend: { top: 0, right: 0, textStyle: { color: c.text2 }, itemWidth: 12, itemHeight: 12 },
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: c.surface, borderColor: c.grid, textStyle: { color: c.text },
        formatter: (p: { dataIndex: number }[]) => {
          const s = series[p[0]!.dataIndex]!
          const lines = owners.filter((o) => (s.perOwnerExpense[o.profileId] ?? 0) !== 0).map((o) => `${esc(o.name)}: ${formatCents(s.perOwnerExpense[o.profileId] ?? 0)}`).join('<br/>')
          return `<b>${monthLabel(s.month)}</b><br/>${lines}<br/><b>Together: ${formatCents(s.expenseCents)}</b><br/>Income: ${formatCents(s.incomeCents)}`
        }
      },
      xAxis: { type: 'category', data: series.map((s) => shortMonth(s.month)), axisLine: { lineStyle: { color: c.grid } }, axisTick: { show: false }, axisLabel: { color: c.muted } },
      yAxis: { type: 'value', axisLabel: { color: c.muted, formatter: (v: number) => `$${dollars(v * 100)}` }, splitLine: { lineStyle: { color: c.grid } } },
      series: owners.map((o, i) => ({ name: o.name, type: 'bar', stack: 'spend', data: series.map((s) => (s.perOwnerExpense[o.profileId] ?? 0) / 100), itemStyle: { color: slotColor(c, i), borderColor: c.surface, borderWidth: 1 }, barMaxWidth: 34 }))
    }
  }, [series, data])

  const topGroups = useMemo(() => (data ? data.groups.slice(0, 8) : []), [data])
  const groupOption = useMemo(() => (c: ChartColors) => {
    const owners = data?.owners ?? []
    return {
      grid: { left: 8, right: 70, top: 28, bottom: 4, containLabel: true },
      legend: { top: 0, right: 0, textStyle: { color: c.text2 }, itemWidth: 12, itemHeight: 12 },
      tooltip: {
        trigger: 'axis', axisPointer: { type: 'shadow' }, backgroundColor: c.surface, borderColor: c.grid, textStyle: { color: c.text },
        formatter: (p: { dataIndex: number }[]) => {
          const g = topGroups[p[0]!.dataIndex]!
          return `<b>${esc(g.group)}</b>: ${formatCents(g.totalCents)}<br/>${owners.filter((o) => (g.perOwner[o.profileId] ?? 0) !== 0).map((o) => `${esc(o.name)}: ${formatCents(g.perOwner[o.profileId] ?? 0)}`).join('<br/>')}`
        }
      },
      xAxis: { type: 'value', show: false },
      yAxis: { type: 'category', inverse: true, data: topGroups.map((g) => g.group), axisLine: { show: false }, axisTick: { show: false }, axisLabel: { color: c.text2, width: 150, overflow: 'truncate' } },
      series: owners.map((o, i) => ({ name: o.name, type: 'bar', stack: 'g', data: topGroups.map((g) => (g.perOwner[o.profileId] ?? 0) / 100), itemStyle: { color: slotColor(c, i), borderColor: c.surface, borderWidth: 1 }, barMaxWidth: 16 }))
    }
  }, [topGroups, data])

  if (error) return <ErrorBox error={error} />
  if (data === undefined) return <p className="muted">Loading…</p>
  if (data === null) return <Card><h2>No household activity yet</h2><p className="sub">There are no recorded transactions to combine.</p></Card>

  const c = data.combined
  /** Open the household Transactions page on this month (or another), for one kind of money, one person or one category group. */
  const go = (opts: { kind?: string; personId?: number; groupName?: string; month?: string } = {}) => { const m = opts.month ?? data.month; goto('transactions', { kind: opts.kind, personId: opts.personId, groupName: opts.groupName, from: `${m}-01`, to: monthEnd(m) }) }
  const active = data.perOwner.filter((o) => o.kind === 'person' || o.incomeCents !== 0 || o.expenseCents !== 0)
  return (
    <>
      <div className="page-head">
        <div><h1>Household · {monthLabel(data.month)}</h1><p>Both of you together, with each person's share. Your own finances stay separate: use the tabs at the top to see them.</p></div>
        <label className="field">Month<select value={data.month} onChange={(e) => setMonth(e.target.value)} aria-label="Select month">{[...data.availableMonths].reverse().map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}</select></label>
      </div>

      <ReviewNotice profileId={null} goto={goto} />
      {data.pendingReview > 0 && <div className="banner"><span>{data.pendingReview} transactions across your finances are waiting for review. Until then they are not counted as income or spending.</span></div>}

      <div className="grid stats">
        <Stat label="Combined income" value={formatCents(c.incomeCents)} hint="Both of you plus shared accounts" onClick={() => go({ kind: 'income' })} title="See the money that came in" />
        <Stat label="Combined spending" value={formatCents(c.expenseCents)} hint="After refunds, excluding transfers" onClick={() => go({ kind: 'expense,refund' })} title="See the money that went out" />
        <Stat label="Net together" value={formatCents(c.netCents, { sign: true })} tone={c.netCents < 0 ? 'neg' : 'pos'} hint={`Savings rate ${pct(c.savingsRate)}`} onClick={() => go({ kind: 'income,expense,refund' })} title="See all the income and spending" />
        <Stat label="Money in accounts" value={formatCents(data.money.assetsCents)} hint={`Owed: ${formatCents(data.money.owedCardsCents)} on cards${data.money.otherDebtCents ? ` + ${formatCents(data.money.otherDebtCents)} in loans` : ''}`} onClick={() => goto('accounts')} title="Open the accounts" />
      </div>

      <Card>
        <div className="card-head"><h2>Who brought in and spent what</h2></div>
        <div className="table-wrap"><table>
          <thead><tr><th>Owner</th><th className="r">Income</th><th className="r">Spending</th><th className="r">Net</th><th className="r">Money in accounts</th><th className="r">Owed</th></tr></thead>
          <tbody>
            {active.map((o) => {
              const m = data.money.perOwner.find((x) => x.profileId === o.profileId)
              const i = data.owners.findIndex((x) => x.profileId === o.profileId)
              return (
                <tr key={o.profileId}>
                  <td><span className="person-dot" style={{ background: slotVar(i) }} aria-hidden="true" /><button className="txn-link" title="See this person's transactions this month" onClick={() => go({ kind: 'income,expense,refund', personId: o.profileId })}>{o.kind === 'household' ? 'Shared accounts' : o.name}</button></td>
                  <td className="r num">{formatCents(o.incomeCents)}</td><td className="r num">{formatCents(o.expenseCents)}</td>
                  <td className={`r num ${o.netCents < 0 ? 'neg' : ''}`}>{formatCents(o.netCents, { sign: true })}</td>
                  <td className="r num">{formatCents(m?.assetsCents ?? 0)}</td><td className="r num">{formatCents(m?.owedCents ?? 0)}</td>
                </tr>
              )
            })}
            <tr><td><b>Together</b></td><td className="r num"><b>{formatCents(c.incomeCents)}</b></td><td className="r num"><b>{formatCents(c.expenseCents)}</b></td><td className={`r num ${c.netCents < 0 ? 'neg' : ''}`}><b>{formatCents(c.netCents, { sign: true })}</b></td><td className="r num"><b>{formatCents(data.money.assetsCents)}</b></td><td className="r num"><b>{formatCents(data.money.owedCardsCents)}</b></td></tr>
          </tbody>
        </table></div>
      </Card>

      <div style={{ height: 16 }} />
      <div className="grid two">
        <ChartCard
          title="Household spending by month"
          subtitle="Stacked by person, so each share is visible. Click a bar to see that person's spending that month"
          controls={<Segmented small label="Time period" value={period} onChange={setPeriod} options={[{ value: '3', label: '3M' }, { value: '6', label: '6M' }, { value: '12', label: '12M' }, { value: 'all', label: 'All' }]} />}
          table={{ headers: ['Month', ...data.owners.map((o) => o.name), 'Together', 'Income'], rows: series.map((s) => [monthLabel(s.month), ...data.owners.map((o) => formatCents(s.perOwnerExpense[o.profileId] ?? 0)), formatCents(s.expenseCents), formatCents(s.incomeCents)]) }}
        >
          <Chart build={barOption} label="Stacked bar chart of household spending by month and person" onClick={(_n, p) => { const m = series[p.dataIndex]?.month; const o = data.owners.find((x) => x.name === p.seriesName); if (m) go({ kind: 'expense,refund', personId: o?.profileId, month: m }) }} />
        </ChartCard>
        <ChartCard
          title="Where the household's money went"
          subtitle="Category groups combine both of your categories. Click a bar to see those transactions"
          table={{ headers: ['Group', ...data.owners.map((o) => o.name), 'Together'], rows: data.groups.map((g) => [g.group, ...data.owners.map((o) => formatCents(g.perOwner[o.profileId] ?? 0)), formatCents(g.totalCents)]) }}
        >
          <Chart build={groupOption} height={Math.max(240, topGroups.length * 34 + 50)} label="Stacked bar chart of household spending by category group" onClick={(name) => go({ groupName: name })} />
        </ChartCard>
      </div>

      <div className="grid two">
        <Card>
          <div className="card-head"><h2>Money moving between you</h2></div>
          <p className="muted" style={{ marginTop: 0 }}>Not income or spending for either of you: one of you has already spent it or will.</p>
          {data.movement.betweenUs.length === 0 && data.movement.sharedAccounts.length === 0 ? <p className="muted">Nothing this month.</p> : (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {data.movement.betweenUs.map((b) => <li key={b.fromId}><b>{b.from}</b> sent {b.to} {formatCents(b.sentCents)}</li>)}
              {data.movement.sharedAccounts.map((s) => <li key={s.personId}><b>{s.person}</b> put {formatCents(s.putInCents)} into shared accounts{s.takenOutCents > 0 ? ` and took out ${formatCents(s.takenOutCents)}` : ''}</li>)}
            </ul>
          )}
        </Card>
        <Card>
          <div className="card-head"><h2>This month, in words</h2></div>
          <div className="insights">
            {data.facts.length === 0 ? <p className="muted">Nothing to report yet.</p> : data.facts.map((f, i) => <div className="insight" key={i}><span className="badge">Fact</span><div>{f}</div></div>)}
          </div>
        </Card>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn" onClick={() => goto('budget')}>Household budgets</button>
        <button className="btn" onClick={() => goto('goals')}>Household goals</button>
        <button className="btn" onClick={() => goto('accounts')}>Accounts and sharing</button>
      </div>
    </>
  )
}
