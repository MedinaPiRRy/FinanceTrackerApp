import { useCallback, useEffect, useRef, useState } from 'react'
import { useKept } from '../nav'
import { api } from '../api'
import { Card, ErrorBox } from '../components/ui'
import { BulkCategoryBar } from '../components/BulkCategoryBar'
import { Pager } from '../components/Pager'
import { formatCents, KIND_LABEL } from '../format'
import type { AccountInfo, CategoryInfo, Profile, TxnFilter, TxnRow } from '../../db/queries'
import type { Owner } from '../../db/household'
import type { Page, TxnPreset } from '../App'

const PAGE_SIZE = 100
type SortKey = NonNullable<TxnFilter['sort']>
const dollarsToCents = (v: string) => (v.trim() === '' || Number.isNaN(Number(v)) ? undefined : Math.round(Number(v) * 100))

export function Transactions({ profile, accounts, categories, preset, goto, household, onChanged }: { onChanged?: () => void; profile: Profile; accounts: (AccountInfo & { owner?: string; ownerKind?: 'person' | 'household' })[]; categories: CategoryInfo[]; preset: TxnPreset; goto: (p: Page) => void; household?: { owners: Owner[] } }) {
  const [text, setText] = useKept('text', preset.text ?? '')
  const [debouncedText, setDebouncedText] = useState(text)
  const [accountId, setAccountId] = useKept('accountId', preset.accountId ? String(preset.accountId) : '')
  const [categoryId, setCategoryId] = useKept('categoryId', preset.categoryId ? String(preset.categoryId) : '')
  const [kind, setKind] = useKept('kind', preset.kind ?? '')
  const [from, setFrom] = useKept('from', preset.from ?? '')
  const [to, setTo] = useKept('to', preset.to ?? '')
  const [min, setMin] = useKept('min', '')
  const [max, setMax] = useKept('max', '')
  const [reviewOnly, setReviewOnly] = useKept('reviewOnly', !!preset.reviewOnly)
  const [sort, setSort] = useKept<SortKey>('sort', 'date')
  const [dir, setDir] = useKept<'asc' | 'desc'>('dir', 'desc')
  const [page, setPage] = useKept('page', 0)
  const [personId, setPersonId] = useKept('personId', preset.personId ? String(preset.personId) : '')
  const [groupName, setGroupName] = useKept('groupName', preset.groupName ?? '')
  const [groupNames, setGroupNames] = useState<string[]>([])
  useEffect(() => { if (household) void api('groupNames').then(setGroupNames) }, [household])
  const [result, setResult] = useState<{ rows: TxnRow[]; total: number; sumCents: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  // the row we were sent to is lit for about a second so the person can see which one it is
  const [flashId, setFlashId] = useState<number | null>(preset.txnId ?? null)
  useEffect(() => {
    if (flashId === null || !result?.rows.some((r) => r.id === flashId)) return
    document.querySelector(`[data-txn-id="${flashId}"]`)?.scrollIntoView({ block: 'center' })
    const t = setTimeout(() => setFlashId(null), 1600)
    return () => clearTimeout(t)
  }, [flashId, result])

  useEffect(() => {
    const t = setTimeout(() => setDebouncedText(text), 250)
    return () => clearTimeout(t)
  }, [text])

  const load = useCallback(() => {
    const filter: TxnFilter = {
      text: debouncedText || undefined, accountId: accountId ? Number(accountId) : undefined, categoryId: categoryId ? Number(categoryId) : undefined, kind: kind || undefined,
      personId: personId ? Number(personId) : undefined, groupName: groupName || undefined,
      from: from || undefined, to: to || undefined, minCents: dollarsToCents(min), maxCents: dollarsToCents(max), reviewOnly, sort, dir, limit: PAGE_SIZE, offset: page * PAGE_SIZE
    }
    ;(household ? api('householdTxns', filter) : api('txns', profile.id, filter)).then((r) => { setResult(r); setError(null) }).catch((e: Error) => setError(e.message))
  }, [profile.id, household, personId, groupName, debouncedText, accountId, categoryId, kind, from, to, min, max, reviewOnly, sort, dir, page])
  useEffect(load, [load])
  // a new filter starts again at page one (but coming back with the back button keeps the page you were on)
  const filtersSeen = useRef(false)
  useEffect(() => {
    if (!filtersSeen.current) { filtersSeen.current = true; return }
    setPage(0); setSelected(new Set())
  }, [debouncedText, accountId, categoryId, kind, from, to, min, max, reviewOnly, sort, dir, personId, groupName])

  // ticking rows to change many categories at once (not in the household view, where categories belong to different people)
  const [selected, setSelected] = useKept<Set<number>>('selected', () => new Set<number>())
  const [notice, setNotice] = useState<string | null>(null)
  const editable = (k: string) => !household && (k === 'income' || k === 'expense' || k === 'refund')
  const pageIds = (result?.rows ?? []).filter((r) => editable(r.kind)).map((r) => r.id)
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id))
  const toggle = (id: number) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const togglePage = () => setSelected((s) => { const n = new Set(s); if (allOnPage) pageIds.forEach((id) => n.delete(id)); else pageIds.forEach((id) => n.add(id)); return n })
  const selectAllMatching = async () => {
    try {
      const filter: TxnFilter = { text: debouncedText || undefined, accountId: accountId ? Number(accountId) : undefined, categoryId: categoryId ? Number(categoryId) : undefined, kind: kind || undefined, from: from || undefined, to: to || undefined, minCents: dollarsToCents(min), maxCents: dollarsToCents(max), reviewOnly }
      const ids = await api('txnIds', profile.id, filter)
      setSelected(new Set(ids)); setError(null)
    } catch (e) { setError((e as Error).message) }
  }
  const moveSelected = async (categoryId: number, remember: boolean) => {
    const r = await api('setCategoryMany', [...selected], categoryId, remember)
    setNotice(`Moved ${r.updated.toLocaleString()} transaction${r.updated === 1 ? '' : 's'}${r.remembered ? ` and remembered ${r.remembered} name${r.remembered === 1 ? '' : 's'} for future imports` : ''}.`)
    setTimeout(() => setNotice(null), 4000)
    setSelected(new Set()); load()
  }

  const sortBy = (k: SortKey) => { if (sort === k) setDir(dir === 'asc' ? 'desc' : 'asc'); else { setSort(k); setDir(k === 'date' || k === 'amount' ? 'desc' : 'asc') } }
  const arrow = (k: SortKey) => (sort === k ? (dir === 'asc' ? ' ▲' : ' ▼') : '')
  const ariaSort = (k: SortKey) => (sort === k ? (dir === 'asc' ? 'ascending' : 'descending') : 'none')

  const changeCategory = async (row: TxnRow, id: number) => {
    try { await api('setCategory', row.id, id); load() } catch (e) { setError((e as Error).message) }
  }
  const clear = () => { setPersonId(''); setGroupName(''); setText(''); setAccountId(''); setCategoryId(''); setKind(''); setFrom(''); setTo(''); setMin(''); setMax(''); setReviewOnly(false) }
  const catsFor = (k: string) => categories.filter((c) => c.kind === (k === 'income' ? 'income' : 'expense'))
  const filtering = !!(text || accountId || categoryId || kind || from || to || min || max || reviewOnly || personId || groupName)
  const pages = result ? Math.max(1, Math.ceil(result.total / PAGE_SIZE)) : 1

  return (
    <>
      <div className="page-head"><div><h1>Transactions</h1><p>Search, filter and fix categories. Changes apply immediately.</p></div></div>
      <Card>
        <div className="filters">
          <label className="field">Search<input type="search" value={text} placeholder="Description or note" onChange={(e) => setText(e.target.value)} /></label>
          <label className="field">Account<select value={accountId} onChange={(e) => setAccountId(e.target.value)}><option value="">All accounts</option>{accounts.map((a) => <option key={a.id} value={a.id}>{household && a.owner ? `${a.ownerKind === 'household' ? 'Shared' : a.owner} · ${a.name}` : a.name}</option>)}</select></label>
          {household && <label className="field">Person<select value={personId} onChange={(e) => setPersonId(e.target.value)}><option value="">Everyone</option>{household.owners.map((o) => <option key={o.profileId} value={o.profileId}>{o.kind === 'household' ? 'Shared accounts' : o.name}</option>)}</select></label>}
          {household ? <label className="field">Category group<select value={groupName} onChange={(e) => setGroupName(e.target.value)}><option value="">All groups</option>{groupNames.map((g) => <option key={g} value={g}>{g}</option>)}</select></label>
            : <label className="field">Category<select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}><option value="">All categories</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}{c.kind === 'income' ? ' (income)' : ''}</option>)}</select></label>}
          <label className="field">Type<select value={kind} onChange={(e) => setKind(e.target.value)}><option value="">All types</option><option value="expense,refund">Spending (expenses and refunds)</option><option value="income,expense,refund">Income and spending</option>{Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label className="field">From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="field">To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <label className="field">Min $<input type="number" min="0" step="0.01" value={min} onChange={(e) => setMin(e.target.value)} style={{ width: 90 }} /></label>
          <label className="field">Max $<input type="number" min="0" step="0.01" value={max} onChange={(e) => setMax(e.target.value)} style={{ width: 90 }} /></label>
          <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><input type="checkbox" checked={reviewOnly} onChange={(e) => setReviewOnly(e.target.checked)} />Needs review only</label>
          <button className="btn" onClick={clear}>Clear</button>
        </div>
        <ErrorBox error={error} />
        {notice && <div className="notice" role="status">{notice}</div>}
        {selected.size > 0 && !household && <BulkCategoryBar count={selected.size} total={result?.total ?? 0} profileId={profile.id} categories={categories} onApply={moveSelected} onClear={() => setSelected(new Set())} onSelectAll={() => void selectAllMatching()} onCategoryCreated={() => onChanged?.()} />}
        {result && (
          <p className="muted" role="status">
            {result.total.toLocaleString()} transaction{result.total === 1 ? '' : 's'} · net {formatCents(result.sumCents, { sign: true })} (money in minus money out)
          </p>
        )}
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Transactions</caption>
            <thead>
              <tr>
                {!household && <th style={{ width: 32 }}><input type="checkbox" aria-label="Select every transaction on this page" checked={allOnPage} disabled={pageIds.length === 0} onChange={togglePage} /></th>}
                <th aria-sort={ariaSort('date')}><button onClick={() => sortBy('date')}>Date{arrow('date')}</button></th>
                {household && <th>Person</th>}
                <th aria-sort={ariaSort('merchant')}><button onClick={() => sortBy('merchant')}>Description{arrow('merchant')}</button></th>
                <th>Account</th>
                <th aria-sort={ariaSort('category')}><button onClick={() => sortBy('category')}>Category{arrow('category')}</button></th>
                <th>Type</th>
                <th className="r" aria-sort={ariaSort('amount')}><button onClick={() => sortBy('amount')}>Amount{arrow('amount')}</button></th>
              </tr>
            </thead>
            <tbody>
              {result?.rows.map((r) => (
                <tr key={r.id} data-txn-id={r.id} className={`${r.reviewReason ? 'review' : ''}${r.id === flashId ? ' flash' : ''}`.trim()}>
                  {!household && <td><input type="checkbox" aria-label={`Select ${r.description}`} checked={selected.has(r.id)} disabled={!editable(r.kind)} onChange={() => toggle(r.id)} /></td>}
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>{r.date}</td>
                  {household && <td>{r.person === 'Household' ? 'Shared' : r.person}</td>}
                  <td>{r.description}{r.notes && <div className="muted">{r.notes}</div>}{r.reviewReason && <div><button className="badge warn" style={{ cursor: 'pointer' }} onClick={() => goto('review')} title={r.reviewReason}>Needs review</button></div>}</td>
                  <td>{r.account}</td>
                  <td>
                    {household ? <span>{r.category ?? <span className="muted">—</span>}</span> : r.kind === 'income' || r.kind === 'expense' || r.kind === 'refund' ? (
                      <select className="cat-select" aria-label={`Category for ${r.description}`} value={r.categoryId ?? ''} onChange={(e) => void changeCategory(r, Number(e.target.value))}>
                        {r.categoryId === null && <option value="">Uncategorized</option>}
                        {catsFor(r.kind).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    ) : <span className="muted">—</span>}
                  </td>
                  <td><span className={`badge ${r.kind === 'unclassified' ? 'warn' : ''}`}>{KIND_LABEL[r.kind] ?? r.kind}</span>{r.counterparty && <div className="muted" style={{ fontSize: 12 }}>{r.kind === 'transfer' ? `with ${r.counterparty === 'Household' ? 'shared accounts' : r.counterparty}` : ''}</div>}</td>
                  <td className={`r num ${r.amountCents > 0 ? 'pos' : ''}`}>{formatCents(r.amountCents, { sign: true })}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {result && result.rows.length === 0 && (filtering ? <p className="muted" style={{ padding: 12 }}>No transactions match these filters.</p> : <p className="muted" style={{ padding: 12 }}>No transactions yet. <button className="btn small" onClick={() => goto('import')}>Import transactions</button></p>)}
        </div>
        <Pager page={page} total={result?.total ?? 0} pageSize={PAGE_SIZE} onPage={setPage} noun="Transactions" />
      </Card>
    </>
  )
}
