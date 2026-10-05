import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { Card, ErrorBox } from '../components/ui'
import { formatCents, KIND_LABEL } from '../format'
import type { AccountInfo, CategoryInfo, Profile, TxnFilter, TxnRow } from '../../db/queries'
import type { Owner } from '../../db/household'
import type { Page, TxnPreset } from '../App'

const PAGE_SIZE = 100
type SortKey = NonNullable<TxnFilter['sort']>
const dollarsToCents = (v: string) => (v.trim() === '' || Number.isNaN(Number(v)) ? undefined : Math.round(Number(v) * 100))

export function Transactions({ profile, accounts, categories, preset, goto, household }: { profile: Profile; accounts: (AccountInfo & { owner?: string; ownerKind?: 'person' | 'household' })[]; categories: CategoryInfo[]; preset: TxnPreset; goto: (p: Page) => void; household?: { owners: Owner[] } }) {
  const [text, setText] = useState(preset.text ?? '')
  const [debouncedText, setDebouncedText] = useState(text)
  const [accountId, setAccountId] = useState(preset.accountId ? String(preset.accountId) : '')
  const [categoryId, setCategoryId] = useState(preset.categoryId ? String(preset.categoryId) : '')
  const [kind, setKind] = useState(preset.reviewOnly ? '' : '')
  const [from, setFrom] = useState(preset.from ?? '')
  const [to, setTo] = useState(preset.to ?? '')
  const [min, setMin] = useState('')
  const [max, setMax] = useState('')
  const [reviewOnly, setReviewOnly] = useState(!!preset.reviewOnly)
  const [sort, setSort] = useState<SortKey>('date')
  const [dir, setDir] = useState<'asc' | 'desc'>('desc')
  const [page, setPage] = useState(0)
  const [personId, setPersonId] = useState('')
  const [groupName, setGroupName] = useState('')
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
  useEffect(() => setPage(0), [debouncedText, accountId, categoryId, kind, from, to, min, max, reviewOnly, sort, dir, personId, groupName])

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
          <label className="field">Type<select value={kind} onChange={(e) => setKind(e.target.value)}><option value="">All types</option>{Object.entries(KIND_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label className="field">From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="field">To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <label className="field">Min $<input type="number" min="0" step="0.01" value={min} onChange={(e) => setMin(e.target.value)} style={{ width: 90 }} /></label>
          <label className="field">Max $<input type="number" min="0" step="0.01" value={max} onChange={(e) => setMax(e.target.value)} style={{ width: 90 }} /></label>
          <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><input type="checkbox" checked={reviewOnly} onChange={(e) => setReviewOnly(e.target.checked)} />Needs review only</label>
          <button className="btn" onClick={clear}>Clear</button>
        </div>
        <ErrorBox error={error} />
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
        <div className="filters" style={{ justifyContent: 'space-between', marginTop: 12, marginBottom: 0 }}>
          <span className="muted">Page {page + 1} of {pages}</span>
          <span style={{ display: 'flex', gap: 8 }}>
            <button className="btn" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
            <button className="btn" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>Next</button>
          </span>
        </div>
      </Card>
    </>
  )
}
