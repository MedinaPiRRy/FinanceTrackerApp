import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { Card, ErrorBox } from '../components/ui'
import { Chart, type ChartColors } from '../components/Chart'
import { formatCents, monthLabel, shortMonth } from '../format'
import { txnPreset } from '../txnLink'
import { useKept } from '../nav'
import type { CostsReport, CostLine } from '../../db/costsReport'
import type { Profile } from '../../db/queries'
import type { Page, TxnPreset } from '../App'

function Lines({ lines, more, goto }: { lines: CostLine[]; more: number; goto: (p: Page, preset?: TxnPreset) => void }) {
  if (lines.length === 0) return <p className="muted">Nothing this year.</p>
  return (
    <div className="table-wrap"><table>
      <thead><tr><th>Date</th><th>Transaction</th><th className="r">Amount</th></tr></thead>
      <tbody>{lines.map((l) => (
        <tr key={l.id}>
          <td className="num">{l.date}</td>
          <td><button className="txn-link" title="Show this transaction in its account" onClick={() => goto('transactions', txnPreset({ id: l.id, accountId: l.accountId, date: l.date }))}>{l.description}</button>{l.category && <div className="muted" style={{ fontSize: 12 }}>{l.category}</div>}</td>
          <td className={`r num ${l.cents < 0 ? 'pos' : ''}`}>{l.cents < 0 ? `${formatCents(-l.cents)} back` : formatCents(l.cents)}</td>
        </tr>
      ))}</tbody>
    </table></div>
  )
}

/** Money spent on taxes and on interest, by month and year. Which categories count as taxes is set in Settings → Categories. */
export function Costs({ profile, household, goto }: { profile: Profile; household?: boolean; goto: (p: Page, preset?: TxnPreset) => void }) {
  const [year, setYear] = useKept<number>('year', new Date().getFullYear())
  const [data, setData] = useState<CostsReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { void api('costsReport', household ? null : profile.id, year).then((r) => { setData(r); setError(null) }).catch((e: Error) => setError(e.message)) }, [profile.id, household, year])

  const option = useMemo(() => (c: ChartColors) => ({
    grid: { left: 56, right: 12, top: 28, bottom: 28 },
    legend: { top: 0, textStyle: { color: c.text2 } },
    tooltip: { trigger: 'axis', backgroundColor: c.surface, borderColor: c.grid, textStyle: { color: c.text }, valueFormatter: (v: number) => formatCents(Math.round(v * 100)) },
    xAxis: { type: 'category', data: (data?.months ?? []).map((m) => shortMonth(m.month)), axisLine: { lineStyle: { color: c.grid } }, axisTick: { show: false }, axisLabel: { color: c.muted } },
    yAxis: { type: 'value', axisLabel: { color: c.muted, formatter: (v: number) => `$${v.toLocaleString('en-CA')}` }, splitLine: { lineStyle: { color: c.grid } } },
    series: [
      { name: 'Taxes', type: 'bar', data: (data?.months ?? []).map((m) => m.taxCents / 100), itemStyle: { color: c.s1, borderRadius: [4, 4, 0, 0] }, barMaxWidth: 18 },
      { name: 'Interest', type: 'bar', data: (data?.months ?? []).map((m) => m.interestCents / 100), itemStyle: { color: c.s2, borderRadius: [4, 4, 0, 0] }, barMaxWidth: 18 }
    ]
  }), [data])

  const years = data ? (data.years.includes(year) ? data.years : [year, ...data.years]) : [year]
  return (
    <>
      <div className="page-head">
        <div><h1>Taxes &amp; interest</h1><p>What {household ? 'you have' : `${profile.name} has`} paid in taxes and in interest. Interest is found from the transaction’s wording; taxes are the categories marked as taxes in Settings.</p></div>
        <label className="field">Year<select value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Select year">{years.map((y) => <option key={y} value={y}>{y}</option>)}</select></label>
      </div>
      <ErrorBox error={error} />
      {!data ? <p className="muted">Loading…</p> : (
        <>
          <div className="grid stats">
            <Card className="stat"><div className="label">Taxes paid in {year}</div><div className="value num">{formatCents(data.taxCents)}</div><div className="hint">Refunds are taken off</div></Card>
            <Card className="stat"><div className="label">Interest paid in {year}</div><div className="value num">{formatCents(data.interestCents)}</div><div className="hint">Credit cards, loans and overdraft</div></Card>
          </div>
          <Card>
            <div className="card-head"><h2>By month</h2></div>
            {data.taxCents === 0 && data.interestCents === 0 ? <p className="muted">Nothing counted as taxes or interest in {year}. Mark a category as Taxes in Settings → Categories if yours has a different name.</p> : (
              <>
                <Chart build={option} height={220} label={`Bar chart of taxes and interest paid each month of ${year}`} />
                <div className="table-wrap"><table>
                  <thead><tr><th>Month</th><th className="r">Taxes</th><th className="r">Interest</th></tr></thead>
                  <tbody>{data.months.filter((m) => m.taxCents !== 0 || m.interestCents !== 0).map((m) => <tr key={m.month}><td>{monthLabel(m.month)}</td><td className="r num">{formatCents(m.taxCents)}</td><td className="r num">{formatCents(m.interestCents)}</td></tr>)}</tbody>
                </table></div>
              </>
            )}
          </Card>
          <div className="grid two">
            <Card>
              <div className="card-head"><h2>Taxes</h2></div>
              {data.taxBy.length > 0 && <div className="table-wrap"><table><tbody>{data.taxBy.map((b) => <tr key={b.name}><td>{b.name}</td><td className="r num">{formatCents(b.cents)}</td></tr>)}</tbody></table></div>}
              <Lines lines={data.taxLines} more={data.moreTax} goto={goto} />
              {data.moreTax > 0 && <p className="muted">And {data.moreTax.toLocaleString()} more (counted in the total).</p>}
            </Card>
            <Card>
              <div className="card-head"><h2>Interest</h2></div>
              {data.interestBy.length > 0 && <div className="table-wrap"><table><tbody>{data.interestBy.map((b) => <tr key={b.name}><td>{b.name}</td><td className="r num">{formatCents(b.cents)}</td></tr>)}</tbody></table></div>}
              <Lines lines={data.interestLines} more={data.moreInterest} goto={goto} />
              {data.moreInterest > 0 && <p className="muted">And {data.moreInterest.toLocaleString()} more (counted in the total).</p>}
            </Card>
          </div>
        </>
      )}
    </>
  )
}
