import { useEffect, useState } from 'react'
import { api } from '../api'
import { Card, ErrorBox } from './ui'
import type { Profile } from '../../db/queries'

type Mode = 'single' | 'couple' | 'couple_household'
const MODE_LABEL: Record<Mode, string> = { single: 'Just me', couple: 'Me and my partner', couple_household: 'Me, my partner and a shared household' }

/** Move between "just me", "me and my partner" and "plus a shared household". Adding is safe; removing deletes that data and needs a typed confirmation. */
export function SetupMode({ mode, onChanged }: { mode: Mode; onChanged: () => void }) {
  const [people, setPeople] = useState<Profile[]>([])
  const [name, setName] = useState('')
  const [chequing, setChequing] = useState(true)
  const [card, setCard] = useState(true)
  const [removing, setRemoving] = useState<'household' | number | null>(null)
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => { void api('profiles').then((ps) => setPeople(ps)).catch((e: Error) => setError(e.message)) }, [mode])

  const run = async (fn: () => Promise<unknown>, note: string) => {
    setBusy(true)
    try { await fn(); setError(null); setMsg(note); setName(''); setRemoving(null); setTyped(''); onChanged() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <Card>
      <div className="card-head"><h2>Setup</h2></div>
      <p className="sub" style={{ marginTop: 0 }}>Your setup is <b>{MODE_LABEL[mode]}</b>. You can add people or a shared household later; nothing you already have changes.</p>
      <ErrorBox error={error} />
      {msg && <div className="notice" role="status">{msg}</div>}

      {mode === 'single' && (
        <div className="review-card" role="group" aria-label="Add my partner">
          <b>Add my partner</b>
          <p className="sub" style={{ margin: 0 }}>Your partner gets their own private finances next to yours (their own accounts, categories and budgets). Money you send each other is treated as movement between you.</p>
          <div className="filters" style={{ marginBottom: 0 }}>
            <label className="field">Partner’s name<input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="e.g. Jordan" /></label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={chequing} onChange={(e) => setChequing(e.target.checked)} />Start with a Chequing account</label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={card} onChange={(e) => setCard(e.target.checked)} />and a Credit card</label>
            <button className="btn primary" disabled={!name.trim() || busy} onClick={() => void run(() => api('addPartner', { name, accounts: [...(chequing ? [{ name: 'Chequing', type: 'chequing' as const }] : []), ...(card ? [{ name: 'Credit card', type: 'credit_card' as const }] : [])] }), `${name.trim()} was added. Use the buttons at the top to switch between you.`)}>Add partner</button>
          </div>
        </div>
      )}

      {mode === 'couple' && (
        <div className="review-card" role="group" aria-label="Add a shared household">
          <b>Add a shared household</b>
          <p className="sub" style={{ margin: 0 }}>Adds a Household view for shared accounts (a joint account or card), household budgets and goals you work toward together. Each person’s own finances stay separate.</p>
          <div><button className="btn primary" disabled={busy} onClick={() => void run(() => api('addHousehold'), 'The shared household was added. Open it from the buttons at the top.')}>Add the shared household</button></div>
        </div>
      )}

      {mode !== 'single' && (
        <div style={{ marginTop: 12 }}>
          <h3 style={{ fontSize: 14, margin: '4px 0' }}>Remove</h3>
          <p className="sub" style={{ marginTop: 0 }}>Removing deletes that data for good. A backup copy of everything is made first.</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {mode === 'couple_household' && <button className="btn danger" onClick={() => { setRemoving('household'); setTyped(''); setError(null) }}>Remove the shared household</button>}
            {mode === 'couple' && people.map((p) => <button key={p.id} className="btn danger" onClick={() => { setRemoving(p.id); setTyped(''); setError(null) }}>Remove {p.name} and their data</button>)}
          </div>
          {mode === 'couple_household' && <p className="muted" style={{ fontSize: 12 }}>To remove a person, remove the shared household first.</p>}
          {removing !== null && (
            <div className="review-card" style={{ marginTop: 12 }} role="group" aria-label="Confirm removal">
              {removing === 'household' ? (
                <>
                  <b>Remove the shared household?</b>
                  <p className="sub" style={{ margin: 0 }}>Its shared accounts, their transactions, and the household budgets and goals are deleted. Money that moved between a person and the household is kept on the person’s side and put in Review so you can decide what it was.</p>
                  <label className="field">Type REMOVE to confirm<input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="REMOVE" style={{ width: 160 }} autoComplete="off" /></label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button className="btn danger" disabled={typed.trim() !== 'REMOVE' || busy} onClick={() => void run(() => api('removeHousehold', typed), 'The shared household was removed.')}>Remove the household</button>
                    <button className="btn" onClick={() => setRemoving(null)}>Cancel</button>
                  </div>
                </>
              ) : (() => {
                const p = people.find((x) => x.id === removing)
                if (!p) return null
                return (
                  <>
                    <b>Remove {p.name} and all of their data?</b>
                    <p className="sub" style={{ margin: 0 }}>Their accounts, transactions, categories, budgets, goals and recurring items are deleted. Money that moved between you and them is kept on your side and put in Review.</p>
                    <label className="field">Type {p.name} to confirm<input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={p.name} style={{ width: 200 }} autoComplete="off" /></label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn danger" disabled={typed.trim() !== p.name || busy} onClick={() => void run(() => api('removePartner', p.id, typed), `${p.name} was removed.`)}>Remove {p.name}</button>
                      <button className="btn" onClick={() => setRemoving(null)}>Cancel</button>
                    </div>
                  </>
                )
              })()}
            </div>
          )}
        </div>
      )}
    </Card>
  )
}
