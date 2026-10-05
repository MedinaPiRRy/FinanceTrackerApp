import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { Card, ErrorBox, ProgressBar, StateBadge } from '../components/ui'
import { formatCents, monthLabel, today } from '../format'
import { SuggestBudgets } from '../components/SuggestBudgets'
import type { HouseholdBudgetReport, CategoryGroupRow } from '../../db/household'

const toCents = (v: string) => Math.round(Number(v) * 100)

function GroupEditor({ onChanged }: { onChanged: () => void }) {
  const [rows, setRows] = useState<CategoryGroupRow[]>([])
  const [names, setNames] = useState<string[]>([])
  const [draft, setDraft] = useState<Record<number, string>>({})
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => { void api('categoryGroups').then(setRows); void api('groupNames').then(setNames) }, [])
  useEffect(load, [load])

  const save = async (r: CategoryGroupRow, value: string) => {
    try { await api('setCategoryGroup', r.id, value.trim() === '' ? null : value.trim()); setDraft((d) => { const n = { ...d }; delete n[r.id]; return n }); setError(null); load(); onChanged() } catch (e) { setError((e as Error).message) }
  }

  return (
    <Card>
      <div className="card-head"><h2>Category groups</h2><span className="muted">Each of you has your own category names. A group is the shared name used for household totals and budgets.</span></div>
      <ErrorBox error={error} />
      <datalist id="group-names">{names.map((n) => <option key={n} value={n} />)}</datalist>
      <div className="table-wrap"><table>
        <thead><tr><th>Whose</th><th>Category</th><th>Category group</th><th></th></tr></thead>
        <tbody>
          {rows.map((r) => {
            const v = draft[r.id] ?? r.group
            return (
              <tr key={r.id}>
                <td>{r.owner}</td><td>{r.name}</td>
                <td><input list="group-names" value={v} aria-label={`Group for ${r.owner}'s ${r.name}`} onChange={(e) => setDraft({ ...draft, [r.id]: e.target.value })} style={{ width: 240 }} /></td>
                <td className="r" style={{ whiteSpace: 'nowrap' }}>
                  {draft[r.id] !== undefined && draft[r.id] !== r.group && <button className="btn small primary" onClick={() => void save(r, draft[r.id]!)}>Save</button>}{' '}
                  {r.overridden && <button className="btn small" title="Go back to the automatic group" onClick={() => void save(r, '')}>Reset</button>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table></div>
    </Card>
  )
}

export function HouseholdBudget({ onChanged }: { onChanged: () => void }) {
  const [month, setMonth] = useState<string | undefined>()
  const [months, setMonths] = useState<string[]>([])
  const thisMonth = today().slice(0, 7)
  const [report, setReport] = useState<HouseholdBudgetReport | null>(null)
  const [groups, setGroups] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [name, setName] = useState('')
  const [amount, setAmount] = useState('')
  const [picked, setPicked] = useState<string[]>([])

  useEffect(() => { void api('householdOverview').then((d) => { if (d) { setMonths(d.availableMonths); setMonth(d.month) } else { setMonths([thisMonth]); setMonth(thisMonth) } }) }, [])
  const load = useCallback(() => {
    if (!month) return
    void api('householdBudgets', month).then((r) => setReport(r.report)).catch((e: Error) => setError(e.message))
    void api('groupNames').then(setGroups)
  }, [month])
  useEffect(load, [load])

  const taken = new Map<string, string>()
  report?.lines.forEach((l) => l.groups.forEach((g) => { if (editing !== l.id) taken.set(g, l.name) }))
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); setError(null); setEditing(null); load(); onChanged() } catch (e) { setError((e as Error).message) } }
  const startNew = () => { setEditing('new'); setName(''); setAmount(''); setPicked([]) }
  const startEdit = (l: HouseholdBudgetReport['lines'][number]) => { setEditing(l.id); setName(l.name); setAmount((l.budgetCents / 100).toFixed(2)); setPicked(l.groups) }
  const save = () => {
    if (amount.trim() === '' || Number.isNaN(Number(amount)) || Number(amount) < 0) return setError('Enter the monthly amount as a number, e.g. 600')
    if (editing === 'new') void run(() => api('householdBudgetCreate', name, toCents(amount), picked))
    else if (editing !== null) void run(() => api('householdBudgetUpdate', editing, { name, monthlyCents: toCents(amount), groups: picked }))
  }

  if (!report || !month) return <p className="muted">Loading…</p>
  const t = report.totals
  const over = report.lines.filter((l) => l.state === 'over').length

  return (
    <>
      <div className="page-head">
        <div><h1>Household budget</h1><p>Monthly budgets for the two of you together, by category group. Each line shows who spent what.</p></div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
          <label className="field">Month<select value={month} onChange={(e) => setMonth(e.target.value)}>{[...months].reverse().map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}</select></label>
          <button className="btn primary" onClick={startNew}>Add budget</button>
        </div>
      </div>
      <ErrorBox error={error} />
      <SuggestBudgets
        hint={report.lines.length === 0}
        load={() => api('householdBudgetSuggest').then((r) => ({ months: r.months, suggestions: r.suggestions }))}
        create={(items) => api('householdBudgetCreateMany', items.map((i) => ({ name: i.name, monthlyCents: i.monthlyCents, groups: [i.key] })))}
        onCreated={() => { load(); onChanged() }}
      />

      {editing !== null && (
        <>
          <Card>
            <div className="card-head"><h2>{editing === 'new' ? 'New household budget' : `Edit "${name}"`}</h2></div>
            <div className="filters">
              <label className="field">Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Eating out" /></label>
              <label className="field">Monthly amount ($)<input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 130 }} /></label>
            </div>
            <div className="muted" style={{ marginBottom: 6 }}>Category groups covered (each group can be in one budget):</div>
            <div className="chips" role="group" aria-label="Category groups in this budget">
              {groups.map((g) => {
                const other = taken.get(g)
                const checked = picked.includes(g)
                return (
                  <label key={g} title={other && !checked ? `Already in "${other}"` : undefined} style={other && !checked ? { opacity: 0.45 } : undefined}>
                    <input type="checkbox" checked={checked} disabled={!!other && !checked} onChange={(e) => setPicked(e.target.checked ? [...picked, g] : picked.filter((x) => x !== g))} />{g}
                  </label>
                )
              })}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button className="btn primary" disabled={!name.trim()} onClick={save}>Save budget</button>
              <button className="btn" onClick={() => { setEditing(null); setError(null) }}>Cancel</button>
            </div>
          </Card>
          <div style={{ height: 16 }} />
        </>
      )}

      <div className="grid stats">
        <Card className="stat"><div className="label">Budgeted</div><div className="value num">{formatCents(t.budgetCents)}</div></Card>
        <Card className="stat"><div className="label">Spent in budgeted groups</div><div className="value num">{formatCents(t.spentCents)}</div></Card>
        <Card className="stat"><div className="label">{t.remainingCents >= 0 ? 'Left to spend' : 'Over by'}</div><div className={`value num ${t.remainingCents < 0 ? 'neg' : 'pos'}`}>{formatCents(Math.abs(t.remainingCents))}</div></Card>
        <Card className="stat"><div className="label">Over budget</div><div className={`value num ${over ? 'neg' : ''}`}>{over} of {report.lines.length}</div></Card>
      </div>

      <Card>
        {report.lines.length === 0 ? <p className="muted">No household budgets yet. Add one to track a category group for both of you together.</p> : (
          <div className="table-wrap"><table>
            <caption className="sr-only">Household budgets for {monthLabel(month)}</caption>
            <thead><tr><th>Budget</th><th className="r">Monthly budget</th><th className="r">Spent</th><th className="r">Left</th><th style={{ width: 160 }}>Progress</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {report.lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.name}<div className="muted" style={{ fontSize: 12 }}>{l.groups.join(' · ') || 'No groups yet'}</div></td>
                  <td className="r num">{formatCents(l.budgetCents)}</td>
                  <td className="r num">{formatCents(l.spentCents)}<div className="muted" style={{ fontSize: 12 }}>{l.perOwner.map((o) => `${o.name} ${formatCents(o.cents)}`).join(' · ')}</div></td>
                  <td className={`r num ${l.remainingCents < 0 ? 'neg' : ''}`}>{l.remainingCents < 0 ? '-' : ''}{formatCents(Math.abs(l.remainingCents))}</td>
                  <td><ProgressBar value={l.ratio ?? (l.spentCents > 0 ? 1 : 0)} tone={l.state} label={`${l.name} budget used`} /><div className="muted" style={{ fontSize: 12 }}>{l.ratio === null ? 'no limit set' : `${Math.round(l.ratio * 100)}% used`}</div></td>
                  <td><StateBadge state={l.state} /></td>
                  <td className="r" style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn small" onClick={() => startEdit(l)}>Edit</button>{' '}
                    <button className="btn small danger" onClick={() => { if (confirm(`Delete the "${l.name}" household budget? Your transactions are not affected.`)) void run(() => api('householdBudgetDelete', l.id)) }}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Card>

      {report.unbudgeted.length > 0 && (
        <>
          <div style={{ height: 16 }} />
          <Card>
            <div className="card-head"><h2>Spending in no household budget</h2><span className="muted">{monthLabel(month)}</span></div>
            <div className="table-wrap"><table><tbody>{report.unbudgeted.map((u) => <tr key={u.group}><td>{u.group}</td><td className="r num">{formatCents(u.cents)}</td></tr>)}</tbody></table></div>
          </Card>
        </>
      )}

      <div style={{ height: 16 }} />
      <GroupEditor onChanged={load} />
    </>
  )
}
