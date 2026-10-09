import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api'
import { Card, ErrorBox, Segmented } from '../components/ui'
import { Pager } from '../components/Pager'
import { formatCents, KIND_LABEL } from '../format'
import type { AccountInfo, CategoryInfo, Profile } from '../../db/queries'
import type { Preview, PreviewRow, BatchInfo, CommitResult, CommitRow } from '../../db/import'
import type { ImportMeta, AccountSuggestion } from '../../db/importMatch'
import type { ColumnMap } from '../../core/statement'
import type { Page } from '../App'

const IMPORT_PAGE = 100
type View = 'all' | 'new' | 'duplicate' | 'repeat' | 'attention'
type Kind = PreviewRow['kind']

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
    r.onerror = () => reject(new Error('Could not read that file'))
    r.readAsDataURL(file)
  })
}

export function Import({ profile, accounts, categories, onChanged, goto, partner }: { profile: Profile; accounts: AccountInfo[]; categories: CategoryInfo[]; onChanged: () => void; goto: (p: Page) => void; partner: { id: number; name: string } | null }) {
  const importable = accounts.filter((a) => a.type !== 'investment' && !a.archived)
  const [accountId, setAccountId] = useState<string>('')
  const [flip, setFlip] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<(Preview & ImportMeta) | null>(null)
  const [rows, setRows] = useState<PreviewRow[]>([])
  const [view, setView] = useState<View>('all')
  const [learn, setLearn] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<CommitResult | null>(null)
  const [history, setHistory] = useState<BatchInfo[]>([])
  const [otherOk, setOtherOk] = useState(false) // confirmed: import a file already imported elsewhere into this account
  const [touched, setTouched] = useState(false) // the person picked the account themselves
  const [suggestion, setSuggestion] = useState<AccountSuggestion | null>(null)
  const [peek, setPeek] = useState<{ rows: string[][]; columns: number } | null>(null)
  const [map, setMap] = useState({ headerRow: true, date: '0', description: '1', mode: 'amount' as 'amount' | 'split', amount: '2', debit: '2', credit: '3' })
  const [newCat, setNewCat] = useState('')
  const [newCatKind, setNewCatKind] = useState<'expense' | 'income'>('expense')

  // Start on the account used last time.
  useEffect(() => { void api('importSuggest', profile.id).then((s) => { if (s) { setAccountId((cur) => cur || String(s.accountId)); setSuggestion(s) } }) }, [profile.id])
  const loadHistory = useCallback(() => { void api('importHistory', profile.id).then(setHistory) }, [profile.id])
  useEffect(loadHistory, [loadHistory])

  const runPreview = async (f: File, acc: string, flipSign: boolean, columns?: ColumnMap) => {
    if (!acc) return
    setBusy(true); setError(null); setResult(null); setPeek(null)
    const b64 = await toBase64(f)
    try {
      const pv = await api('importPreview', profile.id, Number(acc), f.name, b64, { flipSign, columns })
      setPreview(pv); setRows(pv.rows); setView('all')
    } catch (e) {
      setPreview(null); setRows([]); setError((e as Error).message)
      // The layout was not recognised: let the person say which column is which.
      try { setPeek(await api('importPeek', f.name, b64)) } catch { /* the error above already explains */ }
    }
    setBusy(false)
  }
  const applyMap = () => {
    if (!file) return
    const n = (v: string) => Number(v)
    const columns: ColumnMap = map.mode === 'amount'
      ? { headerRow: map.headerRow, date: n(map.date), description: n(map.description), amount: n(map.amount) }
      : { headerRow: map.headerRow, date: n(map.date), description: n(map.description), debit: n(map.debit), credit: n(map.credit) }
    void runPreview(file, accountId, flip, columns)
  }

  const onFile = async (f: File | null) => {
    setFile(f); setPreview(null); setRows([]); setResult(null); setPeek(null); setError(null); setOtherOk(false)
    if (!f) return
    let acc = accountId
    try {
      // Match the file to an account by what we know: same file before, same columns, its name, or the last account used.
      const s = await api('importSuggest', profile.id, { name: f.name, base64: await toBase64(f) })
      setSuggestion(s)
      if (s && (!touched || !accountId)) { acc = String(s.accountId); setAccountId(acc) }
    } catch { /* the preview below reports an unreadable file */ }
    if (acc) void runPreview(f, acc, flip)
  }
  const onAccount = (v: string) => { setTouched(true); setAccountId(v); if (file && v) void runPreview(file, v, flip) }

  const update = (idx: number, patch: Partial<PreviewRow>) => setRows((rs) => rs.map((r) => (r.idx === idx ? { ...r, ...patch } : r)))
  const setKind = (r: PreviewRow, kind: Kind) => {
    const want = kind === 'income' ? 'income' : 'expense'
    const keep = r.categoryId !== null && categories.find((c) => c.id === r.categoryId)?.kind === want
    const categoryId = kind === 'transfer' || kind === 'unclassified' ? null : keep ? r.categoryId : null
    const reviewReason = kind === 'unclassified' ? r.reviewReason ?? 'Needs your decision' : kind === 'transfer' ? null : categoryId === null ? 'Needs a category' : null
    update(r.idx, { kind, categoryId, reviewReason, counterpartyProfileId: null })
  }
  const setBetweenUs = (r: PreviewRow) => { if (partner) update(r.idx, { kind: 'transfer', categoryId: null, reviewReason: null, counterpartyProfileId: partner.id }) }
  const setCategory = (r: PreviewRow, id: string) => update(r.idx, { categoryId: id ? Number(id) : null, reviewReason: id ? null : 'Needs a category' })

  const visible = useMemo(() => rows.filter((r) => view === 'all' || (view === 'new' && r.status === 'new') || (view === 'duplicate' && r.status === 'duplicate') || (view === 'repeat' && r.status === 'repeat') || (view === 'attention' && r.include && r.reviewReason)), [rows, view])
  // a statement can have thousands of lines: show them 100 at a time
  const [pg, setPg] = useState(0)
  useEffect(() => setPg(0), [view, rows.length])
  const shown = useMemo(() => visible.slice(pg * IMPORT_PAGE, (pg + 1) * IMPORT_PAGE), [visible, pg])
  const counts = useMemo(() => ({ include: rows.filter((r) => r.include).length, dup: rows.filter((r) => r.status === 'duplicate').length, repeat: rows.filter((r) => r.status === 'repeat').length, near: rows.filter((r) => r.status === 'new' && r.nearMatch).length, attention: rows.filter((r) => r.include && r.reviewReason).length }), [rows])

  const commit = async () => {
    if (!preview) return
    setBusy(true); setError(null)
    try {
      const payload: CommitRow[] = rows.map(({ idx: _i, line: _l, suggestionSource: _s, matchedDescription: _m, nearMatch: _n, ...r }) => r)
      const res = await api('importCommit', profile.id, Number(accountId), preview.fileName, payload, learn, { fileHash: preview.fileHash, layout: preview.layout, allowOtherAccount: otherOk })
      setResult(res); setPreview(null); setRows([]); setFile(null)
      onChanged(); loadHistory()
    } catch (e) { setError((e as Error).message) }
    setBusy(false)
  }

  const addCategory = async () => {
    try { await api('createCategory', profile.id, newCat, newCatKind); setNewCat(''); onChanged() } catch (e) { setError((e as Error).message) }
  }
  const undo = async (b: BatchInfo) => {
    if (!confirm(`Remove the ${b.remaining} transactions added by "${b.fileName}"? This cannot be undone.`)) return
    try { await api('importUndo', profile.id, b.id); loadHistory(); onChanged() } catch (e) { setError((e as Error).message) }
  }

  const expenseCats = categories.filter((c) => c.kind === 'expense')
  const incomeCats = categories.filter((c) => c.kind === 'income')
  const selectedAcc = importable.find((a) => String(a.id) === accountId)

  return (
    <>
      <div className="page-head"><div><h1>Import transactions</h1><p>Bring in a bank or card statement (CSV or Excel). You can check and fix everything before anything is saved.</p></div></div>
      <ErrorBox error={error} />

      {peek && file && (
        <Card>
          <div className="card-head"><h2>Tell the app which column is which</h2></div>
          <p className="sub" style={{ marginTop: 0 }}>This file's layout was not recognised automatically. Pick the column for each item below. Your choice is remembered for this account, so next time it is one click.</p>
          <div className="table-wrap" style={{ marginBottom: 12 }}>
            <table>
              <thead><tr>{Array.from({ length: peek.columns }, (_, i) => <th key={i}>Column {i + 1}</th>)}</tr></thead>
              <tbody>{peek.rows.map((r, ri) => <tr key={ri}>{Array.from({ length: peek.columns }, (_, i) => <td key={i}>{r[i] ?? ''}</td>)}</tr>)}</tbody>
            </table>
          </div>
          <div className="filters">
            {(['date', 'description'] as const).map((k) => (
              <label className="field" key={k}>{k === 'date' ? 'Date' : 'Description'}
                <select value={map[k]} onChange={(e) => setMap({ ...map, [k]: e.target.value })}>{Array.from({ length: peek.columns }, (_, i) => <option key={i} value={i}>Column {i + 1}</option>)}</select>
              </label>
            ))}
            <label className="field">Amounts are in
              <select value={map.mode} onChange={(e) => setMap({ ...map, mode: e.target.value as 'amount' | 'split' })}><option value="amount">one column (negative = money out)</option><option value="split">two columns (money out / money in)</option></select>
            </label>
            {map.mode === 'amount'
              ? <label className="field">Amount<select value={map.amount} onChange={(e) => setMap({ ...map, amount: e.target.value })}>{Array.from({ length: peek.columns }, (_, i) => <option key={i} value={i}>Column {i + 1}</option>)}</select></label>
              : (<>
                  <label className="field">Money out<select value={map.debit} onChange={(e) => setMap({ ...map, debit: e.target.value })}>{Array.from({ length: peek.columns }, (_, i) => <option key={i} value={i}>Column {i + 1}</option>)}</select></label>
                  <label className="field">Money in<select value={map.credit} onChange={(e) => setMap({ ...map, credit: e.target.value })}>{Array.from({ length: peek.columns }, (_, i) => <option key={i} value={i}>Column {i + 1}</option>)}</select></label>
                </>)}
            <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><input type="checkbox" checked={map.headerRow} onChange={(e) => setMap({ ...map, headerRow: e.target.checked })} />First row is a header</label>
            <button className="btn primary" disabled={busy} onClick={applyMap}>Use these columns</button>
          </div>
        </Card>
      )}

      {result && (
        <div className="notice" role="status">
          <b>Imported {result.inserted} transaction{result.inserted === 1 ? '' : 's'}.</b>{' '}
          {result.queuedForReview > 0 && <>{result.queuedForReview} need your review. </>}
          {result.learned > 0 && <>Remembered {result.learned} merchant{result.learned === 1 ? '' : 's'} for next time. </>}
          {result.transfersPaired > 0 && <>Linked {result.transfersPaired} transfer{result.transfersPaired === 1 ? '' : 's'} between your accounts. </>}
          {result.skippedExisting > 0 && <>Skipped {result.skippedExisting} already imported. </>}
          <button className="btn small" style={{ marginLeft: 8 }} onClick={() => goto('review')}>Open review queue</button>
        </div>
      )}

      {importable.length === 0 && (
        <div className="notice" role="status" style={{ marginBottom: 12 }}>
          {profile.slug === 'household' ? 'There is no shared account to import into yet. Create one first, then come back.' : 'There is no account to import into yet. Add one first, then come back.'}{' '}
          <button className="btn small" onClick={() => goto('accounts')}>Add an account</button>
        </div>
      )}
      <Card>
        <div className="filters" style={{ marginBottom: 0 }}>
          <label className="field">Account this statement belongs to
            <select value={accountId} onChange={(e) => onAccount(e.target.value)}>
              <option value="">Choose account…</option>
              {importable.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
          <label className="field">Statement file (.csv, .xlsx)
            <input type="file" accept=".csv,.txt,.xlsx,.xlsm" disabled={busy} onChange={(e) => void onFile(e.target.files?.[0] ?? null)} />
          </label>
          <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={flip} onChange={(e) => { setFlip(e.target.checked); if (file && accountId) void runPreview(file, accountId, e.target.checked) }} />
            Spending shows as positive numbers in this file
          </label>
        </div>
        {!accountId && <p className="muted" style={{ marginBottom: 0 }}>Choose an account, or pick the file and the app will try to match it to one.</p>}
        {suggestion && accountId && String(suggestion.accountId) === accountId && <p className="muted" role="status" style={{ marginBottom: 0 }}>✓ {suggestion.message} Change it above if that is wrong.</p>}
        {suggestion && accountId && String(suggestion.accountId) !== accountId && suggestion.reason !== 'last_used' && (
          <p className="notice" role="status" style={{ marginBottom: 0 }}>
            {suggestion.message}{' '}
            <button className="btn small" onClick={() => onAccount(String(suggestion.accountId))}>Use {importable.find((a) => a.id === suggestion.accountId)?.name ?? 'that account'}</button>
          </p>
        )}
        <p className="muted" style={{ marginBottom: 0 }}>The file is read in memory and never copied anywhere. PDF statements are not supported yet; download the CSV or Excel version from your bank.</p>
        {busy && <p className="muted">Working…</p>}
      </Card>

      {preview && (
        <>
          <div style={{ height: 16 }} />
          {preview.sameFileBefore && (
            <div className="notice" role="status" style={{ marginBottom: 12 }}>
              <b>This exact file was already imported</b> on {preview.sameFileBefore.importedAt.slice(0, 10)}{preview.sameFileBefore.accountName ? <> into <b>{preview.sameFileBefore.accountName}</b></> : null}.
              {preview.sameFileBefore.accountId !== null && String(preview.sameFileBefore.accountId) !== accountId
                ? <> You have chosen a different account, so every row looks new and would be recorded a second time. <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={otherOk} onChange={(e) => setOtherOk(e.target.checked)} />Import it here anyway</label></>
                : ' Rows the app already has are skipped, so importing it again adds nothing twice.'}
            </div>
          )}
          <div className="grid stats">
            <Card className="stat"><div className="label">Rows in file</div><div className="value num">{preview.summary.total}</div><div className="hint">{preview.summary.minDate} to {preview.summary.maxDate}</div></Card>
            <Card className="stat"><div className="label">Will be imported</div><div className="value num">{counts.include}</div><div className="hint">{preview.summary.newCount} new</div></Card>
            <Card className="stat"><div className="label">Already in the app</div><div className="value num">{counts.dup}</div><div className="hint">Same account, date and amount. Left out.</div></Card>
            {counts.repeat > 0 && <Card className="stat"><div className="label">Repeated in this file</div><div className="value num">{counts.repeat}</div><div className="hint">Identical lines. Left out until you confirm they are real.</div></Card>}
            <Card className="stat"><div className="label">Need attention</div><div className="value num">{counts.attention}</div><div className="hint">Will wait in the review queue</div></Card>
            <Card className="stat"><div className="label">Money in / out</div><div className="value num" style={{ fontSize: 20 }}>{formatCents(preview.summary.inCents)} / {formatCents(preview.summary.outCents)}</div></Card>
          </div>
          {preview.warnings.length > 0 && <div className="notice" role="status">{preview.warnings.slice(0, 5).map((w, i) => <div key={i}>{w}</div>)}{preview.warnings.length > 5 && <div>…and {preview.warnings.length - 5} more.</div>}</div>}

          {counts.near > 0 && <div className="notice" role="status">{counts.near} row{counts.near === 1 ? '' : 's'} look similar to rows the app already has, a day or two apart (the bank's posting date can differ from the purchase date). Check the yellow "Similar to…" badges and untick Import for any that are the same purchase.</div>}
          <Card>
            <div className="card-head">
              <Segmented<View> small label="Show rows" value={view} onChange={setView} options={[{ value: 'all', label: `All (${rows.length})` }, { value: 'new', label: `New (${preview.summary.newCount})` }, { value: 'duplicate', label: `Already in app (${counts.dup})` }, ...(counts.repeat > 0 ? [{ value: 'repeat' as View, label: `Repeated (${counts.repeat})` }] : []), { value: 'attention', label: `Need attention (${counts.attention})` }]} />
              <div className="filters" style={{ marginBottom: 0 }}>
                <label className="field">New category<input value={newCat} onChange={(e) => setNewCat(e.target.value)} placeholder="e.g. Pets" style={{ width: 140 }} /></label>
                <label className="field">Type<select value={newCatKind} onChange={(e) => setNewCatKind(e.target.value as 'expense' | 'income')}><option value="expense">Spending</option><option value="income">Income</option></select></label>
                <button className="btn" disabled={!newCat.trim()} onClick={() => void addCategory()}>Add</button>
              </div>
            </div>
            <Pager page={pg} total={visible.length} pageSize={IMPORT_PAGE} onPage={setPg} noun="Lines" />
            <div className="table-wrap">
              <table>
                <caption className="sr-only">Preview of the statement</caption>
                <thead><tr><th>Import</th><th>Date</th><th>Name</th><th>Type</th><th>Category</th><th className="r">Amount</th><th>Status</th></tr></thead>
                <tbody>
                  {shown.map((r) => {
                    const cats = r.kind === 'income' ? incomeCats : expenseCats
                    const catEditable = r.kind === 'income' || r.kind === 'expense' || r.kind === 'refund'
                    return (
                      <tr key={r.idx} className={r.include && r.reviewReason ? 'review' : ''} style={!r.include ? { opacity: 0.55 } : undefined}>
                        <td><input type="checkbox" aria-label={`Import ${r.raw}`} checked={r.include} onChange={(e) => update(r.idx, { include: e.target.checked })} title={r.status === 'duplicate' ? 'The app already has a row like this. Importing it again would create a duplicate.' : r.status === 'repeat' ? 'Identical to another line in this file.' : undefined} /></td>
                        <td className="num" style={{ whiteSpace: 'nowrap' }}>{r.date}</td>
                        <td style={{ minWidth: 230 }}>
                          <input aria-label={`Name for ${r.raw}`} value={r.description} onChange={(e) => update(r.idx, { description: e.target.value })} style={{ width: '100%' }} />
                          <div className="muted" style={{ fontSize: 12 }} title="Exactly what the bank wrote">{r.raw}</div>
                        </td>
                        <td>
                          <select aria-label={`Type for ${r.raw}`} value={r.kind === 'transfer' && r.counterpartyProfileId ? 'between_us' : r.kind} onChange={(e) => (e.target.value === 'between_us' ? setBetweenUs(r) : setKind(r, e.target.value as Kind))}>
                            <option value="expense" disabled={r.amountCents >= 0}>Expense</option>
                            <option value="income" disabled={r.amountCents <= 0}>Income</option>
                            <option value="refund" disabled={r.amountCents <= 0}>Refund / reimbursement</option>
                            <option value="transfer">Transfer (own or shared accounts)</option>
                            {partner && <option value="between_us">Between us (with {partner.name})</option>}
                            <option value="unclassified">Decide later</option>
                          </select>
                        </td>
                        <td>
                          {catEditable ? (
                            <select className="cat-select" aria-label={`Category for ${r.raw}`} value={r.categoryId ?? ''} onChange={(e) => setCategory(r, e.target.value)}>
                              <option value="">Choose…</option>
                              {cats.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                            </select>
                          ) : <span className="muted">{r.kind === 'transfer' ? 'not counted' : '—'}</span>}
                          {r.suggestionSource && r.categoryId === r.suggestedCategoryId && <div className="muted" style={{ fontSize: 11 }}>suggested from {r.suggestionSource === 'user' ? 'your earlier choice' : r.suggestionSource === 'alias' ? 'a learned name' : r.suggestionSource === 'history' ? 'your history' : 'keywords'}</div>}
                        </td>
                        <td className={`r num ${r.amountCents > 0 ? 'pos' : ''}`}>{formatCents(r.amountCents, { sign: true })}</td>
                        <td>
                          {r.status === 'duplicate' ? <span className="badge">Already in app{r.matchedDescription ? `: ${r.matchedDescription}` : ''}</span>
                            : r.status === 'repeat' ? <span className="badge warn" title="Same date, amount and bank text as an earlier line in this file. Tick Import only if you really made this purchase twice.">Repeated line: check</span>
                            : r.nearMatch ? <span className="badge warn" title="The app has a row with the same amount a day or two away. Untick Import if it is the same purchase.">Similar to {r.nearMatch.description} on {r.nearMatch.date}</span>
                            : r.reviewReason ? <span className="badge warn" title={r.reviewReason}>{r.kind === 'unclassified' ? KIND_LABEL.unclassified : r.reviewReason}</span>
                            : <span className="badge good">Ready</span>}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              {visible.length === 0 && <p className="muted" style={{ padding: 12 }}>No rows in this view.</p>}
            </div>
            <Pager page={pg} total={visible.length} pageSize={IMPORT_PAGE} onPage={setPg} noun="Lines" />
            <div className="filters" style={{ justifyContent: 'space-between', marginTop: 14, marginBottom: 0 }}>
              <div>
                {counts.dup > 0 && (
                  <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <input type="checkbox" checked={learn} onChange={(e) => setLearn(e.target.checked)} />
                    Learn merchant names and categories from the {counts.dup} row{counts.dup === 1 ? '' : 's'} the app already has (recommended)
                  </label>
                )}
                <div className="muted">Importing into <b>{selectedAcc?.name}</b>. Rows marked "Need attention" are saved and wait in the review queue.</div>
              </div>
              <span style={{ display: 'flex', gap: 8 }}>
                <button className="btn" onClick={() => { setPreview(null); setRows([]); setFile(null) }}>Cancel</button>
                <button className="btn primary" disabled={busy || (counts.include === 0 && !(learn && counts.dup > 0)) || (!!preview.sameFileBefore && preview.sameFileBefore.accountId !== null && String(preview.sameFileBefore.accountId) !== accountId && !otherOk)} onClick={() => void commit()}>
                  {counts.include === 0 ? 'Learn from these rows' : `Import ${counts.include} transaction${counts.include === 1 ? '' : 's'}`}
                </button>
              </span>
            </div>
          </Card>
        </>
      )}

      <div style={{ height: 16 }} />
      <Card>
        <div className="card-head"><h2>Past imports</h2></div>
        {history.length === 0 ? <p className="muted">Nothing imported yet.</p> : (
          <div className="table-wrap"><table>
            <thead><tr><th>When</th><th>File</th><th className="r">Transactions</th><th></th></tr></thead>
            <tbody>
              {history.map((b) => (
                <tr key={b.id}>
                  <td className="num">{b.importedAt.slice(0, 16)}</td>
                  <td>{b.fileName ? b.fileName.split(/[\\/]/).pop() : '—'}{!b.undoable && b.rowCount > 0 && b.remaining === 0 ? <span className="muted"> (removed)</span> : null}</td>
                  <td className="r num">{b.remaining}</td>
                  <td className="r">{b.undoable ? <button className="btn small danger" onClick={() => void undo(b)}>Undo import</button> : <span className="muted">{b.remaining === 0 ? 'Nothing left to undo' : ''}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Card>
    </>
  )
}
