import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { Card, ErrorBox, Segmented } from './ui'
import type { CategoryRow } from '../../db/categoriesManage'
import type { BudgetRow } from '../../db/budgets'

type Kind = 'expense' | 'income'

/** Add, rename and delete the categories transactions are filed under, and choose which budget a spending category counts toward. */
export function CategoryManager({ profileId, onChanged }: { profileId: number; onChanged: () => void }) {
  const [rows, setRows] = useState<CategoryRow[] | null>(null)
  const [budgets, setBudgets] = useState<BudgetRow[]>([])
  const [kind, setKind] = useState<Kind>('expense')
  const [newName, setNewName] = useState('')
  const [newParent, setNewParent] = useState('')
  const [moving, setMoving] = useState<number | null>(null)
  const [editing, setEditing] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [deleting, setDeleting] = useState<number | null>(null)
  const [moveTo, setMoveTo] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    void api('categoryManage', profileId).then((r) => { setRows(r); setError(null) }).catch((e: Error) => setError(e.message))
    void api('budgetList', profileId).then(setBudgets).catch(() => setBudgets([]))
  }, [profileId])
  useEffect(load, [load])

  const run = async (fn: () => Promise<unknown>, note?: string) => {
    try { await fn(); setError(null); if (note) { setMsg(note); setTimeout(() => setMsg(null), 3500) }; load(); onChanged() } catch (e) { setError((e as Error).message) }
  }

  const shown = (rows ?? []).filter((c) => c.kind === kind)
  const deletingRow = rows?.find((c) => c.id === deleting)
  const mains = (rows ?? []).filter((c) => c.kind === kind && c.parentId === null)
  const targets = (rows ?? []).filter((c) => c.kind === kind && c.id !== deleting && !(deletingRow && c.parentId === deletingRow.id))
  const inUse = (c: CategoryRow) => c.txnCount + c.goalCount > 0

  return (
    <Card>
      <div className="card-head"><h2>Categories</h2><Segmented<Kind> small label="Kind of category" value={kind} onChange={(k) => { setKind(k); setEditing(null); setDeleting(null) }} options={[{ value: 'expense', label: 'Spending' }, { value: 'income', label: 'Income' }]} /></div>
      <p className="sub" style={{ marginTop: 0 }}>The categories your transactions are filed under. Rename one and every transaction follows. A subcategory (like Gas under Gas & Transportation) counts toward its main category in budgets and charts, and you still see it on its own. {kind === 'expense' ? 'Choose which budget a category counts toward (a category is in at most one).' : 'Income categories are not part of budgets.'}</p>
      <ErrorBox error={error} />
      {msg && <div className="notice" role="status">{msg}</div>}

      <div className="filters">
        <label className="field">New {kind === 'expense' ? 'spending' : 'income'} category<input value={newName} maxLength={60} onChange={(e) => setNewName(e.target.value)} placeholder={kind === 'expense' ? 'e.g. Pets' : 'e.g. Side job'} style={{ width: 220 }} onKeyDown={(e) => { if (e.key === 'Enter' && newName.trim()) void run(async () => { await api('createCategory', profileId, newName, kind, newParent ? Number(newParent) : null); setNewName('') }, 'Category added.') }} /></label>
        <label className="field">Under<select value={newParent} onChange={(e) => setNewParent(e.target.value)}><option value="">Nothing (a main category)</option>{mains.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
        <button className="btn primary" disabled={!newName.trim()} onClick={() => void run(async () => { await api('createCategory', profileId, newName, kind, newParent ? Number(newParent) : null); setNewName('') }, 'Category added.')}>Add</button>
      </div>

      {rows === null ? <p className="muted">Loading…</p> : shown.length === 0 ? <p className="muted">No {kind === 'expense' ? 'spending' : 'income'} categories yet.</p> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Name</th><th className="r">Transactions</th>{kind === 'expense' && <th>Budget</th>}{kind === 'expense' && <th>Counts as</th>}<th></th></tr></thead>
          <tbody>
            {shown.map((c) => (
              <tr key={c.id}>
                <td>
                  {editing === c.id ? (
                    <span style={{ display: 'flex', gap: 6 }}>
                      <input value={editName} maxLength={60} autoFocus aria-label={`New name for ${c.name}`} onChange={(e) => setEditName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void run(async () => { await api('categoryRename', profileId, c.id, editName); setEditing(null) }, 'Renamed.'); if (e.key === 'Escape') setEditing(null) }} />
                      <button className="btn small primary" onClick={() => void run(async () => { await api('categoryRename', profileId, c.id, editName); setEditing(null) }, 'Renamed.')}>Save</button>
                      <button className="btn small" onClick={() => setEditing(null)}>Cancel</button>
                    </span>
                  ) : <span style={{ paddingLeft: c.parentId ? 20 : 0 }}>{c.parentId ? '↳ ' : ''}{c.name}</span>}
                  {(c.ruleCount > 0 || c.goalCount > 0) && editing !== c.id && <div className="muted" style={{ fontSize: 12 }}>{[c.ruleCount > 0 ? `${c.ruleCount} remembered name${c.ruleCount === 1 ? '' : 's'}` : '', c.goalCount > 0 ? `${c.goalCount} goal${c.goalCount === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ')}</div>}
                </td>
                <td className="r num">{c.txnCount.toLocaleString()}</td>
                {kind === 'expense' && (
                  <td>
                    <select aria-label={`Budget for ${c.name}`} value={c.budgetId ?? ''} onChange={(e) => void run(() => api('categorySetBudget', profileId, c.id, e.target.value ? Number(e.target.value) : null), 'Budget updated.')}>
                      <option value="">No budget</option>
                      {budgets.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                  </td>
                )}
                {kind === 'expense' && (
                  <td>
                    <select aria-label={`Counts as, for ${c.name}`} value={c.purpose ?? ''} onChange={(e) => void run(() => api('categorySetPurpose', profileId, c.id, e.target.value ? (e.target.value as 'tax' | 'interest' | 'none') : null), 'Updated.')}>
                      <option value="">{c.effectivePurpose === 'none' ? 'Ordinary spending' : `Auto: ${c.effectivePurpose === 'tax' ? 'Taxes' : 'Interest'}`}</option>
                      <option value="tax">Taxes</option><option value="interest">Interest</option><option value="none">Neither</option>
                    </select>
                  </td>
                )}
                <td className="r" style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn small" aria-label={`Rename ${c.name}`} onClick={() => { setEditing(c.id); setEditName(c.name); setDeleting(null) }}>Rename</button>{' '}
                  {moving === c.id ? (
                    <select autoFocus aria-label={`Move ${c.name} under`} defaultValue="" onChange={(e) => void run(async () => { await api('categorySetParent', profileId, c.id, e.target.value === 'none' ? null : Number(e.target.value)); setMoving(null) }, 'Moved.')} onBlur={() => setMoving(null)}>
                      <option value="" disabled>Move under…</option>
                      {c.parentId !== null && <option value="none">Make it a main category</option>}
                      {mains.filter((m) => m.id !== c.id && m.id !== c.parentId).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                  ) : <><button className="btn small" aria-label={`Move ${c.name}`} onClick={() => setMoving(c.id)}>Move</button>{' '}</>}
                  <button className="btn small danger" aria-label={`Delete ${c.name}`} onClick={() => { setDeleting(c.id); setMoveTo(''); setEditing(null) }}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}

      {deletingRow && (
        <div className="review-card" style={{ marginTop: 12 }} role="group" aria-label={`Delete ${deletingRow.name}`}>
          <b>Delete “{deletingRow.name}”?</b>
          {inUse(deletingRow) ? (
            <>
              <p className="sub" style={{ margin: 0 }}>{deletingRow.txnCount.toLocaleString()} transaction{deletingRow.txnCount === 1 ? '' : 's'}{deletingRow.goalCount ? ` and ${deletingRow.goalCount} goal${deletingRow.goalCount === 1 ? '' : 's'}` : ''} use it. Choose the category they move to. Its remembered names and budget place move too, so nothing is left without a category.</p>
              <label className="field">Move them to
                <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)}><option value="">Choose…</option>{targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
              </label>
            </>
          ) : <p className="sub" style={{ margin: 0 }}>Nothing uses it, so it is simply removed{deletingRow.budgetName ? ` (and taken out of the “${deletingRow.budgetName}” budget)` : ''}.</p>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn danger" disabled={inUse(deletingRow) && !moveTo} onClick={() => void run(async () => { const r = await api('categoryDelete', profileId, deletingRow.id, moveTo ? Number(moveTo) : null); setDeleting(null); setMsg(r.moved ? `Deleted. ${r.moved.toLocaleString()} transaction${r.moved === 1 ? '' : 's'} moved.` : 'Deleted.') })}>{inUse(deletingRow) ? 'Move and delete' : 'Delete'}</button>
            <button className="btn" onClick={() => setDeleting(null)}>Keep it</button>
          </div>
        </div>
      )}
    </Card>
  )
}
