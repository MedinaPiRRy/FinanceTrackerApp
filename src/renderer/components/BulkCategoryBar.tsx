import { useState } from 'react'
import { api } from '../api'
import { ErrorBox } from './ui'
import type { CategoryInfo } from '../../db/queries'

/**
 * The bar that appears when transactions are ticked: put them all in one category (an existing one, or a new one
 * created right here). Remembering the merchant names for future imports is a tick-box that starts off.
 */
export function BulkCategoryBar({ count, total, profileId, categories, onApply, onClear, onSelectAll, onCategoryCreated }: {
  count: number
  /** How many rows match the current filters (offers "select all N" when more than the ticked ones). */
  total: number
  profileId: number
  categories: CategoryInfo[]
  onApply: (categoryId: number, remember: boolean) => Promise<void>
  onClear: () => void
  onSelectAll: () => void
  onCategoryCreated: () => void
}) {
  const [categoryId, setCategoryId] = useState('')
  const [remember, setRemember] = useState(false)
  const [newName, setNewName] = useState('')
  const [newKind, setNewKind] = useState<'expense' | 'income'>('expense')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const create = async () => {
    try {
      const c = await api('createCategory', profileId, newName, newKind)
      onCategoryCreated()
      setCategoryId(String(c.id))
      setNewName('')
      setError(null)
    } catch (e) { setError((e as Error).message) }
  }
  const apply = async () => {
    setBusy(true)
    try { await onApply(Number(categoryId), remember); setError(null); setCategoryId('') } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <div className="bulk-bar" role="region" aria-label="Change the category of the selected transactions">
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <b>{count.toLocaleString()} selected</b>
        {total > count && <button className="btn small" onClick={onSelectAll}>Select all {total.toLocaleString()} that match</button>}
        <button className="btn small" onClick={onClear}>Clear selection</button>
      </div>
      <div className="filters" style={{ marginTop: 8, marginBottom: 0 }}>
        <label className="field">Move to category
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Choose…</option>
            <optgroup label="Spending">{categories.filter((c) => c.kind === 'expense').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>
            <optgroup label="Income">{categories.filter((c) => c.kind === 'income').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>
          </select>
        </label>
        <label className="field">Or create one
          <span style={{ display: 'flex', gap: 6 }}>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Pets" style={{ width: 140 }} />
            <select value={newKind} onChange={(e) => setNewKind(e.target.value as 'expense' | 'income')} aria-label="Kind of the new category"><option value="expense">Spending</option><option value="income">Income</option></select>
            <button className="btn" type="button" disabled={!newName.trim()} onClick={() => void create()}>Add</button>
          </span>
        </label>
        <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Also remember these names for future imports
        </label>
        <button className="btn primary" disabled={!categoryId || busy} onClick={() => void apply()}>Move {count.toLocaleString()}</button>
      </div>
      <ErrorBox error={error} />
    </div>
  )
}
