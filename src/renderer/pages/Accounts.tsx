import { useEffect, useMemo, useState, useCallback } from 'react'
import { api } from '../api'
import { Card, ErrorBox } from '../components/ui'
import { Chart, type ChartColors } from '../components/Chart'
import { ACCOUNT_TYPE_LABEL, formatCents, shortMonth, today } from '../format'
import type { AccountInfo, DebtRow, Profile } from '../../db/queries'
import type { Owner, HouseholdAccount } from '../../db/household'
import type { AccountType } from '../../db/accounts'
import type { Page, TxnPreset } from '../App'

const toCents = (v: string) => Math.round(Number(v) * 100)
type Row = AccountInfo & { profileId: number; owner: string; ownerKind: 'person' | 'household' }

function InvestmentEditor({ account, onSaved }: { account: Row; onSaved: () => void }) {
  const [value, setValue] = useState(account.valueCents === null ? '' : (account.valueCents / 100).toFixed(2))
  const [asOf, setAsOf] = useState(today())
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    const n = Number(value)
    if (value.trim() === '' || Number.isNaN(n) || n < 0) return setError('Enter the current value as a number, e.g. 12500.00')
    try { await api('setValuation', account.id, asOf, Math.round(n * 100)); setError(null); onSaved() } catch (e) { setError((e as Error).message) }
  }
  return (
    <div>
      <ErrorBox error={error} />
      <div className="filters" style={{ marginBottom: 0 }}>
        <label className="field">Current value ($)<input type="number" step="0.01" min="0" value={value} onChange={(e) => setValue(e.target.value)} style={{ width: 140 }} /></label>
        <label className="field">As of<input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} /></label>
        <button className="btn primary" onClick={() => void save()}>Save value</button>
      </div>
    </div>
  )
}

/** The balances recorded for a debt over time, so progress is visible. */
function DebtHistory({ debt, profileId }: { debt: DebtRow; profileId: number }) {
  const [points, setPoints] = useState<{ asOf: string; balanceCents: number }[] | null>(null)
  useEffect(() => { void api('debtHistory', profileId, debt.id).then(setPoints) }, [profileId, debt.id, debt.balanceCents])
  const option = useMemo(() => (c: ChartColors) => ({
    grid: { left: 64, right: 16, top: 12, bottom: 28 },
    tooltip: { trigger: 'axis', backgroundColor: c.surface, borderColor: c.grid, textStyle: { color: c.text }, valueFormatter: (v: number) => formatCents(Math.round(v * 100)) },
    xAxis: { type: 'category', data: (points ?? []).map((x) => x.asOf), axisLine: { lineStyle: { color: c.grid } }, axisTick: { show: false }, axisLabel: { color: c.muted, formatter: (v: string) => shortMonth(v.slice(0, 7)) } },
    yAxis: { type: 'value', axisLabel: { color: c.muted, formatter: (v: number) => `$${v.toLocaleString('en-CA')}` }, splitLine: { lineStyle: { color: c.grid } } },
    series: [{ type: 'line', data: (points ?? []).map((x) => x.balanceCents / 100), lineStyle: { width: 2, color: c.s1 }, itemStyle: { color: c.s1 }, symbolSize: 7 }]
  }), [points])
  if (!points) return <span className="muted">Loading…</span>
  if (points.length < 2) return <span className="muted">Only one balance is recorded so far. Use "Update balance" when it changes and the history appears here.</span>
  return <Chart build={option} height={160} label={`Line chart of the balance owed on ${debt.name} over time`} />
}

function DebtRowEditor({ debt, profileId, onSaved }: { debt: DebtRow; profileId: number; onSaved: () => void }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState((debt.balanceCents / 100).toFixed(2))
  const [asOf, setAsOf] = useState(today())
  const [error, setError] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const save = async () => {
    const n = Number(value)
    if (value.trim() === '' || Number.isNaN(n) || n < 0) return setError('Enter the balance as a number')
    try { await api('debtUpdate', profileId, debt.id, Math.round(n * 100), asOf); setEditing(false); setError(null); onSaved() } catch (e) { setError((e as Error).message) }
  }
  return (
    <>
    <tr>
      <td>{debt.name}<div className="muted" style={{ fontSize: 12 }}>{debt.notes}</div></td>
      <td className="r num">{editing ? <input type="number" min="0" step="0.01" value={value} onChange={(e) => setValue(e.target.value)} className="inline-input" aria-label={`New balance for ${debt.name}`} /> : formatCents(debt.balanceCents)}<div className="muted" style={{ fontSize: 12 }}>as of {editing ? '' : debt.asOf}</div>{editing && <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} aria-label="Balance date" />}{error && <div className="neg" style={{ fontSize: 12 }}>{error}</div>}</td>
      <td className="r" style={{ whiteSpace: 'nowrap' }}>{editing ? <><button className="btn small primary" onClick={() => void save()}>Save</button> <button className="btn small" onClick={() => setEditing(false)}>Cancel</button></> : <><button className="btn small" onClick={() => setEditing(true)}>Update balance</button> <button className="btn small" aria-expanded={showHistory} onClick={() => setShowHistory((v) => !v)}>{showHistory ? 'Hide history' : 'History'}</button></>}</td>
    </tr>
    {showHistory && <tr><td colSpan={3}><DebtHistory debt={debt} profileId={profileId} /></td></tr>}
    </>
  )
}

function AccountCard({ a, owners, goto, reload, onError }: { a: Row; owners: Owner[]; goto: (p: Page, preset?: TxnPreset) => void; reload: () => void; onError: (m: string | null) => void }) {
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(a.name)
  const household = owners.find((o) => o.kind === 'household')
  const persons = owners.filter((o) => o.kind === 'person')
  const act = async (fn: () => Promise<unknown>) => { try { await fn(); onError(null); reload() } catch (e) { onError((e as Error).message) } }

  const close = () => act(async () => {
    const r = await api('accountClose', a.profileId, a.id)
    if (!r.closed) {
      const owed = a.type === 'credit_card' || a.type === 'loan'
      if (confirm(`"${a.name}" still ${owed ? 'owes' : 'has'} ${formatCents(Math.abs(r.balanceCents ?? 0))}. Closing it removes it from your totals, but the history stays.\n\nClose it anyway?`)) await api('accountClose', a.profileId, a.id, true)
    }
  })
  const share = () => act(async () => {
    if (!household) return
    if (confirm(`Make "${a.name}" a shared account?\n\nIt and all its transactions move to the household, so they leave ${a.owner}'s own finances and count for both of you.`)) await api('accountMove', a.id, household.profileId)
  })
  const unshare = (to: Owner) => act(async () => { if (confirm(`Make "${a.name}" ${to.name}'s personal account? It and its transactions will leave the shared household accounts.`)) await api('accountMove', a.id, to.profileId) })

  return (
    <Card className="account-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <div>
          {renaming ? (
            <span style={{ display: 'flex', gap: 6 }}>
              <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Account name" style={{ width: 180 }} />
              <button className="btn small primary" onClick={() => void act(async () => { await api('accountRename', a.profileId, a.id, name); setRenaming(false) })}>Save</button>
              <button className="btn small" onClick={() => { setRenaming(false); setName(a.name) }}>Cancel</button>
            </span>
          ) : <h2>{a.name}</h2>}
          <div className="muted">{ACCOUNT_TYPE_LABEL[a.type] ?? a.type}{a.institution ? ` · ${a.institution}` : ''}</div>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {a.ownerKind === 'household' && <span className="badge accent">Shared</span>}
          {a.archived && <span className="badge">Closed</span>}
        </div>
      </div>
      {a.type === 'investment' ? (
        <>
          <div className="num" style={{ fontSize: 24, fontWeight: 700 }}>{a.valueCents === null ? <span className="muted">No value entered yet</span> : formatCents(a.valueCents)}</div>
          <div className="muted">{a.valuedAt ? `Last updated ${a.valuedAt}. Update it whenever you check the balance.` : 'Enter the balance you see in your investment app.'}</div>
          {!a.archived && <InvestmentEditor account={a} onSaved={reload} />}
        </>
      ) : (
        <>
          <div className="num" style={{ fontSize: 24, fontWeight: 700 }}>
            {a.type === 'credit_card' || a.type === 'loan' ? <>{formatCents(Math.max(0, -(a.valueCents ?? 0)))} <span className="muted" style={{ fontSize: 13, fontWeight: 500 }}>owed</span></> : formatCents(a.valueCents ?? 0)}
          </div>
          {a.type === 'credit_card' && <CreditLimit account={a} onSaved={reload} />}
          <div className="muted">{a.txnCount} transactions</div>
          <div><button className="btn small" onClick={() => goto('transactions', { accountId: a.id })}>View transactions</button></div>
        </>
      )}
      {a.type !== 'cash' && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', borderTop: '1px solid var(--border)', paddingTop: 8 }}>
          <button className="btn small" onClick={() => setRenaming(true)}>Rename</button>
          {a.archived ? <button className="btn small" onClick={() => void act(() => api('accountReopen', a.profileId, a.id))}>Reopen</button> : <button className="btn small" onClick={() => void close()}>Close account</button>}
          {a.ownerKind === 'person' && household && <button className="btn small" title="Move to the household so it counts for both of you" onClick={() => void share()}>Make shared</button>}
          {a.ownerKind === 'household' && persons.map((p) => <button key={p.profileId} className="btn small" onClick={() => void unshare(p)}>Make {p.name}'s</button>)}
        </div>
      )}
    </Card>
  )
}

/** A card's limit and how much of it is in use. */
function CreditLimit({ account, onSaved }: { account: Row; onSaved: () => void }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(account.creditLimitCents ? (account.creditLimitCents / 100).toFixed(0) : '')
  const [error, setError] = useState<string | null>(null)
  const owed = Math.max(0, -(account.valueCents ?? 0))
  const limit = account.creditLimitCents
  const used = limit ? owed / limit : null
  const save = async () => {
    try { await api('accountSetLimit', account.profileId, account.id, value.trim() === '' ? null : Math.round(Number(value) * 100)); setEditing(false); setError(null); onSaved() } catch (e) { setError((e as Error).message) }
  }
  if (editing) {
    return (
      <div>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="number" min="0" step="100" value={value} onChange={(e) => setValue(e.target.value)} aria-label={`Credit limit for ${account.name}`} placeholder="Limit ($)" style={{ width: 120 }} />
          <button className="btn small primary" onClick={() => void save()}>Save</button>
          <button className="btn small" onClick={() => { setEditing(false); setError(null) }}>Cancel</button>
        </span>
        {error && <div className="neg" role="alert">{error}</div>}
      </div>
    )
  }
  return (
    <div className="muted">
      {limit ? <>Limit {formatCents(limit)} · <b className={used !== null && used >= 0.3 ? 'neg' : ''}>{Math.round((used ?? 0) * 100)}% used</b> · {formatCents(Math.max(0, limit - owed))} available </> : <>No credit limit entered </>}
      {!account.archived && <button className="btn small" onClick={() => setEditing(true)}>{limit ? 'Change limit' : 'Add limit'}</button>}
    </div>
  )
}

function AddAccount({ owners, defaultOwner, allowChoice, onDone, onError }: { owners: Owner[]; defaultOwner: number; allowChoice: boolean; onDone: () => void; onError: (m: string | null) => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [type, setType] = useState<AccountType>('chequing')
  const [institution, setInstitution] = useState('')
  const [amount, setAmount] = useState('')
  const [limit, setLimit] = useState('')
  const [shared, setShared] = useState(false)
  const [owner, setOwner] = useState(String(defaultOwner))
  const household = owners.find((o) => o.kind === 'household')
  const debt = type === 'credit_card' || type === 'loan'

  const save = async () => {
    const ownerId = allowChoice ? Number(owner) : shared && household ? household.profileId : defaultOwner
    try {
      await api('accountCreate', ownerId, { name, type, institution: institution || undefined, openingCents: amount.trim() ? toCents(amount) : undefined, creditLimitCents: type === 'credit_card' && limit.trim() ? toCents(limit) : null })
      onError(null); setOpen(false); setName(''); setAmount(''); setLimit(''); setInstitution(''); setShared(false); onDone()
    } catch (e) { onError((e as Error).message) }
  }

  if (!open) return <button className="btn primary" onClick={() => setOpen(true)}>Add account</button>
  return (
    <Card>
      <div className="card-head"><h2>Add an account</h2></div>
      <div className="filters">
        <label className="field">Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Joint Savings" /></label>
        <label className="field">Type
          <select value={type} onChange={(e) => setType(e.target.value as AccountType)}>
            {(['chequing', 'savings', 'credit_card', 'investment', 'loan', 'other'] as AccountType[]).map((t) => <option key={t} value={t}>{ACCOUNT_TYPE_LABEL[t]}</option>)}
          </select>
        </label>
        <label className="field">Bank or company (optional)<input value={institution} onChange={(e) => setInstitution(e.target.value)} /></label>
        {type !== 'investment' && <label className="field">{debt ? 'Amount owed now ($)' : 'Balance now ($)'}<input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 130 }} placeholder="0.00" /></label>}
        {type === 'credit_card' && <label className="field">Credit limit ($, optional)<input type="number" min="0" step="0.01" value={limit} onChange={(e) => setLimit(e.target.value)} style={{ width: 130 }} /></label>}
        {allowChoice && (
          <label className="field">Whose
            <select value={owner} onChange={(e) => setOwner(e.target.value)}>
              {owners.map((o) => <option key={o.profileId} value={o.profileId}>{o.kind === 'household' ? 'Shared (both of us)' : o.name}</option>)}
            </select>
          </label>
        )}
      </div>
      {!allowChoice && household && <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />Shared account (counts for both of us, e.g. a joint savings or a card we use together)</label>}
      {type === 'investment' && <p className="muted">Investments are valued by hand: after adding it, type in its current value whenever you check it.</p>}
      <p className="muted" style={{ marginTop: 0 }}>The starting amount is only where the balance begins. Transactions you import or add afterwards change it from there.</p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn primary" disabled={!name.trim()} onClick={() => void save()}>Add account</button>
        <button className="btn" onClick={() => { setOpen(false); onError(null) }}>Cancel</button>
      </div>
    </Card>
  )
}

function AddDebt({ profileId, onDone }: { profileId: number; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [amount, setAmount] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)
  if (!open) return <button className="btn small" onClick={() => setOpen(true)}>Add a loan or personal debt</button>
  return (
    <div>
      <ErrorBox error={error} />
      <div className="filters" style={{ marginBottom: 0 }}>
        <label className="field">Owed to<input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Aunt Maria" /></label>
        <label className="field">Amount owed ($)<input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 130 }} /></label>
        <label className="field">Notes (optional)<input value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
        <button className="btn primary" disabled={!name.trim() || !amount.trim()} onClick={() => void (async () => { try { await api('debtCreate', profileId, name, toCents(amount), today(), notes || undefined); setOpen(false); setName(''); setAmount(''); setNotes(''); setError(null); onDone() } catch (e) { setError((e as Error).message) } })()}>Add</button>
        <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  )
}

export function Accounts({ profile, household, goto, onChanged }: { profile: Profile; household?: boolean; goto: (p: Page, preset?: TxnPreset) => void; onChanged: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [owners, setOwners] = useState<Owner[]>([])
  const [debts, setDebts] = useState<DebtRow[]>([])
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    void api('owners').then(setOwners)
    if (household) void api('householdAccounts').then((r: HouseholdAccount[]) => setRows(r))
    else {
      void api('accounts', profile.id).then((r) => setRows(r.map((a) => ({ ...a, profileId: profile.id, owner: profile.name, ownerKind: 'person' as const }))))
      void api('debts', profile.id).then(setDebts)
    }
  }, [profile.id, profile.name, household])
  useEffect(load, [load])
  const reload = () => { load(); onChanged() }

  // In the personal view, shared accounts are not part of "my" accounts; they are shown on the household side.
  if (!rows) return <p className="muted">Loading…</p>

  const open = rows.filter((a) => !a.archived)
  const closed = rows.filter((a) => a.archived)
  const assets = open.filter((a) => a.type !== 'credit_card' && a.type !== 'loan' && a.valueCents !== null && a.valueCents > 0).reduce((s, a) => s + (a.valueCents ?? 0), 0)
  const owed = open.filter((a) => a.type === 'credit_card' || a.type === 'loan').reduce((s, a) => s + Math.max(0, -(a.valueCents ?? 0)), 0)
  const loans = debts.reduce((s, d) => s + d.balanceCents, 0)
  const groups = household ? owners.map((o) => ({ owner: o, list: open.filter((a) => a.profileId === o.profileId) })).filter((g) => g.list.length > 0) : [{ owner: null as Owner | null, list: open }]

  return (
    <>
      <div className="page-head">
        <div><h1>Accounts</h1><p>{household ? 'Every account, with who owns it. Shared accounts belong to both of you.' : 'Balances come from your transactions. Investments are valued by hand because they move with the market.'}</p></div>
        <AddAccount owners={owners} defaultOwner={profile.id} allowChoice={!!household} onDone={reload} onError={setError} />
      </div>
      <ErrorBox error={error} />
      <div className="grid stats">
        <Card className="stat"><div className="label">Money in accounts</div><div className="value num">{formatCents(assets)}</div><div className="hint">Chequing, savings, cash and valued investments</div></Card>
        <Card className="stat"><div className="label">Owed on cards and loans</div><div className="value num">{formatCents(owed)}</div></Card>
        {loans > 0 && <Card className="stat"><div className="label">Personal debts</div><div className="value num">{formatCents(loans)}</div><div className="hint">Entered manually</div></Card>}
      </div>

      {groups.map((g) => (
        <div key={g.owner?.profileId ?? 'mine'} style={{ marginBottom: 8 }}>
          {household && <h3 style={{ margin: '14px 0 10px' }}>{g.owner?.kind === 'household' ? 'Shared accounts' : `${g.owner?.name}'s accounts`}</h3>}
          <div className="grid two">{g.list.map((a) => <AccountCard key={a.id} a={a} owners={owners} goto={goto} reload={reload} onError={setError} />)}</div>
        </div>
      ))}
      {household && !groups.some((g) => g.owner?.kind === 'household') && <p className="muted">No shared accounts yet. Use "Add account" and choose Shared, or open one of your accounts and press "Make shared".</p>}

      {!household && (
        <Card>
          <div className="card-head"><h2>Loans and personal debts</h2><span className="muted">Update a balance whenever it changes; the history is kept for your goals.</span></div>
          {debts.length > 0 && (
            <div className="table-wrap"><table>
              <thead><tr><th>Owed to</th><th className="r">Balance</th><th></th></tr></thead>
              <tbody>{debts.map((d) => <DebtRowEditor key={d.id} debt={d} profileId={profile.id} onSaved={reload} />)}</tbody>
            </table></div>
          )}
          <div style={{ marginTop: 10 }}><AddDebt profileId={profile.id} onDone={reload} /></div>
        </Card>
      )}

      {closed.length > 0 && <><h3 style={{ margin: '20px 0 10px' }}>Closed accounts</h3><div className="grid two">{closed.map((a) => <AccountCard key={a.id} a={a} owners={owners} goto={goto} reload={reload} onError={setError} />)}</div></>}
    </>
  )
}
