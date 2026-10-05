import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { Card, ErrorBox, Segmented } from './ui'
import { formatCents, monthLabel } from '../format'
import type { PlannerState } from '../../db/debtPlan'
import type { Strategy } from '../../core/debtPlan'

const STRATEGY: { value: Strategy; label: string; blurb: string }[] = [
  { value: 'avalanche', label: 'Highest interest first', blurb: 'Costs the least interest. Every extra dollar goes to the debt with the highest rate.' },
  { value: 'snowball', label: 'Smallest balance first', blurb: 'Clears whole debts sooner, which many people find motivating. Costs a little more interest.' },
  { value: 'minimum', label: 'Minimums only', blurb: 'Pays only the required minimum on each. The slowest and most expensive way.' }
]

interface Draft { apr: Record<string, string>; min: Record<string, string>; strategy: Strategy; budget: string | null }

/**
 * Debt payoff planner. It starts from defaults (typical card rates and minimums, your recent surplus) so it
 * works without any input, and everything can be edited; the result updates as you type. Nothing is saved until you press Save.
 */
export function DebtPlanner({ profileId, onSaved }: { profileId: number; onSaved?: () => void }) {
  const [state, setState] = useState<PlannerState | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [showSchedule, setShowSchedule] = useState(false)
  const first = useRef(true)

  const load = () => {
    void api('debtPlanner', profileId).then((s) => {
      setState(s)
      setDraft({ apr: Object.fromEntries(s.debts.map((d) => [d.key, (d.aprBps / 100).toString()])), min: Object.fromEntries(s.debts.map((d) => [d.key, (d.minPaymentCents / 100).toFixed(0)])), strategy: s.strategy, budget: s.budgetIsDefault ? null : (s.monthlyBudgetCents / 100).toFixed(0) })
      setDirty(false); first.current = true
    }).catch((e: Error) => setError(e.message))
  }
  useEffect(load, [profileId])

  const edits = (d: Draft, s: PlannerState) => ({
    terms: s.debts.map((x) => ({ key: x.key, aprBps: Math.round(Number(d.apr[x.key]) * 100), minPaymentCents: Math.round(Number(d.min[x.key]) * 100) })).filter((t) => Number.isFinite(t.aprBps) && Number.isFinite(t.minPaymentCents)),
    strategy: d.strategy,
    monthlyBudgetCents: d.budget === null || d.budget === '' ? null : Math.round(Number(d.budget) * 100)
  })

  // live preview while editing
  useEffect(() => {
    if (!draft || !state) return
    if (first.current) { first.current = false; return }
    const t = setTimeout(() => { void api('debtPlanner', profileId, edits(draft, state)).then((s) => { setState((cur) => cur ? { ...s, debts: cur.debts } : s); setError(null) }).catch((e: Error) => setError(e.message)) }, 300)
    return () => clearTimeout(t)
  }, [draft]) // eslint-disable-line react-hooks/exhaustive-deps

  const change = (patch: Partial<Draft>) => { setDraft((d) => d && { ...d, ...patch }); setDirty(true) }

  const save = async () => {
    if (!draft || !state) return
    try { const s = await api('debtPlannerSave', profileId, edits(draft, state)); setState(s); setDirty(false); setMsg('Plan saved. The forecast now uses it.'); setTimeout(() => setMsg(null), 3000); onSaved?.() } catch (e) { setError((e as Error).message) }
  }
  const reset = async () => { try { await api('debtPlannerReset', profileId); load(); setMsg('Back to the suggested plan.'); setTimeout(() => setMsg(null), 3000); onSaved?.() } catch (e) { setError((e as Error).message) } }

  if (!state || !draft) return <ErrorBox error={error} />
  if (state.debts.length === 0) {
    return <Card><div className="card-head"><h2>Debt payoff planner</h2></div><p className="sub" style={{ margin: 0 }}>You have no credit card or loan balances to plan for. If you add a loan or a card with a balance owed, a payoff plan appears here with a default plan you can edit.</p></Card>
  }
  const r = state.results
  const chosen = r.chosen
  const total = state.debts.reduce((s, d) => s + d.balanceCents, 0)
  const minSum = state.debts.reduce((s, d) => s + Math.min(d.balanceCents, d.minPaymentCents), 0)
  const compare = STRATEGY.map((x) => ({ ...x, res: r[x.value] }))

  return (
    <Card>
      <div className="card-head">
        <h2>Debt payoff planner</h2>
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {msg && <span className="pos" role="status">{msg}</span>}
          {dirty && <span className="muted">Unsaved changes</span>}
          <button className="btn small" onClick={() => void reset()}>Use the suggested plan</button>
          <button className="btn small primary" disabled={!dirty} onClick={() => void save()}>Save plan</button>
        </span>
      </div>
      <ErrorBox error={error} />
      <p className="sub" style={{ marginTop: 0 }}>
        Owing {formatCents(total)} in total. It starts from typical rates and minimums and pays {formatCents(state.monthlyBudgetCents)} a month{state.surplusAfterGoalsCents !== null && state.surplusAfterGoalsCents > 0 && state.budgetIsDefault ? ` (about 60% of the ${formatCents(state.surplusAfterGoalsCents)} you have left each month after the money planned for goals, never less than the minimums)` : ''}. Change anything and the result updates.
      </p>

      <div className="table-wrap"><table>
        <thead><tr><th>Debt</th><th className="r">Owed</th><th className="r">Interest rate (% a year)</th><th className="r">Minimum payment ($/mo)</th></tr></thead>
        <tbody>
          {state.debts.map((d) => (
            <tr key={d.key}>
              <td>{d.label}{d.owner && <span className="muted"> · {d.owner}</span>}<span className="muted"> · {d.kind === 'card' ? 'card' : 'loan'}</span></td>
              <td className="r num">{formatCents(d.balanceCents)}</td>
              <td className="r"><input type="number" min="0" max="100" step="0.01" aria-label={`Interest rate for ${d.label}`} value={draft.apr[d.key] ?? ''} onChange={(e) => change({ apr: { ...draft.apr, [d.key]: e.target.value } })} style={{ width: 90, textAlign: 'right' }} />{d.aprIsDefault && !dirty && <div className="muted" style={{ fontSize: 11 }}>typical, change if you know it</div>}</td>
              <td className="r"><input type="number" min="0" step="5" aria-label={`Minimum payment for ${d.label}`} value={draft.min[d.key] ?? ''} onChange={(e) => change({ min: { ...draft.min, [d.key]: e.target.value } })} style={{ width: 90, textAlign: 'right' }} />{d.minIsDefault && !dirty && <div className="muted" style={{ fontSize: 11 }}>estimated</div>}</td>
            </tr>
          ))}
        </tbody>
      </table></div>

      <div className="filters" style={{ margin: '14px 0 0' }}>
        <label className="field">How much to pay toward debts each month ($)
          <span style={{ display: 'flex', gap: 6 }}>
            <input type="number" min="0" step="25" aria-label="Monthly amount toward debts" value={draft.budget ?? (state.monthlyBudgetCents / 100).toFixed(0)} onChange={(e) => change({ budget: e.target.value })} style={{ width: 130 }} />
            {draft.budget !== null && <button className="btn small" onClick={() => change({ budget: null })}>Suggested</button>}
          </span>
          <span className="muted" style={{ fontSize: 11.5 }}>Minimums add up to {formatCents(minSum)}.</span>
        </label>
        <label className="field">Order
          <Segmented<Strategy> label="Payoff order" small value={draft.strategy} onChange={(v) => change({ strategy: v })} options={STRATEGY.map((s) => ({ value: s.value, label: s.label, title: s.blurb }))} />
          <span className="muted" style={{ fontSize: 11.5 }}>{STRATEGY.find((s) => s.value === draft.strategy)!.blurb}</span>
        </label>
      </div>

      {chosen.warnings.map((w) => <div key={w} className="notice" style={{ marginTop: 12 }}>{w}</div>)}

      <div className="grid stats" style={{ marginTop: 14 }}>
        <Card className="stat"><div className="label">Debt-free</div><div className="value num">{chosen.debtFreeMonth ? monthLabel(chosen.debtFreeMonth) : 'Not within 50 years'}</div><div className="hint">{chosen.months ? `${chosen.months} month${chosen.months === 1 ? '' : 's'} from ${monthLabel(state.startMonth)}` : 'Raise the monthly amount'}</div></Card>
        <Card className="stat"><div className="label">Interest you would pay</div><div className="value num">{formatCents(chosen.totalInterestCents)}</div><div className="hint">on top of {formatCents(total)}</div></Card>
        <Card className="stat"><div className="label">Paying per month</div><div className="value num">{formatCents(chosen.monthlyBudgetCents)}</div></Card>
      </div>

      <div className="table-wrap" style={{ marginTop: 14 }}>
        <table>
          <caption className="sr-only">Comparison of payoff orders</caption>
          <thead><tr><th>Order</th><th className="r">Debt-free</th><th className="r">Months</th><th className="r">Total interest</th></tr></thead>
          <tbody>
            {compare.map((c) => (
              <tr key={c.value} style={c.value === draft.strategy ? { fontWeight: 650 } : undefined}>
                <td>{c.label}{c.value === draft.strategy && <span className="badge accent" style={{ marginLeft: 6 }}>chosen</span>}</td>
                <td className="r">{c.res.debtFreeMonth ? monthLabel(c.res.debtFreeMonth) : '—'}</td>
                <td className="r num">{c.res.months ?? '—'}</td>
                <td className="r num">{formatCents(c.res.totalInterestCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {chosen.order.length > 0 && (
        <p className="muted" style={{ marginBottom: 0 }}>
          Paid off in this order: {chosen.order.map((o, i) => <span key={o.id}>{i > 0 ? ' → ' : ''}<b>{o.label}</b> ({monthLabel(o.paidOffMonth)})</span>)}.
        </p>
      )}

      <div style={{ marginTop: 10 }}>
        <button className="btn small" onClick={() => setShowSchedule((s) => !s)} aria-expanded={showSchedule}>{showSchedule ? 'Hide' : 'Show'} month-by-month schedule</button>
      </div>
      {showSchedule && (
        <div className="table-wrap" style={{ marginTop: 8, maxHeight: 360, overflow: 'auto' }}>
          <table>
            <thead><tr><th>Month</th><th className="r">Paid</th><th className="r">Interest</th><th className="r">Still owed</th></tr></thead>
            <tbody>{chosen.schedule.map((m) => <tr key={m.month}><td>{monthLabel(m.month)}</td><td className="r num">{formatCents(m.paidCents)}</td><td className="r num">{formatCents(m.interestCents)}</td><td className="r num">{formatCents(m.balanceCents)}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      <p className="muted" style={{ marginBottom: 0 }}>Interest is charged monthly at a twelfth of the yearly rate. Real cards compute interest daily, so treat the dates as a close estimate.</p>
    </Card>
  )
}
