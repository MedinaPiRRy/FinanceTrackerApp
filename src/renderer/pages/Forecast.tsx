import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../api'
import { Chart, type ChartColors } from '../components/Chart'
import { Card, ChartCard, ErrorBox, Segmented } from '../components/ui'
import { formatCents, monthLabel, shortMonth } from '../format'
import { emptyWhatIf, type ForecastCase, type ForecastInput, type WhatIf } from '../../core/forecast'
import type { ForecastView } from '../../db/forecast'
import type { Profile } from '../../db/queries'
import type { Page } from '../App'

const HORIZONS = [12, 24, 36, 60]
const dollars = (cents: number) => Math.round(cents / 100)
const toCents = (v: string) => Math.round(Number(v) * 100)

interface Row { name: string; c: ForecastCase; tone: 'current' | 'plan' | 'whatif' }

function Kpi({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'pos' | 'neg' }) {
  return <Card className="stat"><div className="label">{label}</div><div className={`value num ${tone === 'neg' ? 'neg' : tone === 'pos' ? 'pos' : ''}`}>{value}</div>{hint && <div className="hint">{hint}</div>}</Card>
}

export function Forecast({ profile, goto }: { profile: Profile; goto: (p: Page) => void }) {
  const [months, setMonths] = useState(24)
  const [data, setData] = useState<ForecastView | null>(null)
  const [w, setW] = useState<WhatIf | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [scenario, setScenario] = useState<'current' | 'plan' | 'whatif'>('plan')
  const [showTable, setShowTable] = useState(false)
  const first = useRef(true)

  // First load (and whenever the person or horizon changes): the saved what-if, if any, comes back with the forecast.
  useEffect(() => {
    first.current = true
    void api('forecast', profile.id, months).then((d) => { setData(d); setW(d.savedWhatIf ? { ...d.savedWhatIf, months } : null); setError(null) }).catch((e: Error) => setError(e.message))
  }, [profile.id, months])

  // Editing the what-if recalculates after a short pause.
  useEffect(() => {
    if (first.current) { first.current = false; return }
    const t = setTimeout(() => { void api('forecast', profile.id, months, w ?? null).then((d) => { setData(d); setError(null) }).catch((e: Error) => setError(e.message)) }, 300)
    return () => clearTimeout(t)
  }, [w]) // eslint-disable-line react-hooks/exhaustive-deps

  const rows: Row[] = useMemo(() => {
    if (!data) return []
    const r: Row[] = [{ name: 'Today\'s pace', c: data.current.expected, tone: 'current' }, { name: 'With my budgets & goals', c: data.plan.expected, tone: 'plan' }]
    if (data.whatIf) r.push({ name: 'My what-if', c: data.whatIf.expected, tone: 'whatif' })
    return r
  }, [data])

  const hasRange = !!data && data.inputs.plan.income.some((s) => s.kind === 'irregular' && (s.lowCents !== s.monthlyCents || s.highCents !== s.monthlyCents))
  const selected = useMemo(() => {
    if (!data) return null
    return scenario === 'whatif' && data.whatIf ? data.whatIf : scenario === 'current' ? data.current : data.plan
  }, [data, scenario])

  const cashOption = useMemo(() => (c: ChartColors) => {
    if (!data) return {}
    const labels = data.plan.expected.months.map((m) => shortMonth(m.month))
    const line = (name: string, cs: ForecastCase, color: string, extra: object = {}) => ({ name, type: 'line', data: cs.months.map((m) => dollars(m.cashCents)), showSymbol: false, lineStyle: { width: 2, color }, itemStyle: { color }, ...extra })
    const series = [
      line('Today\'s pace', data.current.expected, c.muted),
      line('With my budgets & goals', data.plan.expected, c.s1, { lineStyle: { width: 3, color: c.s1 } }),
      ...(hasRange ? [line('Plan, poor income months', data.plan.low, c.s1, { lineStyle: { width: 1, type: 'dashed', color: c.s1, opacity: 0.55 } }), line('Plan, good income months', data.plan.high, c.s1, { lineStyle: { width: 1, type: 'dashed', color: c.s1, opacity: 0.55 } })] : []),
      ...(data.whatIf ? [line('My what-if', data.whatIf.expected, c.s2, { lineStyle: { width: 3, color: c.s2 } })] : [])
    ]
    return {
      grid: { left: 64, right: 16, top: 36, bottom: 28 },
      legend: { top: 0, textStyle: { color: c.text2 } },
      tooltip: { trigger: 'axis', backgroundColor: c.surface, borderColor: c.grid, textStyle: { color: c.text }, valueFormatter: (v: number) => formatCents(Math.round(v * 100)) },
      xAxis: { type: 'category', data: labels, axisLine: { lineStyle: { color: c.grid } }, axisTick: { show: false }, axisLabel: { color: c.muted } },
      yAxis: { type: 'value', axisLabel: { color: c.muted, formatter: (v: number) => `$${v.toLocaleString('en-CA')}` }, splitLine: { lineStyle: { color: c.grid } } },
      series
    }
  }, [data, hasRange])

  const debtOption = useMemo(() => (c: ChartColors) => {
    if (!data) return {}
    const labels = data.plan.expected.months.map((m) => shortMonth(m.month))
    const line = (name: string, cs: ForecastCase, color: string, width = 2) => ({ name, type: 'line', data: cs.months.map((m) => dollars(m.debtCents)), showSymbol: false, lineStyle: { width, color }, itemStyle: { color } })
    return {
      grid: { left: 64, right: 16, top: 36, bottom: 28 },
      legend: { top: 0, textStyle: { color: c.text2 } },
      tooltip: { trigger: 'axis', backgroundColor: c.surface, borderColor: c.grid, textStyle: { color: c.text }, valueFormatter: (v: number) => formatCents(Math.round(v * 100)) },
      xAxis: { type: 'category', data: labels, axisLine: { lineStyle: { color: c.grid } }, axisTick: { show: false }, axisLabel: { color: c.muted } },
      yAxis: { type: 'value', axisLabel: { color: c.muted, formatter: (v: number) => `$${v.toLocaleString('en-CA')}` }, splitLine: { lineStyle: { color: c.grid } } },
      series: [line('Today\'s pace (minimum payments)', data.current.expected, c.muted), line('With my plan', data.plan.expected, c.s1, 3), ...(data.whatIf ? [line('My what-if', data.whatIf.expected, c.s2, 3)] : [])]
    }
  }, [data])

  const save = async () => { try { await api('forecastSaveWhatIf', profile.id, w); setMsg(w ? 'What-if saved.' : 'What-if cleared.'); setTimeout(() => setMsg(null), 2500) } catch (e) { setError((e as Error).message) } }

  if (!data) return <><ErrorBox error={error} />{!error && <p className="muted">Loading…</p>}</>
  const plan = data.plan.expected
  const last = plan.months[plan.months.length - 1]
  const base: ForecastInput | null = w ? data.inputs[w.base] : null
  // The plan only differs from today's pace when there are budgets or goals to follow.
  const noPlan = data.inputs.plan.goals.length === 0 && JSON.stringify(data.inputs.plan.expenses) === JSON.stringify(data.inputs.current.expenses)

  if (data.basedOnMonths.length === 0) {
    return (
      <>
        <div className="page-head"><div><h1>Forecast</h1><p>Where your money is heading, starting from today's balances.</p></div></div>
        <ErrorBox error={error} />
        <Card>
          <h2>Nothing to forecast yet</h2>
          <p className="sub">The forecast is built from your own income and spending, and there is no complete month of transactions yet. Import a month or two from your bank and it appears here.</p>
          <button className="btn primary" onClick={() => goto('import')}>Import transactions</button>
        </Card>
      </>
    )
  }

  return (
    <>
      <div className="page-head">
        <div><h1>Forecast</h1><p>Where your money is heading, starting from today's balances. Nothing here is saved or changed in your accounts.</p></div>
        <label className="field">Look ahead<select value={months} onChange={(e) => setMonths(Number(e.target.value))}>{HORIZONS.map((h) => <option key={h} value={h}>{h} months</option>)}</select></label>
      </div>
      <ErrorBox error={error} />
      {data.notes.map((n) => <div key={n} className="notice" style={{ marginBottom: 12 }}>{n}</div>)}

      <div className="grid stats">
        <Kpi label={`Spendable cash in ${monthLabel(last?.month ?? data.startMonth)}`} value={formatCents(last?.cashCents ?? 0)} hint={noPlan ? 'Same as today\'s pace: no budgets or goals set yet' : 'Following your budgets and goals'} tone={(last?.cashCents ?? 0) < 0 ? 'neg' : undefined} />
        <Kpi label="Debt-free" value={plan.debtFreeMonth ? (data.planner.debts.length === 0 ? 'No debt' : monthLabel(plan.debtFreeMonth)) : 'Not within this period'} hint={data.planner.debts.length ? `${formatCents(plan.totalInterestCents)} interest on the way` : undefined} />
        <Kpi label="Lowest cash" value={formatCents(plan.lowestCash.cents)} hint={plan.firstShortfall ? `Runs out in ${monthLabel(plan.firstShortfall)}` : `in ${monthLabel(plan.lowestCash.month)}`} tone={plan.firstShortfall ? 'neg' : undefined} />
        <Kpi label="Net worth at the end" value={formatCents(last?.netWorthCents ?? 0)} hint="Cash + set aside + investments − debt" />
      </div>
      {plan.firstShortfall && <div className="notice" role="status" style={{ marginBottom: 12 }}>At this pace spendable cash goes below zero in <b>{monthLabel(plan.firstShortfall)}</b>. Try the what-if below to see what closes the gap: less spending, more income, or smaller goals.</div>}

      <div className="grid two">
        <ChartCard title="Spendable cash" subtitle={hasRange ? 'Dashed lines show a run of poor and of good months for your irregular income' : 'Cash in the bank and wallet after setting money aside for goals'}
          table={{ headers: ['Month', 'Today\'s pace', 'My plan', ...(data.whatIf ? ['What-if'] : [])], rows: plan.months.map((m, i) => [monthLabel(m.month), formatCents(data.current.expected.months[i]!.cashCents), formatCents(m.cashCents), ...(data.whatIf ? [formatCents(data.whatIf.expected.months[i]!.cashCents)] : [])]) }}>
          <Chart build={cashOption} label="Line chart of forecast spendable cash" />
        </ChartCard>
        <ChartCard title="Debt remaining" subtitle={data.planner.debts.length ? 'Cards and loans, with interest' : 'You have no cards or loans with a balance'}
          table={{ headers: ['Month', 'Today\'s pace', 'My plan', ...(data.whatIf ? ['What-if'] : [])], rows: plan.months.map((m, i) => [monthLabel(m.month), formatCents(data.current.expected.months[i]!.debtCents), formatCents(m.debtCents), ...(data.whatIf ? [formatCents(data.whatIf.expected.months[i]!.debtCents)] : [])]) }}>
          <Chart build={debtOption} label="Line chart of forecast debt" />
        </ChartCard>
      </div>

      <div style={{ height: 16 }} />
      <Card>
        <div className="card-head"><h2>Compared</h2></div>
        <div className="table-wrap"><table>
          <thead><tr><th>Scenario</th><th className="r">Cash at the end</th><th className="r">Debt at the end</th><th className="r">Interest paid</th><th>Debt-free</th><th>Cash runs out</th><th className="r">Net worth</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const l = r.c.months[r.c.months.length - 1]!
              return <tr key={r.tone}><td><b>{r.name}</b></td><td className="r num">{formatCents(l.cashCents)}</td><td className="r num">{formatCents(l.debtCents)}</td><td className="r num">{formatCents(r.c.totalInterestCents)}</td><td>{r.c.debtFreeMonth ? (data.planner.debts.length ? monthLabel(r.c.debtFreeMonth) : '—') : 'Not in this period'}</td><td>{r.c.firstShortfall ? <span className="neg">{monthLabel(r.c.firstShortfall)}</span> : 'Never'}</td><td className="r num">{formatCents(l.netWorthCents)}</td></tr>
            })}
          </tbody>
        </table></div>
        <p className="muted" style={{ marginBottom: 0 }}>
          <b>Today's pace</b> keeps your recent income and spending as they are and pays only the minimum on debts. <b>With my budgets &amp; goals</b> follows your budgets, puts money toward your goals and uses your <button className="btn small" onClick={() => goto('goals')}>debt payoff plan</button>.
        </p>
      </Card>

      <div style={{ height: 16 }} />
      <Card>
        <div className="card-head">
          <h2>What if…?</h2>
          {w ? <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>{msg && <span className="pos" role="status">{msg}</span>}<button className="btn" onClick={() => void save()}>Save what-if</button><button className="btn" onClick={() => { setW(null); void api('forecastSaveWhatIf', profile.id, null) }}>Clear</button></span>
            : <button className="btn primary" onClick={() => setW(emptyWhatIf('plan', months))}>Try a what-if</button>}
        </div>
        {!w ? <p className="sub" style={{ margin: 0 }}>Change the numbers to see what would happen: earn or spend more or less, cancel a bill, start a second job or a side business, add a one-off expense, pay extra toward debt.</p> : base && (
          <WhatIfEditor w={w} setW={setW} base={base} months={data.plan.expected.months.map((m) => m.month)} />
        )}
      </Card>

      <div style={{ height: 16 }} />
      <Card>
        <div className="card-head"><h2>Month by month</h2>
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Segmented<'current' | 'plan' | 'whatif'> label="Scenario" small value={scenario} onChange={setScenario} options={[{ value: 'current', label: 'Today\'s pace' }, { value: 'plan', label: 'My plan' }, ...(data.whatIf ? [{ value: 'whatif' as const, label: 'What-if' }] : [])]} />
            <button className="btn small" onClick={() => setShowTable((s) => !s)} aria-expanded={showTable}>{showTable ? 'Hide' : 'Show'}</button>
          </span>
        </div>
        {showTable && selected && (
          <div className="table-wrap"><table>
            <thead><tr><th>Month</th><th className="r">Income</th><th className="r">Spending</th><th className="r">Set aside</th><th className="r">Debt paid</th><th className="r">Interest</th><th className="r">Cash</th><th className="r">Debt</th></tr></thead>
            <tbody>{selected.expected.months.map((m) => <tr key={m.month}><td>{monthLabel(m.month)}</td><td className="r num">{formatCents(m.incomeCents)}</td><td className="r num">{formatCents(m.expenseCents)}</td><td className="r num">{formatCents(m.goalCents)}</td><td className="r num">{formatCents(m.debtPaidCents)}</td><td className="r num">{formatCents(m.interestCents)}</td><td className={`r num ${m.cashCents < 0 ? 'neg' : ''}`}>{formatCents(m.cashCents)}</td><td className="r num">{formatCents(m.debtCents)}</td></tr>)}</tbody>
          </table></div>
        )}
      </Card>

      <div style={{ height: 16 }} />
      <Card>
        <div className="card-head"><h2>How this is worked out</h2></div>
        <ul className="muted" style={{ margin: 0, paddingLeft: 20, lineHeight: 1.6 }}>
          <li><b>Starting point:</b> today's cash in the bank, savings and wallet ({formatCents(data.inputs.plan.startCashCents)}), then full months from {monthLabel(data.startMonth)}.</li>
          <li><b>Income:</b> recurring income you track counts as regular. Everything else that came in, grouped by category (freelance, tips, selling things, a side business), counts as regular if it shows up steadily and as irregular if it swings; irregular income gets a range from your poorest to your best recent month.</li>
          <li><b>Spending:</b> your tracked recurring bills, plus everyday spending by category from the last {data.basedOnMonths.length >= 3 ? 'three' : 'few'} complete months. A bill is not counted twice. The plan limits each budgeted category to its budget.</li>
          <li><b>Goals:</b> the monthly amount you planned for each savings goal is set aside until the goal is reached. That money is still yours, so net worth does not drop.</li>
          <li><b>Debts:</b> interest is charged monthly at each debt's rate. Rates and minimums you have not entered use defaults (cards 19.99%, minimum the larger of $25 or 3%). Edit them in the debt payoff planner on the Goals page.</li>
          <li>It is an estimate from your own history, not a promise: prices, pay and interest rates change, and it ignores taxes and investment growth.</li>
        </ul>
      </Card>
    </>
  )
}

function WhatIfEditor({ w, setW, base, months }: { w: WhatIf; setW: (w: WhatIf) => void; base: ForecastInput; months: string[] }) {
  const line = (id: string) => w.lines.find((l) => l.id === id)
  const setLine = (id: string, patch: { enabled?: boolean; monthlyCents?: number | undefined }) => {
    const rest = w.lines.filter((l) => l.id !== id)
    const next = { ...(line(id) ?? { id }), ...patch }
    const useful = next.enabled === false || next.monthlyCents !== undefined
    setW({ ...w, lines: useful ? [...rest, next] : rest })
  }
  const [add, setAdd] = useState({ label: '', type: 'income' as 'income' | 'irregular' | 'expense', amount: '', from: 0, forMonths: '' })
  const [one, setOne] = useState({ label: '', month: 0, amount: '', direction: 'out' as 'out' | 'in' })

  const lineRow = (id: string, label: string, monthlyCents: number, kind: string) => {
    const l = line(id)
    const off = l?.enabled === false
    return (
      <tr key={id} style={off ? { opacity: 0.5 } : undefined}>
        <td><input type="checkbox" aria-label={`Include ${label}`} checked={!off} onChange={(e) => setLine(id, { enabled: e.target.checked ? undefined : false })} /></td>
        <td>{label}<span className="muted"> · {kind}</span></td>
        <td className="r num">{formatCents(monthlyCents)}</td>
        <td className="r"><input type="number" min="0" step="10" aria-label={`Monthly amount for ${label}`} placeholder={(monthlyCents / 100).toFixed(0)} value={l?.monthlyCents !== undefined ? (l.monthlyCents / 100).toString() : ''} disabled={off} onChange={(e) => setLine(id, { monthlyCents: e.target.value === '' ? undefined : toCents(e.target.value) })} style={{ width: 100, textAlign: 'right' }} /></td>
      </tr>
    )
  }

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="filters" style={{ marginBottom: 0 }}>
        <label className="field">Start from
          <select value={w.base} onChange={(e) => setW({ ...w, base: e.target.value as 'current' | 'plan', lines: [] })}><option value="plan">My budgets &amp; goals</option><option value="current">Today's pace</option></select>
        </label>
        <label className="field">All income: {w.incomePct > 0 ? '+' : ''}{w.incomePct}%
          <input type="range" min="-50" max="100" step="5" value={w.incomePct} onChange={(e) => setW({ ...w, incomePct: Number(e.target.value) })} aria-label="Change all income by percent" />
        </label>
        <label className="field">Everyday spending: {w.spendPct > 0 ? '+' : ''}{w.spendPct}%
          <input type="range" min="-50" max="100" step="5" value={w.spendPct} onChange={(e) => setW({ ...w, spendPct: Number(e.target.value) })} aria-label="Change everyday spending by percent" />
        </label>
        <label className="field">Extra toward debt each month ($)
          <input type="number" min="0" step="25" value={w.extraDebtCents ? w.extraDebtCents / 100 : ''} placeholder="0" onChange={(e) => setW({ ...w, extraDebtCents: e.target.value === '' ? 0 : toCents(e.target.value) })} style={{ width: 120 }} />
        </label>
      </div>

      <div className="grid two">
        <div>
          <div className="muted" style={{ marginBottom: 6 }}>Income lines. Untick one to remove it, or type a new monthly amount.</div>
          <div className="table-wrap"><table><thead><tr><th></th><th>Income</th><th className="r">Now</th><th className="r">Change to</th></tr></thead>
            <tbody>{base.income.length === 0 ? <tr><td colSpan={4} className="muted">No income found.</td></tr> : base.income.map((s) => lineRow(s.id, s.label, s.monthlyCents, s.kind === 'irregular' ? 'irregular' : 'regular'))}</tbody></table></div>
        </div>
        <div>
          <div className="muted" style={{ marginBottom: 6 }}>Spending lines. Untick a bill to cancel it.</div>
          <div className="table-wrap"><table><thead><tr><th></th><th>Spending</th><th className="r">Now</th><th className="r">Change to</th></tr></thead>
            <tbody>{base.expenses.length === 0 ? <tr><td colSpan={4} className="muted">No spending found.</td></tr> : base.expenses.map((e) => lineRow(e.id, e.label, e.monthlyCents, e.kind === 'bill' ? 'bill' : 'everyday'))}</tbody></table></div>
        </div>
      </div>

      <div>
        <div className="muted" style={{ marginBottom: 6 }}>Add something new: a second job, a side business, selling things, a new bill.</div>
        <div className="filters" style={{ marginBottom: 6 }}>
          <label className="field">What<input value={add.label} onChange={(e) => setAdd({ ...add, label: e.target.value })} placeholder="e.g. Weekend freelance work" style={{ width: 220 }} /></label>
          <label className="field">Type
            <select value={add.type} onChange={(e) => setAdd({ ...add, type: e.target.value as typeof add.type })}><option value="income">Regular income</option><option value="irregular">Irregular income (varies a lot)</option><option value="expense">New expense</option></select>
          </label>
          <label className="field">Per month ($)<input type="number" min="0" step="10" value={add.amount} onChange={(e) => setAdd({ ...add, amount: e.target.value })} style={{ width: 110 }} /></label>
          <label className="field">Starting<select value={add.from} onChange={(e) => setAdd({ ...add, from: Number(e.target.value) })}>{months.slice(0, 36).map((m, i) => <option key={m} value={i}>{monthLabel(m)}</option>)}</select></label>
          <label className="field">For (months)<input type="number" min="1" step="1" value={add.forMonths} placeholder="ongoing" onChange={(e) => setAdd({ ...add, forMonths: e.target.value })} style={{ width: 100 }} /></label>
          <button className="btn" disabled={!add.label.trim() || !(Number(add.amount) > 0)} onClick={() => { setW({ ...w, added: [...w.added, { label: add.label.trim(), kind: add.type === 'expense' ? 'expense' : 'income', irregular: add.type === 'irregular', monthlyCents: toCents(add.amount), fromIndex: add.from, toIndex: add.forMonths ? add.from + Math.max(1, Number(add.forMonths)) - 1 : null }] }); setAdd({ ...add, label: '', amount: '', forMonths: '' }) }}>Add</button>
        </div>
        {w.added.length > 0 && (
          <div className="table-wrap"><table><tbody>{w.added.map((a, i) => (
            <tr key={i}><td>{a.label}<span className="muted"> · {a.kind === 'expense' ? 'expense' : a.irregular ? 'irregular income' : 'income'}</span></td><td className="r num">{formatCents(a.monthlyCents)}/mo</td><td className="muted">from {monthLabel(months[a.fromIndex] ?? months[0]!)}{a.toIndex === null ? ', ongoing' : `, ${a.toIndex - a.fromIndex + 1} month${a.toIndex === a.fromIndex ? '' : 's'}`}</td><td className="r"><button className="btn small danger" onClick={() => setW({ ...w, added: w.added.filter((_, j) => j !== i) })}>Remove</button></td></tr>
          ))}</tbody></table></div>
        )}
      </div>

      <div>
        <div className="muted" style={{ marginBottom: 6 }}>One-off events: a car repair, a bonus, a tax refund, a trip.</div>
        <div className="filters" style={{ marginBottom: 6 }}>
          <label className="field">What<input value={one.label} onChange={(e) => setOne({ ...one, label: e.target.value })} placeholder="e.g. New laptop" style={{ width: 200 }} /></label>
          <label className="field">Money<select value={one.direction} onChange={(e) => setOne({ ...one, direction: e.target.value as 'in' | 'out' })}><option value="out">goes out</option><option value="in">comes in</option></select></label>
          <label className="field">Amount ($)<input type="number" min="0" step="10" value={one.amount} onChange={(e) => setOne({ ...one, amount: e.target.value })} style={{ width: 110 }} /></label>
          <label className="field">In<select value={one.month} onChange={(e) => setOne({ ...one, month: Number(e.target.value) })}>{months.map((m, i) => <option key={m} value={i}>{monthLabel(m)}</option>)}</select></label>
          <button className="btn" disabled={!one.label.trim() || !(Number(one.amount) > 0)} onClick={() => { setW({ ...w, oneTime: [...w.oneTime, { label: one.label.trim(), index: one.month, cents: (one.direction === 'out' ? -1 : 1) * toCents(one.amount) }] }); setOne({ ...one, label: '', amount: '' }) }}>Add</button>
        </div>
        {w.oneTime.length > 0 && (
          <div className="table-wrap"><table><tbody>{w.oneTime.map((o, i) => (
            <tr key={i}><td>{o.label}</td><td className={`r num ${o.cents > 0 ? 'pos' : ''}`}>{formatCents(o.cents, { sign: true })}</td><td className="muted">{monthLabel(months[o.index] ?? months[0]!)}</td><td className="r"><button className="btn small danger" onClick={() => setW({ ...w, oneTime: w.oneTime.filter((_, j) => j !== i) })}>Remove</button></td></tr>
          ))}</tbody></table></div>
        )}
      </div>
    </div>
  )
}

