import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { Card, ErrorBox } from './ui'
import { formatCents } from '../format'
import type { AccountInfo } from '../../db/queries'

const TYPES: { value: string; label: string }[] = [
  { value: 'chequing', label: 'Chequing' }, { value: 'savings', label: 'Savings' }, { value: 'credit_card', label: 'Credit card' },
  { value: 'investment', label: 'Investment (valued by hand)' }, { value: 'loan', label: 'Loan or line of credit' }, { value: 'other', label: 'Other' }
]
const typeLabel = (t: string) => (t === 'cash' ? 'Cash wallet' : TYPES.find((x) => x.value === t)?.label ?? t)
const toCents = (v: string): number | undefined => (v.trim() === '' || Number.isNaN(Number(v)) ? undefined : Math.round(Number(v) * 100))

/** Add, edit and delete accounts. Deleting one with transactions asks whether to move them to another account or delete them too. */
export function AccountManager({ profileId, owner, onChanged }: { profileId: number; owner?: string; onChanged: () => void }) {
  const [accounts, setAccounts] = useState<AccountInfo[] | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [add, setAdd] = useState({ name: '', type: 'chequing', institution: '', amount: '', limit: '' })
  const [editing, setEditing] = useState<number | null>(null)
  const [edit, setEdit] = useState({ name: '', institution: '', limit: '' })
  const [deleting, setDeleting] = useState<number | null>(null)
  const [how, setHow] = useState<'move' | 'delete'>('move')
  const [moveTo, setMoveTo] = useState('')
  const [typed, setTyped] = useState('')

  const load = useCallback(() => { void api('accounts', profileId).then((a) => { setAccounts(a); setError(null) }).catch((e: Error) => setError(e.message)) }, [profileId])
  useEffect(load, [load])
  const run = async (fn: () => Promise<unknown>, note: string) => {
    try { await fn(); setError(null); setMsg(note); setTimeout(() => setMsg(null), 4000); load(); onChanged() } catch (e) { setError((e as Error).message) }
  }

  const create = () => run(async () => {
    await api('accountCreate', profileId, { name: add.name, type: add.type as 'chequing', institution: add.institution || undefined, openingCents: toCents(add.amount), creditLimitCents: add.type === 'credit_card' ? toCents(add.limit) ?? null : undefined })
    setAdd({ name: '', type: 'chequing', institution: '', amount: '', limit: '' }); setAdding(false)
  }, 'Account added.')

  const delRow = accounts?.find((a) => a.id === deleting)
  const owes = add.type === 'credit_card' || add.type === 'loan'

  return (
    <Card>
      <div className="card-head"><h2>Accounts{owner ? ` · ${owner}` : ''}</h2><button className="btn primary small" onClick={() => setAdding(!adding)} aria-expanded={adding}>{adding ? 'Cancel' : 'Add an account'}</button></div>
      <p className="sub" style={{ marginTop: 0 }}>Add, rename or delete the accounts you track. Closing an account (on the Accounts page) hides it but keeps its history; deleting removes it.</p>
      <ErrorBox error={error} />
      {msg && <div className="notice" role="status">{msg}</div>}

      {adding && (
        <div className="review-card" role="group" aria-label="New account">
          <div className="filters" style={{ marginBottom: 0 }}>
            <label className="field">Name<input value={add.name} maxLength={60} onChange={(e) => setAdd({ ...add, name: e.target.value })} placeholder="e.g. Everyday chequing" /></label>
            <label className="field">Type<select value={add.type} onChange={(e) => setAdd({ ...add, type: e.target.value })}>{TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select></label>
            <label className="field">Bank (optional)<input value={add.institution} maxLength={60} onChange={(e) => setAdd({ ...add, institution: e.target.value })} /></label>
            <label className="field">{owes ? 'Owed right now ($)' : 'Balance today ($)'}<input type="number" min="0" step="0.01" value={add.amount} onChange={(e) => setAdd({ ...add, amount: e.target.value })} style={{ width: 120 }} /></label>
            {add.type === 'credit_card' && <label className="field">Credit limit ($, optional)<input type="number" min="0" step="0.01" value={add.limit} onChange={(e) => setAdd({ ...add, limit: e.target.value })} style={{ width: 120 }} /></label>}
            <button className="btn primary" disabled={!add.name.trim()} onClick={() => void create()}>Add account</button>
          </div>
        </div>
      )}

      {accounts === null ? <p className="muted">Loading…</p> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Account</th><th>Type</th><th className="r">Transactions</th><th className="r">Balance</th><th></th></tr></thead>
          <tbody>
            {accounts.map((a) => (
              <tr key={a.id} style={a.archived ? { opacity: 0.6 } : undefined}>
                <td>
                  {a.name}{a.archived && <span className="badge" style={{ marginLeft: 6 }}>Closed</span>}
                  {a.institution && <div className="muted" style={{ fontSize: 12 }}>{a.institution}</div>}
                </td>
                <td>{typeLabel(a.type)}</td>
                <td className="r num">{a.txnCount.toLocaleString()}</td>
                <td className="r num">{a.valueCents === null ? <span className="muted">not valued</span> : formatCents(a.valueCents)}</td>
                <td className="r" style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn small" aria-label={`Edit ${a.name}`} onClick={() => { setEditing(a.id); setEdit({ name: a.name, institution: a.institution ?? '', limit: a.creditLimitCents ? (a.creditLimitCents / 100).toFixed(2) : '' }); setDeleting(null) }}>Edit</button>
                  {a.type !== 'cash' && <> <button className="btn small danger" aria-label={`Delete ${a.name}`} onClick={() => { setDeleting(a.id); setHow('move'); setMoveTo(''); setTyped(''); setEditing(null) }}>Delete</button></>}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}

      {editing !== null && accounts?.find((a) => a.id === editing) && (() => {
        const a = accounts.find((x) => x.id === editing)!
        return (
          <div className="review-card" style={{ marginTop: 12 }} role="group" aria-label={`Edit ${a.name}`}>
            <b>Edit {a.name}</b>
            <div className="filters" style={{ marginBottom: 0 }}>
              <label className="field">Name<input value={edit.name} maxLength={60} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></label>
              <label className="field">Bank (optional)<input value={edit.institution} maxLength={60} onChange={(e) => setEdit({ ...edit, institution: e.target.value })} /></label>
              {a.type === 'credit_card' && <label className="field">Credit limit ($)<input type="number" min="0" step="0.01" value={edit.limit} onChange={(e) => setEdit({ ...edit, limit: e.target.value })} style={{ width: 120 }} /></label>}
              <button className="btn primary" disabled={!edit.name.trim()} onClick={() => void run(async () => { await api('accountUpdate', profileId, a.id, { name: edit.name, institution: edit.institution || null, ...(a.type === 'credit_card' ? { creditLimitCents: toCents(edit.limit) ?? null } : {}) }); setEditing(null) }, 'Saved.')}>Save</button>
              <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </div>
        )
      })()}

      {delRow && (
        <div className="review-card" style={{ marginTop: 12 }} role="group" aria-label={`Delete ${delRow.name}`}>
          <b>Delete “{delRow.name}”?</b>
          {delRow.txnCount === 0 ? (
            <p className="sub" style={{ margin: 0 }}>It has no transactions. A backup copy of your data is made first.</p>
          ) : (
            <>
              <p className="sub" style={{ margin: 0 }}>It has {delRow.txnCount.toLocaleString()} transaction{delRow.txnCount === 1 ? '' : 's'}. A backup copy of your data is made first. What should happen to them?</p>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="radio" name="how" checked={how === 'move'} onChange={() => setHow('move')} />Move them to another of my accounts</label>
              {how === 'move' && (
                <label className="field" style={{ marginLeft: 24 }}>Move to
                  <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)}><option value="">Choose…</option>{accounts?.filter((a) => a.id !== delRow.id && a.type !== 'investment').map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
                </label>
              )}
              <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="radio" name="how" checked={how === 'delete'} onChange={() => setHow('delete')} />Delete them together with the account</label>
              {how === 'delete' && (
                <label className="field" style={{ marginLeft: 24 }}>Type the account name to confirm
                  <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={delRow.name} style={{ width: 260 }} />
                </label>
              )}
            </>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn danger" disabled={delRow.txnCount > 0 && (how === 'move' ? !moveTo : typed.trim() !== delRow.name)}
              onClick={() => void run(async () => { await api('accountDelete', profileId, delRow.id, delRow.txnCount === 0 ? {} : how === 'move' ? { moveToAccountId: Number(moveTo) } : { deleteTransactions: true, confirmName: typed }); setDeleting(null) }, 'Account deleted.')}>
              {delRow.txnCount === 0 ? 'Delete account' : how === 'move' ? 'Move and delete' : `Delete account and ${delRow.txnCount.toLocaleString()} transactions`}
            </button>
            <button className="btn" onClick={() => setDeleting(null)}>Keep it</button>
          </div>
        </div>
      )}
    </Card>
  )
}
