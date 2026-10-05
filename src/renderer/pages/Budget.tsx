import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { Card, ErrorBox, ProgressBar, StateBadge } from '../components/ui'
import { formatCents, monthLabel, today } from '../format'
import { SuggestBudgets } from '../components/SuggestBudgets'
import type { BudgetReport } from '../../db/budgets'
import type { CategoryInfo, Profile } from '../../db/queries'
import type { Page, TxnPreset } from '../App'

const toCents = (v: string) => Math.round(Number(v) * 100)

function CategoryPicker({ categories, selected, takenBy, onChange }: { categories: CategoryInfo[]; selected: number[]; takenBy: Map<number, string>; onChange: (ids: number[]) => void }) {
  return (
    <div className="chips" role="group" aria-label="Categories in this budget">
      {categories.filter((c) => c.kind === 'expense').map((c) => {
        const other = takenBy.get(c.id)
        const checked = selected.includes(c.id)
        return (
          <label key={c.id} title={other && !checked ? `Already in "${other}"` : undefined} style={other && !checked ? { opacity: 0.45 } : undefined}>
            <input type="checkbox" checked={checked} disabled={!!other && !checked} onChange={(e) => onChange(e.target.checked ? [...selected, c.id] : selected.filter((x) => x !== c.id))} />
            {c.name}
          </label>
        )
      })}
    </div>
  )
}

export function Budget({ profile, categories, goto, onChanged }: { profile: Profile; categories: CategoryInfo[]; goto: (p: Page, preset?: TxnPreset) => void; onChanged: () => void }) {
  const [month, setMonth] = useState<string | undefined>()
  const [months, setMonths] = useState<string[]>([])
  const thisMonth = today().slice(0, 7) // a profile with no transactions yet still gets a page, for the current month
  const [report, setReport] = useState<BudgetReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [name, setName] = useState('')
  const [amount, setAmount] = useState('')
  const [picked, setPicked] = useState<number[]>([])

  useEffect(() => { void api('dashboard', profile.id).then((d) => { if (d) { setMonths(d.availableMonths); setMonth((m) => m ?? d.month) } else { setMonths([thisMonth]); setMonth((m) => m ?? thisMonth) } }) }, [profile.id])
  const load = useCallback(() => { if (month) void api('budgets', profile.id, month).then(setReport).catch((e: Error) => setError(e.message)) }, [profile.id, month])
  useEffect(load, [load])

  const takenBy = new Map<number, string>()
  report?.lines.forEach((l) => l.categoryIds.forEach((c) => { if (editing !== l.id) takenBy.set(c, l.name) }))

  const run = async (fn: () => Promise<unknown>) => { try { await fn(); setError(null); setEditing(null); load(); onChanged() } catch (e) { setError((e as Error).message) } }
  const startEdit = (l: BudgetReport['lines'][number]) => { setEditing(l.id); setName(l.name); setAmount((l.budgetCents / 100).toFixed(2)); setPicked(l.categoryIds) }
  const startNew = () => { setEditing('new'); setName(''); setAmount(''); setPicked([]) }
  const save = () => {
    if (amount.trim() === '' || Number.isNaN(Number(amount)) || Number(amount) < 0) return setError('Enter the monthly amount as a number, e.g. 250')
    if (editing === 'new') void run(() => api('budgetCreate', profile.id, name, toCents(amount), picked))
    else if (editing !== null) void run(() => api('budgetUpdate', profile.id, editing, { name, monthlyCents: toCents(amount), categoryIds: picked }))
  }
  const remove = (l: BudgetReport['lines'][number]) => { if (confirm(`Delete the "${l.name}" budget? Your transactions are not affected.`)) void run(() => api('budgetDelete', profile.id, l.id)) }

  if (!report || !month) return <p className="muted">Loading…</p>
  const t = report.totals
  const over = report.lines.filter((l) => l.state === 'over').length
  const catId = (n: string) => categories.find((c) => c.kind === 'expense' && c.name === n)?.id
  const range = { from: `${month}-01`, to: `${month}-31` }

  const editor = (
    <Card>
      <div className="card-head"><h2>{editing === 'new' ? 'New budget' : `Edit "${name}"`}</h2></div>
      <div className="filters">
        <label className="field">Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Eating out" /></label>
        <label className="field">Monthly amount ($)<input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 130 }} /></label>
      </div>
      <div className="muted" style={{ marginBottom: 6 }}>Spending categories covered (each category can be in one budget):</div>
      <CategoryPicker categories={categories} selected={picked} takenBy={takenBy} onChange={setPicked} />
      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button className="btn primary" disabled={!name.trim()} onClick={save}>Save budget</button>
        <button className="btn" onClick={() => { setEditing(null); setError(null) }}>Cancel</button>
      </div>
    </Card>
  )

  return (
    <>
      <div className="page-head">
        <div><h1>Budget</h1><p>Monthly budgets by category. Spending is expenses minus refunds; transfers never count.</p></div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
          <label className="field">Month<select value={month} onChange={(e) => setMonth(e.target.value)}>{[...months].reverse().map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}</select></label>
          <button className="btn primary" onClick={startNew}>Add budget</button>
        </div>
      </div>
      <ErrorBox error={error} />
      <SuggestBudgets
        hint={report.lines.length === 0}
        load={() => api('budgetSuggest', profile.id).then((r) => ({ months: r.months, suggestions: r.suggestions }))}
        create={(items) => api('budgetCreateMany', profile.id, items.map((i) => ({ name: i.name, monthlyCents: i.monthlyCents, categoryIds: [Number(i.key)] })))}
        onCreated={() => { load(); onChanged() }}
      />
      {editing !== null && editor}
      {editing !== null && <div style={{ height: 16 }} />}

      <div className="grid stats">
        <Card className="stat"><div className="label">Budgeted</div><div className="value num">{formatCents(t.budgetCents)}</div></Card>
        <Card className="stat"><div className="label">Spent in budgeted categories</div><div className="value num">{formatCents(t.spentCents)}</div></Card>
        <Card className="stat"><div className="label">{t.remainingCents >= 0 ? 'Left to spend' : 'Over by'}</div><div className={`value num ${t.remainingCents < 0 ? 'neg' : 'pos'}`}>{formatCents(Math.abs(t.remainingCents))}</div><div className="hint">Across all budgets together</div></Card>
        <Card className="stat"><div className="label">Over budget</div><div className={`value num ${over ? 'neg' : ''}`}>{over} of {report.lines.length}</div></Card>
      </div>

      <Card>
        {report.lines.length === 0 ? <p className="muted">No budgets yet. Add one to start tracking a category.</p> : (
          <div className="table-wrap"><table>
            <caption className="sr-only">Budgets for {monthLabel(month)}</caption>
            <thead><tr><th>Budget</th><th className="r">Monthly budget</th><th className="r">Spent</th><th className="r">Left</th><th style={{ width: 170 }}>Progress</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {report.lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.name}<div className="muted" style={{ fontSize: 12 }}>{l.categoryNames.join(' · ') || 'No categories yet'}</div></td>
                  <td className="r num">{formatCents(l.budgetCents)}</td>
                  <td className="r num">{formatCents(l.spentCents)}{l.projectedCents != null && l.projectedCents > l.budgetCents && l.state !== 'over' && <div className="muted" style={{ fontSize: 12 }}>on pace for {formatCents(l.projectedCents)}</div>}</td>
                  <td className={`r num ${l.remainingCents < 0 ? 'neg' : ''}`}>{l.remainingCents < 0 ? '-' : ''}{formatCents(Math.abs(l.remainingCents))}</td>
                  <td><ProgressBar value={l.ratio ?? (l.spentCents > 0 ? 1 : 0)} tone={l.state} label={`${l.name} budget used`} /><div className="muted" style={{ fontSize: 12 }}>{l.ratio === null ? 'no limit set' : `${Math.round(l.ratio * 100)}% used`}</div></td>
                  <td><StateBadge state={l.state} /></td>
                  <td className="r" style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn small" onClick={() => startEdit(l)}>Edit</button>{' '}
                    <button className="btn small danger" onClick={() => remove(l)}>Delete</button>
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
            <div className="card-head"><h2>Spending with no budget</h2><span className="muted">Categories in {monthLabel(month)} that are not in any budget</span></div>
            <div className="table-wrap"><table><tbody>
              {report.unbudgeted.map((u) => (
                <tr key={u.categoryId}><td>{u.name}</td><td className="r num">{formatCents(u.spentCents)}</td><td className="r"><button className="btn small" onClick={() => { const id = catId(u.name); if (id) goto('transactions', { categoryId: id, ...range }) }}>View</button></td></tr>
              ))}
            </tbody></table></div>
          </Card>
        </>
      )}
    </>
  )
}
