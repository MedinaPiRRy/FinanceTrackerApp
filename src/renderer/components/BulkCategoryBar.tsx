import { useState } from 'react'
import { api } from '../api'
import { ErrorBox, Segmented } from './ui'
import type { CategoryInfo } from '../../db/queries'
import type { BulkEdit, BulkKind } from '../../db/txnBulk'

type Mode = 'move' | 'edit' | 'cost' | 'delete'
const KIND_OPTIONS: { value: BulkKind | ''; label: string }[] = [
  { value: '', label: 'Leave as it is' }, { value: 'expense', label: 'Spending' }, { value: 'income', label: 'Income' }, { value: 'refund', label: 'Refund' }, { value: 'transfer', label: 'Transfer between my accounts' }
]

/**
 * The bar that appears when transactions are ticked. Move them to another category (an existing one, or a new one created right here),
 * edit them (rename the merchant, change the type), or delete them after a confirmation that says how many.
 * Remembering the merchant names for future imports is a tick-box that starts off.
 */
export function BulkCategoryBar({ count, total, profileId, categories, onApply, onEdit, onCost, onDelete, onClear, onSelectAll, onCategoryCreated }: {
  count: number
  /** How many rows match the current filters (offers "select all N" when more than the ticked ones). */
  total: number
  profileId: number
  categories: CategoryInfo[]
  onApply: (categoryId: number, remember: boolean) => Promise<void>
  onEdit?: (edit: BulkEdit) => Promise<void>
  /** Count the selected payments as taxes, as interest, as not counted, or (null) automatically on the Taxes & interest page. */
  onCost?: (purpose: 'tax' | 'interest' | 'none' | null) => Promise<void>
  onDelete?: () => Promise<void>
  onClear: () => void
  onSelectAll: () => void
  onCategoryCreated: () => void
}) {
  const [mode, setMode] = useState<Mode>('move')
  const [categoryId, setCategoryId] = useState('')
  const [remember, setRemember] = useState(false)
  const [newName, setNewName] = useState('')
  const [newParent, setNewParent] = useState('')
  const [newKind, setNewKind] = useState<'expense' | 'income'>('expense')
  const [name, setName] = useState('')
  const [kind, setKind] = useState<BulkKind | ''>('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const create = async () => {
    try {
      const c = await api('createCategory', profileId, newName, newKind, newParent ? Number(newParent) : null)
      onCategoryCreated()
      setCategoryId(String(c.id))
      setNewName('')
      setError(null)
    } catch (e) { setError((e as Error).message) }
  }
  const guard = async (fn: () => Promise<void>) => {
    setBusy(true)
    try { await fn(); setError(null) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const apply = () => guard(async () => { await onApply(Number(categoryId), remember); setCategoryId('') })
  const edit = () => guard(async () => {
    await onEdit!({ description: name.trim() || undefined, kind: kind || undefined, categoryId: kind === 'transfer' || !categoryId ? undefined : Number(categoryId), remember: remember && kind !== 'transfer' })
    setName(''); setKind(''); setCategoryId('')
  })
  const del = () => {
    if (!confirm(`Delete ${count.toLocaleString()} transaction${count === 1 ? '' : 's'}? This cannot be undone, and the balances of their accounts change.`)) return
    void guard(async () => { await onDelete!() })
  }

  const spendMains = categories.filter((c) => c.kind === 'expense' && c.parentId === null)
  const options = (
    <>
      <option value="">Choose…</option>
      <optgroup label="Spending">{categories.filter((c) => c.kind === 'expense').map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</optgroup>
      <optgroup label="Income">{categories.filter((c) => c.kind === 'income').map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</optgroup>
    </>
  )
  const rememberBox = (
    <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
      Also remember these names for future imports
    </label>
  )

  return (
    <div className="bulk-bar" role="region" aria-label="Change the selected transactions">
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <b>{count.toLocaleString()} selected</b>
        {total > count && <button className="btn small" onClick={onSelectAll}>Select all {total.toLocaleString()} that match</button>}
        <button className="btn small" onClick={onClear}>Clear selection</button>
        {(onEdit || onDelete || onCost) && <Segmented<Mode> small label="What to do with the selected transactions" value={mode} onChange={(m) => { setMode(m); setError(null) }} options={[{ value: 'move', label: 'Move' }, ...(onEdit ? [{ value: 'edit' as const, label: 'Edit' }] : []), ...(onCost ? [{ value: 'cost' as const, label: 'Taxes & interest' }] : []), ...(onDelete ? [{ value: 'delete' as const, label: 'Delete' }] : [])]} />}
      </div>

      {mode === 'move' && (
        <div className="filters" style={{ marginTop: 8, marginBottom: 0 }}>
          <label className="field">Move to category<select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>{options}</select></label>
          <label className="field">Or create one
            <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Pets" style={{ width: 140 }} />
              <select value={newKind} onChange={(e) => { setNewKind(e.target.value as 'expense' | 'income'); setNewParent('') }} aria-label="Kind of the new category"><option value="expense">Spending</option><option value="income">Income</option></select>
              {newKind === 'expense' && <select value={newParent} onChange={(e) => setNewParent(e.target.value)} aria-label="Put the new category under"><option value="">Main category</option>{spendMains.map((m) => <option key={m.id} value={m.id}>Under {m.name}</option>)}</select>}
              <button className="btn" type="button" disabled={!newName.trim()} onClick={() => void create()}>Add</button>
            </span>
          </label>
          {rememberBox}
          <button className="btn primary" disabled={!categoryId || busy} onClick={() => void apply()}>Move {count.toLocaleString()}</button>
        </div>
      )}

      {mode === 'edit' && onEdit && (
        <div className="filters" style={{ marginTop: 8, marginBottom: 0 }}>
          <label className="field">New merchant name<input value={name} maxLength={120} placeholder="Leave empty to keep each name" onChange={(e) => setName(e.target.value)} style={{ width: 220 }} /></label>
          <label className="field">Type<select value={kind} onChange={(e) => setKind(e.target.value as BulkKind | '')}>{KIND_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
          {kind !== 'transfer' && <label className="field">{kind ? 'Category' : 'Category (optional)'}<select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>{options}</select></label>}
          {kind !== 'transfer' && rememberBox}
          <button className="btn primary" disabled={busy || (!name.trim() && !kind && !categoryId)} onClick={() => void edit()}>Save changes to {count.toLocaleString()}</button>
        </div>
      )}

      {mode === 'cost' && onCost && (
        <div className="filters" style={{ marginTop: 8, marginBottom: 0 }}>
          <span className="sub">Choose how {count === 1 ? 'this payment counts' : `these ${count.toLocaleString()} payments count`} on the Taxes &amp; interest page. Money paid counts as paid, money received counts as received.</span>
          <button className="btn primary" disabled={busy} onClick={() => void guard(() => onCost('tax'))}>Count as taxes</button>
          <button className="btn primary" disabled={busy} onClick={() => void guard(() => onCost('interest'))}>Count as interest</button>
          <button className="btn" disabled={busy} onClick={() => void guard(() => onCost('none'))}>Do not count</button>
          <button className="btn" disabled={busy} onClick={() => void guard(() => onCost(null))}>Back to automatic</button>
        </div>
      )}

      {mode === 'delete' && onDelete && (
        <div className="filters" style={{ marginTop: 8, marginBottom: 0 }}>
          <span className="sub">Removes {count.toLocaleString()} transaction{count === 1 ? '' : 's'} from the app for good. The balances of their accounts change. A payment counted toward a loan is un-counted first.</span>
          <button className="btn danger" disabled={busy} onClick={del}>Delete {count.toLocaleString()}</button>
        </div>
      )}
      <ErrorBox error={error} />
    </div>
  )
}
