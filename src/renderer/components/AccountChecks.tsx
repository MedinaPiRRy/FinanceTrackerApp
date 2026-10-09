import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { Card, ErrorBox } from './ui'
import { formatCents, monthLabel } from '../format'
import type { BalanceCheck, DuplicatePair } from '../../db/accountChecks'

const money = (c: number) => formatCents(Math.abs(c))
const toCents = (v: string): number | null => (v.trim() === '' || Number.isNaN(Number(v)) ? null : Math.round(Number(v) * 100))

/** "Match my bank": type what the bank shows, see what would change, and set the account's starting balance so the two agree. */
export function MatchBalance({ profileId, accountId, name, type, onDone }: { profileId: number; accountId: number; name: string; type: string; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [pending, setPending] = useState('')
  const [check, setCheck] = useState<BalanceCheck | null>(null)
  const [error, setError] = useState<string | null>(null)
  const owes = type === 'credit_card' || type === 'loan'

  const preview = async () => {
    const cents = toCents(value)
    if (cents === null) return setError('Enter the amount your bank shows.')
    const pend = pending.trim() === '' ? null : toCents(pending)
    try { setCheck(await api('accountCheckBalance', profileId, accountId, cents, pend)); setError(null) } catch (e) { setError((e as Error).message); setCheck(null) }
  }
  const apply = async () => {
    const cents = toCents(value)
    if (cents === null) return
    const pend = pending.trim() === '' ? null : toCents(pending)
    try { await api('accountMatchBalance', profileId, accountId, cents, pend); setOpen(false); setCheck(null); setValue(''); setPending(''); onDone() } catch (e) { setError((e as Error).message) }
  }

  if (!open) return <div><button className="btn small" onClick={() => setOpen(true)}>Match my bank’s balance</button></div>
  return (
    <div className="review-card" role="group" aria-label={`Match the bank's balance for ${name}`}>
      <div className="filters" style={{ marginBottom: 0 }}>
        <label className="field">{owes ? 'Amount you owe, as your bank shows ($)' : 'Balance your bank shows ($)'}
          <input type="number" step="0.01" min={owes ? '0' : undefined} value={value} onChange={(e) => { setValue(e.target.value); setCheck(null) }} style={{ width: 160 }} />
        </label>
        <label className="field">Pending charges, if your bank lists them ($)
          <input type="number" step="0.01" min="0" value={pending} placeholder="optional" onChange={(e) => { setPending(e.target.value); setCheck(null) }} style={{ width: 160 }} />
        </label>
        <button className="btn" disabled={!value.trim()} onClick={() => void preview()}>Check</button>
        <button className="btn" onClick={() => { setOpen(false); setCheck(null); setError(null) }}>Cancel</button>
      </div>
      <ErrorBox error={error} />
      {check && (
        <>
          <p className="sub" style={{ margin: 0 }}>
            The app shows {owes ? 'you owe' : 'a balance of'} <b>{money(check.appCents)}</b>{check.appCents < 0 && !owes ? ' (overdrawn)' : ''}; your bank shows <b>{money(check.bankCents)}</b>.
            {' '}To make them agree, the starting balance (what the account held before its first transaction{check.firstDate ? `, ${check.firstDate}` : ''}) changes from <b>{formatCents(check.openingCents)}</b> to <b>{formatCents(check.newOpeningCents)}</b>. None of your {check.txnCount.toLocaleString()} transactions change.{check.pendingCents ? ` With the ${money(check.pendingCents)} pending included, ${owes ? 'you will owe' : 'the balance will be'} ${money(check.afterPendingCents ?? 0)} once it posts.` : ''}
          </p>
          {check.warnings.map((w) => <div key={w} className="notice" role="alert">{w}</div>)}
          <div><button className="btn primary" onClick={() => void apply()}>Set the starting balance</button></div>
        </>
      )}
    </div>
  )
}

/** Two accounts that hold the same purchases (the same file imported twice, or a workbook and a statement for the same card). */
export function DuplicatesCard({ profileId, onChanged }: { profileId: number; onChanged: () => void }) {
  const [pairs, setPairs] = useState<DuplicatePair[]>([])
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const load = useCallback(() => { void api('duplicatesFind', profileId).then((p) => { setPairs(p); setError(null) }).catch((e: Error) => setError(e.message)) }, [profileId])
  useEffect(load, [load])

  const remove = async (from: { id: number; name: string }, other: { id: number; name: string }, n: number) => {
    if (!confirm(`Delete ${n.toLocaleString()} transactions from "${from.name}" that are also in "${other.name}"?\n\n"${other.name}" is not changed. A backup copy of your data is made first.`)) return
    try { const r = await api('duplicatesDelete', profileId, from.id, other.id); setMsg(`Deleted ${r.deleted.toLocaleString()} duplicate transactions from ${from.name}. Check the balances below.`); setError(null); load(); onChanged() } catch (e) { setError((e as Error).message) }
  }

  if (pairs.length === 0 && !msg && !error) return null
  return (
    <Card>
      <div className="card-head"><h2>The same transactions in two accounts</h2></div>
      <ErrorBox error={error} />
      {msg && <div className="notice" role="status">{msg}</div>}
      {pairs.map((p) => (
        <div key={`${p.a.id}-${p.b.id}`} style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginTop: 10 }}>
          <p className="sub" style={{ marginTop: 0 }}>
            <b>{p.a.name}</b> and <b>{p.b.name}</b> hold <b>{p.matches.toLocaleString()}</b> identical transactions (same date and amount) in {p.months.length} month{p.months.length === 1 ? '' : 's'} ({monthLabel(p.months[0]!)}{p.months.length > 1 ? ` to ${monthLabel(p.months[p.months.length - 1]!)}` : ''}). A purchase cannot be on two cards, so one of the two accounts has copies, which makes both balances wrong. Decide which account really has them, and delete the copies from the other. {p.a.name} has {p.rowsA.toLocaleString()} rows in those months and {p.b.name} has {p.rowsB.toLocaleString()}.
          </p>
          <div className="table-wrap"><table>
            <thead><tr><th>Date</th><th>In {p.a.name}</th><th>In {p.b.name}</th><th className="r">Amount</th></tr></thead>
            <tbody>{p.examples.map((e, i) => <tr key={i}><td className="num">{e.date}</td><td>{e.descriptionA}</td><td>{e.descriptionB}</td><td className="r num">{formatCents(e.amountCents, { sign: true })}</td></tr>)}</tbody>
          </table></div>
          <p className="muted" style={{ fontSize: 12 }}>Showing {p.examples.length} of {p.matches.toLocaleString()}.</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn danger" onClick={() => void remove(p.a, p.b, p.matches)}>Delete the {p.matches.toLocaleString()} copies from {p.a.name}</button>
            <button className="btn danger" onClick={() => void remove(p.b, p.a, p.matches)}>Delete the {p.matches.toLocaleString()} copies from {p.b.name}</button>
          </div>
        </div>
      ))}
    </Card>
  )
}
