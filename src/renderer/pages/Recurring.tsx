import { useEffect, useState } from 'react'
import { api } from '../api'
import { Card } from '../components/ui'
import { formatCents, pct } from '../format'
import { ErrorBox } from '../components/ui'
import type { AccountInfo, Profile, RecurringRow } from '../../db/queries'
import type { RecurringSuggestion, StoppedItem } from '../../db/recurringDetect'

const FREQ: Record<string, string> = { weekly: 'Weekly', biweekly: 'Every 2 weeks', semimonthly: 'Twice a month', monthly: 'Monthly', quarterly: 'Every 3 months', yearly: 'Yearly', irregular: 'Irregular' }

function Table({ rows, title, note, onEdit, onDelete }: { rows: RecurringRow[]; title: string; note?: string; onEdit: (r: RecurringRow) => void; onDelete: (r: RecurringRow) => void }) {
  if (!rows.length) return null
  const counted = rows.filter((r) => r.countsInBudget)
  return (
    <Card>
      <div className="card-head"><h2>{title}</h2>{note && <span className="muted">{note}</span>}</div>
      <div className="table-wrap"><table>
        <thead><tr><th>Item</th><th>Paid with</th><th>How often</th><th className="r">Amount</th><th className="r">Per month</th><th className="r">Per year</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} style={r.status === 'cancelled' ? { opacity: 0.6 } : undefined}>
              <td>{r.name}{r.notes && <div className="muted">{r.notes}</div>}</td>
              <td>{r.account ?? r.paidWith ?? '—'}</td>
              <td>{FREQ[r.frequency]}{r.usualTiming && <div className="muted">{r.usualTiming}</div>}</td>
              <td className="r num">{formatCents(r.amountCents)}</td>
              <td className="r num">{r.countsInBudget ? formatCents(r.monthlyCents) : <span className="muted">not counted</span>}</td>
              <td className="r num">{r.countsInBudget ? formatCents(r.annualCents) : <span className="muted">—</span>}</td>
              <td><span className={`badge ${r.status === 'cancelled' ? '' : r.status === 'irregular' ? 'warn' : 'accent'}`}>{r.status}</span></td>
              <td className="r" style={{ whiteSpace: 'nowrap' }}><button className="btn small" aria-label={`Edit ${r.name}`} onClick={() => onEdit(r)}>Edit</button> <button className="btn small danger" aria-label={`Delete ${r.name}`} onClick={() => onDelete(r)}>Delete</button></td>
            </tr>
          ))}
          <tr><td colSpan={4}><b>Total counted</b></td><td className="r num"><b>{formatCents(counted.reduce((s, r) => s + r.monthlyCents, 0))}</b></td><td className="r num"><b>{formatCents(counted.reduce((s, r) => s + r.annualCents, 0))}</b></td><td colSpan={2}></td></tr>
        </tbody>
      </table></div>
    </Card>
  )
}


interface Draft { id: number | null; name: string; direction: 'income' | 'expense'; accountId: string; amount: string; frequency: string; counts: boolean; notes: string; status: 'active' | 'cancelled' }
const blank: Draft = { id: null, name: '', direction: 'expense', accountId: '', amount: '', frequency: 'monthly', counts: true, notes: '', status: 'active' }

/** Add a recurring item by hand, or edit one the app found. */
function RecurringForm({ draft, setDraft, accounts, onSave, onCancel, error }: { draft: Draft; setDraft: (d: Draft) => void; accounts: AccountInfo[]; onSave: () => void; onCancel: () => void; error: string | null }) {
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch })
  return (
    <Card>
      <div className="card-head"><h2>{draft.id === null ? 'Add a recurring item' : 'Edit recurring item'}</h2></div>
      <ErrorBox error={error} />
      <div className="filters">
        <label className="field">Name<input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Phone plan" style={{ width: 220 }} maxLength={80} autoFocus /></label>
        <label className="field">Type
          <select value={draft.direction} onChange={(e) => set({ direction: e.target.value as 'income' | 'expense' })}><option value="expense">Bill or subscription</option><option value="income">Income</option></select>
        </label>
        <label className="field">Amount ($)<input type="number" min="0" step="0.01" value={draft.amount} onChange={(e) => set({ amount: e.target.value })} style={{ width: 110 }} /></label>
        <label className="field">How often
          <select value={draft.frequency} onChange={(e) => set({ frequency: e.target.value })}>{Object.entries(FREQ).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        </label>
        <label className="field">{draft.direction === 'income' ? 'Paid into' : 'Paid from'}
          <select value={draft.accountId} onChange={(e) => set({ accountId: e.target.value })}>
            <option value="">Not in any of my accounts</option>
            {accounts.filter((a) => !a.archived).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        {draft.id !== null && (
          <label className="field">Status
            <select value={draft.status} onChange={(e) => set({ status: e.target.value as 'active' | 'cancelled' })}><option value="active">Active</option><option value="cancelled">Cancelled</option></select>
          </label>
        )}
        <label className="field" style={{ flex: 1, minWidth: 180 }}>Note (optional)<input value={draft.notes} onChange={(e) => set({ notes: e.target.value })} /></label>
      </div>
      {draft.direction === 'expense' && <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}><input type="checkbox" checked={draft.counts} onChange={(e) => set({ counts: e.target.checked })} />Count it in my monthly bills total</label>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn primary" disabled={!draft.name.trim() || !(Number(draft.amount) > 0)} onClick={onSave}>{draft.id === null ? 'Add item' : 'Save changes'}</button>
        <button className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </Card>
  )
}

const niceDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

/** Things the app noticed: payments that stopped ("was it cancelled?") and regular payments it is not tracking yet. */
function Attention({ profile, onChanged }: { profile: Profile; onChanged: () => void }) {
  const [stopped, setStopped] = useState<StoppedItem[]>([])
  const [found, setFound] = useState<RecurringSuggestion[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [names, setNames] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const id = (s: RecurringSuggestion) => `${s.direction}|${s.key}`

  const load = () => {
    void api('recurringStopped', profile.id).then(setStopped).catch((e: Error) => setError(e.message))
    void api('recurringSuggest', profile.id).then((f) => { setFound(f); setPicked(new Set(f.filter((x) => x.confidence === 'high').map(id))); setNames(Object.fromEntries(f.map((x) => [id(x), x.name]))) }).catch((e: Error) => setError(e.message))
  }
  useEffect(load, [profile.id])
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); setError(null); load(); onChanged() } catch (e) { setError((e as Error).message) } }

  const chosen = found.filter((f) => picked.has(id(f)))
  return (
    <>
      <ErrorBox error={error} />
      {stopped.length > 0 && (
        <Card>
          <div className="card-head"><h2>Did these stop?</h2></div>
          <p className="sub" style={{ marginTop: 0 }}>These used to appear regularly, but your latest transactions show no sign of them. Tell the app what happened so your totals stay accurate.</p>
          {stopped.map((s) => (
            <div key={s.id} style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', padding: '10px 0', borderTop: '1px solid var(--border)' }}>
              <div>
                <b>{s.name}</b> <span className="muted">· {formatCents(s.amountCents)} {FREQ[s.frequency]?.toLowerCase()}{s.accountName ? ` · ${s.accountName}` : ''}</span>
                <div className="muted">Last seen {niceDate(s.lastSeen)}. It was due around {niceDate(s.expectedBy)}, and {s.missed === 1 ? 'one payment has' : `${s.missed} payments have`} not appeared since.</div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn" onClick={() => void run(() => api('recurringAnswer', profile.id, s.id, 'cancelled'))}>Yes, it was cancelled</button>
                <button className="btn" onClick={() => void run(() => api('recurringAnswer', profile.id, s.id, 'active'))}>No, it is still active</button>
              </div>
            </div>
          ))}
        </Card>
      )}
      {found.length > 0 && (
        <Card>
          <div className="card-head"><h2>Found {found.length} regular payment{found.length === 1 ? '' : 's'}</h2></div>
          <p className="sub" style={{ marginTop: 0 }}>These repeat on a steady schedule for a steady amount, but are not in your list yet. Tick the ones you want to track. Shopping that varies every time (groceries, fuel) is left out on purpose.</p>
          <div className="table-wrap"><table>
            <thead><tr><th></th><th>Name</th><th>How often</th><th className="r">Amount</th><th>Paid from</th><th>Seen</th><th></th></tr></thead>
            <tbody>
              {found.map((f) => (
                <tr key={id(f)}>
                  <td><input type="checkbox" aria-label={`Track ${f.name}`} checked={picked.has(id(f))} onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(id(f)); else n.delete(id(f)); return n })} /></td>
                  <td><input aria-label={`Name for ${f.name}`} value={names[id(f)] ?? f.name} onChange={(e) => setNames({ ...names, [id(f)]: e.target.value })} style={{ width: 200 }} />{f.direction === 'income' && <span className="badge accent" style={{ marginLeft: 6 }}>Income</span>}</td>
                  <td>{FREQ[f.frequency]}</td>
                  <td className="r num">{formatCents(f.amountCents)}</td>
                  <td>{f.accountName ?? '—'}</td>
                  <td className="muted">{f.occurrences}× since {niceDate(f.firstDate)}{f.confidence === 'medium' && ' · less certain'}</td>
                  <td><button className="btn small" title="Never suggest this again" onClick={() => void run(() => api('recurringDismiss', profile.id, f.key, f.direction))}>Not recurring</button></td>
                </tr>
              ))}
            </tbody>
          </table></div>
          <div style={{ marginTop: 12 }}>
            <button className="btn primary" disabled={chosen.length === 0} onClick={() => void run(() => api('recurringAdd', profile.id, chosen.map((f) => ({ key: f.key, direction: f.direction, name: names[id(f)] }))))}>Track {chosen.length} selected</button>
          </div>
        </Card>
      )}
    </>
  )
}

export function Recurring({ profile, accounts, onChanged }: { profile: Profile; accounts: AccountInfo[]; onChanged: () => void }) {
  const [rows, setRows] = useState<RecurringRow[] | null>(null)
  const [income, setIncome] = useState<number | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const loadRows = () => { void api('recurring', profile.id).then(setRows) }
  useEffect(() => {
    loadRows()
    void api('dashboard', profile.id).then((d) => setIncome(d?.average ? d.average.incomeCents : d?.summary.incomeCents ?? null))
  }, [profile.id])
  if (!rows) return <p className="muted">Loading…</p>

  const edit = (r: RecurringRow) => { setFormError(null); setDraft({ id: r.id, name: r.name, direction: r.direction as 'income' | 'expense', accountId: r.accountId ? String(r.accountId) : '', amount: (r.amountCents / 100).toFixed(2), frequency: r.frequency, counts: r.countsInBudget, notes: r.notes ?? '', status: r.status === 'cancelled' ? 'cancelled' : 'active' }) }
  const save = async () => {
    if (!draft) return
    const input = { name: draft.name, direction: draft.direction, accountId: draft.accountId ? Number(draft.accountId) : null, amountCents: Math.round(Number(draft.amount) * 100), frequency: draft.frequency as never, countsInBudget: draft.counts, notes: draft.notes || null }
    try {
      if (draft.id === null) await api('recurringCreate', profile.id, input)
      else await api('recurringUpdate', profile.id, draft.id, { ...input, status: draft.status })
      setDraft(null); setFormError(null); loadRows(); onChanged()
    } catch (e) { setFormError((e as Error).message) }
  }
  const remove = async (r: RecurringRow) => {
    if (!confirm(`Delete "${r.name}" from your recurring list? Your transactions are not affected, and the app will not suggest it again.`)) return
    try { await api('recurringDelete', profile.id, r.id); setActionError(null); loadRows(); onChanged() } catch (e) { setActionError((e as Error).message) }
  }

  const bills = rows.filter((r) => r.direction === 'expense' && r.countsInBudget && r.status !== 'cancelled')
  const monthly = bills.reduce((s, r) => s + r.monthlyCents, 0)
  return (
    <>
      <div className="page-head"><div><h1>Recurring</h1><p>Regular income and bills, with what they cost per month and per year.</p></div><button className="btn primary" onClick={() => { setFormError(null); setDraft({ ...blank }) }}>Add item</button></div>
      <ErrorBox error={actionError} />
      {draft && <><RecurringForm draft={draft} setDraft={setDraft} accounts={accounts} onSave={() => void save()} onCancel={() => { setDraft(null); setFormError(null) }} error={formError} /><div style={{ height: 16 }} /></>}
      <div className="grid stats">
        <Card className="stat"><div className="label">Recurring bills per month</div><div className="value num">{formatCents(monthly)}</div></Card>
        <Card className="stat"><div className="label">Per year</div><div className="value num">{formatCents(monthly * 12)}</div></Card>
        <Card className="stat"><div className="label">Share of average income</div><div className="value num">{income && income > 0 ? pct(monthly / income) : 'n/a'}</div><div className="hint">{income ? `Average income ${formatCents(income)}/mo` : ''}</div></Card>
      </div>
      <div className="grid" style={{ gap: 16 }}>
        <Attention profile={profile} onChanged={() => { loadRows(); onChanged() }} />
        {rows.length === 0 && <Card><h2>No recurring items yet</h2><p className="sub">Bills, subscriptions and regular income show up here. The app suggests them when it finds payments that repeat in your transactions, or you can add one yourself.</p><button className="btn primary" onClick={() => { setFormError(null); setDraft({ ...blank }) }}>Add an item</button></Card>}
        <Table onEdit={edit} onDelete={(r) => void remove(r)} title="Income" rows={rows.filter((r) => r.direction === 'income')} note="Irregular income is not counted as regular income" />
        <Table onEdit={edit} onDelete={(r) => void remove(r)} title="Bills and subscriptions" rows={rows.filter((r) => r.direction === 'expense' && r.status !== 'cancelled')} note="Bills paid in cash are tracked on the Cash page" />
        <Table onEdit={edit} onDelete={(r) => void remove(r)} title="Cancelled" rows={rows.filter((r) => r.status === 'cancelled')} />
      </div>
    </>
  )
}
