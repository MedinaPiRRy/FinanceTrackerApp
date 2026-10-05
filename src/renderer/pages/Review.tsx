import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { txnPreset } from '../txnLink'
import type { Page, TxnPreset } from '../App'
import { Card, ErrorBox } from '../components/ui'
import { formatCents } from '../format'
import type { AccountInfo, CategoryInfo, Profile } from '../../db/queries'
import type { ReviewItem, Decision } from '../../db/review'

type Choice = Decision['kind'] | ''

function ReviewCard({ item, goto, profileId, accounts, categories, partner, onDone, onCategoryCreated }: { item: ReviewItem; goto: (p: Page, pre?: TxnPreset) => void; profileId: number; accounts: AccountInfo[]; categories: CategoryInfo[]; partner: { id: number; name: string } | null; onDone: (msg: string) => void; onCategoryCreated: () => void }) {
  const moneyIn = item.amountCents > 0
  const [choice, setChoice] = useState<Choice>('')
  const [categoryId, setCategoryId] = useState('')
  const [counter, setCounter] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [newName, setNewName] = useState('')

  const options: { value: Choice; label: string }[] = moneyIn
    ? [{ value: 'income', label: 'Income (earned or received)' }, { value: 'refund', label: 'Reimbursement or refund (reduces spending)' }, ...(partner ? [{ value: 'between_us' as Choice, label: `Between us (money from ${partner.name})` }] : []), { value: 'transfer', label: 'Transfer between my own or shared accounts' }, { value: 'keep', label: 'Keep as is (excluded from income and spending)' }]
    : [{ value: 'expense', label: 'Expense' }, ...(partner ? [{ value: 'between_us' as Choice, label: `Between us (money to ${partner.name})` }] : []), { value: 'transfer', label: 'Transfer between my own or shared accounts / investment' }, { value: 'keep', label: 'Keep as is (it is fine)' }]
  const needsCategory = choice === 'income' || choice === 'refund' || choice === 'expense'
  const cats = categories.filter((c) => c.kind === (choice === 'income' ? 'income' : 'expense'))
  const ready = choice !== '' && (!needsCategory || categoryId !== '')

  const createCat = async () => {
    try {
      const c = await api('createCategory', profileId, newName, choice === 'income' ? 'income' : 'expense')
      onCategoryCreated()
      setCategoryId(String(c.id))
      setNewName('')
      setError(null)
    } catch (e) { setError((e as Error).message) }
  }

  const apply = async () => {
    setBusy(true)
    try {
      let decision: Decision
      if (choice === 'between_us') decision = { kind: 'between_us', partnerProfileId: partner!.id, note: note || undefined }
      else if (choice === 'transfer') decision = { kind: 'transfer', counterAccountId: counter ? Number(counter) : undefined, note: note || undefined }
      else if (choice === 'keep') decision = { kind: 'keep', note: note || undefined }
      else decision = { kind: choice as 'income' | 'expense' | 'refund', categoryId: Number(categoryId), note: note || undefined }
      await api('resolveReview', item.id, decision)
      onDone(`Saved: ${item.description}`)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="review-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <strong>{item.description}</strong>
          <div className="muted">{item.date} · {item.account} · <button className="txn-link" title="Show the days around this transaction in its account" onClick={() => goto('transactions', txnPreset(item))}>See it in the account</button></div>
          {item.notes && <div className="muted">Note: {item.notes}</div>}
        </div>
        <div className={`num ${moneyIn ? 'pos' : ''}`} style={{ fontSize: 20, fontWeight: 700 }}>{formatCents(item.amountCents, { sign: true })}</div>
      </div>
      <div><span className="badge warn">{item.reason}</span></div>
      <ErrorBox error={error} />
      <div className="row">
        <label className="field">This is…
          <select value={choice} onChange={(e) => { setChoice(e.target.value as Choice); setCategoryId('') }}>
            <option value="">Choose…</option>
            {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        {needsCategory && (
          <label className="field">Category
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}><option value="">Choose…</option>{cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          </label>
        )}
        {needsCategory && (
          <label className="field">Or create a new one
            <span style={{ display: 'flex', gap: 6 }}>
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={choice === 'income' ? 'e.g. Gifts' : 'e.g. Loans to friends'} style={{ width: 160 }} />
              <button className="btn" type="button" disabled={!newName.trim()} onClick={() => void createCat()}>Add</button>
            </span>
          </label>
        )}
        {choice === 'transfer' && (
          <label className="field">Other account (optional)
            <select value={counter} onChange={(e) => setCounter(e.target.value)}>
              <option value="">Not tracked in the app</option>
              {accounts.filter((a) => a.id !== item.accountId && !a.archived).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
        )}
        <label className="field" style={{ flex: 1, minWidth: 160 }}>Note (optional)<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. birthday gift from Mom" /></label>
        <button className="btn primary" disabled={!ready || busy} onClick={() => void apply()}>Save</button>
      </div>
    </div>
  )
}

export function Review({ profile, goto, accounts, categories, onChanged, partner }: { profile: Profile; goto: (p: Page, pre?: TxnPreset) => void; accounts: AccountInfo[]; categories: CategoryInfo[]; onChanged: () => void; partner: { id: number; name: string } | null }) {
  const [items, setItems] = useState<ReviewItem[] | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const load = useCallback(() => { void api('reviewQueue', profile.id).then(setItems) }, [profile.id])
  useEffect(load, [load])

  const done = (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 2500); load(); onChanged() }

  return (
    <>
      <div className="page-head"><div><h1>Review queue</h1><p>Anything the app is not sure about waits here. Until you decide, it is not counted as income or spending.</p></div></div>
      {toast && <div className="notice" role="status">{toast}</div>}
      {items === null ? <p className="muted">Loading…</p> : items.length === 0 ? <Card><h2>All clear</h2><p className="sub">Nothing needs your review.</p></Card> : (
        <>
          <p className="muted">{items.length} to review</p>
          {items.map((i) => <ReviewCard goto={goto} key={i.id} item={i} profileId={profile.id} accounts={accounts} categories={categories} partner={partner} onDone={done} onCategoryCreated={onChanged} />)}
        </>
      )}
    </>
  )
}
