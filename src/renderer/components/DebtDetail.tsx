import { useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { Chart, type ChartColors } from './Chart'
import { ErrorBox, ProgressBar } from './ui'
import { formatCents, shortMonth } from '../format'
import type { DebtDetail as Detail } from '../../db/debtDetail'
import type { Page, TxnPreset } from '../App'

/** One loan in detail: how much was owed, how much is paid off, every payment counted toward it, and where the balance is heading. */
export function DebtDetailPanel({ profileId, debtId, version, goto, onChanged }: { profileId: number; debtId: number; version: number; goto: (p: Page, preset?: TxnPreset) => void; onChanged: () => void }) {
  const [d, setD] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = () => { void api('debtDetail', profileId, debtId).then((r) => { setD(r); setError(null) }).catch((e: Error) => setError(e.message)) }
  useEffect(load, [profileId, debtId, version]) // eslint-disable-line react-hooks/exhaustive-deps

  const option = useMemo(() => (c: ChartColors) => ({
    grid: { left: 64, right: 16, top: 12, bottom: 28 },
    tooltip: { trigger: 'axis', backgroundColor: c.surface, borderColor: c.grid, textStyle: { color: c.text }, valueFormatter: (v: number) => formatCents(Math.round(v * 100)) },
    xAxis: { type: 'category', data: (d?.history ?? []).map((x) => x.asOf), axisLine: { lineStyle: { color: c.grid } }, axisTick: { show: false }, axisLabel: { color: c.muted, formatter: (v: string) => shortMonth(v.slice(0, 7)) } },
    yAxis: { type: 'value', min: 0, axisLabel: { color: c.muted, formatter: (v: number) => `$${v.toLocaleString('en-CA')}` }, splitLine: { lineStyle: { color: c.grid } } },
    series: [{ type: 'line', step: 'end', data: (d?.history ?? []).map((x) => x.balanceCents / 100), lineStyle: { width: 2, color: c.s1 }, itemStyle: { color: c.s1, borderColor: c.surface, borderWidth: 2 }, symbolSize: 8, areaStyle: { color: c.s1, opacity: 0.08 } }]
  }), [d])

  if (error) return <ErrorBox error={error} />
  if (!d) return <span className="muted">Loading…</span>
  const pct = d.percentPaid === null ? null : Math.max(0, Math.min(1, d.percentPaid))
  return (
    <div className="review-card" role="group" aria-label={`Details of ${d.name}`} style={{ gap: 12 }}>
      <div className="grid stats">
        <div><div className="muted">Started at</div><b className="num">{formatCents(d.startCents)}</b><div className="muted" style={{ fontSize: 12 }}>{d.startAsOf}</div></div>
        <div><div className="muted">Owed now</div><b className="num">{formatCents(d.balanceCents)}</b><div className="muted" style={{ fontSize: 12 }}>as of {d.asOf}</div></div>
        <div><div className="muted">Paid down</div><b className="num pos">{formatCents(d.paidDownCents)}</b></div>
        <div><div className="muted">Payments counted</div><b className="num">{formatCents(d.paymentsTotalCents)}</b><div className="muted" style={{ fontSize: 12 }}>{d.payments.length} payment{d.payments.length === 1 ? '' : 's'}</div></div>
      </div>
      {pct !== null && <ProgressBar value={pct} tone={pct >= 1 ? 'goal' : 'ok'} label={`${Math.round(pct * 100)}% of ${d.name} paid off`} />}
      <p className="sub" style={{ margin: 0 }}>
        {pct !== null ? `${(pct * 100).toFixed(pct < 0.1 ? 1 : 0)}% paid off. ` : ''}
        {d.balanceCents === 0 ? 'Paid in full.' : d.monthlyAverageCents !== null
          ? `You have been paying about ${formatCents(d.monthlyAverageCents)} a month${d.monthsLeft !== null ? `; at that pace about ${d.monthsLeft} more month${d.monthsLeft === 1 ? '' : 's'} (interest not counted)` : ''}.`
          : 'No payments are counted yet. When you review a payment, choose this loan under “Counts toward a loan I track”.'}
      </p>
      {d.history.length >= 2 ? <Chart build={option} height={180} label={`Line chart of the balance owed on ${d.name} over time`} /> : <span className="muted">The chart appears once the balance has changed at least once.</span>}
      {d.payments.length > 0 && (
        <div className="table-wrap"><table>
          <thead><tr><th>Date</th><th>Payment</th><th className="r">Paid</th><th className="r">Took off the balance</th><th></th></tr></thead>
          <tbody>{d.payments.map((p) => (
            <tr key={p.txnId}>
              <td className="num">{p.date}</td>
              <td><button className="txn-link" title="Show this transaction in its account" onClick={() => goto('transactions', { from: p.date, to: p.date, text: p.description })}>{p.description}</button></td>
              <td className="r num">{formatCents(p.amountCents)}</td><td className="r num">{formatCents(p.appliedCents)}</td>
              <td className="r"><button className="btn small" onClick={() => void api('debtPaymentUnlink', p.txnId).then(() => { load(); onChanged() }).catch((e: Error) => setError(e.message))}>Stop counting</button></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  )
}
