import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'
import { Card, ErrorBox, Toast } from '../components/ui'
import { formatCents, today } from '../format'
import type { AccountInfo, CategoryInfo, Profile, RecurringRow, TxnRow } from '../../db/queries'

interface CashData { balanceCents: number; entries: TxnRow[]; cashBills: RecurringRow[] }
const toCents = (v: string) => Math.round(Number(v) * 100)
const validNum = (v: string) => v.trim() !== '' && Number(v) > 0
const CURRENCIES = ['CAD', 'USD', 'EUR', 'GBP', 'MXN', 'AUD', 'JPY']

export function Cash({ profile, accounts, categories, onChanged }: { profile: Profile; accounts: AccountInfo[]; categories: CategoryInfo[]; onChanged: () => void }) {
  const [data, setData] = useState<CashData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [tipDate, setTipDate] = useState(today())
  const [tipAmount, setTipAmount] = useState('')
  const [tipNote, setTipNote] = useState('')
  const [tipCur, setTipCur] = useState('CAD') // the currency the tips were received in
  const [otherCur, setOtherCur] = useState('')
  const [rate, setRate] = useState('')
  const [rates, setRates] = useState<Record<string, number>>({})
  useEffect(() => { void api('fxRates').then(setRates) }, [])
  const curCode = tipCur === 'OTHER' ? otherCur.trim().toUpperCase() : tipCur
  const foreign = curCode !== 'CAD' && curCode !== ''
  const pickCurrency = (c: string) => { setTipCur(c); if (c !== 'OTHER' && rates[c]) setRate(String(rates[c])); else if (c === 'CAD') setRate('') }
  const converted = foreign && validNum(tipAmount) && validNum(rate) ? Math.round(Number(tipAmount) * 100 * Number(rate)) : null
  const [depDate, setDepDate] = useState(today())
  const [depAmount, setDepAmount] = useState('')
  const [depTo, setDepTo] = useState('')
  const [billCat, setBillCat] = useState<Record<number, string>>({})
  const [billDate, setBillDate] = useState(today())
  const [spendDate, setSpendDate] = useState(today())
  const [spendAmount, setSpendAmount] = useState('')
  const [spendWhat, setSpendWhat] = useState('')
  const [spendCat, setSpendCat] = useState('')
  const [spendNote, setSpendNote] = useState('')
  const [newCat, setNewCat] = useState('')

  const load = useCallback(() => { void api('cash', profile.id).then(setData) }, [profile.id])
  useEffect(load, [load])
  const banks = accounts.filter((a) => (a.type === 'chequing' || a.type === 'savings') && !a.archived)
  const expenseCats = categories.filter((c) => c.kind === 'expense')

  const run = async (fn: () => Promise<unknown>, msg: string, reset?: () => void) => {
    try { await fn(); setError(null); setToast(msg); setTimeout(() => setToast(null), 2500); reset?.(); load(); onChanged() } catch (e) { setError((e as Error).message) }
  }
  const validAmount = (v: string) => v.trim() !== '' && Number(v) > 0

  if (!data) return <p className="muted">Loading…</p>
  return (
    <>
      <div className="page-head"><div><h1>Cash &amp; tips</h1><p>Cash you earn and spend outside the bank. Tips count as income, and bills paid in cash count as spending.</p></div></div>
      <ErrorBox error={error} />
      <div className="grid stats">
        <Card className="stat"><div className="label">Cash on hand</div><div className="value num">{formatCents(data.balanceCents)}</div><div className="hint">Tips recorded minus cash spent or deposited</div></Card>
      </div>
      {data.balanceCents < 0 && <div className="notice">Your recorded cash is below zero. That usually means tips were spent or deposited before they were logged. Add the missing tips and the balance will correct itself.</div>}

      <Card>
        <div className="card-head"><h2>Spent cash</h2></div>
        <p className="muted" style={{ marginTop: 0 }}>Record cash you spent (lunch, parking, a gift…). It counts as spending in the category you pick, and comes out of your cash on hand.</p>
        <div className="filters" style={{ marginBottom: 0 }}>
          <label className="field">Date<input type="date" value={spendDate} onChange={(e) => setSpendDate(e.target.value)} /></label>
          <label className="field">Amount ($)<input type="number" min="0" step="0.01" value={spendAmount} onChange={(e) => setSpendAmount(e.target.value)} style={{ width: 110 }} /></label>
          <label className="field" style={{ flex: 1, minWidth: 160 }}>What for<input value={spendWhat} onChange={(e) => setSpendWhat(e.target.value)} placeholder="e.g. Lunch with friends" /></label>
          <label className="field">Category
            <select value={spendCat} onChange={(e) => setSpendCat(e.target.value)}><option value="">Choose…</option>{expenseCats.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select>
          </label>
          <label className="field">Or a new category
            <span style={{ display: 'flex', gap: 6 }}>
              <input value={newCat} onChange={(e) => setNewCat(e.target.value)} placeholder="e.g. Gifts" style={{ width: 120 }} />
              <button className="btn" type="button" disabled={!newCat.trim()} onClick={() => void (async () => { try { const c = await api('createCategory', profile.id, newCat, 'expense'); setNewCat(''); setSpendCat(String(c.id)); onChanged(); setError(null) } catch (e) { setError((e as Error).message) } })()}>Add</button>
            </span>
          </label>
          <label className="field" style={{ flex: 1, minWidth: 140 }}>Note (optional)<input value={spendNote} onChange={(e) => setSpendNote(e.target.value)} /></label>
          <button className="btn primary" disabled={!validAmount(spendAmount) || !spendWhat.trim() || !spendCat} onClick={() => void run(() => api('addCashSpend', profile.id, spendDate, toCents(spendAmount), spendWhat, Number(spendCat), spendNote || undefined), 'Cash spending saved', () => { setSpendAmount(''); setSpendWhat(''); setSpendNote('') })}>Record spending</button>
        </div>
      </Card>
      <div style={{ height: 16 }} />

      <div className="grid two">
        <Card>
          <div className="card-head"><h2>Add tips for a day</h2></div>
          <div className="filters" style={{ marginBottom: 0 }}>
            <label className="field">Date<input type="date" value={tipDate} onChange={(e) => setTipDate(e.target.value)} /></label>
            <label className="field">Currency
              <select value={tipCur} onChange={(e) => pickCurrency(e.target.value)} aria-label="Currency the tips were received in">
                {CURRENCIES.map((c) => <option key={c} value={c}>{c === 'CAD' ? 'CAD (home)' : c}</option>)}<option value="OTHER">Other…</option>
              </select>
            </label>
            {tipCur === 'OTHER' && <label className="field">Code<input value={otherCur} maxLength={3} onChange={(e) => setOtherCur(e.target.value)} placeholder="e.g. CHF" style={{ width: 80 }} /></label>}
            <label className="field">Amount ({foreign ? curCode || '?' : '$'})<input type="number" min="0" step="0.01" value={tipAmount} onChange={(e) => setTipAmount(e.target.value)} style={{ width: 110 }} /></label>
            {foreign && <label className="field">Rate (CAD per 1 {curCode || '?'})<input type="number" min="0" step="0.0001" value={rate} onChange={(e) => setRate(e.target.value)} style={{ width: 110 }} placeholder="e.g. 1.37" /></label>}
            <label className="field" style={{ flex: 1, minWidth: 140 }}>Note (optional)<input value={tipNote} onChange={(e) => setTipNote(e.target.value)} placeholder="e.g. Friday close" /></label>
            <button className="btn primary" disabled={!validAmount(tipAmount) || (foreign && (!/^[A-Z]{3}$/.test(curCode) || !validNum(rate)))} onClick={() => void run(() => foreign ? api('addTip', profile.id, tipDate, 0, tipNote || undefined, { currency: curCode, cents: toCents(tipAmount), rate: Number(rate) }) : api('addTip', profile.id, tipDate, toCents(tipAmount), tipNote || undefined), 'Tips saved', () => { setTipAmount(''); setTipNote(''); void api('fxRates').then(setRates) })}>Save tips</button>
          </div>
          {foreign && <p className="muted" style={{ marginBottom: 0 }}>{converted !== null ? <>That is about <b>{formatCents(converted)}</b> CAD at your rate. The app works offline, so it never looks rates up: use the rate you actually got. The converted amount is what counts in your income and cash.</> : 'Enter the amount and the exchange rate to see the CAD value.'}</p>}
        </Card>
        <Card>
          <div className="card-head"><h2>Deposit cash to the bank</h2></div>
          <p className="muted" style={{ marginTop: 0 }}>A transfer, not new income, so deposited tips are never counted twice.</p>
          <div className="filters" style={{ marginBottom: 0 }}>
            <label className="field">Date<input type="date" value={depDate} onChange={(e) => setDepDate(e.target.value)} /></label>
            <label className="field">Amount ($)<input type="number" min="0" step="0.01" value={depAmount} onChange={(e) => setDepAmount(e.target.value)} style={{ width: 110 }} /></label>
            <label className="field">Into<select value={depTo} onChange={(e) => setDepTo(e.target.value)}><option value="">Choose account…</option>{banks.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
            <button className="btn primary" disabled={!validAmount(depAmount) || !depTo} onClick={() => void run(() => api('depositCash', profile.id, depDate, toCents(depAmount), Number(depTo)), 'Deposit saved', () => setDepAmount(''))}>Deposit</button>
          </div>
        </Card>
      </div>

      {data.cashBills.length > 0 && (
        <Card>
          <div className="card-head"><h2>Bills paid in cash</h2><label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>Payment date<input type="date" value={billDate} onChange={(e) => setBillDate(e.target.value)} /></label></div>
          <p className="muted" style={{ marginTop: 0 }}>These never appear on a bank statement. Record each month's payment so it shows in your spending.</p>
          <div className="table-wrap"><table>
            <thead><tr><th>Bill</th><th className="r">Amount</th><th>Category</th><th></th></tr></thead>
            <tbody>
              {data.cashBills.map((b) => (
                <tr key={b.id}>
                  <td>{b.name}<div className="muted">{b.frequency}</div></td>
                  <td className="r num">{formatCents(b.amountCents)}</td>
                  <td><select className="cat-select" aria-label={`Category for ${b.name}`} value={billCat[b.id] ?? ''} onChange={(e) => setBillCat({ ...billCat, [b.id]: e.target.value })}><option value="">Choose…</option>{expenseCats.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></td>
                  <td className="r"><button className="btn small primary" disabled={!billCat[b.id]} onClick={() => void run(() => api('recordCashBill', profile.id, b.id, billDate, Number(billCat[b.id])), `${b.name} recorded`)}>Record payment</button></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        </Card>
      )}

      <div style={{ height: 16 }} />
      <Card>
        <div className="card-head"><h2>Recent cash activity</h2></div>
        {data.entries.length === 0 ? <p className="muted">Nothing recorded yet. Add your first day of tips above.</p> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Date</th><th>What</th><th>Note</th><th className="r">Amount</th><th></th></tr></thead>
            <tbody>
              {data.entries.map((e) => (
                <tr key={e.id}>
                  <td className="num">{e.date}</td><td>{e.description}</td><td className="muted">{e.notes}</td>
                  <td className={`r num ${e.amountCents > 0 ? 'pos' : ''}`}>{formatCents(e.amountCents, { sign: true })}{e.currency && e.originalCents !== null && <div className="muted" style={{ fontSize: 12 }}>{(e.originalCents / 100).toLocaleString('en-CA', { minimumFractionDigits: 2 })} {e.currency} @ {e.fxRate}</div>}</td>
                  <td className="r">{e.source === 'cash_entry' && <button className="btn small danger" onClick={() => { if (confirm(`Delete "${e.description}" on ${e.date}? This cannot be undone.`)) void run(() => api('deleteCashEntry', profile.id, e.id), 'Entry deleted') }}>Delete</button>}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </Card>
      <Toast message={toast} />
    </>
  )
}
