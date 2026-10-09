import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { useKept } from '../nav'
import { txnPreset } from '../txnLink'
import type { Page, TxnPreset } from '../App'
import { Card, ErrorBox } from '../components/ui'
import { Pager } from '../components/Pager'
import { formatCents } from '../format'
import type { AccountInfo, CategoryInfo, Profile } from '../../db/queries'
import type { ReviewItem, Decision, ReviewGroup, ReviewSummary } from '../../db/review'
import type { ReviewTab } from '../../core/reviewTabs'

type Choice = Decision['kind'] | ''
type Go = (p: Page, pre?: TxnPreset) => void
const GROUPS_PER_PAGE = 20
const ITEMS_PER_PAGE = 20

/** The "what is this?" form, shared by a single transaction and a whole source. */
function DecisionForm({ moneyIn, name, accounts, excludeAccountId, categories, partner, profileId, submitLabel, onSubmit, onCategoryCreated }: {
  moneyIn: boolean
  /** The source's name, used in the "always do this" tick-box. */
  name: string
  accounts: AccountInfo[]
  /** Set for a single transaction: its own account is not a choice for the other side of a transfer. Omitted for a whole source. */
  excludeAccountId?: number
  categories: CategoryInfo[]
  partner: { id: number; name: string } | null
  profileId: number
  submitLabel: string
  onSubmit: (decision: Decision, remember: boolean) => Promise<void>
  onCategoryCreated: () => void
}) {
  const [choice, setChoice] = useState<Choice>('')
  const [categoryId, setCategoryId] = useState('')
  const [counter, setCounter] = useState('')
  const [note, setNote] = useState('')
  const [remember, setRemember] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [newName, setNewName] = useState('')

  const options: { value: Choice; label: string }[] = moneyIn
    ? [{ value: 'income', label: 'Income (earned or received)' }, { value: 'refund', label: 'Reimbursement or refund (reduces spending)' }, ...(partner ? [{ value: 'between_us' as Choice, label: `Between us (money from ${partner.name})` }] : []), { value: 'transfer', label: 'Transfer between my own or shared accounts' }, { value: 'keep', label: 'Keep as is (excluded from income and spending)' }]
    : [{ value: 'expense', label: 'Expense' }, ...(partner ? [{ value: 'between_us' as Choice, label: `Between us (money to ${partner.name})` }] : []), { value: 'transfer', label: 'Transfer between my own or shared accounts / investment' }, { value: 'keep', label: 'Keep as is (it is fine)' }]
  const needsCategory = choice === 'income' || choice === 'refund' || choice === 'expense'
  const cats = categories.filter((c) => c.kind === (choice === 'income' ? 'income' : 'expense'))
  const ready = choice !== '' && (!needsCategory || categoryId !== '')
  const canRemember = needsCategory || choice === 'transfer'

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
      await onSubmit(decision, canRemember && remember)
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <>
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
        {choice === 'transfer' && excludeAccountId !== undefined && (
          <label className="field">Other account (optional)
            <select value={counter} onChange={(e) => setCounter(e.target.value)}>
              <option value="">Not tracked in the app</option>
              {accounts.filter((a) => a.id !== excludeAccountId && !a.archived).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
        )}
        <label className="field" style={{ flex: 1, minWidth: 160 }}>Note (optional)<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. birthday gift from Mom" /></label>
        <button className="btn primary" disabled={!ready || busy} onClick={() => void apply()}>{submitLabel}</button>
      </div>
      {canRemember && (
        <label className="remember" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} style={{ marginTop: 3 }} />
          <span>Always do this for <b>{name}</b> ({moneyIn ? 'money in' : 'money out'})<span className="muted" style={{ display: 'block', fontSize: 12 }}>Everything else waiting from this source, and future imports, are filed the same way. You can undo this any time in Settings.</span></span>
        </label>
      )}
    </>
  )
}

function ReviewCard({ item, goto, name, profileId, accounts, categories, partner, onDone, onCategoryCreated }: { item: ReviewItem; goto: Go; name: string; profileId: number; accounts: AccountInfo[]; categories: CategoryInfo[]; partner: { id: number; name: string } | null; onDone: (msg: string) => void; onCategoryCreated: () => void }) {
  const moneyIn = item.amountCents > 0
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
      <DecisionForm moneyIn={moneyIn} name={name} accounts={accounts} excludeAccountId={item.accountId} categories={categories} partner={partner} profileId={profileId} submitLabel="Save"
        onSubmit={async (decision, remember) => { const r = await api('resolveReview', item.id, decision, remember); onDone(`Saved: ${item.description}${r.alsoResolved ? `. ${r.alsoResolved} more from the same source were filed the same way.` : ''}`) }}
        onCategoryCreated={onCategoryCreated} />
    </div>
  )
}

function GroupCard({ group, tab, goto, profileId, accounts, categories, partner, onDone, onCategoryCreated }: { group: ReviewGroup; tab: ReviewTab; goto: Go; profileId: number; accounts: AccountInfo[]; categories: CategoryInfo[]; partner: { id: number; name: string } | null; onDone: (msg: string) => void; onCategoryCreated: () => void }) {
  const moneyIn = group.key.startsWith('+')
  const [open, setOpen] = useKept<boolean>(`open:${tab}:${group.key}`, group.count === 1)
  const [pg, setPg] = useKept<number>(`items:${tab}:${group.key}`, 0)
  const [items, setItems] = useState<{ total: number; items: ReviewItem[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    api('reviewGroupItems', profileId, tab, group.key, pg * ITEMS_PER_PAGE, ITEMS_PER_PAGE).then((r) => { setItems(r); setError(null) }).catch((e: Error) => setError(e.message))
  }, [open, pg, profileId, tab, group.key, group.count])

  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <div>
          <strong style={{ fontSize: 16 }}>{group.name}</strong>
          <div className="muted">{group.count} transaction{group.count === 1 ? '' : 's'} · {group.firstDate === group.lastDate ? group.firstDate : `${group.firstDate} to ${group.lastDate}`}</div>
        </div>
        <div className={`num ${moneyIn ? 'pos' : ''}`} style={{ fontSize: 20, fontWeight: 700 }}>{formatCents(group.totalCents, { sign: true })}</div>
      </div>
      {group.count > 1 && (
        <div className="review-card" style={{ marginTop: 10 }}>
          <b>Decide for all {group.count} at once</b>
          <DecisionForm moneyIn={moneyIn} name={group.name} accounts={accounts} categories={categories} partner={partner} profileId={profileId} submitLabel={`Save all ${group.count}`}
            onSubmit={async (decision, remember) => { const r = await api('reviewResolveGroup', profileId, tab, group.key, decision, remember); onDone(`Saved ${r.resolved} from ${group.name}.`) }}
            onCategoryCreated={onCategoryCreated} />
        </div>
      )}
      {group.count > 1 && <button className="btn small" style={{ marginTop: 10 }} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide the transactions' : `Show the ${group.count} transactions to decide one by one`}</button>}
      <ErrorBox error={error} />
      {open && items && (
        <div style={{ marginTop: 10 }}>
          {items.items.map((i) => <ReviewCard key={i.id} item={i} goto={goto} name={group.name} profileId={profileId} accounts={accounts} categories={categories} partner={partner} onDone={onDone} onCategoryCreated={onCategoryCreated} />)}
          <Pager page={pg} total={items.total} pageSize={ITEMS_PER_PAGE} onPage={setPg} noun="Transactions" />
        </div>
      )}
    </Card>
  )
}

export function Review({ profile, goto, preset, accounts, categories, onChanged, partner }: { profile: Profile; goto: Go; preset?: TxnPreset; accounts: AccountInfo[]; categories: CategoryInfo[]; onChanged: () => void; partner: { id: number; name: string } | null }) {
  const [summary, setSummary] = useState<ReviewSummary | null>(null)
  const [tab, setTab] = useKept<ReviewTab | null>('tab', (preset?.reviewTab as ReviewTab | undefined) ?? null)
  const [gpage, setGpage] = useKept<number>('gpage', 0)
  const [groups, setGroups] = useState<{ total: number; groups: ReviewGroup[] } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [rev, setRev] = useState(0)

  useEffect(() => { api('reviewSummary', profile.id).then((s) => { setSummary(s); setError(null) }).catch((e: Error) => setError(e.message)) }, [profile.id, rev])
  // open on the first tab that has something waiting
  const active: ReviewTab | null = tab && summary?.tabs.find((t) => t.tab === tab && t.count > 0) ? tab : (summary?.tabs.find((t) => t.count > 0)?.tab ?? null)
  useEffect(() => {
    if (!active) { setGroups(null); return }
    api('reviewGroups', profile.id, active, gpage * GROUPS_PER_PAGE, GROUPS_PER_PAGE).then((g) => {
      // the last group on a page was just decided: step back a page rather than show an empty one
      if (g.groups.length === 0 && gpage > 0) setGpage(gpage - 1); else { setGroups(g); setError(null) }
    }).catch((e: Error) => setError(e.message))
  }, [profile.id, active, gpage, rev, setGpage])

  const done = useCallback((msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3500); setRev((r) => r + 1); onChanged() }, [onChanged])
  const selectTab = (t: ReviewTab) => { setTab(t); setGpage(0) }
  const current = summary?.tabs.find((t) => t.tab === active)

  return (
    <>
      <div className="page-head"><div><h1>Review queue</h1><p>Anything the app is not sure about waits here. Until you decide, it is not counted as income or spending. Each source is grouped, so one decision can clear many.</p></div></div>
      {toast && <div className="notice" role="status">{toast}</div>}
      <ErrorBox error={error} />
      {summary === null ? <p className="muted">Loading…</p> : summary.total === 0 ? <Card><h2>All clear</h2><p className="sub">Nothing needs your review.</p></Card> : (
        <>
          <div className="tabs" role="tablist" aria-label="Kinds of transactions waiting for review">
            {summary.tabs.map((t) => (
              <button key={t.tab} role="tab" aria-selected={t.tab === active} className={`tab ${t.tab === active ? 'on' : ''}`} onClick={() => selectTab(t.tab)}>
                {t.label} <span className={`badge ${t.count > 0 ? 'warn' : ''}`}>{t.count.toLocaleString()}</span>
              </button>
            ))}
          </div>
          {current && <p className="muted" style={{ marginTop: 8 }}>{current.hint} {current.count.toLocaleString()} waiting, {formatCents(current.totalCents, { sign: true })} in total{groups ? `, from ${groups.total.toLocaleString()} source${groups.total === 1 ? '' : 's'}` : ''}.</p>}
          {groups === null ? <p className="muted">Loading…</p> : (
            <div className="grid" style={{ gap: 12 }}>
              <Pager page={gpage} total={groups.total} pageSize={GROUPS_PER_PAGE} onPage={setGpage} noun="Sources" />
              {groups.groups.map((g) => <GroupCard key={`${active}:${g.key}`} group={g} tab={active!} goto={goto} profileId={profile.id} accounts={accounts} categories={categories} partner={partner} onDone={done} onCategoryCreated={onChanged} />)}
              <Pager page={gpage} total={groups.total} pageSize={GROUPS_PER_PAGE} onPage={setGpage} noun="Sources" />
            </div>
          )}
        </>
      )}
    </>
  )
}
