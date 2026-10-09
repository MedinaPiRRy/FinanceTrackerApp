import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { Card, ErrorBox, ProgressBar } from '../components/ui'
import { formatCents, monthLabel, pct } from '../format'
import { GoalIdeas } from '../components/GoalIdeas'
import { DebtPlanner } from '../components/DebtPlanner'
import type { AccountInfo, CategoryInfo, DebtRow, Profile } from '../../db/queries'
import type { GoalView, GoalDto } from '../../db/goals'
import type { GoalKind, GoalStatus } from '../../core/goals'
import type { Page } from '../App'

const KIND_LABEL: Record<GoalKind, string> = { manual: 'Savings I add to myself', account: 'Track an account', category: 'Count spending in a category', debt: 'Pay off cards and loans' }
const STATUS: Record<GoalStatus, { label: string; cls: string }> = {
  achieved: { label: '✓ Reached', cls: 'good' }, on_track: { label: '✓ On track', cls: 'good' }, behind: { label: '▲ Behind', cls: 'bad' }, overdue: { label: '▲ Past deadline', cls: 'bad' }, no_deadline: { label: 'No deadline', cls: '' }, no_value: { label: 'Needs a value', cls: 'warn' }
}
const toCents = (v: string) => Math.round(Number(v) * 100)
const dollars = (c: number | null) => (c === null ? '' : (c / 100).toFixed(2))

interface Form { id: number | null; kind: GoalKind; name: string; target: string; saved: string; deadline: string; planned: string; accountId: string; categoryId: string; items: string[]; notes: string }
const blank: Form = { id: null, kind: 'manual', name: '', target: '', saved: '', deadline: '', planned: '', accountId: '', categoryId: '', items: [], notes: '' }

export function Goals({ profile, accounts, categories, goto, householdMode }: { profile: Profile; accounts: AccountInfo[]; categories: CategoryInfo[]; goto: (p: Page) => void; householdMode?: boolean }) {
  const [goals, setGoals] = useState<GoalView[] | null>(null)
  const [debts, setDebts] = useState<DebtRow[]>([])
  const [form, setForm] = useState<Form | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => { void api('goals', profile.id).then(setGoals).catch((e: Error) => setError(e.message)); void (householdMode ? api('allDebts') : api('debts', profile.id)).then(setDebts) }, [profile.id, householdMode])
  useEffect(load, [load])

  const cards = accounts.filter((a) => a.type === 'credit_card' && !a.archived)
  const trackable = accounts.filter((a) => a.type !== 'credit_card' && !a.archived)
  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f))

  const edit = (g: GoalView) => setForm({
    id: g.id, kind: g.kind, name: g.name, target: g.kind === 'debt' ? '' : dollars(g.targetCents), saved: dollars(g.manualCents), deadline: g.deadline ?? '', planned: dollars(g.plannedMonthlyCents),
    accountId: g.accountId ? String(g.accountId) : '', categoryId: g.categoryId ? String(g.categoryId) : '', notes: g.notes ?? '',
    items: g.items.map((i) => (i.accountId ? `a${i.accountId}` : `d${i.debtId}`))
  })

  const save = async () => {
    if (!form) return
    const dto: GoalDto = {
      name: form.name, kind: form.kind, targetCents: form.target ? toCents(form.target) : undefined, manualCents: form.saved ? toCents(form.saved) : 0, deadline: form.deadline || null,
      plannedMonthlyCents: form.planned ? toCents(form.planned) : null, accountId: form.accountId ? Number(form.accountId) : null, categoryId: form.categoryId ? Number(form.categoryId) : null,
      debtItems: form.items.map((x) => (x.startsWith('a') ? { accountId: Number(x.slice(1)) } : { debtId: Number(x.slice(1)) })), notes: form.notes || null
    }
    try {
      if (form.id === null) await api('goalCreate', profile.id, dto)
      else await api('goalUpdate', profile.id, form.id, dto)
      setForm(null); setError(null); load()
    } catch (e) { setError((e as Error).message) }
  }
  const remove = async (g: GoalView) => { if (confirm(`Delete the goal "${g.name}"? Your accounts and transactions are not affected.`)) { try { await api('goalDelete', profile.id, g.id); load() } catch (e) { setError((e as Error).message) } } }

  if (!goals) return <p className="muted">Loading…</p>

  return (
    <>
      <div className="page-head">
        <div><h1>Goals</h1><p>Targets with progress, the monthly amount needed, and when you would get there.</p></div>
        <button className="btn primary" onClick={() => setForm({ ...blank })}>Add goal</button>
      </div>
      <ErrorBox error={error} />
      <GoalIdeas profileId={profile.id} onAdded={load} hint={goals.length === 0} />

      {form && (
        <Card>
          <div className="card-head"><h2>{form.id === null ? 'New goal' : 'Edit goal'}</h2></div>
          <div className="filters">
            <label className="field">Name<input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. New car" style={{ width: 260 }} /></label>
            <label className="field">Type
              <select value={form.kind} disabled={form.id !== null} onChange={(e) => set({ kind: e.target.value as GoalKind })}>
                {(Object.keys(KIND_LABEL) as GoalKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </select>
            </label>
            {form.kind !== 'debt' && <label className="field">Target ($)<input type="number" min="0" step="0.01" value={form.target} onChange={(e) => set({ target: e.target.value })} style={{ width: 130 }} /></label>}
            {(form.kind === 'manual' || form.kind === 'category') && <label className="field">{form.kind === 'category' ? 'Saved separately so far ($)' : 'Saved so far ($)'}<input type="number" min="0" step="0.01" value={form.saved} onChange={(e) => set({ saved: e.target.value })} style={{ width: 150 }} /></label>}
            <label className="field">Deadline (optional)<input type="date" value={form.deadline} onChange={(e) => set({ deadline: e.target.value })} /></label>
            <label className="field">Planned per month ($, optional)<input type="number" min="0" step="0.01" value={form.planned} onChange={(e) => set({ planned: e.target.value })} style={{ width: 150 }} /></label>
          </div>
          {form.kind === 'account' && (
            <label className="field" style={{ marginBottom: 12 }}>Account to track
              <select value={form.accountId} onChange={(e) => set({ accountId: e.target.value })} style={{ maxWidth: 320 }}><option value="">Choose…</option>{trackable.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
            </label>
          )}
          {form.kind === 'category' && (
            <label className="field" style={{ marginBottom: 12 }}>Spending category that counts toward the goal
              <select value={form.categoryId} onChange={(e) => set({ categoryId: e.target.value })} style={{ maxWidth: 320 }}><option value="">Choose…</option>{categories.filter((c) => c.kind === 'expense').map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
            </label>
          )}
          {form.kind === 'debt' && (
            <div style={{ marginBottom: 12 }}>
              <div className="muted" style={{ marginBottom: 6 }}>Which cards and loans to pay off. Progress starts from what is owed on them today.</div>
              <div className="chips">
                {cards.map((a) => <label key={`a${a.id}`}><input type="checkbox" checked={form.items.includes(`a${a.id}`)} onChange={(e) => set({ items: e.target.checked ? [...form.items, `a${a.id}`] : form.items.filter((x) => x !== `a${a.id}`) })} />{a.name} ({formatCents(Math.max(0, -(a.valueCents ?? 0)))})</label>)}
                {debts.map((d) => <label key={`d${d.id}`}><input type="checkbox" checked={form.items.includes(`d${d.id}`)} onChange={(e) => set({ items: e.target.checked ? [...form.items, `d${d.id}`] : form.items.filter((x) => x !== `d${d.id}`) })} />{d.name} ({formatCents(d.balanceCents)})</label>)}
              </div>
            </div>
          )}
          <label className="field">Notes (optional)<input value={form.notes} onChange={(e) => set({ notes: e.target.value })} /></label>
          <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
            <button className="btn primary" disabled={!form.name.trim()} onClick={() => void save()}>Save goal</button>
            <button className="btn" onClick={() => { setForm(null); setError(null) }}>Cancel</button>
          </div>
        </Card>
      )}
      {form && <div style={{ height: 16 }} />}

      {goals.length === 0 ? <Card><h2>No goals yet</h2><p className="sub">Add a goal to track a savings target, a debt you want gone, or money set aside for something big.</p></Card> : (
        <div className="grid two">
          {goals.map((g) => {
            const p = g.progress
            const st = STATUS[p.status]
            return (
              <Card key={g.id} className="goal-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
                  <div><h2>{g.name}</h2><div className="muted">{KIND_LABEL[g.kind]}{g.accountName ? ` · ${g.accountName}` : ''}{g.categoryName ? ` · ${g.categoryName}` : ''}</div></div>
                  <span className={`badge ${st.cls}`}>{st.label}</span>
                </div>
                <div>
                  <div className="num" style={{ fontSize: 22, fontWeight: 700 }}>
                    {g.kind === 'debt' ? <>{formatCents(p.remainingCents)} <span className="muted" style={{ fontSize: 13, fontWeight: 500 }}>still owed of {formatCents(g.targetCents)} at the start</span></>
                      : p.achievedCents === null ? <span className="muted" style={{ fontSize: 15, fontWeight: 500 }}>No value entered yet</span>
                      : <>{formatCents(p.achievedCents)} <span className="muted" style={{ fontSize: 13, fontWeight: 500 }}>of {formatCents(g.targetCents)}</span></>}
                  </div>
                  <ProgressBar value={p.progress} tone="goal" label={`${g.name} progress`} />
                  <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{pct(p.progress)} {g.kind === 'debt' ? 'paid off' : 'there'}</div>
                </div>
                <div className="kv">
                  <div><div className="k">Remaining</div><div className="v num">{formatCents(p.remainingCents)}</div></div>
                  <div><div className="k">Deadline</div><div className="v">{g.deadline ?? 'None set'}</div></div>
                  <div><div className="k">Needed per month</div><div className="v num">{p.requiredMonthlyCents === null ? 'Set a deadline' : formatCents(p.requiredMonthlyCents)}</div></div>
                  <div><div className="k">Planned per month</div><div className="v num">{g.plannedMonthlyCents ? formatCents(g.plannedMonthlyCents) : 'Not set'}</div></div>
                  <div><div className="k">Estimated finish</div><div className="v">{p.estimatedMonth ? monthLabel(p.estimatedMonth) : g.plannedMonthlyCents ? '—' : 'Needs a monthly plan'}</div></div>
                </div>
                {g.items.length > 0 && (
                  <div className="table-wrap"><table><tbody>
                    {g.items.map((i) => <tr key={`${i.type}${i.accountId ?? i.debtId}`}><td>{i.label}<span className="muted"> · {i.type === 'card' ? 'card' : 'loan'}</span></td><td className="r num">{formatCents(i.owedCents)}</td></tr>)}
                  </tbody></table></div>
                )}
                {g.notes && <div className="muted" style={{ fontSize: 12.5 }}>{g.notes}</div>}
                {p.status === 'no_value' && <div><button className="btn small" onClick={() => goto('accounts')}>Enter the account value</button></div>}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn small" onClick={() => edit(g)}>Edit</button>
                  <button className="btn small danger" onClick={() => void remove(g)}>Delete</button>
                </div>
              </Card>
            )
          })}
        </div>
      )}
      <div style={{ height: 20 }} />
      <DebtPlanner profileId={profile.id} />
      <p className="muted" style={{ marginTop: 14 }}>Estimates divide what is left by your planned monthly amount, starting this month. They ignore changes in your income, and they ignore interest (the debt payoff planner above includes it), so treat them as a guide.</p>
    </>
  )
}
